# 可触展品服务

博物馆可触复刻件在公众活动中的流转协作系统。以事件溯源方式把讲解员、保管员、清洁组、无障碍服务台和现场主管记到同一条时间线上：复刻件离开展柜、完成消毒、传感器超限停用或被紧急召回后，任何岗位都不能再把它排进下一场体验。

## 核心原则

- **事件溯源**：`data/events.jsonl` 是唯一真相来源，只追加不修改——原始读数与扫码记录不会被事后覆盖。当前状态由事件流确定性重放得出。
- **时间字段约定**（见 `contracts/device-events.json`）：`occurred_at` 是设备认定的发生时间，`received_at` 是平台接收时间，二者不能互相替代。重放按 `occurred_at` 排序（并列时按平台接收序号），因此离线终端恢复后补传的事件会插入它真实发生的位置，冲突总是按实际发生顺序消除。
- **幂等**：`event_id` 在单台设备内稳定，平台按 `(device_id, event_id)` 去重，网络恢复后重复上传返回 `duplicate`，不产生重复状态。
- **单占用者**：一件复刻件任意时刻只有一个有效占用者。同一占用人再次扫码视为归还；他人扫码被拒并记录依据。
- **可解释**：每次接受/拒绝/取消/改派都写入 `data/decisions.jsonl`（含原因码、中文说明、证据事件）。补传改写历史时，同一决策追加新 `revision`，旧版本保留，主管可以解释"为什么改判"。
- **持久化**：重启后重放事件日志即可恢复当天全部记录与待处理补传；日志末行残缺不影响启动。

## 复刻件生命周期

```
登记 → 待检查 →(检查通过)→ 可放行 →(扫码)→ 占用中 →(本人再扫)→ 已归还
  → 待清洁 →(清洁完成)→ 冷却中(冷却分钟数) →(检查通过)→ 可放行
```

放行门禁（任一不满足即拒绝，并给出主因与全部障碍）：未召回、未停用、无占用者、已清洁、冷却已过、检查通过、非闭馆中。

- **召回**（保管员）：立即生效；占用中的转为"待归还"，归还前他人扫码报 `already_held`，归还后报 `recalled`。检查通过后解除。
- **传感器超限**：`load_reading` 超过登记承重上限 → 自动停用（`auto_suspended`），检查通过后恢复。
- **迟到**：场次开始超过签到宽限期（默认 10 分钟）未扫码，预约失效，扫码报 `late_arrival`。
- **闭馆**：进行中的预约全部取消（`closed`），占用中转待归还；闭馆期间新预约/新领取被拒，归还始终允许；恢复后重新走清洁检查流程。

## 角色与接口

角色：`guide`（讲解员）、`curator`（保管员）、`supervisor`（现场主管）、`cleaner`（清洁组）、`device`（扫码/传感终端）。认证：`Authorization: Bearer <token>`，默认开发令牌为 `<role>-token`（如 `curator-token`），生产用环境变量 `BRONZE_TOKENS`（格式 `token:role:ref,…`）覆盖。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| POST | `/replicas` | curator | 登记复刻件：关联原件、承重上限、可触限制、冷却分钟 |
| GET | `/replicas` / `/replicas/:id` | 任意 | 列表/详情（状态、当前占用人、放行障碍、最近读数） |
| GET | `/replicas/:id/timeline` | 任意 | 该展品按发生时间排列的完整时间线 |
| POST | `/replicas/:id/recall` | curator | 紧急召回 |
| POST | `/replicas/:id/inspections` | curator | 检查 `result: passed/failed` |
| POST | `/replicas/:id/cleaning` | curator, cleaner | 清洁 `phase: started/completed` |
| POST | `/sessions` | supervisor | 排场次：时间窗、容量、辅助支持、签到宽限 |
| GET | `/sessions` / `/sessions/:id` | 任意 | 场次与预约状态 |
| POST | `/sessions/:id/bookings` | guide, supervisor | 预约领用（返回确定决策：confirmed/rejected + 原因） |
| GET | `/bookings/:id` | 任意 | 预约详情与决策历史 |
| POST | `/bookings/:id/reassign` | supervisor | 改派到另一件复刻件（保留原决策链） |
| POST | `/devices/events` | device, curator, supervisor | 设备事件上报（单条或批量，逐条返回 applied/duplicate/pending/invalid） |
| GET | `/devices` | 任意 | 终端与其位置 |
| POST | `/closures` | supervisor | 临时闭馆（已有进行中闭馆返回 409） |
| POST | `/closures/:id/lift` | supervisor | 恢复开放 |
| GET | `/closures` | 任意 | 闭馆记录 |
| GET | `/decisions` | supervisor, curator | 决策日志（可按 replica_id/session_id/result 等过滤） |
| GET | `/backfill/pending` | supervisor, curator | 待处理补传（引用未登记复刻件的事件） |

扫码交接语义：`handover_scan` 在无占用时尝试领取（有有效预约须本人且在宽限期内，否则现场领用）；有占用时，本人扫码为归还，他人扫码为 `already_held`。交接记录保留人员（`actor_ref`）、位置（事件 `location` 或终端注册位置）与交接时刻的最近设备读数快照。

## 运行与测试

```bash
npm start                 # PORT（默认 8080）、DATA_DIR（默认 ./data）
npm test                  # node --test，28 个用例覆盖四类验收流程
```

## 验收流程对照

1. **同一件展品跨场周转**：`test/turnover.test.mjs` —— 登记→检查→场次一领取/归还→清洁冷却→检查→场次二再放行；冷却与未检查期间的预约均被拒且可解释。
2. **两台终端同时交接**：`test/handover.test.mjs` —— 同时扫码按 `occurred_at`（再按接收顺序）确定唯一占用者，后者收 `already_held` 及证据事件。
3. **离线后召回**：`test/recall.test.mjs` —— 补传扫码按实际发生时间与召回对齐：召回前扫码的占用转"待归还"，召回后扫码的直接判拒；召回展品检查通过前不得放行。
4. **闭馆恢复**：`test/closure.test.mjs` —— 闭馆取消预约、占用转待归还、归还允许、恢复后重新放行；`test/persistence.test.mjs` 验证次日重启后当天记录与待处理补传完整存在。

## 目录结构

```
contracts/device-events.json  设备事件样例与时间字段约定
src/domain/                   时间工具、原因码、事件校验、确定性重放引擎
src/store/                    JSONL 追加日志、DataStore（重放 + 决策历史）
src/http/                     角色鉴权、路由、处理函数
src/app.mjs / server.mjs      服务组装与启动入口
test/                         验收流程与引擎单测
```
