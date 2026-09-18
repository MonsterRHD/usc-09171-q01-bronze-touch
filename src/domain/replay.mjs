// 确定性重放引擎：把事件日志折叠成当前状态与全部决策。
//
// 排序规则：occurred_at（事件实际发生时间）升序；并列时按平台接收序号 seq。
// 因此离线终端补传的事件会插入到它真实发生的位置，冲突总是按实际发生顺序消除。
// 重放是纯函数：同样的事件序列必然得到同样的状态与决策序列，重启后结果一致。

import { REASONS, NEED_RESTRICTION_CONFLICTS } from "./reasons.mjs";
import { eventKey } from "./events.mjs";
import { toMs, addMinutesMs } from "./time.mjs";

const RESULT_LABELS = {
  confirmed: "预约确认",
  rejected: "预约被拒绝",
  cancelled: "预约被取消",
  expired: "预约过期",
  reassigned: "预约被改派",
  checkout_granted: "扫码领取成立",
  checkout_rejected: "扫码领取被拒绝",
  return_recorded: "扫码归还记录",
  auto_suspended: "传感器超限自动停用",
  recall_applied: "紧急召回生效",
  inspection_passed: "检查通过",
  inspection_failed: "检查未通过",
};

function cmpEntries(a, b) {
  const ta = toMs(a.event.occurred_at);
  const tb = toMs(b.event.occurred_at);
  if (ta !== tb) return ta - tb;
  return a.seq - b.seq;
}

export function replayEvents(entries, config, nowMs) {
  const sorted = [...entries].sort(cmpEntries);
  // 第一遍：收集日志中登记过的复刻件。设备事件引用"已登记但登记事件尚未发生"的
  // 复刻件时，先积压（backlog），在登记事件处理时按序补应用；引用从未登记的
  // 复刻件时才进入待处理（pending），重启后仍保留，登记后自动吸收。
  const knownReplicas = new Set();
  for (const entry of sorted) {
    if (entry.event.kind === "replica_registered") knownReplicas.add(entry.event.replica_id);
  }
  const st = {
    replicas: new Map(),
    sessions: new Map(),
    bookings: new Map(),
    closures: [],
    decisions: [],
    pending: [],
    timelines: new Map(),
    knownReplicas,
    backlog: new Map(),
  };
  for (const entry of sorted) applyEntry(st, entry, config);
  return finalizeState(st, config, nowMs);
}

function applyEntry(st, entry, config) {
  switch (entry.event.kind) {
    case "replica_registered": return onReplicaRegistered(st, entry, config);
    case "session_scheduled": return onSessionScheduled(st, entry, config);
    case "booking_requested": return onBookingRequested(st, entry, config);
    case "booking_reassigned": return onBookingReassigned(st, entry, config);
    case "handover_scan": return onHandoverScan(st, entry, config);
    case "load_reading": return onLoadReading(st, entry);
    case "recall_issued": return onRecall(st, entry);
    case "inspection_recorded": return onInspection(st, entry);
    case "cleaning_recorded": return onCleaning(st, entry);
    case "closure_started": return onClosureStarted(st, entry);
    case "closure_lifted": return onClosureLifted(st, entry);
    default: break; // 未知种类忽略，便于前向兼容
  }
}

// ---------- 通用辅助 ----------

function pushTimeline(st, replicaId, item) {
  if (!st.timelines.has(replicaId)) st.timelines.set(replicaId, []);
  st.timelines.get(replicaId).push(item);
}

function tlEvent(entry, summary) {
  const evt = entry.event;
  return {
    type: "event",
    at: evt.occurred_at,
    seq: entry.seq,
    kind: evt.kind,
    summary,
    ref: eventKey(evt),
    device_id: evt.device_id,
    actor_ref: evt.actor_ref ?? null,
  };
}

