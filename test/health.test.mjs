import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "../src/app.mjs";

test("服务入口可以创建", () => {
  const server = createServer();
  assert.equal(typeof server.listen, "function");
  server.close();
});
