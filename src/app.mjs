import http from "node:http";
import { EventLog } from "./store/eventlog.mjs";
import {
  capacityUsed,
  foldEvents,
  releaseBlockers,
  replicaDoubleBooked,
  timelineFor,
} from "./domain/fold.mjs";
import { DEFAULT_DEVICES, DEFAULT_STAFF, ROLE_NAMES, STAFF_ROLES } from "./registry.mjs";
import { ApiError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from "./domain/errors.mjs";
import { nowIso, requireIso, toMs } from "./domain/time.mjs";

const DEVICE_KINDS = new Set(["handover_scan", "load_reading"]);
const DIRECTIONS = new Set(["out", "in"]);

export function createServer(options = {}) {
  const dataDir = options.dataDir ?? new URL("../data/", import.meta.url).pathname;
  const registry = {
    staff: { ...DEFAULT_STAFF, ...(options.staff ?? {}) },
    devices: { ...DEFAULT_DEVICES, ...(options.devices ?? {}) },
  };
  const log = new EventLog(dataDir);
  let state = foldEvents(log.events, { now: Date.now(), registry });

  const refold = () => {
    state = foldEvents(log.events, { now: Date.now(), registry });
  };

  // 追加一条事实并重放；若重放导致既有设备事件判定反转，持久化 decision_changed 冲突。
  function record(type, actor, occurredAt, payload) {
    const event = log.append(type, actor, occurredAt, payload);
    const before = state;
    refold();
    const reversals = [];
    for (const [key, d] of state.decisions) {
      const prev = before.decisions.get(key);
      if (prev && prev.verdict !== d.verdict) reversals.push(d);
    }
    for (const d of reversals) {
      log.append("decision_changed", "system", nowIso(), {
        device_id: d.device_id,
        event_id: d.event_id,
        replica_id: d.replica_id,
        from: before.decisions.get(`${d.device_id}/${d.event_id}`).verdict,
        to: d.verdict,
        cause: { type: event.type, seq: event.seq },
      });
    }
    if (reversals.length > 0) refold();
    return event;
  }

  // ---------- 视图 ----------

  const replicaView = (rep) => ({
    replica_id: rep.id,
    status: rep.status,
    original_ref: rep.profile?.original_ref ?? null,
    name: rep.profile?.name ?? null,
    load_limit_kg: rep.profile?.load_limit_kg ?? null,
    touch_constraints: rep.profile?.touch_constraints ?? {},
    cooldown_minutes: rep.profile?.cooldown_minutes ?? null,
    home_location: rep.profile?.home_location ?? null,
    registered_at: rep.registered_at,
    holder: rep.holder,
    needs_inspection: rep.needs_inspection,
    inspection: rep.inspection,
    recall: rep.recall,
    deactivation: rep.deactivation,
    cooldown_until: rep.cooldown_until,
    last_reading: rep.last_reading,
    release_blockers_now: rep.known ? releaseBlockers(rep, Date.now(), state.closures).map((r) => r.code) : ["REPLICA_UNKNOWN"],
  });

  const assignmentView = (a) => {
    const s = state.sessions.get(a.session_id);
    return {
      assignment_id: a.id,
      session_id: a.session_id,
      session_title: s?.title ?? null,
      session_window: s ? { starts_at: s.starts_at, ends_at: s.ends_at } : null,
      replica_id: a.replica_id,
      assignee: a.assignee,
      pickup_deadline: a.pickup_deadline,
      state: a.state,
      cancel_reason: a.cancel_reason,
      picked_at: a.picked_at,
      returned_at: a.returned_at,
      replaces: a.replaces,
      created_by: a.created_by,
      created_at: a.created_at,
    };
  };

  const sessionView = (s) => ({
    session_id: s.id,
    title: s.title,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    capacity: s.capacity,
    seats_used: capacityUsed(state, s.id),
    assistance_needs: s.assistance_needs,
    location: s.location,
    early_pickup_minutes: s.early_pickup_minutes,
    cancelled: s.cancelled,
    assignments: [...state.assignments.values()].filter((a) => a.session_id === s.id).map(assignmentView),
  });

  const decisionView = (d) => ({
    device_id: d.device_id,
    event_id: d.event_id,
    replica_id: d.replica_id,
    actor_ref: d.actor_ref,
    kind: d.kind,
    direction: d.direction ?? null,
    verdict: d.verdict,
    anomaly: d.anomaly ?? null,
    assignment_id: d.assignment_id ?? null,
    reasons: d.reasons,
    occurred_at: d.occurred_at,
  });

  // ---------- 鉴权 ----------

  function staffCtx(req) {
    const id = req.headers["x-actor-id"];
    if (!id) throw unauthorized("NO_ACTOR", "缺少 x-actor-id 请求头");
    const s = state.staff.get(id);
    if (!s) throw unauthorized("NO_ACTOR", `人员 ${id} 不在登记册`);
    return s;
  }

  function deviceCtx(req) {
    const id = req.headers["x-device-id"];
    if (!id) throw unauthorized("NO_DEVICE", "缺少 x-device-id 请求头");
    const d = registry.devices[id];
    if (!d) throw unauthorized("NO_DEVICE", `设备 ${id} 未登记`);
    return { id, ...d };
  }

  const requireRole = (ctx, roles) => {
    if (!roles.includes(ctx.role)) {
      throw forbidden("FORBIDDEN", `岗位「${ROLE_NAMES[ctx.role] ?? ctx.role}」无权执行此操作，需要: ${roles.map((r) => ROLE_NAMES[r] ?? r).join("/")}`);
    }
  };

  // ---------- 工具 ----------

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 1_000_000) throw badRequest("BODY_TOO_LARGE", "请求体超过 1MB");
      chunks.push(c);
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw badRequest("BAD_JSON", "请求体不是合法 JSON");
    }
  }

  const requireString = (value, field) => {
    if (typeof value !== "string" || value.trim() === "") throw badRequest("BAD_FIELD", `${field} 必须是非空字符串`);
    return value;
  };

  const requireNumber = (value, field, { min = -Infinity, integer = false } = {}) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
      throw badRequest("BAD_FIELD", `${field} 必须是${integer ? "整数" : "数值"}且 >= ${min}`);
    }
    return value;
  };

  // 命令的发生时间：默认平台当前时间；允许显式传入（用于补录/演练），仍按 occurred_at 参与排序。
  const occurredAt = (body) => (body.occurred_at ? requireIso(body.occurred_at) : nowIso());

  const getReplicaOr404 = (id) => {
    const rep = state.replicas.get(id);
    if (!rep || !rep.known) throw notFound("REPLICA_UNKNOWN", `复刻件 ${id} 未登记`);
    return rep;
  };

  const nextId = (prefix, exists) => {
    let n = 1;
    while (exists(`${prefix}-${String(n).padStart(3, "0")}`)) n += 1;
    return `${prefix}-${String(n).padStart(3, "0")}`;
  };

  // ---------- 路由表 ----------

  const routes = [];
  const add = (method, pattern, handler, opts = {}) => {
    routes.push({ method, segs: pattern.split("/").filter(Boolean), handler, opts });
  };

  add("GET", "/health", async () => ({ status: 200, body: { status: "ok", service: "bronze-touch" } }), { open: true });

  // ----- 复刻件 -----
  add("POST", "/replicas", async (req, ctx) => {
    requireRole(ctx, ["conservator"]);
    const body = await readBody(req);
    const id = body.replica_id !== undefined ? requireString(body.replica_id, "replica_id") : nextId("replica", (x) => state.replicas.has(x));
    if (state.replicas.get(id)?.known) throw conflict("REPLICA_EXISTS", `复刻件 ${id} 已登记`);
    const original_ref = requireString(body.original_ref, "original_ref");
    const name = requireString(body.name, "name");
    const load_limit_kg = requireNumber(body.load_limit_kg, "load_limit_kg", { min: 0.001 });
    const touch_constraints = body.touch_constraints ?? {};
    if (typeof touch_constraints !== "object" || touch_constraints === null || Array.isArray(touch_constraints)) {
      throw badRequest("BAD_FIELD", "touch_constraints 必须是对象，例如 {\"wheelchair\": true}");
    }
    const cooldown_minutes = body.cooldown_minutes ?? 30;
    requireNumber(cooldown_minutes, "cooldown_minutes", { min: 0 });
    record("replica_registered", ctx.id, occurredAt(body), {
      replica_id: id,
      original_ref,
      name,
      load_limit_kg,
      touch_constraints,
      cooldown_minutes,
      home_location: body.home_location ?? null,
    });
    return { status: 201, body: replicaView(state.replicas.get(id)) };
  });

  add("GET", "/replicas", async (req, ctx, params, query) => {
    const list = [...state.replicas.values()].filter((r) => r.known);
    const filtered = query.get("status") ? list.filter((r) => r.status === query.get("status")) : list;
    return { status: 200, body: filtered.map(replicaView) };
  });

  add("GET", "/replicas/:id", async (req, ctx, params) => ({ status: 200, body: replicaView(getReplicaOr404(params.id)) }));

  add("GET", "/replicas/:id/timeline", async (req, ctx, params) => {
    getReplicaOr404(params.id);
    return { status: 200, body: timelineFor(log.events, state, params.id) };
  });

  add("POST", "/replicas/:id/inspections", async (req, ctx, params) => {
    requireRole(ctx, ["conservator"]);
    getReplicaOr404(params.id);
    const body = await readBody(req);
    if (!["pass", "fail"].includes(body.result)) throw badRequest("BAD_FIELD", "result 必须是 pass 或 fail");
    record("inspection_recorded", ctx.id, occurredAt(body), { replica_id: params.id, result: body.result, notes: body.notes ?? null });
    return { status: 201, body: replicaView(state.replicas.get(params.id)) };
  });

  add("POST", "/replicas/:id/cleaning", async (req, ctx, params) => {
    requireRole(ctx, ["cleaner", "conservator"]);
    const rep = getReplicaOr404(params.id);
    const body = await readBody(req);
    const cleanedAt = body.cleaned_at ? requireIso(body.cleaned_at, "cleaned_at") : occurredAt(body);
    const minutes = body.cooldown_minutes ?? rep.profile.cooldown_minutes;
    requireNumber(minutes, "cooldown_minutes", { min: 0 });
    const cooldownUntil = new Date(toMs(cleanedAt) + minutes * 60_000).toISOString();
    record("cleaning_recorded", ctx.id, cleanedAt, { replica_id: params.id, cleaned_at: cleanedAt, cooldown_until: cooldownUntil });
    return { status: 201, body: replicaView(state.replicas.get(params.id)) };
  });

  add("POST", "/replicas/:id/recall", async (req, ctx, params) => {
    requireRole(ctx, ["conservator"]);
    const rep = getReplicaOr404(params.id);
    const body = await readBody(req);
    const reason = requireString(body.reason, "reason");
    if (rep.recall) throw conflict("RECALL_ACTIVE", `复刻件已处于召回中（${rep.recall.at} 由 ${rep.recall.by} 发起）`);
    record("recall_issued", ctx.id, occurredAt(body), { replica_id: params.id, reason });
    return { status: 201, body: replicaView(state.replicas.get(params.id)) };
  });

  add("POST", "/replicas/:id/recall/clear", async (req, ctx, params) => {
    requireRole(ctx, ["conservator"]);
    const rep = getReplicaOr404(params.id);
    const body = await readBody(req);
    if (!rep.recall) throw conflict("NO_ACTIVE_RECALL", "复刻件当前没有生效中的召回");
    record("recall_cleared", ctx.id, occurredAt(body), { replica_id: params.id, notes: body.notes ?? null });
    return { status: 201, body: replicaView(state.replicas.get(params.id)) };
  });

  add("POST", "/replicas/:id/deactivation/clear", async (req, ctx, params) => {
    requireRole(ctx, ["conservator"]);
    const rep = getReplicaOr404(params.id);
    const body = await readBody(req);
    if (!rep.deactivation) throw conflict("NOT_DEACTIVATED", "复刻件当前没有生效中的传感器停用");
    record("deactivation_cleared", ctx.id, occurredAt(body), { replica_id: params.id, notes: body.notes ?? null });
    return { status: 201, body: replicaView(state.replicas.get(params.id)) };
  });

  // ----- 人员 -----
  add("GET", "/staff", async () => ({ status: 200, body: [...state.staff.values()] }));

  add("POST", "/staff", async (req, ctx) => {
    requireRole(ctx, ["supervisor"]);
    const body = await readBody(req);
    const id = requireString(body.staff_id, "staff_id");
    if (state.staff.has(id)) throw conflict("STAFF_EXISTS", `人员 ${id} 已登记`);
    const name = requireString(body.name, "name");
    if (!STAFF_ROLES.includes(body.role)) throw badRequest("BAD_FIELD", `role 必须是 ${STAFF_ROLES.join("/")} 之一`);
    record("staff_registered", ctx.id, occurredAt(body), { staff_id: id, name, role: body.role });
    return { status: 201, body: state.staff.get(id) };
  });

  // ----- 场次 -----
  add("POST", "/sessions", async (req, ctx) => {
    requireRole(ctx, ["supervisor"]);
    const body = await readBody(req);
    const id = body.session_id !== undefined ? requireString(body.session_id, "session_id") : nextId("session", (x) => state.sessions.has(x));
    if (state.sessions.has(id)) throw conflict("SESSION_EXISTS", `场次 ${id} 已存在`);
    const title = requireString(body.title, "title");
    const starts_at = requireIso(body.starts_at, "starts_at");
    const ends_at = requireIso(body.ends_at, "ends_at");
    if (toMs(starts_at) >= toMs(ends_at)) throw badRequest("BAD_FIELD", "starts_at 必须早于 ends_at");
    const capacity = requireNumber(body.capacity, "capacity", { min: 1, integer: true });
    const needs = body.assistance_needs ?? [];
    if (!Array.isArray(needs) || needs.some((n) => typeof n !== "string")) {
      throw badRequest("BAD_FIELD", "assistance_needs 必须是字符串数组");
    }
    const early = body.early_pickup_minutes ?? 15;
    requireNumber(early, "early_pickup_minutes", { min: 0 });
    record("session_scheduled", ctx.id, occurredAt(body), {
      session_id: id,
      title,
      starts_at,
      ends_at,
      capacity,
      assistance_needs: needs,
      location: body.location ?? null,
      early_pickup_minutes: early,
    });
    return { status: 201, body: sessionView(state.sessions.get(id)) };
  });

  add("GET", "/sessions", async () => ({ status: 200, body: [...state.sessions.values()].map(sessionView) }));

  add("POST", "/sessions/:id/cancel", async (req, ctx, params) => {
    requireRole(ctx, ["supervisor"]);
    const s = state.sessions.get(params.id);
    if (!s) throw notFound("SESSION_UNKNOWN", `场次 ${params.id} 不存在`);
    if (s.cancelled) throw conflict("SESSION_CANCELLED", "场次已取消");
    const body = await readBody(req);
    record("session_cancelled", ctx.id, occurredAt(body), { session_id: params.id, reason: body.reason ?? "主管取消" });
    return { status: 201, body: sessionView(state.sessions.get(params.id)) };
  });

  add("POST", "/sessions/:id/assistance", async (req, ctx, params) => {
    requireRole(ctx, ["accessibility", "supervisor"]);
    const s = state.sessions.get(params.id);
    if (!s) throw notFound("SESSION_UNKNOWN", `场次 ${params.id} 不存在`);
    const body = await readBody(req);
    const need = requireString(body.need, "need");
    record("assistance_added", ctx.id, occurredAt(body), { session_id: params.id, need, note: body.note ?? null });
    return { status: 201, body: sessionView(state.sessions.get(params.id)) };
  });

  // ----- 领用安排 -----
  add("POST", "/assignments", async (req, ctx) => {
    requireRole(ctx, ["supervisor"]);
    const body = await readBody(req);
    const sessionId = requireString(body.session_id, "session_id");
    const replicaId = requireString(body.replica_id, "replica_id");
    const assignee = requireString(body.assignee, "assignee");

    const session = state.sessions.get(sessionId);
    const rep = state.replicas.get(replicaId);
    const reasons = [];
    if (!session) {
      reasons.push({ code: "SESSION_UNKNOWN", message: `场次 ${sessionId} 不存在` });
    } else {
      if (session.cancelled) reasons.push({ code: "SESSION_CANCELLED", message: `场次 ${sessionId} 已取消` });
      if (capacityUsed(state, sessionId) >= session.capacity) {
        reasons.push({ code: "CAPACITY_FULL", message: `场次容量 ${session.capacity} 已满`, facts: { capacity: session.capacity } });
      }
    }
    if (!rep?.known) {
      reasons.push({ code: "REPLICA_UNKNOWN", message: `复刻件 ${replicaId} 未登记` });
    } else if (session) {
      if (rep.recall) reasons.push({ code: "RECALLED", message: `复刻件召回中：${rep.recall.reason}`, facts: { recall: rep.recall } });
      if (rep.deactivation) reasons.push({ code: "SENSOR_ANOMALY", message: "复刻件因传感器异常停用中", facts: { deactivation: rep.deactivation } });
      if (rep.cooldown_until && toMs(rep.cooldown_until) > toMs(session.starts_at)) {
        reasons.push({ code: "COOLDOWN_OVERLAP", message: `清洁冷却至 ${rep.cooldown_until}，晚于场次开始 ${session.starts_at}`, facts: { cooldown_until: rep.cooldown_until } });
      }
      const conflictId = replicaDoubleBooked(state, replicaId, session);
      if (conflictId) reasons.push({ code: "REPLICA_DOUBLE_BOOKED", message: `复刻件已排入时间重叠的领用单 ${conflictId}`, facts: { conflicting_assignment: conflictId } });
      const missing = session.assistance_needs.filter((n) => !rep.profile.touch_constraints?.[n]);
      if (missing.length > 0) reasons.push({ code: "NEEDS_NOT_MET", message: `复刻件可触限制不满足观众辅助需求: ${missing.join(", ")}`, facts: { missing } });
    }
    if (!state.staff.has(assignee)) reasons.push({ code: "ASSIGNEE_UNKNOWN", message: `领用人 ${assignee} 不在人员登记册` });

    if (reasons.length > 0) {
      // 拒绝也留痕，主管可据此解释每一次拒绝
      record("command_rejected", ctx.id, nowIso(), {
        command: "assignment_created",
        reasons,
        request: { session_id: sessionId, replica_id: replicaId, assignee },
      });
      throw unprocessable("ASSIGNMENT_REJECTED", "领用安排被拒绝", { reasons });
    }

    let replaces = null;
    if (body.replaces) {
      const old = state.assignments.get(body.replaces);
      if (!old) throw notFound("ASSIGNMENT_UNKNOWN", `被改派的领用单 ${body.replaces} 不存在`);
      if (old.state !== "planned") throw conflict("ASSIGNMENT_NOT_PLANNED", `领用单 ${body.replaces} 当前状态 ${old.state}，不能改派`);
      replaces = old.id;
    }

    const id = body.assignment_id !== undefined ? requireString(body.assignment_id, "assignment_id") : nextId("asg", (x) => state.assignments.has(x));
    if (state.assignments.has(id)) throw conflict("ASSIGNMENT_EXISTS", `领用单 ${id} 已存在`);
    const pickupDeadline = body.pickup_deadline ? requireIso(body.pickup_deadline, "pickup_deadline") : session.ends_at;
    if (replaces) {
      record("assignment_cancelled", ctx.id, occurredAt(body), { assignment_id: replaces, reason: `改派为 ${id}`, replica_id: replicaId });
    }
    record("assignment_created", ctx.id, occurredAt(body), {
      assignment_id: id,
      session_id: sessionId,
      replica_id: replicaId,
      assignee,
      pickup_deadline: pickupDeadline,
      replaces,
    });
    return { status: 201, body: assignmentView(state.assignments.get(id)) };
  });

  add("GET", "/assignments", async (req, ctx, params, query) => {
    let list = [...state.assignments.values()];
    for (const key of ["session_id", "replica_id", "assignee", "state"]) {
      if (query.get(key)) list = list.filter((a) => String(a[key]) === query.get(key));
    }
    return { status: 200, body: list.map(assignmentView) };
  });

  add("POST", "/assignments/:id/cancel", async (req, ctx, params) => {
    requireRole(ctx, ["supervisor"]);
    const a = state.assignments.get(params.id);
    if (!a) throw notFound("ASSIGNMENT_UNKNOWN", `领用单 ${params.id} 不存在`);
    if (a.state !== "planned") throw conflict("ASSIGNMENT_NOT_PLANNED", `领用单当前状态 ${a.state}，仅待领状态可取消`);
    const body = await readBody(req);
    record("assignment_cancelled", ctx.id, occurredAt(body), { assignment_id: a.id, reason: body.reason ?? "主管取消", replica_id: a.replica_id });
    return { status: 200, body: assignmentView(state.assignments.get(a.id)) };
  });

  add("POST", "/assignments/:id/adjust", async (req, ctx, params) => {
    requireRole(ctx, ["supervisor"]);
    const a = state.assignments.get(params.id);
    if (!a) throw notFound("ASSIGNMENT_UNKNOWN", `领用单 ${params.id} 不存在`);
    if (a.state !== "planned") throw conflict("ASSIGNMENT_NOT_PLANNED", `领用单当前状态 ${a.state}，仅待领状态可调整`);
    const body = await readBody(req);
    const deadline = requireIso(body.pickup_deadline, "pickup_deadline");
    record("assignment_adjusted", ctx.id, occurredAt(body), { assignment_id: a.id, pickup_deadline: deadline, replica_id: a.replica_id });
    return { status: 200, body: assignmentView(state.assignments.get(a.id)) };
  });

  // ----- 临时闭馆 -----
  add("POST", "/closures", async (req, ctx) => {
    requireRole(ctx, ["supervisor"]);
    const body = await readBody(req);
    const starts_at = requireIso(body.starts_at, "starts_at");
    const ends_at = requireIso(body.ends_at, "ends_at");
    if (toMs(starts_at) >= toMs(ends_at)) throw badRequest("BAD_FIELD", "starts_at 必须早于 ends_at");
    const reason = requireString(body.reason, "reason");
    const id = body.closure_id !== undefined ? requireString(body.closure_id, "closure_id") : nextId("closure", (x) => state.closures.some((c) => c.id === x));
    record("closure_declared", ctx.id, occurredAt(body), { closure_id: id, starts_at, ends_at, reason });
    return { status: 201, body: state.closures.find((c) => c.id === id) };
  });

  add("GET", "/closures", async () => ({ status: 200, body: state.closures }));

  add("POST", "/closures/:id/lift", async (req, ctx, params) => {
    requireRole(ctx, ["supervisor"]);
    const c = state.closures.find((x) => x.id === params.id);
    if (!c) throw notFound("CLOSURE_UNKNOWN", `闭馆记录 ${params.id} 不存在`);
    if (c.lifted_at) throw conflict("CLOSURE_LIFTED", "闭馆已提前解除");
    const body = await readBody(req);
    record("closure_lifted", ctx.id, occurredAt(body), { closure_id: c.id });
    return { status: 200, body: state.closures.find((x) => x.id === c.id) };
  });

  // ----- 判定与冲突（主管/保管员可查，用于解释拒绝与改派依据） -----
  add("GET", "/decisions", async (req, ctx, params, query) => {
    requireRole(ctx, ["supervisor", "conservator"]);
    let list = [...state.decisions.values()];
    if (query.get("replica_id")) list = list.filter((d) => d.replica_id === query.get("replica_id"));
    if (query.get("verdict")) list = list.filter((d) => d.verdict === query.get("verdict"));
    if (query.get("device_id")) list = list.filter((d) => d.device_id === query.get("device_id"));
    list.sort((a, b) => toMs(a.occurred_at) - toMs(b.occurred_at));
    return {
      status: 200,
      body: {
        device_decisions: list.map(decisionView),
        rejected_commands: state.rejectedCommands,
      },
    };
  });

  add("GET", "/conflicts", async (req, ctx) => {
    requireRole(ctx, ["supervisor"]);
    return { status: 200, body: state.conflicts };
  });

  add("POST", "/conflicts/:id/ack", async (req, ctx, params) => {
    requireRole(ctx, ["supervisor"]);
    if (!state.conflicts.some((c) => c.id === params.id)) throw notFound("CONFLICT_UNKNOWN", `冲突 ${params.id} 不存在`);
    record("conflict_acknowledged", ctx.id, nowIso(), { conflict_id: params.id });
    return { status: 200, body: state.conflicts.find((c) => c.id === params.id) ?? { id: params.id, acknowledged: true } };
  });

  // ----- 现场总览 -----
  add("GET", "/board", async () => ({
    status: 200,
    body: {
      now: nowIso(),
      replicas: [...state.replicas.values()].filter((r) => r.known).map(replicaView),
      sessions: [...state.sessions.values()].map(sessionView),
      closures: state.closures,
      conflicts_open: state.conflicts.filter((c) => !c.acknowledged).length,
    },
  }));

  // ----- 设备事件接入（扫码终端 / 承重传感器） -----
  add("POST", "/devices/events", async (req, ctx, params, query, dev) => {
    const body = await readBody(req);
    const items = Array.isArray(body) ? body : Array.isArray(body.events) ? body.events : [body];
    if (items.length === 0 || items.some((e) => typeof e !== "object" || e === null)) {
      throw badRequest("BAD_BATCH", "请求体必须是设备事件对象、数组或 {events: [...]}");
    }
    const results = items.map((raw) => ingestDeviceEvent(raw, dev));
    return { status: 200, body: { results } };
  }, { device: true });

  add("GET", "/devices/events/:eventId", async (req, ctx, params, query, dev) => {
    const d = state.decisions.get(`${dev.id}/${params.eventId}`);
    if (!d) throw notFound("EVENT_UNKNOWN", `设备 ${dev.id} 未上报过事件 ${params.eventId}`);
    return { status: 200, body: decisionView(d) };
  }, { device: true });

  function ingestDeviceEvent(raw, dev) {
    // 形状校验：不合格负载直接报错，不入日志
    const shapeError = (code, message) => ({ event_id: raw?.event_id ?? null, error: { code, message } });
    if (typeof raw.event_id !== "string" || raw.event_id === "") return shapeError("BAD_FIELD", "event_id 缺失");
    if (raw.device_id !== dev.id) return shapeError("DEVICE_MISMATCH", `事件 device_id ${raw.device_id} 与终端身份 ${dev.id} 不符`);
    if (!DEVICE_KINDS.has(raw.kind)) return shapeError("BAD_KIND", `kind 必须是 ${[...DEVICE_KINDS].join("/")} 之一`);
    if (!dev.kinds.includes(raw.kind)) return shapeError("KIND_FORBIDDEN", `设备 ${dev.id}（${dev.type}）不允许上报 ${raw.kind}`);
    if (typeof raw.replica_id !== "string" || raw.replica_id === "") return shapeError("BAD_FIELD", "replica_id 缺失");
    try {
      requireIso(raw.occurred_at);
    } catch (err) {
      return shapeError(err.code, err.message);
    }
    if (raw.kind === "handover_scan" && raw.direction !== undefined && !DIRECTIONS.has(raw.direction)) {
      return shapeError("BAD_FIELD", "direction 必须是 out 或 in");
    }

    const key = `${raw.device_id}/${raw.event_id}`;
    const existing = state.decisions.get(key);
    if (existing) {
      // 重复扫码/断网重传：幂等返回既有判定，不产生新事实；
      // 若同一 event_id 带来不同负载（终端异常），原判定不变但显式提示。
      const logged = log.events.find(
        (e) => e.type === "device_event" && e.payload.device_id === raw.device_id && e.payload.event_id === raw.event_id,
      );
      const mismatch = logged && JSON.stringify(logged.payload.raw) !== JSON.stringify(raw);
      return { event_id: raw.event_id, duplicate: true, ...(mismatch ? { payload_mismatch: true } : {}), ...decisionView(existing) };
    }

    record("device_event", `device:${raw.device_id}`, raw.occurred_at, {
      device_id: raw.device_id,
      event_id: raw.event_id,
      kind: raw.kind,
      replica_id: raw.replica_id,
      actor_ref: raw.actor_ref ?? null,
      direction: raw.direction ?? null,
      location: raw.location ?? null,
      assignment_id: raw.assignment_id ?? null,
      value: raw.value ?? null,
      unit: raw.unit ?? null,
      received_at: nowIso(), // 平台接收时间，与设备 occurred_at 各自独立
      client_received_at: raw.received_at ?? null, // 设备侧带来的 received_at 原样保留
      raw, // 原始负载逐字留档，永不覆盖
    });
    const d = state.decisions.get(key);
    return { event_id: raw.event_id, duplicate: false, ...decisionView(d) };
  }

  // ---------- 分发 ----------

  return http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const pathSegs = url.pathname.split("/").filter(Boolean);
      const route = routes.find(
        (r) =>
          r.method === req.method &&
          r.segs.length === pathSegs.length &&
          r.segs.every((s, i) => s.startsWith(":") || s === pathSegs[i]),
      );
      if (!route) {
        send(404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
        return;
      }
      const params = {};
      route.segs.forEach((s, i) => {
        if (s.startsWith(":")) params[s.slice(1)] = decodeURIComponent(pathSegs[i]);
      });
      let ctx = null;
      let dev = null;
      if (!route.opts.open) {
        if (route.opts.device) dev = deviceCtx(req);
        else ctx = staffCtx(req);
      }
      const result = await route.handler(req, ctx, params, url.searchParams, dev);
      send(result.status, result.body);
    } catch (err) {
      if (err instanceof ApiError) {
        send(err.status, { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(err?.message ?? err) } });
      }
    }
  });
}