function recordDecision(st, entry, { subjectType, subjectId, result, reason = null, evidence = [], replicaId = null, sessionId = null, extra = {} }) {
  const evt = entry.event;
  const skey = `${subjectType}:${subjectId}`;
  // decision_id 由主体与触发事件唯一确定：同一事件重放多次得到同一决策（幂等）；
  // 离线补传改写历史后，同一 decision_id 内容变化，由 DataStore 追加为新 revision。
  const decision = {
    decision_id: `${skey}@${eventKey(evt)}`,
    subject_type: subjectType,
    subject_id: subjectId,
    result,
    reason,
    reason_detail: reason ? (REASONS[reason] ?? reason) : null,
    replica_id: replicaId,
    session_id: sessionId,
    evidence,
    occurred_at: evt.occurred_at,
    trigger_event_id: eventKey(evt),
    ...extra,
  };
  st.decisions.push(decision);
  if (replicaId) {
    const label = RESULT_LABELS[result] ?? result;
    pushTimeline(st, replicaId, {
      type: "decision",
      at: evt.occurred_at,
      seq: entry.seq,
      summary: decision.reason_detail ? `${label}：${decision.reason_detail}` : label,
      ref: decision.decision_id,
      result,
      reason,
    });
  }
  return decision;
}

function activeClosure(st, atMs) {
  return st.closures.find((c) => c.startedMs <= atMs && (c.liftedMs === null || c.liftedMs > atMs)) ?? null;
}

function windowsOverlap(a, b) {
  if (!a || !b) return false;
  return a.startsMs < b.endsMs && b.startsMs < a.endsMs;
}

// 展品在 atMs 时刻的放行障碍。顺序即主因优先级。
function blockersFor(rep, atMs) {
  const blocks = [];
  if (rep.recall) blocks.push({ reason: "recalled", evidence: [rep.recall.event_id] });
  if (rep.suspended) blocks.push({ reason: "suspended", evidence: [rep.suspended.event_id] });
  if (rep.holder) blocks.push({ reason: "already_held", evidence: [rep.holder.event_id] });
  const cleaningDone = rep.cleaningCompletedAtMs !== null && rep.cleaningCompletedAtMs >= (rep.lastReturnAtMs ?? 0);
  if (rep.lastReturnAtMs !== null && !cleaningDone) {
    blocks.push({ reason: "cleaning_pending", evidence: [rep.lastReturnEventId] });
  }
  if (cleaningDone && atMs < addMinutesMs(rep.cleaningCompletedAtMs, rep.cooldown_minutes)) {
    blocks.push({ reason: "cooldown_active", evidence: [rep.cleaningEventId] });
  }
  if (rep.needsInspection) {
    blocks.push({ reason: "inspection_pending", evidence: [rep.lastInspection?.event_id ?? rep.registered_event_id] });
  }
  return blocks;
}

// 设备事件引用的复刻件尚不存在时的分流。
function deferOrPending(st, entry, replicaId) {
  if (st.knownReplicas.has(replicaId)) {
    if (!st.backlog.has(replicaId)) st.backlog.set(replicaId, []);
    st.backlog.get(replicaId).push(entry);
  } else {
    st.pending.push(entry.event);
  }
}

// ---------- 各事件处理 ----------

function onReplicaRegistered(st, entry, config) {
  const evt = entry.event;
  const p = evt.payload ?? {};
  const existing = st.replicas.get(evt.replica_id);
  const rep = existing ?? {
    replica_id: evt.replica_id,
    registered_event_id: eventKey(evt),
    holder: null,
    recall: null,
    suspended: null,
    lastReturnAtMs: null,
    lastReturnEventId: null,
    cleaningCompletedAtMs: null,
    cleaningEventId: null,
    lastInspection: null,
    needsInspection: true, // 登记后必须先完成首次检查
    lastReading: null,
    returnRequired: false,
  };
  rep.artifact_ref = p.artifact_ref ?? null;
  rep.load_limit_kg = typeof p.load_limit_kg === "number" ? p.load_limit_kg : null;
  rep.touch_restrictions = Array.isArray(p.touch_restrictions) ? [...p.touch_restrictions] : [];
  rep.cooldown_minutes = typeof p.cooldown_minutes === "number" ? p.cooldown_minutes : config.defaultCooldownMinutes;
  st.replicas.set(evt.replica_id, rep);
  pushTimeline(st, evt.replica_id, tlEvent(entry, existing ? "复刻件资料更新" : `复刻件登记（关联原件 ${rep.artifact_ref ?? "未填"}）`));
  // 补应用先于登记发生的设备事件（离线补传早于登记到达的情形）
  const deferred = st.backlog.get(evt.replica_id);
  if (deferred) {
    st.backlog.delete(evt.replica_id);
    for (const e of deferred) applyEntry(st, e, config);
  }
}

