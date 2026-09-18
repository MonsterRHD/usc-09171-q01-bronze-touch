// 人员与设备登记册（种子数据）。运行时可通过 staff_registered 事件增补人员。
export const DEFAULT_STAFF = {
  "guide-12": { name: "讲解员·林", role: "guide" },
  "guide-07": { name: "讲解员·赵", role: "guide" },
  "keeper-01": { name: "保管员·陈", role: "conservator" },
  "cleaner-03": { name: "清洁组·王", role: "cleaner" },
  "desk-01": { name: "无障碍服务台", role: "accessibility" },
  "supervisor-01": { name: "现场主管·周", role: "supervisor" },
};

export const DEFAULT_DEVICES = {
  "kiosk-a": { type: "kiosk", location: "一层服务台", kinds: ["handover_scan"] },
  "kiosk-b": { type: "kiosk", location: "二层服务台", kinds: ["handover_scan"] },
  "sensor-r1": { type: "sensor", location: "展柜R1", kinds: ["load_reading"] },
};

export const ROLE_NAMES = {
  guide: "讲解员",
  conservator: "保管员",
  cleaner: "清洁组",
  accessibility: "无障碍服务台",
  supervisor: "现场主管",
};

export const STAFF_ROLES = Object.keys(ROLE_NAMES);
