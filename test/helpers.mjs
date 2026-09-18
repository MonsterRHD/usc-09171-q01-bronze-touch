import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/app.mjs";

// 启动一个使用临时数据目录的服务实例，测试结束自动关闭。
export async function boot(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-touch-"));
  const server = createServer({ dataDir: dir, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { server, dir, port: server.address().port };
}

export async function call(port, { method = "GET", path: p, actor, device, body } = {}) {
  const headers = {};
  if (actor) headers["x-actor-id"] = actor;
  if (device) headers["x-device-id"] = device;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// 常用岗位/设备常量，与 src/registry.mjs 种子一致
export const KEEPER = "keeper-01";
export const SUPERVISOR = "supervisor-01";
export const GUIDE_A = "guide-12";
export const GUIDE_B = "guide-07";
export const CLEANER = "cleaner-03";
export const DESK = "desk-01";
export const KIOSK_A = "kiosk-a";
export const KIOSK_B = "kiosk-b";
export const SENSOR = "sensor-r1";

// 一键准备一件“已检查通过、可放行”的复刻件
export async function registerAvailableReplica(port, id, extra = {}) {
  const reg = await call(port, {
    method: "POST",
    path: "/replicas",
    actor: KEEPER,
    body: {
      replica_id: id,
      original_ref: "bronze-鼎-原件-001",
      name: "青铜鼎等比复刻件",
      load_limit_kg: 20,
      touch_constraints: { wheelchair: true },
      cooldown_minutes: 30,
      occurred_at: "2026-09-12T08:00:00+08:00",
      ...extra,
    },
  });
  if (reg.status !== 201) throw new Error(`登记失败: ${JSON.stringify(reg.body)}`);
  const insp = await call(port, {
    method: "POST",
    path: `/replicas/${id}/inspections`,
    actor: KEEPER,
    body: { result: "pass", occurred_at: "2026-09-12T08:05:00+08:00" },
  });
  if (insp.status !== 201) throw new Error(`检查失败: ${JSON.stringify(insp.body)}`);
  return reg.body;
}

export async function scheduleSession(port, id, startsAt, endsAt, extra = {}) {
  const res = await call(port, {
    method: "POST",
    path: "/sessions",
    actor: SUPERVISOR,
    body: { session_id: id, title: `场次 ${id}`, starts_at: startsAt, ends_at: endsAt, capacity: 1, ...extra },
  });
  if (res.status !== 201) throw new Error(`排场失败: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function assign(port, sessionId, replicaId, assignee, extra = {}) {
  return call(port, {
    method: "POST",
    path: "/assignments",
    actor: SUPERVISOR,
    body: { session_id: sessionId, replica_id: replicaId, assignee, ...extra },
  });
}

export async function scan(port, device, event) {
  const res = await call(port, { method: "POST", path: "/devices/events", device, body: event });
  if (res.status !== 200) throw new Error(`事件接入失败: ${JSON.stringify(res.body)}`);
  return res.body.results[0];
}