function onSessionScheduled(st, entry, config) {
  const evt = entry.event;
  const p = evt.payload ?? {};
  st.sessions.set(evt.session_id, {
    session_id: evt.session_id,
    title: p.title ?? null,
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    startsMs: toMs(p.starts_at),
    endsMs: toMs(p.ends_at),
    capacity: typeof p.capacity === "number" ? p.capacity : 1,
    accessibility_supports: Array.isArray(p.accessibility_supports) ? [...p.accessibility_supports] : [],
    checkin_grace_minutes: typeof p.checkin_grace_minutes === "number" ? p.checkin_grace_minutes : config.checkinGraceMinutes,
    status: "scheduled",
    scheduled_by: evt.actor_ref,
  });
}

function decideBooking(st, entry, booking) {
  const evt = entry.event;
  const atMs = toMs(evt.occurred_at);
  const session = st.sessions.get(booking.session_id);
  const rep = st.replicas.get(booking.replica_id);
  const base = { subjectType: "booking", subjectId: booking.booking_id, replicaId: booking.replica_id, sessionId: booking.session_id };
  if (!session) return recordDecision(st, entry, { ...base, result: "rejected", reason: "unknown_session" });
  if (!rep) return recordDecision(st, entry, { ...base, result: "rejected", reason: "unknown_replica" });
  if (session.status === "cancelled") return recordDecision(st, entry, { ...base, result: "rejected", reason: "session_cancelled" });
  const closure = activeClosure(st, atMs);
  if (closure) return recordDecision(st, entry, { ...base, result: "rejected", reason: "closed", evidence: [closure.event_id] });
  const blocks = blockersFor(rep, atMs);
  if (blocks.length > 0) {
    return recordDecision(st, entry, {
      ...base,
      result: "rejected",
      reason: blocks[0].reason,
      evidence: blocks.flatMap((b) => b.evidence),
      extra: { blockers: blocks.map((b) => b.reason) },
    });
  }
  const conflict = [...st.bookings.values()].find(
    (b) => b.booking_id !== booking.booking_id && b.replica_id === booking.replica_id && b.status === "confirmed" && windowsOverlap(session, st.sessions.get(b.session_id)),
  );
  if (conflict) return recordDecision(st, entry, { ...base, result: "rejected", reason: "replica_conflict", evidence: [conflict.requested_event_id] });
  const confirmedCount = [...st.bookings.values()].filter((b) => b.session_id === session.session_id && b.status === "confirmed").length;
  if (confirmedCount >= session.capacity) return recordDecision(st, entry, { ...base, result: "rejected", reason: "session_full" });
  const uncovered = booking.assistance_needs.filter((n) => !session.accessibility_supports.includes(n));
  if (uncovered.length > 0) return recordDecision(st, entry, { ...base, result: "rejected", reason: "assistance_mismatch", extra: { unmet_needs: uncovered } });
  const hit = booking.assistance_needs.find((n) => (NEED_RESTRICTION_CONFLICTS[n] ?? []).some((r) => rep.touch_restrictions.includes(r)));
  if (hit) return recordDecision(st, entry, { ...base, result: "rejected", reason: "restriction_conflict", extra: { conflicting_need: hit } });
  booking.status = "confirmed";
  return recordDecision(st, entry, { ...base, result: "confirmed" });
}

function onBookingRequested(st, entry) {
  const p = entry.event.payload ?? {};
  const booking = {
    booking_id: p.booking_id,
    session_id: p.session_id,
    replica_id: p.replica_id,
    holder_ref: p.holder_ref,
    assistance_needs: Array.isArray(p.assistance_needs) ? [...p.assistance_needs] : [],
    status: "pending",
    requested_by: entry.event.actor_ref,
    requested_at: entry.event.occurred_at,
    requested_event_id: eventKey(entry.event),
  };
  st.bookings.set(booking.booking_id, booking);
  decideBooking(st, entry, booking);
  if (booking.status !== "confirmed") booking.status = "rejected";
}

