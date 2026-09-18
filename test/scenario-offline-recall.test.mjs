// 验收流程三：终端离线期间保管员紧急召回，恢复联网后补传。
// 覆盖：召回阻断放行、离线补传按实际发生顺序重放、判定反转留痕、重复扫码幂等。
import assert from "node:assert/strict";
import test from "node:test";
import {
  assign,
  boot,
  call,
  GUIDE_A,
  KEEPER,
  KIOSK_A,
  KIOSK_B,
  registerAvailableReplica,
  scan,
  scheduleSession,
  SUPERVISOR,
} from "./helpers.mjs";

test("离线后召回：补传按发生顺序重放，反转留痕，重复扫码幂等", async (t) => {
  const { port } = await boot(t);
  await registerAvailableReplica(port, "replica-001");
  await scheduleSession(port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T12:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });
  const a = await assign(port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T12:00:00+08:00", occurred_at: "2026-09-12T08:31:00+08:00" });
  assert.equal(a.status, 201);

  // 09:00 一层终端领用成功；此后二层终端 kiosk-b 离线
  const out = await scan(port, KIOSK_A, {
    event_id: "ka-100", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:00:00+08:00",
  });
  assert.equal(out.verdict, "accepted");

  // 09:30 保管员紧急召回（发现裂纹）→ 持有未归，冲突队列出现“召回归还待办”
  await call(port, {
    method: "POST", path: "/replicas/replica-001/recall", actor: KEEPER,
    body: { reason: "例行巡检发现裂纹", occurred_at: "2026-09-12T09:30:00+08:00" },
  });
  let conflicts = (await call(port, { path: "/conflicts", actor: SUPERVISOR })).body;
  assert.ok(conflicts.some((c) => c.type === "recall_outstanding" && c.replica_id === "replica-001"));

  // 09:35 讲解员在一层终端归还（召回期间允许归还）→ 召回待办消除
  const back = await scan(port, KIOSK_A, {
    event_id: "ka-101", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "in", occurred_at: "2026-09-12T09:35:00+08:00",
  });
  assert.equal(back.verdict, "accepted");
  conflicts = (await call(port, { path: "/conflicts", actor: SUPERVISOR })).body;
  assert.ok(!conflicts.some((c) => c.type === "recall_outstanding"));

  // 09:40 召回期间任何领用都被拒绝
  const blocked = await scan(port, KIOSK_A, {
    event_id: "ka-102", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:40:00+08:00",
  });
  assert.equal(blocked.verdict, "rejected");
  assert.ok(blocked.reasons.some((r) => r.code === "RECALLED"));

  // kiosk-b 恢复联网，补传离线期间的三条记录（其中 kb-1 重复上传一次）
  const batch = await call(port, {
    method: "POST", path: "/devices/events", device: KIOSK_B,
    body: { events: [
      { event_id: "kb-1", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
        actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:10:00+08:00" },
      { event_id: "kb-2", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
        actor_ref: GUIDE_A, direction: "in", occurred_at: "2026-09-12T09:20:00+08:00" },
      { event_id: "kb-1", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
        actor_ref: GUIDE_A, direction: "out", occurred_at: "2026-09-12T09:10:00+08:00" },
    ] },
  });
  const [kb1, kb2, kb1dup] = batch.body.results;
  // 09:10 时一层已领出，补传的再次领用按发生顺序判定为冲突拒绝
  assert.equal(kb1.verdict, "rejected");
  assert.ok(kb1.reasons.some((r) => r.code === "OCCUPIED"));
  // 09:20 的归还发生在召回之前，补传后成立
  assert.equal(kb2.verdict, "accepted");
  // 重复上传幂等：返回既有判定，不产生新事实
  assert.equal(kb1dup.duplicate, true);
  assert.equal(kb1dup.verdict, "rejected");

  // 补传重放后，09:35 那条“归还”在 09:20 已归还的前提下不再成立 → 判定反转并留痕
  const flipped = (await call(port, { path: "/devices/events/ka-101", device: KIOSK_A })).body;
  assert.equal(flipped.verdict, "rejected");
  assert.ok(flipped.reasons.some((r) => r.code === "NO_ACTIVE_LOAN"));
  conflicts = (await call(port, { path: "/conflicts", actor: SUPERVISOR })).body;
  const reversal = conflicts.find((c) => c.type === "decision_reversed" && c.event_id === "ka-101");
  assert.ok(reversal, "应存在判定反转冲突");
  assert.equal(reversal.from, "accepted");
  assert.equal(reversal.to, "rejected");

  // 主管确认该冲突
  const ack = await call(port, { method: "POST", path: `/conflicts/${reversal.id}/ack`, actor: SUPERVISOR, body: {} });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.acknowledged, true);

  // 终态：召回生效、无人持有、待检查；时间线按实际发生顺序排列
  const detail = (await call(port, { path: "/replicas/replica-001", actor: KEEPER })).body;
  assert.equal(detail.status, "recalled");
  assert.equal(detail.holder, null);
  const timeline = (await call(port, { path: "/replicas/replica-001/timeline", actor: KEEPER })).body;
  const occurred = timeline.map((e) => Date.parse(e.occurred_at));
  assert.deepEqual(occurred, [...occurred].sort((x, y) => x - y));

  // 保管员解除召回（随附检查通过）→ 恢复可放行
  const cleared = await call(port, {
    method: "POST", path: "/replicas/replica-001/recall/clear", actor: KEEPER,
    body: { notes: "裂纹为表面划痕，复核无碍", occurred_at: "2026-09-12T10:00:00+08:00" },
  });
  assert.equal(cleared.status, 201);
  assert.equal(cleared.body.status, "available");
});
