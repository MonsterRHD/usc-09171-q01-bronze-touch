// 重放引擎：排序、幂等去重、离线补传改判、待处理事件。

import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, mutableClock, register, inspect, scan, reading } from "./helpers.mjs";

test("离线补传按 occurred_at 重排，占用者与决策随之改判", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  // 平台先收到 10:00 的领取（kiosk-a）
  await store.ingestDeviceEvents([scan({ id: "a-1", device: "kiosk-a", actor: "guide-1", at: "2026-09-12T10:00:00+08:00" })]);
  assert.equal(store.state.replicas["replica-001"].current_holder.actor_ref, "guide-1");

  // 离线终端恢复后补传 09:55 的领取（实际发生更早）
  await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-2", at: "2026-09-12T09:55:00+08:00" })]);

  const replica = store.state.replicas["replica-001"];
  assert.equal(replica.current_holder.actor_ref, "guide-2", "按实际发生顺序，guide-2 先领取");
  assert.equal(replica.current_holder.since, "2026-09-12T09:55:00+08:00");

  // guide-1 的扫码被改判为 already_held；两个版本都留在决策历史中
  const history = store.decisionHistory.filter((d) => d.subject_id === "kiosk-a:a-1");
  assert.equal(history.length, 2);
  assert.equal(history[0].result, "checkout_granted");
  assert.equal(history[0].revision, 1);
  assert.equal(history[1].result, "checkout_rejected");
  assert.equal(history[1].reason, "already_held");
  assert.equal(history[1].revision, 2);
  assert.deepEqual(history[1].evidence, ["kiosk-b:b-1"], "改判依据指向先发生的扫码事件");
});

test("同一终端重复上传同一 event_id 被幂等去重", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  const event = scan({ id: "a-7", actor: "guide-1", at: "2026-09-12T10:00:00+08:00" });
  const first = await store.ingestDeviceEvents([event]);
  assert.equal(first.results[0].status, "applied");
  const decisionCount = store.decisionHistory.length;

  const second = await store.ingestDeviceEvents([event, { ...event }]);
  assert.equal(second.results[0].status, "duplicate");
  assert.equal(second.results[1].status, "duplicate");
  assert.equal(store.decisionHistory.length, decisionCount, "重复事件不产生新决策");
  assert.equal(store.state.replicas["replica-001"].current_holder.actor_ref, "guide-1");
});

test("引用未登记复刻件的事件进入待处理队列，登记后自动吸收", async () => {
  const clock = mutableClock("2026-09-12T10:05:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  const res = await store.ingestDeviceEvents([
    scan({ id: "a-1", replica: "replica-009", actor: "guide-1", at: "2026-09-12T10:00:00+08:00" }),
    reading({ id: "r-1", replica: "replica-009", value: 12.5, at: "2026-09-12T10:01:00+08:00" }),
  ]);
  assert.deepEqual(res.results.map((r) => r.status), ["pending", "pending"]);
  assert.equal(store.state.pending.length, 2);
  assert.equal(store.state.replicas["replica-009"], undefined);

  // 登记后（登记时间晚于事件 occurred_at）：事件在登记点补应用，
  // 读数直接生效；扫码因登记后尚未检查被确定拒绝，同样给出结论。
  clock.set("2026-09-12T10:10:00+08:00");
  await register(store, "replica-009");
  assert.equal(store.state.pending.length, 0, "登记后待处理事件被重放吸收");
  assert.equal(store.state.replicas["replica-009"].last_reading.value, 12.5);
  const scanDecision = store.state.decisions.find((d) => d.subject_id === "kiosk-a:a-1");
  assert.equal(scanDecision.result, "checkout_rejected");
  assert.equal(scanDecision.reason, "inspection_pending");

  // 检查通过后即可正常领取
  clock.set("2026-09-12T10:15:00+08:00");
  await inspect(store, "replica-009", "passed");
  const ok = await store.ingestDeviceEvents([scan({ id: "a-2", replica: "replica-009", actor: "guide-1", at: "2026-09-12T10:16:00+08:00" })]);
  assert.equal(ok.results[0].decisions[0].result, "checkout_granted");
  assert.equal(store.state.replicas["replica-009"].current_holder.actor_ref, "guide-1");
});

test("原始读数不被覆盖：时间线保留全部读数，当前值取实际发生最新的一条", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");

  // 乱序补传：先收到 10:08 的读数，再补 10:05 的读数
  await store.ingestDeviceEvents([reading({ id: "r-2", value: 18.6, at: "2026-09-12T10:08:00+08:00" })]);
  await store.ingestDeviceEvents([reading({ id: "r-1", value: 15.2, at: "2026-09-12T10:05:00+08:00" })]);

  const replica = store.state.replicas["replica-001"];
  assert.equal(replica.last_reading.value, 18.6, "当前读数按 occurred_at 取最新");
  const readings = store.state.timelines["replica-001"].filter((t) => t.kind === "load_reading");
  assert.equal(readings.length, 2, "两条原始读数都在时间线中");
  assert.deepEqual(readings.map((r) => r.at), ["2026-09-12T10:05:00+08:00", "2026-09-12T10:08:00+08:00"], "时间线按实际发生顺序排列");
});

test("非法设备事件被校验拒绝，不进入日志", async () => {
  const store = await makeStore({});
  const res = await store.ingestDeviceEvents([
    { event_id: "x-1", device_id: "kiosk-a", kind: "handover_scan", occurred_at: "not-a-time" },
    { event_id: "x-2", device_id: "kiosk-a", kind: "load_reading", replica_id: "replica-001", value: "abc", occurred_at: "2026-09-12T10:00:00+08:00" },
    { event_id: "x-3", device_id: "kiosk-a", kind: "teleport", replica_id: "replica-001", occurred_at: "2026-09-12T10:00:00+08:00" },
  ]);
  assert.deepEqual(res.results.map((r) => r.status), ["invalid", "invalid", "invalid"]);
  assert.equal(store.entries.length, 0);
});
