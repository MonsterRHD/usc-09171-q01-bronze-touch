import { createServer } from "./app.mjs";

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? new URL("../data/", import.meta.url).pathname;

createServer({ dataDir }).listen(port, () => {
  console.log(`bronze-touch 可触展品服务已启动: http://localhost:${port} (数据目录 ${dataDir})`);
});
