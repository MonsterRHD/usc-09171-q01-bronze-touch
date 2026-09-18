// 路由表与请求分发。roles: "any" 表示任意已认证角色；数组表示限定角色。

import { authenticate, roleAllowed } from "./auth.mjs";
import * as h from "./handlers.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

const ROUTES = [
  { method: "POST", pattern: /^\/replicas$/, roles: ["curator"], handler: h.registerReplica },
  { method: "GET", pattern: /^\/replicas$/, roles: "any", handler: h.listReplicas },
  { method: "GET", pattern: /^\/replicas\/(?<id>[^/]+)$/, roles: "any", handler: h.getReplica },
  { method: "GET", pattern: /^\/replicas\/(?<id>[^/]+)\/timeline$/, roles: "any", handler: h.getReplicaTimeline },
  { method: "POST", pattern: /^\/replicas\/(?<id>[^/]+)\/recall$/, roles: ["curator"], handler: h.recallReplica },
  { method: "POST", pattern: /^\/replicas\/(?<id>[^/]+)\/inspections$/, roles: ["curator"], handler: h.inspectReplica },
  { method: "POST", pattern: /^\/replicas\/(?<id>[^/]+)\/cleaning$/, roles: ["curator", "cleaner"], handler: h.recordCleaning },
  { method: "POST", pattern: /^\/sessions$/, roles: ["supervisor"], handler: h.scheduleSession },
  { method: "GET", pattern: /^\/sessions$/, roles: "any", handler: h.listSessions },
  { method: "GET", pattern: /^\/sessions\/(?<id>[^/]+)$/, roles: "any", handler: h.getSession },
  { method: "POST", pattern: /^\/sessions\/(?<id>[^/]+)\/bookings$/, roles: ["guide", "supervisor"], handler: h.requestBooking },
  { method: "GET", pattern: /^\/bookings\/(?<id>[^/]+)$/, roles: "any", handler: h.getBooking },
  { method: "POST", pattern: /^\/bookings\/(?<id>[^/]+)\/reassign$/, roles: ["supervisor"], handler: h.reassignBooking },
  { method: "POST", pattern: /^\/devices\/events$/, roles: ["device", "curator", "supervisor"], handler: h.postDeviceEvents },
  { method: "GET", pattern: /^\/devices$/, roles: "any", handler: h.listDevices },
  { method: "POST", pattern: /^\/closures$/, roles: ["supervisor"], handler: h.startClosure },
  { method: "GET", pattern: /^\/closures$/, roles: "any", handler: h.listClosures },
  { method: "POST", pattern: /^\/closures\/(?<id>[^/]+)\/lift$/, roles: ["supervisor"], handler: h.liftClosure },
  { method: "GET", pattern: /^\/decisions$/, roles: ["supervisor", "curator"], handler: h.listDecisions },
  { method: "GET", pattern: /^\/backfill\/pending$/, roles: ["supervisor", "curator"], handler: h.listPending },
];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

export function createRouter({ storePromise, config }) {
  return async function route(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      return send(res, 200, { status: "ok", service: "bronze-touch" });
    }

    const principal = authenticate(req, config);
    if (!principal) return send(res, 401, { error: "unauthorized", message: "缺少有效的访问令牌" });

    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(path));
    if (!route) return send(res, 404, { error: "not_found", message: "接口不存在" });
    if (!roleAllowed(principal, route.roles)) {
      return send(res, 403, { error: "forbidden", message: `该接口仅限角色: ${route.roles.join(", ")}` });
    }

    let body = null;
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      try {
        body = await readBody(req);
      } catch (err) {
        return send(res, err.statusCode ?? 400, { error: "invalid_request", message: err.message });
      }
    }

    const store = await storePromise;
    if (req.method === "GET") await store.refresh(); // 刷新随时间变化的派生状态（如预约过期）
    const params = route.pattern.exec(path).groups ?? {};
    const query = Object.fromEntries(url.searchParams.entries());
    try {
      const { status, body: responseBody } = await route.handler({ body, params, query, store, principal, config });
      return send(res, status, responseBody);
    } catch (err) {
      return send(res, 500, { error: "internal_error", message: String(err?.message ?? err) });
    }
  };
}
