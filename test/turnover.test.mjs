// 验收流程一：同一件展品跨场周转。
// 登记 → 检查 → 场次一预约/领取/归还 → 清洁冷却 → 检查 → 场次二再放行。
// 任意时刻只能有一个有效占用者；冷却与检查未完成时拒绝且可解释。

import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, mutableClock, register, inspect, clean, schedule, book, scan, reading } from "./helpers.mjs";

test("同一件复刻件跨场周转的完整链路", async () => {
  const clock = mutableClock("2026-09-12T08:30:00+08:00");
  const store = await makeStore({ clock: clock.clock });

  // 保管员登记：关联原件、承重上限 20kg、可触限制、冷却 30 分钟
  await register(store, "replica-001", { load: 20, restrictions: ["no_lifting"], cooldown: 30 });
  assert.equal(store.state.replicas["replica-001"].status, "awaiting_inspection", "登记后尚未检查，不能放行");

  // 排两个场次
  await schedule(store, "s1", { starts: "2026-09-12T10:00:00+08:00", ends: "2026-09-12T10:45:00+08:00" });
  await schedule(store, "s2", { starts: "2026-09-12T11:30:00+08:00", ends: "2026-09-12T12:15:00+08:00" });

  // 未完成检查前预约被拒，原因可解释
  const early = await book(store, { bookingId: "bk-0", sessionId: "s1", holder: "guide-12" });
  assert.equal(early.result, "rejected");
  assert.equal(early.reason, "inspection_pending");

  // 检查通过 → 可放行
  await inspect(store, "replica-001", "passed");
  assert.equal(store.state.replicas["replica-001"].status, "available");

  // 场次一预约确认
  const d1 = await book(store, { bookingId: "bk-1", sessionId: "s1", holder: "guide-12" });
  assert.equal(d1.result, "confirmed");

  // 10:02 扫码领取：保留人员、位置与交接时读数快照
  await store.ingestDeviceEvents([reading({ id: "r-1", value: 18.6, at: "2026-09-12T09:05:00+08:00" })]);
  const granted = await store.ingestDeviceEvents([
    scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:02:00+08:00" }),
  ]);
  assert.equal(granted.results[0].decisions[0].result, "checkout_granted");
  const holder = store.state.replicas["replica-001"].current_holder;
  assert.equal(holder.actor_ref, "guide-12");
  assert.equal(holder.location, "东展厅服务台", "位置来自终端注册信息");
  assert.equal(holder.booking_id, "bk-1");
  assert.equal(holder.reading_snapshot.value, 18.6, "交接时保留最近设备读数");
  assert.equal(store.state.bookings["bk-1"].status, "fulfilled");

  // 占用期间他人扫码被拒
  const held = await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-7", at: "2026-09-12T10:05:00+08:00" })]);
  assert.equal(held.results[0].decisions[0].reason, "already_held");

  // 10:40 同一占用人再扫 = 归还
  const returned = await store.ingestDeviceEvents([scan({ id: "a-2", actor: "guide-12", at: "2026-09-12T10:40:00+08:00" })]);
  assert.equal(returned.results[0].decisions[0].result, "return_recorded");
  assert.equal(store.state.replicas["replica-001"].current_holder, null);
  assert.equal(store.state.replicas["replica-001"].status, "awaiting_cleaning");

  // 未清洁前预约场次二被拒
  clock.set("2026-09-12T10:41:00+08:00");
  const d2 = await book(store, { bookingId: "bk-2", sessionId: "s2", holder: "guide-12" });
  assert.equal(d2.result, "rejected");
  assert.equal(d2.reason, "cleaning_pending");

  // 10:50 清洁完成 → 冷却期内仍拒
  clock.set("2026-09-12T10:50:00+08:00");
  await clean(store, "replica-001", "completed");
  clock.set("2026-09-12T10:55:00+08:00");
  const d3 = await book(store, { bookingId: "bk-3", sessionId: "s2", holder: "guide-12" });
  assert.equal(d3.result, "rejected");
  assert.equal(d3.reason, "cooldown_active");
  assert.ok(d3.evidence.length > 0, "拒绝决策携带证据事件");

  // 冷却结束但未检查 → 仍拒
  clock.set("2026-09-12T11:21:00+08:00");
  const d4 = await book(store, { bookingId: "bk-4", sessionId: "s2", holder: "guide-12" });
  assert.equal(d4.result, "rejected");
  assert.equal(d4.reason, "inspection_pending");

  // 11:25 检查通过 → 场次二预约确认
  clock.set("2026-09-12T11:25:00+08:00");
  await inspect(store, "replica-001", "passed");
  const d5 = await book(store, { bookingId: "bk-5", sessionId: "s2", holder: "guide-12" });
  assert.equal(d5.result, "confirmed");

  // 11:32 场次二扫码领取成立，全程任意时刻只有一个占用者
  const granted2 = await store.ingestDeviceEvents([scan({ id: "a-3", actor: "guide-12", at: "2026-09-12T11:32:00+08:00" })]);
  assert.equal(granted2.results[0].decisions[0].result, "checkout_granted");
  assert.equal(store.state.replicas["replica-001"].current_holder.actor_ref, "guide-12");

  // 时间线完整可追溯：登记、检查、预约、领取、归还、清洁、检查、再预约、再领取
  const timeline = store.state.timelines["replica-001"];
  const kinds = timeline.map((t) => t.summary);
  assert.ok(kinds.some((s) => s.includes("复刻件登记")));
  assert.ok(kinds.some((s) => s.includes("扫码归还记录")));
  assert.ok(kinds.some((s) => s.includes("清洁消毒完成")));
  assert.deepEqual(
    timeline.filter((t) => t.result === "checkout_granted").map((t) => t.at),
    ["2026-09-12T10:02:00+08:00", "2026-09-12T11:32:00+08:00"],
  );
});

