// 领域折叠：把只追加事件日志折成当前状态。
//
// 确定性约定：
//  - 所有事件按 (occurred_at, seq) 排序后依次应用；occurred_at 相同则按落盘序号。
//  - 设备事件的判定（accepted / rejected / pending）是日志的纯函数，
//    离线补传到达后整体重放，即按“事件实际发生顺序”消除冲突。
//  - `now` 只影响展示性派生（当前状态名、逾期提示），不影响任何事件判定。
import { toMs } from "./time.mjs";

// 清洁组/保管员/主管可代持有人扫码归还。
const RETURN_STAFF_ROLES = new Set(["cleaner", "conservator", "supervisor"]);

export function compareEvents(a, b) {
  const diff = toMs(a.occurred_at) - toMs(b.occurred_at);
  return diff !== 0 ? diff : a.seq - b.seq;
}

function profileFrom(event) {
  const p = event.payload;
  return {
    replica_id: p.replica_id,
    original_ref: p.original_ref,
    name: p.name,
    load_limit_kg: p.load_limit_kg,
    touch_constraints: p.touch_constraints ?? {},
    cooldown_minutes: p.cooldown_minutes ?? 30,
    home_location: p.home_location ?? null,
  };
}

function blankReplica(id, profile) {
  return {
    id,
    known: Boolean(profile), // 登记事件确立“存在”，档案属性对全时间线可见（补传可能早于登记到达）
    profile: profile ?? null,
    registered_at: null,
    needs_inspection: true, // 登记后、每次归还后都需检查，未检查不得放行
    inspection: null,
    recall: null, // { by, reason, at } 召回生效中
    deactivation: null, // { by, reason, value, limit, at } 传感器异常停用中
    cooldown_until: null, // 清洁冷却截止
    holder: null, // { actor, actor_name, since, assignment_id, device_id, location }
    last_reading: null,
    status: "unknown",
  };
}

function ensureReplica(state, id) {
  let rep = state.replicas.get(id);
  if (!rep) {
    rep = blankReplica(id, state.profiles.get(id));
    state.replicas.set(id, rep);
  }
  return rep;
}

export function foldEvents(events, { now, registry }) {
  const sorted = [...events].sort(compareEvents);
  const state = {
    profiles: new Map(),
    replicas: new Map(),
    sessions: new Map(),
    assignments: new Map(),
    closures: [],
    decisions: new Map(), // "device_id/event_id" -> 判定
    decisionChanges: [],
    rejectedCommands: [],
    ackedConflicts: new Set(),
    conflicts: [],
    staff: new Map(Object.entries(registry.staff).map(([id, s]) => [id, { id, ...s, source: "seed" }])),
  };
  // 预扫描登记事件：复刻件一经登记即视为“一直存在”，
  // 这样离线补传的早期扫码能在登记后得到确定判定，而不是永远挂起。
  for (const e of sorted) {
    if (e.type === "replica_registered" && !state.profiles.has(e.payload.replica_id)) {
      state.profiles.set(e.payload.replica_id, profileFrom(e));
    }
  }
  for (const e of sorted) applyEvent(state, e, registry);
  finalize(state, now);
  return state;
}

