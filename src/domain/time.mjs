// 时间字段约定：所有业务时间必须是带时区偏移的 ISO 8601 字符串，
// 例如 2026-09-12T09:02:11+08:00。occurred_at 是设备/命令认定的发生时间，
// received_at（日志内 recorded_at）是平台接收时间，二者不能互相替代。
import { badRequest } from "./errors.mjs";

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function parseInstant(value, field = "occurred_at") {
  if (typeof value !== "string" || !ISO_WITH_OFFSET.test(value.trim())) {
    throw badRequest("BAD_TIME", `${field} 必须是带时区偏移的 ISO 8601 时间，例如 2026-09-12T09:02:11+08:00`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw badRequest("BAD_TIME", `${field} 无法解析: ${value}`);
  }
  return ms;
}

// 校验并原样返回（保留设备给出的原始字符串，不做归一化覆盖）。
export function requireIso(value, field = "occurred_at") {
  parseInstant(value, field);
  return value;
}

export const toMs = (iso) => Date.parse(iso);

export const nowIso = () => new Date().toISOString();