test("迟到：超过签到宽限期扫码被拒，预约失效", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");
  await schedule(store, "s1", { starts: "2026-09-12T10:00:00+08:00", ends: "2026-09-12T10:45:00+08:00", grace: 10 });
  const d = await book(store, { bookingId: "bk-1", sessionId: "s1", holder: "guide-12" });
  assert.equal(d.result, "confirmed");

  // 10:11 才到场，超过 10 分钟宽限期
  const late = await store.ingestDeviceEvents([scan({ id: "a-9", actor: "guide-12", at: "2026-09-12T10:11:00+08:00" })]);
  const reject = late.results[0].decisions.find((x) => x.subject_type === "handover");
  assert.equal(reject.result, "checkout_rejected");
  assert.equal(reject.reason, "late_arrival");
  assert.equal(store.state.bookings["bk-1"].status, "expired");
  assert.equal(store.state.replicas["replica-001"].current_holder, null);
});

test("场次容量与辅助需求约束", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001", { restrictions: ["no_lifting"] });
  await inspect(store, "replica-001", "passed");
  await register(store, "replica-002");
  await inspect(store, "replica-002", "passed");
  await schedule(store, "s1", {
    starts: "2026-09-12T10:00:00+08:00",
    ends: "2026-09-12T10:45:00+08:00",
    capacity: 1,
    supports: ["wheelchair", "lift_assist"],
  });

  // 辅助需求超出场次支持范围
  const d1 = await book(store, { bookingId: "bk-1", sessionId: "s1", needs: ["sign_language"] });
  assert.equal(d1.reason, "assistance_mismatch");

  // 辅助需求与可触限制冲突（lift_assist vs no_lifting）
  const d2 = await book(store, { bookingId: "bk-2", sessionId: "s1", needs: ["lift_assist"] });
  assert.equal(d2.reason, "restriction_conflict");

  // 容量为 1：第一件确认后，第二件（同时段）因容量被拒
  const d3 = await book(store, { bookingId: "bk-3", sessionId: "s1", replicaId: "replica-001", needs: ["wheelchair"] });
  assert.equal(d3.result, "confirmed");
  const d4 = await book(store, { bookingId: "bk-4", sessionId: "s1", replicaId: "replica-002" });
  assert.equal(d4.reason, "session_full");

  // 同一复刻件同时段的另一个预约冲突
  await schedule(store, "s2", {
    starts: "2026-09-12T10:30:00+08:00",
    ends: "2026-09-12T11:15:00+08:00",
    capacity: 5,
  });
  const d5 = await book(store, { bookingId: "bk-5", sessionId: "s2", replicaId: "replica-001" });
  assert.equal(d5.reason, "replica_conflict");
});