function onBookingReassigned(st, entry) {
  const evt = entry.event;
  const p = evt.payload ?? {};
  const orig = st.bookings.get(p.booking_id);
  if (!orig) return;
  orig.status = "reassigned";
  recordDecision(st, entry, {
    subjectType: "booking",
    subjectId: orig.booking_id,
    replicaId: orig.replica_id,
    sessionId: orig.session_id,
    result: "reassigned",
    reason: p.reason_code ?? null,
    evidence: [eventKey(evt)],
    extra: { reassigned_to: p.new_booking_id, reason_note: p.reason ?? null },
  });
  const booking = {
    booking_id: p.new_booking_id,
    session_id: orig.session_id,
    replica_id: p.new_replica_id,
    holder_ref: orig.holder_ref,
    assistance_needs: [...orig.assistance_needs],
    status: "pending",
    requested_by: evt.actor_ref,
    requested_at: evt.occurred_at,
    requested_event_id: eventKey(evt),
    reassigned_from: orig.booking_id,
  };
  st.bookings.set(booking.booking_id, booking);
  decideBooking(st, entry, booking);
  if (booking.status !== "confirmed") booking.status = "rejected";
}

function onHandoverScan(st, entry, config) {
  const evt = entry.event;
  const rep = st.replicas.get(evt.replica_id);
  if (!rep) {
    deferOrPending(st, entry, evt.replica_id);
    return;
  }
  const key = eventKey(evt);
  const atMs = toMs(evt.occurred_at);
  const location = evt.location ?? config.deviceLocations?.[evt.device_id] ?? null;
  const base = { subjectType: "handover", subjectId: key, replicaId: evt.replica_id };

  if (rep.holder) {
    if (rep.holder.actor_ref === evt.actor_ref) {
      // 同一占用人再次扫码 = 归还。归还永远允许，安全优先。
      const holder = rep.holder;
      rep.holder = null;
      rep.lastReturnAtMs = atMs;
      rep.lastReturnEventId = key;
      rep.cleaningCompletedAtMs = null;
      rep.cleaningEventId = null;
      rep.needsInspection = true;
      rep.returnRequired = false;
      recordDecision(st, entry, { ...base, result: "return_recorded", evidence: [holder.event_id], extra: { holder_ref: evt.actor_ref, location } });
    } else {
      recordDecision(st, entry, { ...base, result: "checkout_rejected", reason: "already_held", evidence: [rep.holder.event_id], extra: { current_holder: rep.holder.actor_ref } });
    }
    return;
  }

  // 领取尝试：依次检查闭馆、放行障碍、预约匹配。
  const closure = activeClosure(st, atMs);
  if (closure) {
    recordDecision(st, entry, { ...base, result: "checkout_rejected", reason: "closed", evidence: [closure.event_id] });
    return;
  }
  const blocks = blockersFor(rep, atMs);
  if (blocks.length > 0) {
    recordDecision(st, entry, {
      ...base,
      result: "checkout_rejected",
      reason: blocks[0].reason,
      evidence: blocks.flatMap((b) => b.evidence),
      extra: { blockers: blocks.map((b) => b.reason) },
    });
    return;
  }

  const confirmed = [...st.bookings.values()].filter((b) => b.replica_id === evt.replica_id && b.status === "confirmed");
  const withWindow = confirmed.map((b) => ({ b, s: st.sessions.get(b.session_id) })).filter((x) => x.s);
  const deadlineOf = (x) => addMinutesMs(x.s.startsMs, x.s.checkin_grace_minutes);
  // 有效预约窗口 = [场次开始, 开始+宽限]：未开始的预约不阻挡现场领用，过期的不算有效
  const live = withWindow.filter((x) => atMs >= x.s.startsMs && atMs <= deadlineOf(x));
  const own = live.find((x) => x.b.holder_ref === evt.actor_ref);
  if (own) {
    own.b.status = "fulfilled";
    grantCheckout(st, entry, rep, location, own.b);
    return;
  }
  if (live.length > 0) {
    recordDecision(st, entry, { ...base, result: "checkout_rejected", reason: "booked_by_other", evidence: [live[0].b.requested_event_id], extra: { booked_holder: live[0].b.holder_ref } });
    return;
  }
  const expiredOwn = withWindow.find((x) => x.b.holder_ref === evt.actor_ref && atMs > deadlineOf(x));
  if (expiredOwn) {
    expiredOwn.b.status = "expired";
    recordDecision(st, entry, {
      subjectType: "booking",
      subjectId: expiredOwn.b.booking_id,
      replicaId: rep.replica_id,
      sessionId: expiredOwn.b.session_id,
      result: "expired",
      reason: "late_arrival",
      evidence: [key],
    });
    recordDecision(st, entry, { ...base, result: "checkout_rejected", reason: "late_arrival", evidence: [expiredOwn.b.requested_event_id] });
    return;
  }
  grantCheckout(st, entry, rep, location, null); // 现场领用（无预约）
}

