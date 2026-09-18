import http from "node:http";
import { DataStore } from "./store/datastore.mjs";
import { defaultConfig } from "./config.mjs";
import { createRouter } from "./http/router.mjs";

// options:
//   dataDir  持久化目录；缺省为内存模式（不落盘，便于测试）
//   config   覆盖默认配置（令牌、冷却时间、设备位置等）
//   clock    注入时钟（毫秒时间戳），测试可控制"现在"
//   store    直接注入已打开的 DataStore
export function createServer(options = {}) {
  const config = options.config ?? defaultConfig();
  const clock = options.clock ?? (() => Date.now());
  const storePromise = options.store
    ? Promise.resolve(options.store)
    : DataStore.open({ dir: options.dataDir ?? null, config, clock });
  const router = createRouter({ storePromise, config });
  return http.createServer((req, res) => {
    router(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error", message: String(err?.message ?? err) }));
    });
  });
}
