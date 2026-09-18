// 只追加事件日志：每条事实一行 JSON，落盘后才算受理。
// 原始读数与设备负载原样保存在 payload.raw 中，任何接口都不会修改历史行。
import fs from "node:fs";
import path from "node:path";

export class EventLog {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, "events.jsonl");
    this.events = [];
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const lines = fs.readFileSync(this.file, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();
    lines.forEach((line, index) => {
      try {
        this.events.push(JSON.parse(line));
      } catch (err) {
        // 容忍尾部撕裂写入（进程在追加中途退出），其余损坏必须显式失败。
        if (index === lines.length - 1) return;
        throw new Error(`事件日志第 ${index + 1} 行损坏: ${err.message}`);
      }
    });
  }

  append(type, actor, occurredAt, payload) {
    const seq = this.events.length ? this.events[this.events.length - 1].seq + 1 : 1;
    const event = {
      seq,
      type,
      occurred_at: occurredAt,
      recorded_at: new Date().toISOString(),
      actor,
      payload,
    };
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    this.events.push(event);
    return event;
  }
}