function applyEvent(state, e, registry) {
  const p = e.payload ?? {};
  switch (e.type) {
    case "staff_registered": {
      if (!state.staff.has(p.staff_id)) {
        state.staff.set(p.staff_id, { id: p.staff_id, name: p.name, role: p.role, source: "event" });
      }
      break;
    }
    case "replica_registered": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.registered_at) rep.registered_at = e.occurred_at;
      break;
    }
    case "inspection_recorded": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.known) break;
      rep.inspection = { result: p.result, notes: p.notes ?? null, by: e.actor, at: e.occurred_at };
      rep.needs_inspection = p.result !== "pass";
      break;
    }
    case "cleaning_recorded": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.known) break;
      rep.cooldown_until = p.cooldown_until;
      break;
    }
    case "recall_issued": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.known || rep.recall) break; // 已有生效召回时保留最早一条
      rep.recall = { by: e.actor, reason: p.reason, at: e.occurred_at };
      break;
    }
    case "recall_cleared": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.known) break;
      rep.recall = null;
      // 解除召回必须随附检查通过，否则不得再次放行
      rep.needs_inspection = false;
      rep.inspection = { result: "pass", notes: p.notes ?? "召回解除，随附检查通过", by: e.actor, at: e.occurred_at };
      break;
    }
    case "deactivation_cleared": {
      const rep = ensureReplica(state, p.replica_id);
      if (!rep.known) break;
      rep.deactivation = null;
      break;
    }
    case "session_scheduled": {
      if (state.sessions.has(p.session_id)) break;
      state.sessions.set(p.session_id, {
        id: p.session_id,
        title: p.title,
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        capacity: p.capacity,
        assistance_needs: [...(p.assistance_needs ?? [])],
        location: p.location ?? null,
        early_pickup_minutes: p.early_pickup_minutes ?? 15,
        cancelled: null,
        seq: e.seq,
      });
      break;
    }
    case "session_cancelled": {
      const s = state.sessions.get(p.session_id);
      if (s && !s.cancelled) s.cancelled = { at: e.occurred_at, reason: p.reason ?? null, by: e.actor };
      break;
    }
    case "assistance_added": {
      const s = state.sessions.get(p.session_id);
      if (s && !s.assistance_needs.includes(p.need)) s.assistance_needs.push(p.need);
      break;
    }
    case "assignment_created":
      applyAssignmentCreated(state, e);
      break;
    case "assignment_cancelled": {
      const a = state.assignments.get(p.assignment_id);
      if (a && a.state === "planned") {
        a.state = "cancelled";
        a.cancel_reason = { code: "CANCELLED", message: p.reason ?? "主管取消", by: e.actor, at: e.occurred_at };
      }
      break;
    }
    case "assignment_adjusted": {
      const a = state.assignments.get(p.assignment_id);
      if (a && a.state === "planned") a.pickup_deadline = p.pickup_deadline;
      break;
    }
    case "closure_declared": {
      state.closures.push({
        id: p.closure_id,
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        reason: p.reason,
        lifted_at: null,
        by: e.actor,
        declared_at: e.occurred_at,
      });
      break;
    }
    case "closure_lifted": {
      const c = state.closures.find((x) => x.id === p.closure_id);
      if (c && !c.lifted_at) c.lifted_at = e.occurred_at;
      break;
    }
    case "device_event":
      applyDeviceEvent(state, e, registry);
      break;
    case "decision_changed":
      state.decisionChanges.push({ seq: e.seq, at: e.occurred_at, ...p });
      break;
    case "conflict_acknowledged":
      state.ackedConflicts.add(p.conflict_id);
      break;
    case "command_rejected":
      state.rejectedCommands.push({ seq: e.seq, at: e.occurred_at, actor: e.actor, ...p });
      break;
    default:
      break; // 未知类型不影响状态，但仍在日志中留痕
  }
}

function applyAssignmentCreated(state, e) {
  const p = e.payload;
  if (state.assignments.has(p.assignment_id)) return;
  const a = {
    id: p.assignment_id,
    session_id: p.session_id,
    replica_id: p.replica_id,
    assignee: p.assignee,
    pickup_deadline: p.pickup_deadline,
    replaces: p.replaces ?? null,
    state: "planned",
    cancel_reason: null,
    picked_at: null,
    returned_at: null,
    created_by: e.actor,
    created_at: e.occurred_at,
    seq: e.seq,
  };
  // 折叠期兜底校验：命令可能携带过去的发生时间，与先发生的事实冲突时确定性作废。
  const session = state.sessions.get(p.session_id);
  const code = !session
    ? "SESSION_UNKNOWN"
    : session.cancelled
      ? "SESSION_CANCELLED"
      : capacityUsed(state, p.session_id) >= session.capacity
        ? "CAPACITY_FULL"
        : replicaDoubleBooked(state, p.replica_id, session, p.assignment_id)
          ? "REPLICA_DOUBLE_BOOKED"
          : null;
  if (code) {
    a.state = "cancelled";
    a.cancel_reason = { code, message: `折叠校验未通过: ${code}`, by: "system", at: e.occurred_at };
  }
  state.assignments.set(p.assignment_id, a);
}

export function capacityUsed(state, sessionId) {
  let n = 0;
  for (const a of state.assignments.values()) {
    if (a.session_id === sessionId && (a.state === "planned" || a.state === "active")) n += 1;
  }
  return n;
}

export function sessionsOverlap(a, b) {
  return toMs(a.starts_at) < toMs(b.ends_at) && toMs(b.starts_at) < toMs(a.ends_at);
}

export function replicaDoubleBooked(state, replicaId, session, excludeId = null) {
  for (const a of state.assignments.values()) {
    if (a.replica_id !== replicaId || a.id === excludeId) continue;
    if (a.state !== "planned" && a.state !== "active") continue;
    const other = state.sessions.get(a.session_id);
    if (other && sessionsOverlap(other, session)) return a.id;
  }
  return null;
}

