// 运行配置。生产环境用 BRONZE_TOKENS（格式 token:role:ref，逗号分隔）覆盖默认开发令牌。

const DEFAULT_TOKENS = {
  "guide-token": { role: "guide", ref: "guide-12" },
  "curator-token": { role: "curator", ref: "curator-01" },
  "supervisor-token": { role: "supervisor", ref: "supervisor-01" },
  "cleaner-token": { role: "cleaner", ref: "cleaner-01" },
  "device-token": { role: "device", ref: "device-gateway" },
};

function parseTokens(envValue) {
  if (!envValue) return { ...DEFAULT_TOKENS };
  const tokens = {};
  for (const item of envValue.split(",")) {
    const [token, role, ref] = item.split(":").map((s) => s.trim());
    if (token && role && ref) tokens[token] = { role, ref };
  }
  return Object.keys(tokens).length > 0 ? tokens : { ...DEFAULT_TOKENS };
}

export function defaultConfig(overrides = {}) {
  return {
    defaultCooldownMinutes: 30, // 清洁完成后的默认冷却时间
    checkinGraceMinutes: 10, // 场次开始后的签到宽限期，超过即迟到
    deviceLocations: {
      "kiosk-a": "东展厅服务台",
      "kiosk-b": "西展厅服务台",
    },
    tokens: parseTokens(process.env.BRONZE_TOKENS),
    ...overrides,
  };
}
