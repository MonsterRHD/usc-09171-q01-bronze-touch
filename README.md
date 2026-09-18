# 可触展品服务

本项目承载博物馆可触复刻件在公众活动中的流转协作：登记、排场领用、扫码交接、清洁冷却、检查放行、紧急召回与临时闭馆。所有岗位（讲解员、保管员、清洁组、无障碍服务台、现场主管）共用同一份事实来源，任何岗位的状态变更立即对其他岗位生效，杜绝“各记各的表”。

## 核心设计

**事件溯源 + 确定性重放。** 一切事实（登记、检查、清洁、召回、闭馆、设备事件……）只追加写入 `data/events.jsonl`，当前状态是全部事件按 `(occurred_at, seq)` 排序后折叠出来的纯函数结果：

- 离线终端恢复联网后补传事件，系统整体重放，**按事件实际发生顺序（occurred_at）消除冲突**，而不是按到达顺序。
- 原始负载（含承重读数）逐字留档在 `payload.raw`，**任何接口都不能修改历史**，纠错只能追加新事件。
- 同一 `(device_id, event_id)` 重复上传幂等：返回既有判定，不产生新事实。
- 补传重放若使既有判定反转（如离线期间的“归还”其实发生在更早的归还之后），系统持久化 `decision_changed` 冲突，主管可查可确认。
- 重启后从日志完整重建：当天记录、挂起事件、未确认冲突全部保留。

## 时间字段约定

- 所有业务时间必须是**带时区偏移的 ISO 8601** 字符串，如 `2026-09-12T09:02:11+08:00`，否则 400。
- `occurred_at`：设备/命令认定的发生时间，参与排序与判定。
- `received_at`：平台接收时间，由平台在落盘时盖章；设备负载里自带的 `received_at` 原样保留为 `client_received_at`，二者互不替代。
- 命令类接口默认以平台当前时间为 `occurred_at`，也允许显式传入（用于补录与演练）。
- `event_id` 在单台设备内稳定，网络恢复后可能重复上传（幂等去重）。

## 快速开始

```bash
npm start                 # PORT=8080，数据目录 ./data（可用 PORT / DATA_DIR 覆盖）
npm test                  # node --test，含四类验收流程
```

健康检查：`GET /health`。

## 岗位与受控接口

身份通过请求头声明：员工用 `x-actor-id`（须在人员登记册），终端用 `x-device-id`（须在设备登记册，且只能上报其类型允许的事件）。种子人员/设备见 `src/registry.mjs`，主管可用 `POST /staff` 增补人员。

| 岗位 | 可用接口 |
| --- | --- |
| 讲解员 guide | 查询类接口；领用/归还通过终端扫码完成 |
| 保管员 conservator | `POST /replicas`、`POST /replicas/:id/inspections`、`POST /replicas/:id/recall`、`POST /replicas/:id/recall/clear`、`POST /replicas/:id/deactivation/clear`、`POST /replicas/:id/cleaning`、`GET /decisions` |
| 清洁组 cleaner | `POST /replicas/:id/cleaning` |
| 无障碍服务台 accessibility | `POST /sessions/:id/assistance` |
| 现场主管 supervisor | `POST /sessions`、`POST /sessions/:id/cancel`、`POST /assignments`、`POST /assignments/:id/cancel`、`POST /assignments/:id/adjust`、`POST /closures`、`POST /closures/:id/lift`、`POST /staff`、`GET /decisions`、`GET /conflicts`、`POST /conflicts/:id/ack` |
| 终端 device | `POST /devices/events`（单个/数组/`{events:[...]}` 批量）、`GET /devices/events/:eventId`（重同步后查询终判） |

查询类接口（`GET /replicas*`、`GET /sessions`、`GET /assignments`、`GET /closures`、`GET /board`、`GET /staff`）对所有登记员工开放。

## 复刻件状态与放行门禁

状态（派生展示）：`pending_inspection`（待检查）→ `available`（可领用）→ `checked_out`（已领出）→ 归还后回到 `pending_inspection`；另有 `cooldown`（清洁冷却中）、`recalled`（召回中）、`deactivated`（传感器停用中）。

**每次扫码领用都要过全部门禁**（任一命中即拒绝，理由全部返回）：

| 拒绝码 | 含义 |
| --- | --- |
| `RECALLED` | 保管员已紧急召回，解除前不得放行 |
| `SENSOR_ANOMALY` | 承重读数超限，停用待保管员复核 |
| `INSPECTION_PENDING` | 尚未完成放行检查（登记后/每次归还后都必须检查） |
| `COOLDOWN` | 清洁冷却未结束 |
| `OCCUPIED` | 已有有效持有人（**同一时刻只能有一个有效占用者**） |
| `CLOSED` | 处于临时闭馆窗口 |
| `NO_ASSIGNMENT` | 没有该人员的待领领用单 |
| `LATE` | 超过领用截止时间（迟到） |
| `TOO_EARLY` | 早于场次开始前的允许领取窗口 |
| `SESSION_CANCELLED` | 场次已取消 |
| `NOT_HOLDER` / `NO_ACTIVE_LOAN` | 归还扫码无效：非持有人（且非清洁/保管/主管）或没有在途领用 |

扫码归还不受门禁限制（召回、闭馆期间也允许归还）。未显式传 `direction` 时：持有人再扫视为归还，其余视为领用；终端应尽量显式传 `direction: "out" | "in"`。