// 放行门禁：任一项命中即拒绝扫码领用。返回理由列表（含事实依据，供主管解释）。
export function releaseBlockers(rep, tMs, closures) {
  const reasons = [];
  if (rep.recall) {
    reasons.push({
      code: "RECALLED",
      message: `复刻件已于 ${rep.recall.at} 被 ${rep.recall.by} 紧急召回：${rep.recall.reason}`,
      facts: { recall: rep.recall },
    });
  }
  if (rep.deactivation) {
    reasons.push({
      code: "SENSOR_ANOMALY",
      message: `承重传感器读数 ${rep.deactivation.value}kg 超出上限 ${rep.deactivation.limit}kg，已停用待保管员复核`,
      facts: { deactivation: rep.deactivation },
    });
  }
  if (rep.needs_inspection) {
    reasons.push({ code: "INSPECTION_PENDING", message: "复刻件尚未完成放行检查，不得放行" });
  }
  if (rep.cooldown_until && toMs(rep.cooldown_until) > tMs) {
    reasons.push({
      code: "COOLDOWN",
      message: `清洁冷却中，${rep.cooldown_until} 后方可领用`,
      facts: { cooldown_until: rep.cooldown_until },
    });
  }
  if (rep.holder) {
    reasons.push({
      code: "OCCUPIED",
      message: `复刻件正由 ${rep.holder.actor_name ?? rep.holder.actor} 持有（${rep.holder.since} 起），同一时刻只能有一个有效占用者`,
      facts: { holder: rep.holder },
    });
  }
  const closed = closures.find((c) => toMs(c.starts_at) <= tMs && tMs < toMs(c.lifted_at ?? c.ends_at));
  if (closed) {
    reasons.push({
      code: "CLOSED",
      message: `临时闭馆 ${closed.starts_at} 至 ${closed.lifted_at ?? closed.ends_at}：${closed.reason}`,
      facts: { closure: closed },
    });
  }
  return reasons;
}

function applyDeviceEvent(state, e, registry) {
  const p = e.payload;
  const key = `${p.device_id}/${p.event_id}`;
  const rep = ensureReplica(state, p.replica_id);
  let decision;
  if (!rep.known) {
    decision = {
      verdict: "pending",
      kind: p.kind,
      reasons: [{ code: "REPLICA_UNKNOWN", message: `复刻件 ${p.replica_id} 尚未登记，事件挂起等待登记后重判` }],
    };
  } else if (p.kind === "handover_scan") {
    decision = decideHandover(state, rep, e, registry);
  } else if (p.kind === "load_reading") {
    decision = decideReading(rep, e);
  } else {
    decision = { verdict: "rejected", kind: p.kind, reasons: [{ code: "BAD_KIND", message: `未知事件类型 ${p.kind}` }] };
  }
  decision.device_id = p.device_id;
  decision.event_id = p.event_id;
  decision.replica_id = p.replica_id;
  decision.actor_ref = p.actor_ref ?? null;
  decision.occurred_at = e.occurred_at;
  state.decisions.set(key, decision);
}

function decideHandover(state, rep, e, registry) {
  const p = e.payload;
  const staff = p.actor_ref ? state.staff.get(p.actor_ref) : null;
  if (!staff) {
    return {
      verdict: "pending",
      kind: p.kind,
      reasons: [{ code: "ACTOR_UNKNOWN", message: `人员 ${p.actor_ref ?? "(缺失)"} 不在人员登记册，事件挂起等待登记后重判` }],
    };
  }
  // 未显式给出方向时：持有人再次扫码视为归还，其余视为领用。终端应尽量显式传 direction。
  const direction = p.direction ?? (rep.holder && rep.holder.actor === p.actor_ref ? "in" : "out");
  return direction === "in" ? decideReturn(state, rep, e, staff) : decideCheckout(state, rep, e, staff, registry);
}

