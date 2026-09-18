// 验收流程一：同一件复刻件跨场周转。
// 覆盖：未检查不得放行、单一占用者、归还后须重新检查、清洁冷却、跨场再领用。
import assert from "node:assert/strict";
import test from "node:test";
import {
  assign,
  boot,
  call,
  CLEANER,
  GUIDE_A,
  GUIDE_B,
  KEEPER,
  KIOSK_A,
  KIOSK_B,
  registerAvailableReplica,
  scan,
  scheduleSession,
  SENSOR,
} from "./helpers.mjs";

test("跨场周转：检查→领用→归还→消毒冷却→再检查→下一场领用", async (t) => {
  const { port } = await boot(t);

  // 登记但故意不检查：先验证“尚未完成检查不能放行”
  await call(port, {
    method: "POST",
    path: "/replicas",
    actor: KEEPER,
    body: {
      replica_id: "replica-001",
      original_ref: "bronze-鼎-原件-001",
      name: "青铜鼎等比复刻件",
      load_limit_kg: 20,
      touch_constraints: { wheelchair: true },
      cooldown_minutes: 30,
      occurred_at: "2026-09-12T08:00:00+08:00",
    },
  });
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T10:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });
  const a1 = await assign(port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T09:20:00+08:00", occurred_at: "2026-09-12T08:31:00+08:00" });
  assert.equal(a1.status, 201);

  const early = await scan(port, KIOSK_A, {
    event_id: "ka-001", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:02:00+08:00",
  });
  assert.equal(early.verdict, "rejected");
  assert.ok(early.reasons.some((r) => r.code === "INSPECTION_PENDING"));

  // 保管员检查通过（发生在被拒扫码之后，否则重放会追溯放行那条扫码）
  await call(port, {
    method: "POST", path: "/replicas/replica-001/inspections", actor: KEEPER,
    body: { result: "pass", occurred_at: "2026-09-12T09:03:00+08:00" },
  });

  // 第一场：领用成功；另一台终端同时想领同一间 → 拒绝（单一占用者）
  const out1 = await scan(port, KIOSK_A, {
    event_id: "ka-002", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:05:00+08:00",
  });
  assert.equal(out1.verdict, "accepted");

  const occupied = await scan(port, KIOSK_B, {
    event_id: "kb-001", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "out", occurred_at: "2026-09-12T09:10:00+08:00",
  });
  assert.equal(occupied.verdict, "rejected");
  assert.ok(occupied.reasons.some((r) => r.code === "OCCUPIED"));

  // 承重读数正常上送（未超限）
  const reading = await scan(port, SENSOR, {
    event_id: "sr-001", device_id: SENSOR, kind: "load_reading", replica_id: "replica-001",
    value: 18.6, unit: "kg", occurred_at: "2026-09-12T09:15:00+08:00",
  });
  assert.equal(reading.verdict, "accepted");
  assert.equal(reading.anomaly, false);

  // 第一场结束归还 → 状态变为待检查，第二场之前不能直接放行
  const in1 = await scan(port, KIOSK_A, {
    event_id: "ka-003", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "in", occurred_at: "2026-09-12T09:55:00+08:00",
  });
  assert.equal(in1.verdict, "accepted");

  await scheduleSession(port, "S2", "2026-09-12T10:45:00+08:00", "2026-09-12T11:45:00+08:00", { occurred_at: "2026-09-12T09:56:00+08:00" });
  const a2 = await assign(port, "S2", "replica-001", GUIDE_B, { pickup_deadline: "2026-09-12T11:20:00+08:00", occurred_at: "2026-09-12T09:56:30+08:00" });
  assert.equal(a2.status, 201);

  const tooSoon = await scan(port, KIOSK_B, {
    event_id: "kb-002", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "out", occurred_at: "2026-09-12T09:58:00+08:00",
  });
  assert.equal(tooSoon.verdict, "rejected");
  assert.ok(tooSoon.reasons.some((r) => r.code === "INSPECTION_PENDING"));

  // 清洁组消毒（冷却 30 分钟），保管员复查通过；冷却未结束仍不可领
  await call(port, {
    method: "POST", path: "/replicas/replica-001/cleaning", actor: CLEANER,
    body: { cleaned_at: "2026-09-12T10:00:00+08:00" },
  });
  await call(port, {
    method: "POST", path: "/replicas/replica-001/inspections", actor: KEEPER,
    body: { result: "pass", occurred_at: "2026-09-12T10:05:00+08:00" },
  });
  const cooling = await scan(port, KIOSK_B, {
    event_id: "kb-003", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "out", occurred_at: "2026-09-12T10:10:00+08:00",
  });
  assert.equal(cooling.verdict, "rejected");
  assert.ok(cooling.reasons.some((r) => r.code === "COOLDOWN"));

  // 冷却结束 → 第二场领用成功，结束后归还
  const out2 = await scan(port, KIOSK_B, {
    event_id: "kb-004", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "out", occurred_at: "2026-09-12T10:31:00+08:00",
  });
  assert.equal(out2.verdict, "accepted");
  assert.equal(out2.assignment_id, a2.body.assignment_id);

  const in2 = await scan(port, KIOSK_B, {
    event_id: "kb-005", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "in", occurred_at: "2026-09-12T11:40:00+08:00",
  });
  assert.equal(in2.verdict, "accepted");

  // 时间线完整：每次状态变化可追溯，原始读数原样保留
  const timeline = (await call(port, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  const types = timeline.map((e) => e.type);
  assert.ok(types.includes("replica_registered"));
  assert.ok(types.includes("inspection_recorded"));
  assert.ok(types.includes("cleaning_recorded"));
  const readingEntry = timeline.find((e) => e.type === "device_event" && e.payload.kind === "load_reading");
  assert.equal(readingEntry.payload.value, 18.6);
  assert.equal(readingEntry.payload.raw.value, 18.6);
  // 全程任意时刻至多一个有效占用者：最终已无持有人
  const detail = (await call(port, { path: "/replicas/replica-001", actor: KEEPER })).body;
  assert.equal(detail.holder, null);
  assert.equal(detail.status, "pending_inspection"); // 归还后待再次检查
});
