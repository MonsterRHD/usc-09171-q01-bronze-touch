// 测试公共工具：内存 DataStore、可控时钟、事件与命令工厂。

import { DataStore } from "../src/store/datastore.mjs";
import { defaultConfig } from "../src/config.mjs";

export function makeConfig(overrides = {}) {
  return defaultConfig({
    defaultCooldownMinutes: 30,
    checkinGraceMinutes: 10,
    deviceLocations: { "kiosk-a": "东展厅服务台", "kiosk-b": "西展厅服务台" },
    ...overrides,
  });
}

export function mutableClock(startIso) {
  let now = Date.parse(startIso);
  return {
    clock: () => now,
    set(iso) {
      now = Date.parse(iso);
    },
    advance(minutes) {
      now += minutes * 60_000;
    },
  };
}

export async function makeStore({ config, clock } = {}) {
  return DataStore.open({ dir: null, config: config ?? makeConfig(), clock: clock ?? (() => Date.now()) });
}

export function scan({ id, device = "kiosk-a", replica = "replica-001", actor, at, location }) {
  return {
    event_id: id,
    device_id: device,
    kind: "handover_scan",
    replica_id: replica,
    actor_ref: actor,
    occurred_at: at,
    ...(location ? { location } : {}),
  };
}

export function reading({ id, device = "sensor-r1", replica = "replica-001", value, unit = "kg", at }) {
  return { event_id: id, device_id: device, kind: "load_reading", replica_id: replica, value, unit, occurred_at: at };
}

export async function register(store, id, { load = 20, restrictions = [], cooldown = 30, artifact = "artifact-青铜尊" } = {}) {
  return store.command("replica_registered", {
    replica_id: id,
    payload: { artifact_ref: artifact, load_limit_kg: load, touch_restrictions: restrictions, cooldown_minutes: cooldown },
  }, "curator-01");
}

export async function inspect(store, id, result = "passed") {
  return store.command("inspection_recorded", { replica_id: id, payload: { result } }, "curator-01");
}

export async function clean(store, id, phase = "completed") {
  return store.command("cleaning_recorded", { replica_id: id, payload: { phase } }, "cleaner-01");
}

export async function schedule(store, id, { starts, ends, capacity = 5, supports = [], grace = 10 } = {}) {
  return store.command("session_scheduled", {
    session_id: id,
    payload: { title: id, starts_at: starts, ends_at: ends, capacity, accessibility_supports: supports, checkin_grace_minutes: grace },
  }, "supervisor-01");
}

export async function book(store, { bookingId, sessionId, replicaId = "replica-001", holder = "guide-12", needs = [] }) {
  const { decisions } = await store.command("booking_requested", {
    session_id: sessionId,
    replica_id: replicaId,
    payload: { booking_id: bookingId, session_id: sessionId, replica_id: replicaId, holder_ref: holder, assistance_needs: needs },
  }, holder);
  return decisions.find((d) => d.subject_type === "booking" && d.subject_id === bookingId);
}

export async function recall(store, id, reason = "发现裂纹") {
  return store.command("recall_issued", { replica_id: id, payload: { reason } }, "curator-01");
}

export function lastDecisionFor(store, subjectId) {
  const list = store.state.decisions.filter((d) => d.subject_id === subjectId);
  return list[list.length - 1] ?? null;
}
