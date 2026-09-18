// HTTP 接口：角色权限、contracts 样例兼容、决策解释查询。

import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/app.mjs";
import { makeConfig, mutableClock } from "./helpers.mjs";
import { DataStore } from "../src/store/datastore.mjs";
import contractEvents from "../contracts/device-events.json" with { type: "json" };

const TOKENS = {
  guide: "guide-token",
  curator: "curator-token",
  supervisor: "supervisor-token",
  cleaner: "cleaner-token",
  device: "device-token",
};

async function startApi(t) {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const config = makeConfig();
  const store = await DataStore.open({ dir: null, config, clock: clock.clock });
  const server = createServer({ store, config, clock: clock.clock });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, clock };
}

test("健康检查无需认证", async (t) => {
  const { call } = await startApi(t);
  const res = await call("GET", "/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
});

test("角色权限：未认证 401，越权 403", async (t) => {
  const { call } = await startApi(t);

  assert.equal((await call("GET", "/replicas")).status, 401, "无令牌");
  assert.equal((await call("GET", "/replicas", { token: "wrong" })).status, 401, "错误令牌");

  const reg = { replica_id: "replica-001", artifact_ref: "artifact-1", load_limit_kg: 20 };
  assert.equal((await call("POST", "/replicas", { token: TOKENS.guide, body: reg })).status, 403, "讲解员不能登记");
  assert.equal((await call("POST", "/replicas", { token: TOKENS.device, body: reg })).status, 403, "终端不能登记");
  assert.equal((await call("POST", "/replicas", { token: TOKENS.curator, body: reg })).status, 201, "保管员可登记");

  assert.equal((await call("POST", "/replicas/replica-001/recall", { token: TOKENS.guide, body: { reason: "x" } })).status, 403, "讲解员不能召回");
  assert.equal((await call("POST", "/closures", { token: TOKENS.curator, body: { reason: "x" } })).status, 403, "保管员不能闭馆");
  assert.equal((await call("GET", "/decisions", { token: TOKENS.guide })).status, 403, "讲解员不能查决策日志");
  assert.equal((await call("GET", "/decisions", { token: TOKENS.supervisor })).status, 200, "主管可查决策日志");
  assert.equal((await call("POST", "/devices/events", { token: TOKENS.guide, body: [] })).status, 403, "讲解员不能直传设备事件");
});

test("contracts 样例事件可直接上报，字段约定兼容", async (t) => {
  const { call } = await startApi(t);
  await call("POST", "/replicas", {
    token: TOKENS.curator,
    body: { replica_id: "replica-001", artifact_ref: "artifact-青铜尊", load_limit_kg: 20, touch_restrictions: [] },
  });
  await call("POST", "/replicas/replica-001/inspections", { token: TOKENS.curator, body: { result: "passed" } });

  // 直接 POST contracts/device-events.json 中的两条样例
  const res = await call("POST", "/devices/events", { token: TOKENS.device, body: contractEvents });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => r.status), ["applied", "applied"]);
  assert.deepEqual(res.body.results.map((r) => r.event_id), ["kiosk-a-0007", "sensor-r1-031"]);

  const replica = (await call("GET", "/replicas/replica-001", { token: TOKENS.guide })).body.replica;
  assert.equal(replica.current_holder.actor_ref, "guide-12", "扫码交接保留人员");
  assert.equal(replica.current_holder.device_id, "kiosk-a");
  assert.equal(replica.last_reading.value, 18.6, "承重读数保留");
  assert.equal(replica.last_reading.at, "2026-09-12T09:05:00+08:00", "读数时间取 occurred_at 而非 received_at");

  // 重复上传同一批 → 幂等
  const again = await call("POST", "/devices/events", { token: TOKENS.device, body: contractEvents });
  assert.deepEqual(again.body.results.map((r) => r.status), ["duplicate", "duplicate"]);
});