function grantCheckout(st, entry, rep, location, booking) {
  const evt = entry.event;
  const key = eventKey(evt);
  rep.holder = {
    actor_ref: evt.actor_ref,
    since: evt.occurred_at,
    device_id: evt.device_id,
    location,
    event_id: key,
    booking_id: booking?.booking_id ?? null,
    reading_snapshot: rep.lastReading ?? null, // 交接时刻的最近设备读数快照
  };
  recordDecision(st, entry, {
    subjectType: "handover",
    subjectId: key,
    replicaId: rep.replica_id,
    sessionId: booking?.session_id ?? null,
    result: "checkout_granted",
    evidence: booking ? [booking.requested_event_id] : [],
    extra: {
      holder_ref: evt.actor_ref,
      location,
      walk_up: !booking,
      reading_snapshot: rep.lastReading ?? null,
    },
  });
}

function onLoadReading(st, entry) {
  const evt = entry.event;
  const rep = st.replicas.get(evt.replica_id);
  if (!rep) {
    deferOrPending(st, entry, evt.replica_id);
    return;
  }
  const key = eventKey(evt);
  const atMs = toMs(evt.occurred_at);
  // 原始读数只追加进时间线，永不改写；当前值取 occurred_at 最新的一条。
  if (!rep.lastReading || toMs(rep.lastReading.at) <= atMs) {
    rep.lastReading = { value: evt.value, unit: evt.unit ?? "kg", at: evt.occurred_at, device_id: evt.device_id, event_id: key };
  }
  pushTimeline(st, rep.replica_id, tlEvent(entry, `承重读数 ${evt.value}${evt.unit ?? "kg"}`));
  if (typeof rep.load_limit_kg === "number" && evt.value > rep.load_limit_kg && !rep.suspended) {
    rep.suspended = { at: evt.occurred_at, event_id: key, value: evt.value, limit: rep.load_limit_kg };
    if (rep.holder) rep.returnRequired = true;
    recordDecision(st, entry, {
      subjectType: "replica",
      subjectId: rep.replica_id,
      replicaId: rep.replica_id,
      result: "auto_suspended",
      reason: "load_exceeded",
      evidence: [key],
      extra: { value: evt.value, limit: rep.load_limit_kg },
    });
  }
}

function onRecall(st, entry) {
  const evt = entry.event;
  const rep = st.replicas.get(evt.replica_id);
  if (!rep) return; // 命令入口已校验存在性
  rep.recall = { at: evt.occurred_at, by: evt.actor_ref, reason: evt.payload?.reason ?? null, event_id: eventKey(evt) };
  if (rep.holder) rep.returnRequired = true;
  pushTimeline(st, rep.replica_id, tlEvent(entry, `保管员发起召回${evt.payload?.reason ? `（${evt.payload.reason}）` : ""}`));
  recordDecision(st, entry, {
    subjectType: "replica",
    subjectId: rep.replica_id,
    replicaId: rep.replica_id,
    result: "recall_applied",
    extra: { recall_reason: evt.payload?.reason ?? null },
  });
}

function onInspection(st, entry) {
  const evt = entry.event;
  const rep = st.replicas.get(evt.replica_id);
  if (!rep) return;
  const result = evt.payload?.result === "passed" ? "passed" : "failed";
  rep.lastInspection = { result, at: evt.occurred_at, by: evt.actor_ref, notes: evt.payload?.notes ?? null, event_id: eventKey(evt) };
  if (result === "passed") {
    rep.needsInspection = false;
    rep.recall = null; // 检查通过同时解除召回与传感器停用
    rep.suspended = null;
  } else {
    rep.needsInspection = true;
  }
  recordDecision(st, entry, {
    subjectType: "replica",
    subjectId: rep.replica_id,
    replicaId: rep.replica_id,
    result: result === "passed" ? "inspection_passed" : "inspection_failed",
  });
}

function onCleaning(st, entry) {
  const evt = entry.event;
  const rep = st.replicas.get(evt.replica_id);
  if (!rep) return;
  const phase = evt.payload?.phase === "completed" ? "completed" : "started";
  if (phase === "completed") {
    rep.cleaningCompletedAtMs = toMs(evt.occurred_at);
    rep.cleaningEventId = eventKey(evt);
  }
  pushTimeline(st, rep.replica_id, tlEvent(entry, phase === "completed" ? "清洁消毒完成" : "清洁消毒开始"));
}

