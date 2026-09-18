// 时间工具：事件时间一律为 ISO 8601 字符串（可带时区偏移），内部比较统一转毫秒。

export function toMs(iso) {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function isValidIso(value) {
  return toMs(value) !== null;
}

export function addMinutesMs(ms, minutes) {
  return ms + minutes * 60_000;
}

export function isoOf(ms) {
  return new Date(ms).toISOString();
}
