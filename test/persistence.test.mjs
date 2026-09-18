// 持久化：次日重启后当天记录与待处理补传完整存在；
// 重放幂等（决策日志不重复追加）；补传改写历史时决策日志追加新版本。

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore } from "../src/store/datastore.mjs";
import { makeConfig, mutableClock, register, inspect, schedule, book, scan, reading } from "./helpers.mjs";

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "bronze-touch-"));
}

test("重启后状态、决策与待处理补传完整恢复", async () => {
  const dir = await tmpDir();
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const config = makeConfig();

  const store1 = await DataStore.open({ dir, config, clock: clock.clock });
  await register(store1, "replica-001");
  await inspect(store1, "replica-001", "passed");
  await schedule(store1, "s1", { starts: "2026-09-12T10:00:00+08:00", ends: "2026-09-12T10:45:00+08:00" });
  await book(store1, { bookingId: "bk-1", sessionId: "s1", holder: "guide-12" });
  await store1.ingestDeviceEvents([
    scan({ id: "a-1", actor: "guide-12", at: "2026-09-12T10:02:00+08:00" }),
    reading({ id: "r-1", value: 18.6, at: "2026-09-12T10:05:00+08:00" }),
    scan({ id: "x-1", replica: "replica-404", actor: "guide-3", at: "2026-09-12T10:06:00+08:00" }), // 未登记 → 待处理
  ]);
  const decisionsBefore = store1.decisionHistory.length;
  assert.ok(decisionsBefore > 0);
  assert.equal(store1.state.pending.length, 1);

  // 模拟次日重启：同一目录重新打开
  const clock2 = mutableClock("2026-09-13T08:00:00+08:00");
  const store2 = await DataStore.open({ dir, config, clock: clock2.clock });

  assert.equal(store2.state.replicas["replica-001"].current_holder.actor_ref, "guide-12", "占用状态跨重启保留");
  assert.equal(store2.state.replicas["replica-001"].current_holder.location, "东展厅服务台");
  assert.equal(store2.state.replicas["replica-001"].last_reading.value, 18.6, "传感器读数跨重启保留");
  assert.equal(store2.state.bookings["bk-1"].status, "fulfilled");
  assert.equal(store2.state.pending.length, 1, "待处理补传跨重启保留");
  assert.equal(store2.state.pending[0].replica_id, "replica-404");
  assert.equal(store2.decisionHistory.length, decisionsBefore, "重放幂等：重启不重复追加决策");

  // 重启后补录登记缺失的复刻件 → 待处理事件在登记点补应用并给出确定结论
  await register(store2, "replica-404");
  assert.equal(store2.state.pending.length, 0);
  const backfilled = store2.state.decisions.find((d) => d.subject_id === "kiosk-a:x-1");
  assert.equal(backfilled.result, "checkout_rejected", "补应用时登记后尚未检查，扫码被确定拒绝");
  assert.equal(backfilled.reason, "inspection_pending");

  // 检查通过后正常领取，并再次重启验证落盘
  await inspect(store2, "replica-404", "passed");
  await store2.ingestDeviceEvents([scan({ id: "x-2", replica: "replica-404", actor: "guide-3", at: "2026-09-13T09:00:00+08:00" })]);
  assert.equal(store2.state.replicas["replica-404"].current_holder.actor_ref, "guide-3");

  const store3 = await DataStore.open({ dir, config, clock: clock2.clock });
  assert.equal(store3.state.replicas["replica-404"].current_holder.actor_ref, "guide-3");
  assert.equal(store3.decisionHistory.length, store2.decisionHistory.length);
});

test("补传改写历史后，决策日志追加新版本且旧版本保留", async () => {
  const dir = await tmpDir();
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const config = makeConfig();

  const store1 = await DataStore.open({ dir, config, clock: clock.clock });
  await register(store1, "replica-001");
  await inspect(store1, "replica-001", "passed");
  await store1.ingestDeviceEvents([scan({ id: "a-1", actor: "guide-1", at: "2026-09-12T10:00:00+08:00" })]);
  assert.equal(store1.state.replicas["replica-001"].current_holder.actor_ref, "guide-1");

  // 重启后离线终端补传更早的扫码 → 占用者改判
  const store2 = await DataStore.open({ dir, config, clock: clock.clock });
  await store2.ingestDeviceEvents([scan({ id: "b-1", device: "kiosk-b", actor: "guide-2", at: "2026-09-12T09:55:00+08:00" })]);
  assert.equal(store2.state.replicas["replica-001"].current_holder.actor_ref, "guide-2");

  // 第三次打开：改判历史完整
  const store3 = await DataStore.open({ dir, config, clock: clock.clock });
  const history = store3.decisionHistory.filter((d) => d.subject_id === "kiosk-a:a-1");
  assert.equal(history.length, 2);
  assert.equal(history[0].result, "checkout_granted");
  assert.equal(history[1].result, "checkout_rejected");
  assert.equal(history[1].revision, 2);
  assert.equal(store3.state.replicas["replica-001"].current_holder.actor_ref, "guide-2");
});

test("日志末行残缺时启动不失败，完整记录不丢失", async () => {
  const dir = await tmpDir();
  const clock = mutableClock("2026-09-12T09:00:00+08:00");
  const config = makeConfig();

  const store1 = await DataStore.open({ dir, config, clock: clock.clock });
  await register(store1, "replica-001");
  await inspect(store1, "replica-001", "passed");

  // 模拟写入中断：追加半行
  await fs.appendFile(`${dir}/events.jsonl`, '{"seq":99,"event":{"event_id":"broken"', "utf8");

  const store2 = await DataStore.open({ dir, config, clock: clock.clock });
  assert.equal(store2.state.replicas["replica-001"].status, "available", "完整事件正常恢复");
});