function onClosureStarted(st, entry) {
  const evt = entry.event;
  const closure = {
    closure_id: evt.payload?.closure_id,
    event_id: eventKey(evt),
    started_at: evt.occurred_at,
    startedMs: toMs(evt.occurred_at),
    lifted_at: null,
    liftedMs: null,
    reason: evt.payload?.reason ?? null,
    by: evt.actor_ref,
  };
  st.closures.push(closure);
  for (const b of st.bookings.values()) {
    if (b.status === "confirmed") {
      b.status = "cancelled";
      recordDecision(st, entry, {
        subjectType: "booking",
        subjectId: b.booking_id,
        replicaId: b.replica_id,
        sessionId: b.session_id,
        result: "cancelled",
        reason: "closed",
        evidence: [closure.event_id],
      });
    }
  }
  for (const rep of st.replicas.values()) {
    if (rep.holder) rep.returnRequired = true;
  }
}

function onClosureLifted(st, entry) {
  const evt = entry.event;
  const closure = st.closures.find((c) => c.closure_id === evt.payload?.closure_id && c.liftedMs === null);
  if (!closure) return;
  closure.lifted_at = evt.occurred_at;
  closure.liftedMs = toMs(evt.occurred_at);
}

// ---------- 汇总输出 ----------

function statusOf(rep, nowMs) {
  if (rep.holder) return rep.returnRequired ? "return_required" : "checked_out";
  if (rep.recall) return "recalled";
  if (rep.suspended) return "suspended";
  const cleaningDone = rep.cleaningCompletedAtMs !== null && rep.cleaningCompletedAtMs >= (rep.lastReturnAtMs ?? 0);
  if (rep.lastReturnAtMs !== null && !cleaningDone) return "awaiting_cleaning";
  if (rep.needsInspection) return "awaiting_inspection";
  if (cleaningDone && nowMs < addMinutesMs(rep.cleaningCompletedAtMs, rep.cooldown_minutes)) return "cooling";
  return "available";
}

function publicBooking(st, b, nowMs) {
  let effective = b.status;
  if (b.status === "confirmed") {
    const s = st.sessions.get(b.session_id);
    if (s && nowMs > addMinutesMs(s.startsMs, s.checkin_grace_minutes)) effective = "expired";
  }
  return { ...b, effective_status: effective };
}

function finalizeState(st, config, nowMs) {
  const closure = activeClosure(st, nowMs);
  const replicas = {};
  for (const [id, rep] of st.replicas) {
    const blocks = blockersFor(rep, nowMs);
    replicas[id] = {
      replica_id: id,
      artifact_ref: rep.artifact_ref,
      load_limit_kg: rep.load_limit_kg,
      touch_restrictions: rep.touch_restrictions,
      cooldown_minutes: rep.cooldown_minutes,
      status: statusOf(rep, nowMs),
      current_holder: rep.holder,
      return_required: rep.returnRequired,
      recalled: rep.recall !== null,
      suspended: rep.suspended !== null,
      releasable: {
        ok: blocks.length === 0 && !closure,
        blockers: blocks.map((b) => ({ reason: b.reason, detail: REASONS[b.reason] ?? b.reason, evidence: b.evidence })),
      },
      closure_active: closure !== null,
      last_reading: rep.lastReading,
      last_inspection: rep.lastInspection,
    };
  }
  const sessions = {};
  for (const [id, s] of st.sessions) {
    const bookings = [...st.bookings.values()].filter((b) => b.session_id === id);
    sessions[id] = {
      ...s,
      bookings: bookings.map((b) => publicBooking(st, b, nowMs)),
      confirmed_count: bookings.filter((b) => b.status === "confirmed").length,
    };
  }
  const bookings = {};
  for (const [id, b] of st.bookings) bookings[id] = publicBooking(st, b, nowMs);
  const timelines = {};
  for (const [id, items] of st.timelines) {
    // 时间线按发生时间排序展示：离线补传/积压补应用的事件回到它真实发生的位置
    timelines[id] = [...items].sort((a, b) => (toMs(a.at) ?? 0) - (toMs(b.at) ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
  }
  return {
    replicas,
    sessions,
    bookings,
    closures: st.closures,
    decisions: st.decisions,
    pending: st.pending,
    timelines,
  };
}
