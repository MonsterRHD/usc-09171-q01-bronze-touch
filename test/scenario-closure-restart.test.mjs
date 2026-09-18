// 验收流程四：临时闭馆与恢复，以及次日重启后的数据完整性。
// 覆盖：闭馆窗口内拒绝放行、提前解除后恢复、迟到拒绝、重启后记录/待处理补传/幂等性完整。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../src/app.mjs";
import {
  assign,
  call,
  GUIDE_A,
  GUIDE_B,
  KEEPER,
  KIOSK_A,
  registerAvailableReplica,
  scan,
  scheduleSession,
  SUPERVISOR,
} from "./helpers.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

test("临时闭馆→恢复→迟到拒绝→次日重启数据完整", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-touch-day1-"));
  const server1 = createServer({ dataDir: dir });
  const port = await listen(server1);
  t.after(() => server1.close());

  await registerAvailableReplica(port, "replica-001");
  await scheduleSession(port, "S1", "2026-09-12T14:00:00+08:00", "2026-09-12T16:00:00+08:00", { capacity: 2, occurred_at: "2026-09-12T13:00:00+08:00" });
  const a1 = await assign(port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T15:00:00+08:00", occurred_at: "2026-09-12T13:01:00+08:00" });
  assert.equal(a1.status, 201);

  // 13:45 主管宣布 13:50~14:30 临时闭馆（设备检修）
  const closure = await call(port, {
    method: "POST", path: "/closures", actor: SUPERVISOR,
    body: { starts_at: "2026-09-12T13:50:00+08:00", ends_at: "2026-09-12T14:30:00+08:00", reason: "传感线路检修", occurred_at: "2026-09-12T13:45:00+08:00" },
  });
  assert.equal(closure.status, 201);
  const closureId = closure.body.id;

  // 闭馆窗口内的领用扫码 → 拒绝，理由 CLOSED
  const duringClosure = await scan(port, KIOSK_A, {
    event_id: "ka-201", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T14:05:00+08:00",
  });
  assert.equal(duringClosure.verdict, "rejected");
  assert.ok(duringClosure.reasons.some((r) => r.code === "CLOSED"));

  // 14:10 提前解除闭馆 → 14:12 领用成功
  const lift = await call(port, {
    method: "POST", path: `/closures/${closureId}/lift`, actor: SUPERVISOR,
    body: { occurred_at: "2026-09-12T14:10:00+08:00" },
  });
  assert.equal(lift.status, 200);
  const out = await scan(port, KIOSK_A, {
    event_id: "ka-202", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T14:12:00+08:00",
  });
  assert.equal(out.verdict, "accepted");

  // 14:50 归还，14:55 检查通过
  await scan(port, KIOSK_A, {
    event_id: "ka-203", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "in", occurred_at: "2026-09-12T14:50:00+08:00",
  });
  await call(port, {
    method: "POST", path: "/replicas/replica-001/inspections", actor: KEEPER,
    body: { result: "pass", occurred_at: "2026-09-12T14:55:00+08:00" },
  });

  // 15:01 超过领用截止 15:00 → 迟到拒绝
  const a2 = await assign(port, "S1", "replica-001", GUIDE_B, { pickup_deadline: "2026-09-12T15:00:00+08:00", occurred_at: "2026-09-12T14:56:00+08:00" });
  assert.equal(a2.status, 201);
  const late = await scan(port, KIOSK_A, {
    event_id: "ka-204", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_B, direction: "out", occurred_at: "2026-09-12T15:01:00+08:00",
  });
  assert.equal(late.verdict, "rejected");
  assert.ok(late.reasons.some((r) => r.code === "LATE"));

  // 一件未登记复刻件的扫码 → 挂起（待处理补传）
  const pending = await scan(port, KIOSK_A, {
    event_id: "ka-205", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-999",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T15:10:00+08:00",
  });
  assert.equal(pending.verdict, "pending");

  // ---- 次日重启：同一数据目录重新启动服务 ----
  await new Promise((resolve) => server1.close(resolve));
  const server2 = createServer({ dataDir: dir });
  const port2 = await listen(server2);
  t.after(() => server2.close());

  // 当天记录完整：状态、时间线、判定、冲突都在
  const detail = (await call(port2, { path: "/replicas/replica-001", actor: KEEPER })).body;
  assert.equal(detail.status, "available");
  const timeline = (await call(port2, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  assert.ok(timeline.some((e) => e.type === "device_event" && e.payload.event_id === "ka-202"));
  const decisions = (await call(port2, { path: "/decisions?replica_id=replica-001&verdict=rejected", actor: SUPERVISOR })).body;
  assert.ok(decisions.device_decisions.some((d) => d.event_id === "ka-201" && d.reasons.some((r) => r.code === "CLOSED")));
  assert.ok(decisions.device_decisions.some((d) => d.event_id === "ka-204" && d.reasons.some((r) => r.code === "LATE")));

  // 待处理补传仍在冲突队列
  const conflicts = (await call(port2, { path: "/conflicts", actor: SUPERVISOR })).body;
  assert.ok(conflicts.some((c) => c.type === "pending_event" && c.event_id === "ka-205"));

  // 幂等性跨重启保持：重传 ka-202 不重复入账
  const dup = await scan(port2, KIOSK_A, {
    event_id: "ka-202", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T14:12:00+08:00",
  });
  assert.equal(dup.duplicate, true);
  assert.equal(dup.verdict, "accepted");

  // 重启后登记 replica-999 → 挂起事件得到确定判定（未检查 → 拒绝），并留下反转记录
  await call(port2, {
    method: "POST", path: "/replicas", actor: KEEPER,
    body: {
      replica_id: "replica-999", original_ref: "bronze-爵-原件-002", name: "青铜爵复刻件",
      load_limit_kg: 5, touch_constraints: {}, occurred_at: "2026-09-13T09:00:00+08:00",
    },
  });
  const after = (await call(port2, { path: "/devices/events/ka-205", device: KIOSK_A })).body;
  assert.equal(after.verdict, "rejected");
  assert.ok(after.reasons.some((r) => r.code === "INSPECTION_PENDING"));
  const conflicts2 = (await call(port2, { path: "/conflicts", actor: SUPERVISOR })).body;
  assert.ok(conflicts2.some((c) => c.type === "decision_reversed" && c.event_id === "ka-205"));
});
