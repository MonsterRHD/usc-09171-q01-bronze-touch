// HTTP 处理函数：每个 handler 接收 ctx = { body, params, query, store, principal, config }，
// 返回 { status, body }。业务上的拒绝（如预约被拒）不是 HTTP 错误，
// 统一以 200 + decision.result 返回确定结果；只有请求本身非法才返回 4xx。

import { newPlatformId } from "../domain/events.mjs";
import { isValidIso } from "../domain/time.mjs";

function invalid(message, fields) {
  return { status: 400, body: { error: "invalid_request", message, ...(fields ? { fields } : {}) } };
}

function notFound(message) {
  return { status: 404, body: { error: "not_found", message } };
}

function conflict(code, message) {
  return { status: 409, body: { error: code, message } };
}

function ok(body, status = 200) {
  return { status, body };
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------- 复刻件 ----------

export async function registerReplica(ctx) {
  const { body, store, principal } = ctx;
  const replicaId = asString(body?.replica_id);
  if (!replicaId) return invalid("replica_id 必填");
  if (body?.load_limit_kg !== undefined && (typeof body.load_limit_kg !== "number" || !(body.load_limit_kg > 0))) {
    return invalid("load_limit_kg 必须是正数");
  }
  if (body?.touch_restrictions !== undefined && !Array.isArray(body.touch_restrictions)) {
    return invalid("touch_restrictions 必须是数组");
  }
  if (body?.cooldown_minutes !== undefined && (typeof body.cooldown_minutes !== "number" || body.cooldown_minutes < 0)) {
    return invalid("cooldown_minutes 必须是非负数");
  }
  await store.command("replica_registered", {
    replica_id: replicaId,
    payload: {
      artifact_ref: asString(body?.artifact_ref),
      load_limit_kg: body?.load_limit_kg ?? null,
      touch_restrictions: body?.touch_restrictions ?? [],
      cooldown_minutes: body?.cooldown_minutes,
    },
  }, principal.ref);
  return ok({ replica: store.state.replicas[replicaId] }, 201);
}

export async function listReplicas(ctx) {
  return ok({ replicas: Object.values(ctx.store.state.replicas) });
}

export async function getReplica(ctx) {
  const replica = ctx.store.state.replicas[ctx.params.id];
  if (!replica) return notFound(`复刻件不存在: ${ctx.params.id}`);
  return ok({ replica });
}

export async function getReplicaTimeline(ctx) {
  const replica = ctx.store.state.replicas[ctx.params.id];
  if (!replica) return notFound(`复刻件不存在: ${ctx.params.id}`);
  return ok({ replica_id: ctx.params.id, timeline: ctx.store.state.timelines[ctx.params.id] ?? [] });
}

export async function recallReplica(ctx) {
  const { store, principal, params, body } = ctx;
  if (!store.state.replicas[params.id]) return notFound(`复刻件不存在: ${params.id}`);
  const { decisions } = await store.command("recall_issued", {
    replica_id: params.id,
    payload: { reason: asString(body?.reason) },
  }, principal.ref);
  return ok({ decisions, replica: store.state.replicas[params.id] });
}

export async function inspectReplica(ctx) {
  const { store, principal, params, body } = ctx;
  if (!store.state.replicas[params.id]) return notFound(`复刻件不存在: ${params.id}`);
  if (body?.result !== "passed" && body?.result !== "failed") return invalid("result 必须是 passed 或 failed");
  const { decisions } = await store.command("inspection_recorded", {
    replica_id: params.id,
    payload: { result: body.result, notes: asString(body?.notes) },
  }, principal.ref);
  return ok({ decisions, replica: store.state.replicas[params.id] });
}

export async function recordCleaning(ctx) {
  const { store, principal, params, body } = ctx;
  if (!store.state.replicas[params.id]) return notFound(`复刻件不存在: ${params.id}`);
  if (body?.phase !== "started" && body?.phase !== "completed") return invalid("phase 必须是 started 或 completed");
  await store.command("cleaning_recorded", {
    replica_id: params.id,
    payload: { phase: body.phase },
  }, principal.ref);
  return ok({ replica: store.state.replicas[params.id] });
}

// ---------- 场次与预约 ----------

export async function scheduleSession(ctx) {
  const { body, store, principal } = ctx;
  if (!isValidIso(body?.starts_at) || !isValidIso(body?.ends_at)) return invalid("starts_at 与 ends_at 必须是合法的 ISO 时间");
  if (Date.parse(body.ends_at) <= Date.parse(body.starts_at)) return invalid("ends_at 必须晚于 starts_at");
  if (body?.capacity !== undefined && (!Number.isInteger(body.capacity) || body.capacity < 1)) return invalid("capacity 必须是正整数");
  if (body?.accessibility_supports !== undefined && !Array.isArray(body.accessibility_supports)) return invalid("accessibility_supports 必须是数组");
  const sessionId = asString(body?.session_id) ?? newPlatformId("sess");
  await store.command("session_scheduled", {
    session_id: sessionId,
    payload: {
      title: asString(body?.title),
      starts_at: body.starts_at,
      ends_at: body.ends_at,
      capacity: body?.capacity ?? 1,
      accessibility_supports: body?.accessibility_supports ?? [],
      checkin_grace_minutes: body?.checkin_grace_minutes,
    },
  }, principal.ref);
  return ok({ session: store.state.sessions[sessionId] }, 201);
}

export async function listSessions(ctx) {
  return ok({ sessions: Object.values(ctx.store.state.sessions) });
}

export async function getSession(ctx) {
  const session = ctx.store.state.sessions[ctx.params.id];
  if (!session) return notFound(`场次不存在: ${ctx.params.id}`);
  return ok({ session });
}

export async function requestBooking(ctx) {
  const { store, principal, params, body } = ctx;
  const sessionId = params.id;
  const replicaId = asString(body?.replica_id);
  if (!replicaId) return invalid("replica_id 必填");
  if (body?.assistance_needs !== undefined && !Array.isArray(body.assistance_needs)) return invalid("assistance_needs 必须是数组");
  const bookingId = newPlatformId("bk");
  const holderRef = asString(body?.holder_ref) ?? principal.ref;
  const { decisions } = await store.command("booking_requested", {
    session_id: sessionId,
    replica_id: replicaId,
    payload: {
      booking_id: bookingId,
      session_id: sessionId,
      replica_id: replicaId,
      holder_ref: holderRef,
      assistance_needs: body?.assistance_needs ?? [],
    },
  }, principal.ref);
  return ok({
    booking: store.state.bookings[bookingId],
    decision: decisions.find((d) => d.subject_type === "booking" && d.subject_id === bookingId) ?? null,
  });
}

export async function getBooking(ctx) {
  const booking = ctx.store.state.bookings[ctx.params.id];
  if (!booking) return notFound(`预约不存在: ${ctx.params.id}`);
  const decisions = ctx.store.decisionHistory.filter((d) => d.subject_type === "booking" && d.subject_id === ctx.params.id);
  return ok({ booking, decisions });
}

export async function reassignBooking(ctx) {
  const { store, principal, params, body } = ctx;
  const orig = store.state.bookings[params.id];
  if (!orig) return notFound(`预约不存在: ${params.id}`);
  if (!["confirmed", "cancelled", "rejected", "expired"].includes(orig.status)) {
    return conflict("not_reassignable", `预约当前状态为 ${orig.status}，不能改派`);
  }
  const newReplicaId = asString(body?.replica_id);
  if (!newReplicaId) return invalid("replica_id 必填");
  const newBookingId = newPlatformId("bk");
  const { decisions } = await store.command("booking_reassigned", {
    payload: {
      booking_id: params.id,
      new_booking_id: newBookingId,
      new_replica_id: newReplicaId,
      reason: asString(body?.reason),
      reason_code: asString(body?.reason_code),
    },
  }, principal.ref);
  return ok({
    original: store.state.bookings[params.id],
    replacement: {
      booking: store.state.bookings[newBookingId],
      decision: decisions.find((d) => d.subject_type === "booking" && d.subject_id === newBookingId) ?? null,
    },
    decisions,
  });
}

// ---------- 设备事件 ----------

export async function postDeviceEvents(ctx) {
  const { body, store } = ctx;
  const list = Array.isArray(body) ? body : [body];
  if (list.length === 0 || list.some((e) => e === null || typeof e !== "object")) {
    return invalid("请求体必须是事件对象或事件数组");
  }
  const result = await store.ingestDeviceEvents(list);
  return ok(result);
}

export async function listDevices(ctx) {
  const seen = new Map(Object.entries(ctx.config.deviceLocations ?? {}).map(([id, location]) => [id, { device_id: id, location }]));
  for (const { event } of ctx.store.entries) {
    if (event.device_id === "platform") continue;
    if (!seen.has(event.device_id)) seen.set(event.device_id, { device_id: event.device_id, location: null });
  }
  return ok({ devices: [...seen.values()] });
}

// ---------- 闭馆 ----------

export async function startClosure(ctx) {
  const { store, principal, body } = ctx;
  const active = store.state.closures.find((c) => c.lifted_at === null);
  if (active) return conflict("closure_active", `已有进行中的闭馆: ${active.closure_id}`);
  const closureId = newPlatformId("clo");
  const { decisions } = await store.command("closure_started", {
    payload: { closure_id: closureId, reason: asString(body?.reason) },
  }, principal.ref);
  return ok({ closure: store.state.closures.find((c) => c.closure_id === closureId), decisions }, 201);
}

export async function liftClosure(ctx) {
  const { store, principal, params } = ctx;
  const closure = store.state.closures.find((c) => c.closure_id === params.id);
  if (!closure) return notFound(`闭馆记录不存在: ${params.id}`);
  if (closure.lifted_at !== null) return conflict("closure_already_lifted", "该闭馆已恢复");
  await store.command("closure_lifted", { payload: { closure_id: params.id } }, principal.ref);
  return ok({ closure: store.state.closures.find((c) => c.closure_id === params.id) });
}

export async function listClosures(ctx) {
  return ok({ closures: ctx.store.state.closures });
}

// ---------- 决策与待处理补传 ----------

export async function listDecisions(ctx) {
  const { replica_id, session_id, subject_type, result, subject_id } = ctx.query;
  let decisions = ctx.store.decisionHistory; // 含被改判覆盖的旧版本，完整可解释
  if (replica_id) decisions = decisions.filter((d) => d.replica_id === replica_id);
  if (session_id) decisions = decisions.filter((d) => d.session_id === session_id);
  if (subject_type) decisions = decisions.filter((d) => d.subject_type === subject_type);
  if (subject_id) decisions = decisions.filter((d) => d.subject_id === subject_id);
  if (result) decisions = decisions.filter((d) => d.result === result);
  return ok({ decisions });
}

export async function listPending(ctx) {
  return ok({ pending: ctx.store.state.pending });
}