function decideCheckout(state, rep, e, staff, registry) {
  const p = e.payload;
  const t = toMs(e.occurred_at);
  const reasons = releaseBlockers(rep, t, state.closures);

  let assignment = null;
  if (p.assignment_id) {
    const a = state.assignments.get(p.assignment_id);
    if (!a || a.replica_id !== rep.id || a.assignee !== p.actor_ref || a.state !== "planned") {
      reasons.push({ code: "NO_ASSIGNMENT", message: `指定领用单 ${p.assignment_id} 不存在、不属于该人员或已不在待领状态` });
    } else {
      assignment = a;
    }
  } else {
    const candidates = [...state.assignments.values()]
      .filter((a) => a.replica_id === rep.id && a.assignee === p.actor_ref && a.state === "planned")
      .sort((x, y) => x.seq - y.seq);
    if (candidates.length === 0) {
      reasons.push({ code: "NO_ASSIGNMENT", message: `${staff.name} 没有该复刻件的待领领用单` });
    } else {
      assignment = candidates[0];
    }
  }

  if (assignment) {
    const session = state.sessions.get(assignment.session_id);
    if (session?.cancelled) {
      reasons.push({ code: "SESSION_CANCELLED", message: `场次 ${session.id} 已取消：${session.cancelled.reason ?? "未说明"}` });
    } else if (session && t < toMs(session.starts_at) - session.early_pickup_minutes * 60_000) {
      reasons.push({
        code: "TOO_EARLY",
        message: `场次 ${session.id} ${session.starts_at} 才开始，最早提前 ${session.early_pickup_minutes} 分钟领用`,
        facts: { starts_at: session.starts_at },
      });
    }
    if (t > toMs(assignment.pickup_deadline)) {
      reasons.push({
        code: "LATE",
        message: `超过领用截止 ${assignment.pickup_deadline}，按迟到拒绝`,
        facts: { pickup_deadline: assignment.pickup_deadline },
      });
    }
  }

  if (reasons.length > 0) return { verdict: "rejected", kind: p.kind, direction: "out", reasons };

  const device = registry.devices[p.device_id];
  rep.holder = {
    actor: p.actor_ref,
    actor_name: staff.name,
    since: e.occurred_at,
    assignment_id: assignment.id,
    device_id: p.device_id,
    location: p.location ?? device?.location ?? null,
  };
  assignment.state = "active";
  assignment.picked_at = e.occurred_at;
  return { verdict: "accepted", kind: p.kind, direction: "out", assignment_id: assignment.id, reasons: [] };
}

function decideReturn(state, rep, e, staff) {
  const p = e.payload;
  const reasons = [];
  if (!rep.holder) {
    reasons.push({ code: "NO_ACTIVE_LOAN", message: "复刻件当前没有在途领用，无法归还" });
  } else if (rep.holder.actor !== p.actor_ref && !RETURN_STAFF_ROLES.has(staff.role)) {
    reasons.push({
      code: "NOT_HOLDER",
      message: `当前持有人是 ${rep.holder.actor_name ?? rep.holder.actor}，${staff.name} 无权代为归还`,
      facts: { holder: rep.holder },
    });
  }
  if (reasons.length > 0) return { verdict: "rejected", kind: p.kind, direction: "in", reasons };

  const holder = rep.holder;
  rep.holder = null;
  rep.needs_inspection = true; // 归还后必须重新检查才能再次放行
  const a = holder.assignment_id ? state.assignments.get(holder.assignment_id) : null;
  if (a && a.state === "active") {
    a.state = "returned";
    a.returned_at = e.occurred_at;
  }
  return { verdict: "accepted", kind: p.kind, direction: "in", assignment_id: a?.id ?? null, reasons: [] };
}

function decideReading(rep, e) {
  const p = e.payload;
  if (p.unit !== "kg") {
    return { verdict: "rejected", kind: p.kind, reasons: [{ code: "BAD_UNIT", message: `承重读数单位必须是 kg，收到 ${p.unit}` }] };
  }
  if (typeof p.value !== "number" || !Number.isFinite(p.value) || p.value < 0) {
    return { verdict: "rejected", kind: p.kind, reasons: [{ code: "BAD_VALUE", message: `承重读数不是合法数值: ${p.value}` }] };
  }
  rep.last_reading = { value: p.value, unit: p.unit, at: e.occurred_at, device_id: p.device_id };
  const limit = rep.profile?.load_limit_kg ?? null;
  let anomaly = false;
  if (limit != null && p.value > limit) {
    // 超限即停用，保持到保管员人工解除；后续合格读数不会自动覆盖该决定
    rep.deactivation = { at: e.occurred_at, by: p.device_id, reason: "LOAD_EXCEEDED", value: p.value, limit };
    anomaly = true;
  }
  return { verdict: "accepted", kind: p.kind, anomaly, limit, reasons: [] };
}

