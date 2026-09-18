// 事件信封与校验。
// 设备事件（扫码终端、承重传感器）遵循 contracts/device-events.json 约定：
//   - occurred_at 是设备认定的发生时间，received_at 是平台接收时间，二者不能互相替代；
//   - event_id 在单台设备内稳定，网络恢复后可能重复上传，平台按 (device_id, event_id) 幂等去重。
// 平台事件（登记、预约、召回、闭馆等）由平台生成 event_id，occurred_at 取平台接收时刻。

import { randomUUID } from "node:crypto";
import { isValidIso } from "./time.mjs";

export const DEVICE_EVENT_KINDS = new Set(["handover_scan", "load_reading"]);

export function eventKey(evt) {
  return `${evt.device_id}:${evt.event_id}`;
}

// 校验并规范化一条设备事件。未知字段原样保留（宽容读取），
// received_at 缺省时以平台接收时刻补齐——这发生在接收当下，不属于事后改写。
export function validateDeviceEvent(raw, receivedAt) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["事件必须是 JSON 对象"] };
  }
  const errors = [];
  if (typeof raw.event_id !== "string" || raw.event_id.length === 0) errors.push("event_id 缺失");
  if (typeof raw.device_id !== "string" || raw.device_id.length === 0) errors.push("device_id 缺失");
  if (!DEVICE_EVENT_KINDS.has(raw.kind)) errors.push(`不支持的 kind: ${String(raw.kind)}`);
  if (!isValidIso(raw.occurred_at)) errors.push("occurred_at 缺失或无法解析");
  if (raw.received_at !== undefined && !isValidIso(raw.received_at)) errors.push("received_at 无法解析");
  if (raw.kind === "handover_scan") {
    if (typeof raw.replica_id !== "string" || raw.replica_id.length === 0) errors.push("replica_id 缺失");
    if (typeof raw.actor_ref !== "string" || raw.actor_ref.length === 0) errors.push("actor_ref 缺失");
    if (raw.location !== undefined && typeof raw.location !== "string") errors.push("location 必须是字符串");
  }
  if (raw.kind === "load_reading") {
    if (typeof raw.replica_id !== "string" || raw.replica_id.length === 0) errors.push("replica_id 缺失");
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value)) errors.push("value 必须是有限数值");
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, event: { ...raw, received_at: raw.received_at ?? receivedAt } };
}

export function platformEvent(kind, actorRef, fields, nowIso) {
  return {
    event_id: `pf-${randomUUID()}`,
    device_id: "platform",
    kind,
    actor_ref: actorRef,
    occurred_at: nowIso,
    received_at: nowIso,
    ...fields,
  };
}

export function newPlatformId(prefix) {
  return `${prefix}-${randomUUID()}`;
}