test("主管解释一次拒绝：决策含原因、中文说明与证据事件", async (t) => {
  const { call, clock } = await startApi(t);
  await call("POST", "/replicas", { token: TOKENS.curator, body: { replica_id: "replica-001", artifact_ref: "a-1", load_limit_kg: 20 } });
  await call("POST", "/replicas/replica-001/inspections", { token: TOKENS.curator, body: { result: "passed" } });
  await call("POST", "/replicas/replica-001/recall", { token: TOKENS.curator, body: { reason: "表面发现划痕" } });

  clock.set("2026-09-12T10:00:00+08:00");
  const scan = {
    event_id: "a-1", device_id: "kiosk-a", kind: "handover_scan",
    replica_id: "replica-001", actor_ref: "guide-12", occurred_at: "2026-09-12T10:00:00+08:00",
  };
  const res = await call("POST", "/devices/events", { token: TOKENS.device, body: scan });
  const decision = res.body.results[0].decisions[0];
  assert.equal(decision.result, "checkout_rejected");
  assert.equal(decision.reason, "recalled");
  assert.equal(decision.reason_detail, "展品已被保管员召回");

  const list = await call("GET", "/decisions?replica_id=replica-001&result=checkout_rejected", { token: TOKENS.supervisor });
  assert.equal(list.body.decisions.length, 1);
  assert.equal(list.body.decisions[0].reason_detail, "展品已被保管员召回");

  const timeline = await call("GET", "/replicas/replica-001/timeline", { token: TOKENS.supervisor });
  const summaries = timeline.body.timeline.map((x) => x.summary);
  assert.ok(summaries.some((s) => s.includes("召回")));
  assert.ok(summaries.some((s) => s.includes("扫码领取被拒绝")));
});

test("改派：原预约被召回影响后，主管改派到另一件复刻件", async (t) => {
  const { call, clock } = await startApi(t);
  for (const id of ["replica-001", "replica-002"]) {
    await call("POST", "/replicas", { token: TOKENS.curator, body: { replica_id: id, artifact_ref: "a-1", load_limit_kg: 20 } });
    await call("POST", `/replicas/${id}/inspections`, { token: TOKENS.curator, body: { result: "passed" } });
  }
  await call("POST", "/sessions", {
    token: TOKENS.supervisor,
    body: { session_id: "s1", title: "上午场", starts_at: "2026-09-12T10:00:00+08:00", ends_at: "2026-09-12T10:45:00+08:00", capacity: 3 },
  });
  const booked = await call("POST", "/sessions/s1/bookings", { token: TOKENS.guide, body: { replica_id: "replica-001" } });
  assert.equal(booked.body.decision.result, "confirmed");
  const bookingId = booked.body.booking.booking_id;

  // 原复刻件被召回 → 主管改派到 replica-002
  await call("POST", "/replicas/replica-001/recall", { token: TOKENS.curator, body: { reason: "复检" } });
  clock.set("2026-09-12T09:30:00+08:00");
  const reassigned = await call("POST", `/bookings/${bookingId}/reassign`, {
    token: TOKENS.supervisor,
    body: { replica_id: "replica-002", reason: "replica-001 被保管员召回", reason_code: "recalled" },
  });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.body.original.status, "reassigned");
  assert.equal(reassigned.body.replacement.decision.result, "confirmed");
  assert.equal(reassigned.body.replacement.booking.replica_id, "replica-002");

  // 改派依据可查：原预约的决策历史包含 reassigned 及原因
  const detail = await call("GET", `/bookings/${bookingId}`, { token: TOKENS.supervisor });
  const reassignDecision = detail.body.decisions.find((d) => d.result === "reassigned");
  assert.equal(reassignDecision.reason_note, "replica-001 被保管员召回");
});

test("闭馆接口：重复闭馆 409，恢复后再次闭馆允许", async (t) => {
  const { call } = await startApi(t);
  const first = await call("POST", "/closures", { token: TOKENS.supervisor, body: { reason: "客流管控" } });
  assert.equal(first.status, 201);
  const closureId = first.body.closure.closure_id;

  const dup = await call("POST", "/closures", { token: TOKENS.supervisor, body: { reason: "又一次" } });
  assert.equal(dup.status, 409);

  const lift = await call("POST", `/closures/${closureId}/lift`, { token: TOKENS.supervisor });
  assert.equal(lift.status, 200);
  const relift = await call("POST", `/closures/${closureId}/lift`, { token: TOKENS.supervisor });
  assert.equal(relift.status, 409);

  const second = await call("POST", "/closures", { token: TOKENS.supervisor, body: { reason: "再次闭馆" } });
  assert.equal(second.status, 201);
});

test("待处理补传接口与未知复刻件 404", async (t) => {
  const { call } = await startApi(t);
  const scan = {
    event_id: "a-1", device_id: "kiosk-a", kind: "handover_scan",
    replica_id: "replica-404", actor_ref: "guide-1", occurred_at: "2026-09-12T10:00:00+08:00",
  };
  await call("POST", "/devices/events", { token: TOKENS.device, body: scan });
  const pending = await call("GET", "/backfill/pending", { token: TOKENS.supervisor });
  assert.equal(pending.body.pending.length, 1);
  assert.equal(pending.body.pending[0].replica_id, "replica-404");

  assert.equal((await call("GET", "/replicas/replica-404", { token: TOKENS.guide })).status, 404);
  assert.equal((await call("POST", "/replicas/replica-404/recall", { token: TOKENS.curator, body: {} })).status, 404);
});
