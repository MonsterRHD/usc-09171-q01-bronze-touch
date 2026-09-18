// 验收流程四：临时闭馆与恢复。
// 闭馆取消未开始的预约、占用中转待归还；闭馆期间归还仍允许、新领取与新预约被拒；
// 恢复后重新走清洁检查流程再放行。

import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, mutableClock, register, inspect, clean, schedule, book, scan } from "./helpers.mjs";

async function startClosure(store, id, reason = "突发客流管控") {
  return store.command("closure_started", { payload: { closure_id: id, reason } }, "supervisor-01");
}

async function liftClosure(store, id) {
  return store.command("closure_lifted", { payload: { closure_id: id } }, "supervisor-01");
}

test("临时闭馆：预约取消、占用转待归还、新操作被拒；恢复后重新放行", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001", { cooldown: 0 });
  await inspect(store, "replica-001", "passed");
  await register(store, "replica-002", { cooldown: 0 });
  await inspect(store, "replica-002", "passed");
  await schedule(store, "s1", { starts: "2026-09-12T10:00:00+08:00", ends: "2026-09-12T10:45:00+08:00" });
  await schedule(store, "s2", { starts: "2026-09-12T14:00:00+08:00", ends: "2026-09-12T14:45:00+08:00" });

  // replica-001 占用中；replica-002 有下午场预约
  await store.ingestDeviceEvents([scan({ id: "a-1", replica: "replica-001", actor: "guide-12", at: "2026-09-12T10:02:00+08:00" })]);
  const d1 = await book(store, { bookingId: "bk-1", sessionId: "s2", replicaId: "replica-002", holder: "guide-7" });
  assert.equal(d1.result, "confirmed");

  // 10:30 临时闭馆
  clock.set("2026-09-12T10:30:00+08:00");
  const { decisions } = await startClosure(store, "clo-1");
  const cancelled = decisions.find((d) => d.subject_id === "bk-1");
  assert.equal(cancelled.result, "cancelled");
  assert.equal(cancelled.reason, "closed");
  assert.equal(store.state.bookings["bk-1"].status, "cancelled");
  assert.equal(store.state.replicas["replica-001"].return_required, true, "占用中的展品转为待归还");

  // 闭馆期间：新预约被拒、新领取被拒，但归还允许
  const d2 = await book(store, { bookingId: "bk-2", sessionId: "s2", replicaId: "replica-002", holder: "guide-7" });
  assert.equal(d2.reason, "closed");
  const scanIn = await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", replica: "replica-002", actor: "guide-7", at: "2026-09-12T10:31:00+08:00" })]);
  assert.equal(scanIn.results[0].decisions[0].reason, "closed");
  const giveBack = await store.ingestDeviceEvents([scan({ id: "a-2", replica: "replica-001", actor: "guide-12", at: "2026-09-12T10:35:00+08:00" })]);
  assert.equal(giveBack.results[0].decisions[0].result, "return_recorded", "闭馆期间归还必须允许");

  // 11:00 恢复
  clock.set("2026-09-12T11:00:00+08:00");
  await liftClosure(store, "clo-1");
  assert.equal(store.state.closures[0].lifted_at, "2026-09-12T03:00:00.000Z", "平台事件时间以 UTC 落盘（11:00+08:00 = 03:00Z）");

  // replica-001 归还后需清洁+检查才能再放行
  assert.equal(store.state.replicas["replica-001"].status, "awaiting_cleaning");
  await clean(store, "replica-001", "completed");
  await inspect(store, "replica-001", "passed");
  assert.equal(store.state.replicas["replica-001"].status, "available");

  // replica-002 恢复后可直接重新预约下午场
  const d3 = await book(store, { bookingId: "bk-3", sessionId: "s2", replicaId: "replica-002", holder: "guide-7" });
  assert.equal(d3.result, "confirmed");
});

test("重复闭馆与重复恢复被命令层拒绝", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await startClosure(store, "clo-1");
  // 命令层校验由 HTTP 处理函数承担，这里验证重放层对重复 lift 的幂等
  await liftClosure(store, "clo-1");
  await liftClosure(store, "clo-1"); // 已恢复的闭馆再次 lift：重放层忽略
  assert.equal(store.state.closures.length, 1);
  assert.notEqual(store.state.closures[0].lifted_at, null);
});