**领用安排（`POST /assignments`）校验**：场次存在且未取消、容量未满、复刻件未排入时间重叠的其他场次、清洁冷却不晚于场次开始、复刻件可触限制满足场次观众辅助需求（`assistance_needs` 的每一项都须在 `touch_constraints` 中为真）、复刻件未处于召回/停用。被拒绝的安排会记入 `command_rejected`，主管可在 `GET /decisions` 的 `rejected_commands` 中查看依据。改派用 `POST /assignments` 带 `replaces: <旧单id>`，旧单作废原因留痕。

**承重传感器**：`load_reading` 永远原样入账；读数超过 `load_limit_kg` 即触发停用（`deactivated`），后续合格读数不会自动解除，须保管员 `POST /replicas/:id/deactivation/clear`。

**挂起（pending）**：扫码指向未登记的复刻件或未登记人员时，事件挂起；待登记完成后重放自动得到确定判定，并留下 `decision_changed` 记录。挂起事件跨重启保留。

## 判定解释与冲突队列

- `GET /decisions?replica_id=&verdict=&device_id=`（主管/保管员）：每条设备事件的终判及理由（含事实依据，如持有人、召回原因、闭馆窗口），外加被拒绝的排单命令。
- `GET /conflicts`（主管）：判定反转（`decision_reversed`）、挂起事件（`pending_event`）、召回未归还（`recall_outstanding`）、逾期未还（`return_overdue`）。`POST /conflicts/:id/ack` 确认。
- `GET /replicas/:id/timeline`：该复刻件全量时间线，事实与判定按实际发生顺序排列，原始负载逐字呈现。
- `GET /board`：现场总览（各复刻件状态/持有人、场次与领用单、闭馆、未确认冲突数）。

## 四类验收流程

`test/` 下各有对应的可执行场景测试（`npm test`）：

1. **跨场周转**（`scenario-turnover.test.mjs`）：未检查被拒 → 检查 → 领用 → 他台终端再领被拒（OCCUPIED）→ 归还 → 再检查前被拒 → 消毒冷却中被拒 → 冷却结束下一场领用成功。
2. **两台终端同时交接**（`scenario-concurrent.test.mjs`）：同一 `occurred_at` 下恰有一台成功，另一台以 OCCUPIED 拒绝；两种到达顺序结果各自确定，主管可在 `/decisions` 看到持有人事实。
3. **离线后召回**（`scenario-offline-recall.test.mjs`）：召回阻断新领用、允许归还；离线终端补传按发生顺序重放，既有判定反转留痕为冲突；重复上传幂等；解除召回须随附检查通过。
4. **闭馆恢复 + 次日重启**（`scenario-closure-restart.test.mjs`）：闭馆窗口内扫码以 CLOSED 拒绝，提前解除后恢复；超过领用截止以 LATE 拒绝；同一数据目录重启后，当天记录、挂起补传、幂等性全部保持。

手工演练示例（预演时间线，命令显式带 `occurred_at`）：

```bash
# 保管员登记并检查
curl -X POST localhost:8080/replicas -H 'x-actor-id: keeper-01' -H 'content-type: application/json' -d '{
  "replica_id":"replica-001","original_ref":"bronze-鼎-001","name":"青铜鼎等比复刻件",
  "load_limit_kg":20,"touch_constraints":{"wheelchair":true},"cooldown_minutes":30,
  "occurred_at":"2026-09-12T08:00:00+08:00"}'
curl -X POST localhost:8080/replicas/replica-001/inspections -H 'x-actor-id: keeper-01' \
  -H 'content-type: application/json' -d '{"result":"pass","occurred_at":"2026-09-12T08:05:00+08:00"}'

# 主管排场并安排领用
curl -X POST localhost:8080/sessions -H 'x-actor-id: supervisor-01' -H 'content-type: application/json' -d '{
  "session_id":"S1","title":"上午场","starts_at":"2026-09-12T09:00:00+08:00","ends_at":"2026-09-12T10:00:00+08:00",
  "capacity":1,"assistance_needs":["wheelchair"],"occurred_at":"2026-09-12T08:30:00+08:00"}'
curl -X POST localhost:8080/assignments -H 'x-actor-id: supervisor-01' -H 'content-type: application/json' -d '{
  "session_id":"S1","replica_id":"replica-001","assignee":"guide-12",
  "pickup_deadline":"2026-09-12T09:20:00+08:00","occurred_at":"2026-09-12T08:31:00+08:00"}'

# 终端扫码领用（合同外形，direction 建议显式传）
curl -X POST localhost:8080/devices/events -H 'x-device-id: kiosk-a' -H 'content-type: application/json' -d '{
  "event_id":"kiosk-a-0007","device_id":"kiosk-a","kind":"handover_scan","replica_id":"replica-001",
  "actor_ref":"guide-12","direction":"out","occurred_at":"2026-09-12T09:02:11+08:00"}'
```

## 目录结构

```
contracts/device-events.json   设备事件样例（输入契约，兼容原样接入）
src/domain/time.mjs            时间字段约定与校验
src/domain/fold.mjs            折叠：状态机、放行门禁、判定、冲突派生（纯函数）
src/domain/errors.mjs          统一错误
src/store/eventlog.mjs         只追加 JSONL 事件日志
src/registry.mjs               人员/设备种子登记册
src/app.mjs                    HTTP 路由、鉴权、命令校验、设备接入
src/server.mjs                 服务入口（PORT / DATA_DIR）
test/                          四类验收流程 + 规则单元测试
```
