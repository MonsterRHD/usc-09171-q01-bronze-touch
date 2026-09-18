// 验收流程三：离线后召回 —— 补传事件按实际发生顺序与召回对齐；
// 已被召回的展品不能再次放行，直到保管员检查通过。

import assert from "node:assert/strict";
import test from "node:test";
import { makeStore, mutableClock, register, inspect, clean, recall, scan, reading } from "./helpers.mjs";

test("离线扫码发生在召回之前：占用有效但立即转为待归还，之后任何人不得再领", async () => {
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001", { cooldown: 0 });
  await inspect(store, "replica-001", "passed");

  // 终端离线：10:00 的扫码滞留本地；10:05 保管员在线召回；10:10 终端恢复补传
  clock.set("2026-09-12T10:05:00+08:00");
  await recall(store, "replica-001", "展柜玻璃出现裂纹");

  clock.set("2026-09-12T10:10:00+08:00");
  const res = await store.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:00:00+08:00" })]);
  assert.equal(res.results[0].status, "applied");

  const replica = store.state.replicas["replica-001"];
  assert.equal(replica.current_holder.actor_ref, "guide-12", "扫码发生时未召回，占用成立");
  assert.equal(replica.return_required, true, "召回后该占用转为待归还");
  assert.equal(replica.status, "return_required");
  assert.equal(replica.releasable.ok, false);
  assert.ok(replica.releasable.blockers.some((b) => b.reason === "recalled"));

  // 召回后新的领取一律被拒
  const after = await store.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-7", at: "2026-09-12T10:11:00+08:00" })]);
  assert.equal(after.results[0].decisions[0].result, "checkout_rejected");
  assert.equal(after.results[0].decisions[0].reason, "already_held", "仍被占用时先报占用");

  // 归还后再扫 → 因召回被拒
  await store.ingestDeviceEvents([scan({ id: "a-2", actor: "guide-12", at: "2026-09-12T10:20:00+08:00" })]);
  const again = await store.ingestDeviceEvents([scan({ id: "a-3", actor: "guide-12", at: "2026-09-12T10:25:00+08:00" })]);
  assert.equal(again.results[0].decisions[0].reason, "recalled");

  // 保管员完成清洁与检查后解除召回，可再次放行
  clock.set("2026-09-12T10:30:00+08:00");
  await clean(store, "replica-001", "completed");
  clock.set("2026-09-12T10:40:00+08:00");
  await inspect(store, "replica-001", "passed");
  assert.equal(store.state.replicas["replica-001"].status, "available");
  const ok = await store.ingestDeviceEvents([scan({ id: "a-4", actor: "guide-12", at: "2026-09-12T10:41:00+08:00" })]);
  assert.equal(ok.results[0].decisions[0].result, "checkout_granted");
});

test("补传扫码发生在召回之后：重放直接判拒，不产生占用", async () => {
  const clock = mutableClock("2026-09-12T10:05:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001");
  await inspect(store, "replica-001", "passed");
  await recall(store, "replica-001", "例行复核");

  // 离线终端 10:06（召回之后）的扫码，10:10 才补传
  clock.set("2026-09-12T10:10:00+08:00");
  const res = await store.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:06:00+08:00" })]);
  const decision = res.results[0].decisions[0];
  assert.equal(decision.result, "checkout_rejected");
  assert.equal(decision.reason, "recalled");
  assert.equal(store.state.replicas["replica-001"].current_holder, null, "召回后的扫码不产生占用");
});

test("承重传感器超限自动停用，检查通过后恢复；原始读数保留", async () => {
  const clock = mutableClock("2026-09-12T08:00:00+08:00");
  const store = await makeStore({ clock: clock.clock });
  await register(store, "replica-001", { load: 20, cooldown: 0 });
  await inspect(store, "replica-001", "passed");

  // 占用中超限 → 自动停用 + 待归还
  await store.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:00:00+08:00" })]);
  await store.ingestDeviceEvents([reading({ id: "r-1", value: 25.4, at: "2026-09-12T10:03:00+08:00" })]);

  const replica = store.state.replicas["replica-001"];
  assert.equal(replica.suspended, true);
  assert.equal(replica.return_required, true);
  const suspend = store.state.decisions.find((d) => d.result === "auto_suspended");
  assert.equal(suspend.reason, "load_exceeded");
  assert.equal(suspend.value, 25.4);
  assert.equal(suspend.limit, 20);

  // 归还后仍停用，扫码被拒
  await store.ingestDeviceEvents([scan({ id: "a-2", actor: "guide-12", at: "2026-09-12T10:10:00+08:00" })]);
  const res = await store.ingestDeviceEvents([scan({ id: "a-3", actor: "guide-12", at: "2026-09-12T10:15:00+08:00" })]);
  assert.equal(res.results[0].decisions[0].reason, "suspended");

  // 归还后完成清洁与复查（检查时间须晚于超限读数才能解除停用）；超限读数仍在时间线中
  clock.set("2026-09-12T10:20:00+08:00");
  await clean(store, "replica-001", "completed");
  await inspect(store, "replica-001", "passed");
  assert.equal(store.state.replicas["replica-001"].status, "available");
  const readings = store.state.timelines["replica-001"].filter((t) => t.kind === "load_reading");
  assert.equal(readings.length, 1);
  assert.ok(readings[0].summary.includes("25.4"));
});
