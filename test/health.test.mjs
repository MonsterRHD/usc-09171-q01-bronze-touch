import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "../src/app.mjs";

test("服务入口可以创建", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bronze-health-"));
  const server = createServer({ dataDir: dir });
  assert.equal(typeof server.listen, "function");
  server.close();
});
