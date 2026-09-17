import { createServer } from "./app.mjs";

createServer().listen(Number(process.env.PORT ?? 8080));
