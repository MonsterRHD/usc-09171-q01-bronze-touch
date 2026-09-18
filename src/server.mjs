import { createServer } from "./app.mjs";
import { defaultConfig } from "./config.mjs";

const port = Number(process.env.PORT ?? 8080);
const dataDir = process.env.DATA_DIR ?? new URL("../data", import.meta.url).pathname;

const server = createServer({ dataDir, config: defaultConfig() });
server.listen(port, () => {
  console.log(`bronze-touch 可触展品服务已启动，端口 ${port}，数据目录 ${dataDir}`);
});
