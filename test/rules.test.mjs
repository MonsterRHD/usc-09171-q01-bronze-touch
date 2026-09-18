// 规则单元测试：传感器停用、读数不可覆盖、容量与辅助需求、鉴权、时间约定、改派。
import assert from "node:assert/strict";
import test from "node:test";
import {
  assign,
  boot,
  call,
  DESK,
  GUIDE_A,
  KEEPER,
  KIOSK_A,
  registerAvailableReplica,
  scan,
  scheduleSession,
  SENSOR,
  SUPERVISOR,
} from "./helpers.mjs";

test("承重超限即停用，保管员解除后方可放行；原始读数不被覆盖", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001"); // 上限 20kg
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T12:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });
  await assign(port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T12:00:00+08:00", occurred_at: "2026-09-12T08:31:00+08:00" });

  const over = await scan(port, SENSOR, {
    event_id: "sr-1", device_id: SENSOR, kind: "load_reading", replica_id: "replica-001",
    value: 25.4, unit: "kg", occurred_at: "2026-09-12T09:01:00+08:00",
  });
  assert.equal(over.verdict, "accepted");
  assert.equal(over.anomaly, true);

  const blocked = await scan(port, KIOSK_A, {
    event_id: "ka-1", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:02:00+08:00",
  });
  assert.equal(blocked.verdict, "rejected");
  assert.ok(blocked.reasons.some((r) => r.code === "SENSOR_ANOMALY"));

  // 后续合格读数不会自动解除停用，也不会覆盖历史读数
  await scan(port, SENSOR, {
    event_id: "sr-2", device_id: SENSOR, kind: "load_reading", replica_id: "replica-001",
    value: 3.2, unit: "kg", occurred_at: "2026-09-12T09:03:00+08:00",
  });
  let detail = (await call(port, { path: "/replicas/replica-001", actor: KEEPER })).body;
  assert.equal(detail.status, "deactivated");
  assert.equal(detail.last_reading.value, 3.2); // 最新读数可见
  const timeline = (await call(port, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  const readings = timeline.filter((e) => e.type === "device_event" && e.payload.kind === "load_reading");
  assert.deepEqual(readings.map((e) => e.payload.raw.value), [25.4, 3.2]); // 两条原始读数都在

  await call(port, {
    method: "POST", path: "/replicas/replica-001/deactivation/clear", actor: KEEPER,
    body: { notes: "复核为观众放置背包所致", occurred_at: "2026-09-12T09:10:00+08:00" },
  });
  detail = (await call(port, { path: "/replicas/replica-001", actor: KEEPER })).body;
  assert.equal(detail.status, "available");
});

test("重复扫码幂等：同一 event_id 不产生重复事实", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001");
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T12:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });
  await assign(port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T12:00:00+08:00", occurred_at: "2026-09-12T08:31:00+08:00" });
  const event = {
    event_id: "ka-dup", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:00:00+08:00",
  };
  const first = await scan(port, KIOSK_A, event);
  const second = await scan(port, KIOSK_A, event);
  assert.equal(first.verdict, "accepted");
  assert.equal(second.duplicate, true);
  assert.equal(second.verdict, "accepted");
  const timeline = (await call(port, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  assert.equal(timeline.filter((e) => e.type === "device_event" && e.payload.event_id === "ka-dup").length, 1);
});

test("场次容量与观众辅助需求约束；被拒绝的安排留有记录", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001"); // 支持 wheelchair
  await registerAvailableReplica(port, "replica-002", { touch_constraints: {} }); // 不支持任何辅助
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T10:00:00+08:00", { capacity: 1, occurred_at: "2026-09-12T08:30:00+08:00" });

  // 无障碍服务台登记本场有轮椅观众
  const need = await call(port, {
    method: "POST", path: "/sessions/S1/assistance", actor: DESK,
    body: { need: "wheelchair", note: "两名轮椅观众" },
  });
  assert.equal(need.status, 201);

  // 不满足辅助需求的复刻件 → 422 NEEDS_NOT_MET
  const bad = await assign(port, "S1", "replica-002", GUIDE_A, { occurred_at: "2026-09-12T08:31:00+08:00" });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.details.reasons.some((r) => r.code === "NEEDS_NOT_MET"));

  // 满足的 → 成功；容量已满后再排 → 422 CAPACITY_FULL
  const ok = await assign(port, "S1", "replica-001", GUIDE_A, { occurred_at: "2026-09-12T08:32:00+08:00" });
  assert.equal(ok.status, 201);
  const full = await assign(port, "S1", "replica-001", GUIDE_A.replace("12", "07"), { occurred_at: "2026-09-12T08:33:00+08:00" });
  assert.equal(full.status, 422);
  assert.ok(full.body.error.details.reasons.some((r) => ["CAPACITY_FULL", "REPLICA_DOUBLE_BOOKED"].includes(r.code)));

  // 主管能在 /decisions 中看到被拒绝安排的依据
  const decisions = (await call(port, { path: "/decisions", actor: SUPERVISOR })).body;
  assert.ok(decisions.rejected_commands.some((c) => c.command === "assignment_created" && c.reasons.some((r) => r.code === "NEEDS_NOT_MET")));
});

