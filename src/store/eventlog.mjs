// JSONL 追加日志：事件与决策的落盘格式。只追加、不修改，原始记录不会被事后覆盖。

import fs from "node:fs/promises";
import path from "node:path";

export async function appendJsonLines(file, records) {
  if (records.length === 0) return;
  const data = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, data, "utf8");
}

// 读取全部记录。末行可能因进程中断只写了一半，不可解析的行跳过并计数，不影响启动。
export async function readJsonLines(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { records: [], skipped: 0 };
    throw err;
  }
  const records = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}
