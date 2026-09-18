// 验收流程二：两台终端同时交接同一件复刻件。
// 覆盖：同一 occurred_at 下先到先得的确定性、拒绝理由可解释、结果与到达顺序一致。
import assert from "node:assert/strict";
import test from "node:test";
import {
  assign,
  boot,
  call,
  GUIDE_A,
  KIOSK_A,
  KIOSK_B,
  registerAvailableReplica,
  scan,
  scheduleSession,
  SUPERVISOR,
} from "./helpers.mjs";

const AT = "2026-09-12T09:00:00+08:00";

async function prepare(t) {
  const ctx = await boot(t);
  await registerAvailableReplica(ctx.port, "replica-001");
  await scheduleSession(ctx.port, "S1", "2026-09-12T09:00:00+08:00", "2026-09-12T10:00:00+08:00", { occurred_at: "2026-09-12T08:30:00+08:00" });
  const a = await assign(ctx.port, "S1", "replica-001", GUIDE_A, { pickup_deadline: "2026-09-12T09:30:00+08:00", occurred_at: "2026-09-12T08:31:00+08:00" });
  assert.equal(a.status, 201);
  return ctx;
}

test("两台终端同一时刻扫码领用：恰有一个成功，另一个被拒且理由可解释", async (t) => {
  const { port } = await prepare(t);

  const first = await scan(port, KIOSK_A, {
    event_id: "ka-race", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: AT,
  });
  const second = await scan(port, KIOSK_B, {
    event_id: "kb-race", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: AT,
  });

  assert.equal(first.verdict, "accepted");
  assert.equal(second.verdict, "rejected");
  assert.ok(second.reasons.some((r) => r.code === "OCCUPIED"));
  assert.match(second.reasons.find((r) => r.code === "OCCUPIED").message, /同一时刻只能有一个有效占用者/);

  // 主管视角：能调出这次拒绝的依据（谁持有、何时开始）
  const decisions = (await call(port, { path: "/decisions?verdict=rejected", actor: SUPERVISOR })).body;
  const rejected = decisions.device_decisions.find((d) => d.event_id === "kb-race");
  assert.ok(rejected);
  const occupied = rejected.reasons.find((r) => r.code === "OCCUPIED");
  assert.equal(occupied.facts.holder.actor, GUIDE_A);
  assert.equal(occupied.facts.holder.device_id, KIOSK_A);

  // 板上只有一名持有人
  const detail = (await call(port, { path: "/replicas/replica-001", actor: SUPERVISOR })).body;
  assert.equal(detail.holder.device_id, KIOSK_A);
});

test("同样的竞争按相反顺序到达：先到的终端获胜，结果确定性一致", async (t) => {
  const { port } = await prepare(t);

  const first = await scan(port, KIOSK_B, {
    event_id: "kb-race", device_id: KIOSK_B, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: AT,
  });
  const second = await scan(port, KIOSK_A, {
    event_id: "ka-race", device_id: KIOSK_A, kind: "handover_scan", replica_id: "replica-001",
    actor_ref: GUIDE_A, direction: "out", occurred_at: AT,
  });

  assert.equal(first.verdict, "accepted");
  assert.equal(second.verdict, "rejected");
  assert.ok(second.reasons.some((r) => r.code === "OCCUPIED"));

  const detail = (await call(port, { path: "/replicas/replica-001", actor: SUPERVISOR })).body;
  assert.equal(detail.holder.device_id, KIOSK_B);
});