test("改派：旧单作废留痕，新单生效", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001");
  await registerAvailableReplica(port, "replica-002");
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T10:00:00+08:00", { capacity: 2, occurred_at: "2026-09-12T08:30:00+08:00" });
  const a1 = await assign(port, "S1", "replica-001", GUIDE_A, { occurred_at: "2026-09-12T08:31:00+08:00" });
  assert.equal(a1.status, 201);
  const a2 = await assign(port, "S1", "replica-002", GUIDE_A, { replaces: a1.body.assignment_id, occurred_at: "2026-09-12T08:32:00+08:00" });
  assert.equal(a2.status, 201);
  assert.equal(a2.body.replaces, a1.body.assignment_id);
  const list = (await call(port, { path: "/assignments", actor: SUPERVISOR })).body;
  const oldOne = list.find((x) => x.assignment_id === a1.body.assignment_id);
  assert.equal(oldOne.state, "cancelled");
  assert.match(oldOne.cancel_reason.message, /改派/);
});

test("受控接口：未认证/越权/设备身份不符都被拒绝", async (t) => {
  const { port } = await boot(t);
  // 无身份
  assert.equal((await call(port, { path: "/replicas" })).status, 401);
  // 讲解员不能登记复刻件（需保管员）
  const forbidden = await call(port, {
    method: "POST", path: "/replicas", actor: GUIDE_A,
    body: { original_ref: "x", name: "x", load_limit_kg: 1 },
  });
  assert.equal(forbidden.status, 403);
  // 未登记设备
  assert.equal((await call(port, { method: "POST", path: "/devices/events", device: "kiosk-z", body: {} })).status, 401);
  // 传感器不允许上报扫码事件
  await registerAvailableReplica(port, "replica-001");
  const wrong = await call(port, {
    method: "POST", path: "/devices/events", device: SENSOR,
    body: { event_id: "sr-x", device_id: SENSOR, kind: "handover_scan", replica_id: "replica-001", actor_ref: GUIDE_A, occurred_at: "2026-09-12T09:00:00+08:00" },
  });
  assert.equal(wrong.body.results[0].error.code, "KIND_FORBIDDEN");
  // 事件 device_id 与终端身份不符
  const mismatch = await call(port, {
    method: "POST", path: "/devices/events", device: KIOSK_A,
    body: { event_id: "e1", device_id: "kiosk-b", kind: "handover_scan", replica_id: "replica-001", occurred_at: "2026-09-12T09:00:00+08:00" },
  });
  assert.equal(mismatch.body.results[0].error.code, "DEVICE_MISMATCH");
});

test("时间字段约定：必须带时区偏移，否则 400", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001");
  const bad = await call(port, {
    method: "POST", path: "/devices/events", device: KIOSK_A,
    body: { event_id: "e1", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001", actor_ref: GUIDE_A, occurred_at: "2026-09-12 09:00:00" },
  });
  assert.equal(bad.body.results[0].error.code, "BAD_TIME");
  const badCmd = await call(port, {
    method: "POST", path: "/sessions", actor: SUPERVISOR,
    body: { title: "x", starts_at: "2026-09-12T09:00:00", ends_at: "2026-09-12T10:00:00+08:00", capacity: 1 },
  });
  assert.equal(badCmd.status, 400);
  assert.equal(badCmd.body.error.code, "BAD_TIME");
});

test("人员后登记可解开挂起事件；合同样例事件可原样接入", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001");
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T10:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });

  // 合同样例（无 direction，含设备侧 received_at）原样上送；guide-99 未登记 → 挂起
  const sample = {
    event_id: "kiosk-a-0007", device_id: "kiosk-a", kind: "handover_scan", replica_id: "replica-001",
    actor_ref: "guide-99", occurred_at: "2026-09-12T09:02:11+08:00", received_at: "2026-09-12T09:02:12+08:00",
  };
  const first = await scan(port, KIOSK_A, sample);
  assert.equal(first.verdict, "pending");

  // 未登记人员不能排领用单
  const noAssignee = await assign(port, "S1", "replica-001", "guide-99", { occurred_at: "2026-09-12T08:35:00+08:00" });
  assert.equal(noAssignee.status, 422);

  // 主管登记该讲解员并补排领用单 → 挂起事件重放后得到确定判定
  await call(port, {
    method: "POST", path: "/staff", actor: SUPERVISOR,
    body: { staff_id: "guide-99", name: "讲解员·新", role: "guide", occurred_at: "2026-09-12T08:35:00+08:00" },
  });
  const a = await assign(port, "S1", "replica-001", "guide-99", { pickup_deadline: "2026-09-12T10:00:00+08:00", occurred_at: "2026-09-12T08:36:00+08:00" });
  assert.equal(a.status, 201);

  const after = (await call(port, { path: "/devices/events/kiosk-a-0007", device: KIOSK_A })).body;
  assert.equal(after.verdict, "accepted");
  assert.equal(after.direction, "out"); // 无持有人时默认领用

  // 设备侧 received_at 与平台 received_at 各自保留，互不替代
  const timeline = (await call(port, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  const entry = timeline.find((e) => e.type === "device_event" && e.payload.event_id === "kiosk-a-0007");
  assert.equal(entry.payload.client_received_at, "2026-09-12T09:02:12+08:00");
  assert.equal(entry.payload.raw.received_at, "2026-09-12T09:02:12+08:00");
  assert.ok(entry.payload.received_at); // 平台接收时间
});
