// DataStore：事件日志 + 重放 + 决策日志的协调者。
//
// - events.jsonl：全部事件（设备与平台），按接收顺序追加，是唯一的真相来源；
// - decisions.jsonl：决策历史。每次重放后与已持久化内容对比，仅当出现新决策或
//   离线补传改写了既有决策时，才追加一个带单调 revision 的新版本——主管可据此
//   解释任何一次拒绝或改派，以及它后来被谁改写；
// - 重启后读取 events.jsonl 重放即可恢复当天全部状态，包括待处理的离线补传事件；
// - 所有写操作经 queue 串行化，避免并发请求交错写日志。

import { replayEvents } from "../domain/replay.mjs";
import { platformEvent, validateDeviceEvent, eventKey } from "../domain/events.mjs";
import { appendJsonLines, readJsonLines } from "./eventlog.mjs";
import { isoOf } from "../domain/time.mjs";

function canonicalOf(decision) {
  const { revision, ...rest } = decision;
  return JSON.stringify(rest);
}

export class DataStore {
  static async open({ dir = null, config, clock = () => Date.now() } = {}) {
    const store = new DataStore();
    store.dir = dir;
    store.config = config;
    store.clock = clock;
    store.entries = []; // { seq, event }，seq 为平台接收顺序
    store.seen = new Set(); // 已接收的 (device_id, event_id)
    store.nextSeq = 1;
    store.persistedDecisions = new Map(); // decision_id -> { canonical, decision }
    store.subjectRevisions = new Map(); // subjectKey -> 已分配的最大 revision
    store.decisionHistory = []; // 全部决策版本（含被改判覆盖的旧版本）
    store.queue = Promise.resolve();
    store.state = null;

    if (dir) {
      const { records } = await readJsonLines(`${dir}/events.jsonl`);
      for (const rec of records) {
        store.entries.push({ seq: rec.seq, event: rec.event });
        store.seen.add(eventKey(rec.event));
        store.nextSeq = Math.max(store.nextSeq, rec.seq + 1);
      }
      const { records: decisions } = await readJsonLines(`${dir}/decisions.jsonl`);
      for (const d of decisions) store.#indexDecision(d);
    }
    await store.replayAndDiff();
    return store;
  }

  #indexDecision(d) {
    this.persistedDecisions.set(d.decision_id, { canonical: canonicalOf(d), decision: d });
    const subjectKey = `${d.subject_type}:${d.subject_id}`;
    this.subjectRevisions.set(subjectKey, Math.max(this.subjectRevisions.get(subjectKey) ?? 0, d.revision));
    this.decisionHistory.push(d);
  }

  nowMs() {
    return this.clock();
  }

  nowIso() {
    return isoOf(this.nowMs());
  }

  async replayAndDiff() {
    const replayed = replayEvents(this.entries, this.config, this.nowMs());
    const fresh = [];
    const aligned = [];
    for (const d of replayed.decisions) {
      const existing = this.persistedDecisions.get(d.decision_id);
      if (existing && existing.canonical === canonicalOf(d)) {
        aligned.push(existing.decision); // 沿用已分配的 revision，重启后内容稳定
        continue;
      }
      const subjectKey = `${d.subject_type}:${d.subject_id}`;
      const revision = (this.subjectRevisions.get(subjectKey) ?? 0) + 1;
      this.subjectRevisions.set(subjectKey, revision);
      const versioned = { ...d, revision };
      this.persistedDecisions.set(d.decision_id, { canonical: canonicalOf(d), decision: versioned });
      this.decisionHistory.push(versioned);
      fresh.push(versioned);
      aligned.push(versioned);
    }
    if (fresh.length > 0 && this.dir) await appendJsonLines(`${this.dir}/decisions.jsonl`, fresh);
    replayed.decisions = aligned;
    this.state = replayed;
    return fresh;
  }

  mutate(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // 接收设备事件（单条或批量）。逐条返回确定结果：
  // applied（已应用）/ duplicate（重复上传，幂等忽略）/ pending（引用未登记复刻件，挂起待处理）/ invalid（校验失败）。
  ingestDeviceEvents(rawList) {
    return this.mutate(async () => {
      const results = [];
      const accepted = [];
      const receivedAt = this.nowIso();
      for (const raw of rawList) {
        const { ok, errors, event } = validateDeviceEvent(raw, receivedAt);
        if (!ok) {
          results.push({ event_id: raw?.event_id ?? null, status: "invalid", errors });
          continue;
        }
        if (this.seen.has(eventKey(event))) {
          results.push({ event_id: event.event_id, device_id: event.device_id, status: "duplicate" });
          continue;
        }
        const entry = { seq: this.nextSeq++, event };
        this.seen.add(eventKey(event));
        this.entries.push(entry);
        accepted.push(entry);
      }
      if (accepted.length > 0 && this.dir) {
        await appendJsonLines(`${this.dir}/events.jsonl`, accepted);
      }
      await this.replayAndDiff();
      for (const entry of accepted) {
        const key = eventKey(entry.event);
        results.push({
          event_id: entry.event.event_id,
          device_id: entry.event.device_id,
          status: this.state.pending.some((p) => eventKey(p) === key) ? "pending" : "applied",
          decisions: this.state.decisions.filter((d) => d.trigger_event_id === key),
        });
      }
      return { results };
    });
  }

  // 平台命令：登记、预约、召回、检查、清洁、闭馆等，统一落成平台事件。
  command(kind, fields, actorRef) {
    return this.mutate(async () => {
      const event = platformEvent(kind, actorRef, fields, this.nowIso());
      const entry = { seq: this.nextSeq++, event };
      this.seen.add(eventKey(event));
      this.entries.push(entry);
      if (this.dir) await appendJsonLines(`${this.dir}/events.jsonl`, [entry]);
      await this.replayAndDiff();
      const key = eventKey(event);
      return { event, decisions: this.state.decisions.filter((d) => d.trigger_event_id === key) };
    });
  }

  // 触发一次重放（clock 前进后刷新派生状态，如预约过期展示）。
  refresh() {
    return this.mutate(async () => {
      await this.replayAndDiff();
      return this.state;
    });
  }
}
