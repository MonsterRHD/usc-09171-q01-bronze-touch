// 验收流程二：两台终端同时交接 —— 任何时刻只能有一个有效占用者。

import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, mutableClock, register, inspect, schedule, book, scan } from "./helpers.mjs";

test("两台终端同时扫码：先发生的成立，后发生的被拒且可解释", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  // kiosk-a 与 kiosk-b 几乎同时上报（批量到达，平台按 occurred_at 排序）
  const res = await store.ingestDeviceEvents([
    scan({ id: "b-1", device: "kiosk-b", actor: "guide-7", at: "2026-09-12T10:00:01.200+08:00" }),
    scan({ id: "a-1", device: "kiosk-a", actor: "guide-12", at: "2026-09-12T10:00:01.000+08:00" }),
  ]);
  assert.deepEqual(res.results.map((r) => r.status), ["applied", "applied"]);

  const replica = store.state.replicas["replica-001"];
  assert.equal(replica.current_holder.actor_ref, "guide-12", "occurred_at 更早的 kiosk-a 成立");
  assert.equal(replica.current_holder.device_id, "kiosk-a");

  const loser = store.state.decisions.find((d) => d.subject_id === "kiosk-b:b-1");
  assert.equal(loser.result, "checkout_rejected");
  assert.equal(loser.reason, "already_held");
  assert.deepEqual(loser.evidence, ["kiosk-a:a-1"], "拒绝依据指向占用成立的扫码事件");
});

test("两台终端 occurred_at 完全相同时按接收顺序确定占用者，结果稳定", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  const at = "2026-09-12T10:00:01+08:00";
  await store.ingestDeviceEvents([scan({ id: "a-1", device: "kiosk-a", actor: "guide-12", at })]);
  await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-7", at })]);

  assert.equal(store.state.replicas["replica-001"].current_holder.actor_ref, "guide-12", "先接收的终端成立");
  const loser = store.state.decisions.find((d) => d.subject_id === "kiosk-b:b-1");
  assert.equal(loser.reason, "already_held");
});

test("同一占用人在两台终端上的扫码语义：本人再扫为归还，他人扫码被拒", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  await store.ingestDeviceEvents([scan({ id: "a-1", device: "kiosk-a", actor: "guide-12", at: "2026-09-12T10:00:00+08:00" })]);
  // 他人在另一台终端扫码 → 拒绝
  const res1 = await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-7", at: "2026-09-12T10:05:00+08:00" })]);
  assert.equal(res1.results[0].decisions[0].reason, "already_held");
  // 本人在另一台终端扫码 → 归还
  const res2 = await store.ingestDeviceEvents([scan({ id: "b-2", device: "kiosk-b", actor: "guide-12", at: "2026-09-12T10:10:00+08:00" })]);
  assert.equal(res2.results[0].decisions[0].result, "return_recorded");
  assert.equal(store.state.replicas["replica-001"].current_holder, null);
});

test("有预约时他人扫码被拒（booked_by_other），预约人本人扫码成立", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");
  await schedule(store, "s1", { starts: "2026-09-12T10:00:00+08:00", ends: "2026-09-12T10:45:00+08:00" });
  await book(store, { bookingId: "bk-1", sessionId: "s1", holder: "guide-12" });

  const other = await store.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-7", at: "2026-09-12T10:01:00+08:00" })]);
  assert.equal(other.results[0].decisions[0].reason, "booked_by_other");

  const own = await store.ingestDeviceEvents([scan({ id: "a-2", actor: "guide-12", at: "2026-09-12T10:02:00+08:00" })]);
  assert.equal(own.results[0].decisions[0].result, "checkout_granted");
});

test("未开始场次的预约不阻挡现场领用，也不会被误判为迟到", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");
  // 明天下午场已约给 guide-12
  await schedule(store, "s-tomorrow", { starts: "2026-09-13T14:00:00+08:00", ends: "2026-09-13T14:45:00+08:00" });
  await book(store, { bookingId: "bk-future", sessionId: "s-tomorrow", holder: "guide-12" });

  // 今天 guide-12 现场领用：应成立，且明天的预约保持 confirmed
  const res = await store.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:00:00+08:00" })]);
  assert.equal(res.results[0].decisions[0].result, "checkout_granted");
  assert.equal(store.state.bookings["bk-future"].status, "confirmed");
});