function finalize(state, nowMs) {
  for (const rep of state.replicas.values()) {
    rep.status = !rep.known
      ? "unknown"
      : rep.recall
        ? "recalled"
        : rep.deactivation
          ? "deactivated"
          : rep.holder
            ? "checked_out"
            : rep.cooldown_until && toMs(rep.cooldown_until) > nowMs
              ? "cooldown"
              : rep.needs_inspection
                ? "pending_inspection"
                : "available";
  }

  const conflicts = [];
  for (const dc of state.decisionChanges) {
    conflicts.push({
      id: `dc-${dc.seq}`,
      type: "decision_reversed",
      device_id: dc.device_id,
      event_id: dc.event_id,
      replica_id: dc.replica_id,
      from: dc.from,
      to: dc.to,
      at: dc.at,
      cause: dc.cause ?? null,
    });
  }
  for (const d of state.decisions.values()) {
    if (d.verdict === "pending") {
      conflicts.push({
        id: `pending-${d.device_id}-${d.event_id}`,
        type: "pending_event",
        device_id: d.device_id,
        event_id: d.event_id,
        replica_id: d.replica_id,
        reasons: d.reasons,
      });
    }
  }
  for (const rep of state.replicas.values()) {
    if (rep.known && rep.recall && rep.holder) {
      conflicts.push({
        id: `recall-${rep.id}`,
        type: "recall_outstanding",
        replica_id: rep.id,
        holder: rep.holder,
        recall: rep.recall,
      });
    }
  }
  for (const a of state.assignments.values()) {
    if (a.state !== "active") continue;
    const s = state.sessions.get(a.session_id);
    if (s && toMs(s.ends_at) < nowMs) {
      conflicts.push({ id: `overdue-${a.id}`, type: "return_overdue", assignment_id: a.id, replica_id: a.replica_id, assignee: a.assignee, session_ends_at: s.ends_at });
    }
  }
  for (const c of conflicts) c.acknowledged = state.ackedConflicts.has(c.id);
  state.conflicts = conflicts;
}

// 复刻件时间线：每条事实 + 设备事件对应的判定，按 (occurred_at, seq) 排序。
export function timelineFor(events, state, replicaId) {
  const sorted = [...events].sort(compareEvents);
  const entries = [];
  for (const e of sorted) {
    const p = e.payload ?? {};
    if (p.replica_id !== replicaId) continue;
    const key = e.type === "device_event" ? `${p.device_id}/${p.event_id}` : null;
    entries.push({
      seq: e.seq,
      type: e.type,
      occurred_at: e.occurred_at,
      recorded_at: e.recorded_at,
      actor: e.actor,
      summary: summarize(e, state),
      decision: key ? (state.decisions.get(key) ?? null) : null,
      payload: p, // 原始负载（含设备读数）原样呈现，不可被事后覆盖
    });
  }
  return entries;
}

function summarize(e, state) {
  const p = e.payload ?? {};
  switch (e.type) {
    case "replica_registered":
      return `登记复刻件，关联原件 ${p.original_ref}，承重上限 ${p.load_limit_kg}kg`;
    case "inspection_recorded":
      return `放行检查${p.result === "pass" ? "通过" : "未通过"}${p.notes ? `：${p.notes}` : ""}`;
    case "cleaning_recorded":
      return `完成消毒清洁，冷却至 ${p.cooldown_until}`;
    case "recall_issued":
      return `保管员紧急召回：${p.reason}`;
    case "recall_cleared":
      return `召回解除（随附检查通过）`;
    case "deactivation_cleared":
      return `传感器停用解除`;
    case "assignment_created":
      return `安排领用单 ${p.assignment_id}（场次 ${p.session_id}，领用人 ${p.assignee}）`;
    case "assignment_cancelled":
      return `领用单 ${p.assignment_id} 取消：${p.reason ?? "未说明"}`;
    case "assignment_adjusted":
      return `领用单 ${p.assignment_id} 领用截止调整为 ${p.pickup_deadline}`;
    case "device_event": {
      const d = state.decisions.get(`${p.device_id}/${p.event_id}`);
      if (p.kind === "load_reading") {
        return `承重读数 ${p.value}${p.unit}${d?.anomaly ? "，超限触发停用" : ""}`;
      }
      const dir = d?.direction === "in" ? "归还" : "领用";
      const verdict = d?.verdict === "accepted" ? "成功" : d?.verdict === "pending" ? "挂起" : "被拒";
      return `扫码${dir}${verdict}（${p.actor_ref} @ ${p.device_id}）`;
    }
    case "decision_changed":
      return `补传重放后判定反转：${p.device_id}/${p.event_id} 由 ${p.from} 变为 ${p.to}`;
    default:
      return e.type;
  }
}
