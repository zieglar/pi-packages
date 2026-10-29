[English](protocol-v2.md) | [简体中文](protocol-v2.zh-CN.md)

# pi-chat-exchange 协议 v2（冻结）

> 历史协议阶段记录：下文关于尚未实现的 host、持久化和端点的描述指 PH-0002/PH-0003。后续私有存储和 MCP 实现见 [storage-contract.md](storage-contract.zh-CN.md) 与 [delivery-ack-contract.md](delivery-ack-contract.zh-CN.md)；冻结协议语义不变。

PH-0002（对 PH-0001 的已批准架构修正）于 2026-10-06 冻结。变更必须经过显式契约修订。机器可读形式位于 `src/protocol/`（schema、生命周期要求表）及 `src/core/rules.ts`（纯规则执行）。分层见 [architecture.md](architecture.zh-CN.md)；被取代的 v1 记录在 `docs/protocol-v1.md`（仅仓库内，不随包分发）。

**已授权的 PH-0003 修订：**Owner 放弃时的取消例外，由 `docs/quarantine-hotfix-ph0003.md`（仅仓库内，不随包分发）中的修订取代。修订后的规则已写入本契约。身份格式、outcome 词汇和正常关闭前置条件均不变。

**已批准的 PH-0003 收敛：**Client/Agent 标签改为带 scope 的 action grant；MCP 是控制表面，不是对话投递。对等端点支持独立于授权和事实证据。实体/身份 schema 和修正后的生命周期边保持不变。底层审计记录在 `docs/chat-bridge-audit-ph0003.md`（仅仓库内，不随包分发）。

## 1. 身份（保持兼容）

| 实体 | 前缀 | 状态 |
| --- | --- | --- |
| Exchange | `ho_<ULID>` | 保留 v1 旧前缀（v1 “handoff” → Exchange 聚合）；不迁移 id |
| Result | `hr_<ULID>` | 与 v1 相同 |
| Message | `msg_<ULID>` | v2 新增 |
| DeliveryAttempt | `att_<ULID>` | v2 新增 |
| Receipt | `rcpt_<ULID>` | v2 新增 |
| Event | `evt_<ULID>` | v2 新增 |

所有 id 均为 Crockford Base32 ULID（48 位毫秒时间戳 + 80 位 CSPRNG 随机数，无损编码；推导记录在 `docs/identity-hotfix-ph0002.md`，仅仓库内，不随包分发），不透明、唯一、不可变、非秘密，并独立于 payload 内容。显示后缀绝不具有权威性。

## 2. Message 生命周期

```text
CREATED → QUEUED → CLAIMED → DISPATCHING → ACCEPTED → RUNNING → SETTLED
                                                             → RESULT_AVAILABLE
```

辅助状态：`DELIVERY_UNKNOWN`（隔离）、`CANCEL_REQUESTED`，以及结束状态 `CANCELLED` / `FAILED`（连同 `RESULT_AVAILABLE`）。不存在 `CONSUMED`：读取绝不改变生命周期状态。

转换合法性采用两层表（`src/protocol/lifecycle.ts` 中的 `TRANSITION_REQUIREMENTS`）：只检查形状的 helper（`canTransition`、`isLegalTransition`）回答结构合法性，绝不授权修改。每次实际转换都检查带 scope 的 grant；需要证据的转换还检查关联事实证据。主要要求如下：

- `CLAIMED → QUEUED` / `CLAIMED → CANCELLED`：带 scope 的 release/confirm grant + 已记录租约 + 一致的 `not_attempted` / `pending` attempt（唯一安全的重新入队方式）。marker 不能掩盖矛盾的传输事实。
- `CLAIMED → DISPATCHING`：带 scope 的 dispatch-start grant + **当前**租约 + 持久 `started` dispatch marker（在任何 adapter 副作用之前记录）。
- `DISPATCHING → ACCEPTED`：当前权威 fenced lease + transport `delivered`，并且必须有独立关联的 runtime `accepted` 证据。单独的传输投递绝不表示 runtime 接受。
- `DISPATCHING / CLAIMED / CANCEL_REQUESTED → DELIVERY_UNKNOWN`：已记录 attempt + 可能已尝试/不确定的 transport 证据；租约过期不阻止恢复进入隔离。这些恢复记录不授予实时 dispatch 权限。
- `DISPATCHING → FAILED`：当前租约 + transport `failed`；仅当 adapter 证明未发生副作用时才能报告，否则必须为 `ambiguous`。在 start marker 后崩溃时，经 `CLAIMED → DELIVERY_UNKNOWN` 隔离。
- Runtime progress 要求当前 fencing 和独立关联的 `RuntimeEvidence`（`exchangeId`、`messageId`、`attemptId`、endpoint、outcome、观察时间）：`RUNNING` 需要 `running`；`SETTLED` 需要 settlement 级 `settled|runtime_error|cancelled|interrupted`。dispatch marker 不是执行证明。`SETTLED → RESULT_AVAILABLE` 还需要从成功 publication 加载、经过校验且关联的不可变 Result。
- `DELIVERY_UNKNOWN → ACCEPTED/FAILED`：带 scope 的 reconciliation grant + 已记录租约 + 关联 transport 证据 + **显式 reconciliation 证据**。接受还要求独立的带 scope runtime-progress grant 和证据。禁止 `DELIVERY_UNKNOWN → CANCELLED`（PH-0003 已授权 hotfix）：Owner 意图/reconciliation 文本不是执行证据。行政放弃是独立 disposition，绝不是执行状态转换。不存在通往可重试状态的出口；任何地方都不自动重试。
- 取消：`QUEUED → CANCELLED`（cancellation-request grant；尚未 dispatch）无需证据，但仍需权限。从 `CLAIMED/DISPATCHING/ACCEPTED/RUNNING`，请求者只能 `→ CANCEL_REQUESTED`；确认要求独立 scope 的 cancellation-confirmation grant。`CANCEL_REQUESTED → CANCELLED` 要求可证明未尝试 dispatch（`not_attempted` 加 `pending`），或 started/delivered attempt 加关联 runtime `cancelled` 确认；不确定性仍保持隔离。已启动 runtime 的取消还要求 settlement-report 权限；未尝试的取消不合成 runtime 事件。失败/settlement 需要各自证据，不能由请求替代。队列中取消也拒绝所呈现的矛盾 dispatch 证据。

guard 必须关联确切 Message、attempt、endpoint 和已记录租约。对于实时 progress 和安全 release/requeue，`currentLease` 还必须匹配 host 事务读取的权威最新 claim（token、consumer、instance 和 expiry）。仅匹配旧 attempt 的租约还不够。无效时间戳默认拒绝。隔离/reconciliation 可以引用历史租约，但绝不授权重试或 dispatch。

这些 helper 校验传入快照，不提供持久化/认证。未来 host 必须自行认证 principal，加载当前 Message、attempt、最新 claim、完整 Exchange Message 集合和已发布 Result，再原子检查并提交。绝不能把外部 adapter 直接提供的 `authorization`、`currentLease` 或已发布 Result 证明视为权威。并发 revision/CAS 和持久 fencing 分配在本阶段尚未实现。仅请求型转换不需要合成租约输入。基于 attempt 的转换仍按不变的转换表要求经过校验的已记录/当前租约证据。

## 3. 实体（src/protocol/entities.ts）

- `Exchange { exchangeId, state OPEN|CLOSED, createdAt, closedAt? }`
- `Message { messageId, exchangeId, from, to, state, payloadDigest,
  payloadLength, createdAt, idempotencyKey? }`：可用于任一方向；产品字段无法通过 schema 校验。
- `EndpointRef { adapter, endpointId, instanceId? }`：不透明、非秘密的路由身份；区分持久 endpoint 与临时 instance；不允许自由路由元数据或凭证（`additionalProperties: false`）。
- `Lease { consumerId, instanceId, fencingToken ≥ 1, expiresAt }`
- `DeliveryAttempt { attemptId, messageId, endpoint, lease, dispatch
  not_attempted|started, transport pending|delivered|ambiguous|failed,
  createdAt }`
- `RuntimeEvidence { exchangeId, messageId, attemptId, endpoint, outcome,
  observedAt }`：独立 runtime 观察，绝不从 transport 推导。
- `Result { resultId, exchangeId, messageId, attemptId, source, transport,
  runtime, body, resultDigest, settledAt, applicationEvidence? }`：transport 三分法为 `delivered|ambiguous|failed`；runtime 阶梯为 `accepted|running|settled|runtime_error|cancelled|interrupted`；`applicationEvidence` 是协议绝不解释的不透明 JSON。
- `Receipt { receiptId, exchangeId, messageId, endpoint, kind
  read|delivery_ack|duplicate_suppressed, createdAt }`
- `Consumer { consumerId, label?, createdAt, lastSeenAt? }`
- `Event { eventId, exchangeId, sequence ≥ 1, kind, subjectId, createdAt,
  digest?, length?, outcome? }`：诊断只携带 ID/摘要/长度/带类型的 outcome；结构上拒绝原始 payload 正文。

### 不解决执行结果的行政终止

正常 `Exchange.state = CLOSED` 仍要求所有 Message 已结束。不将其扩展为“未解决的 Exchange 已取消或成功”。用不可变 `ExchangeDisposition` 单独记录行政终止：

```text
status = ABANDONED_UNRESOLVED
exchangeId, ownerId, recordedAt, reason, reconciliation intent
unresolved[] = { messageId, originalState: DELIVERY_UNKNOWN,
                 transport: ambiguous, unresolvedSideEffects: true,
                 attempt: original started/ambiguous DeliveryAttempt snapshot }
```

Exchange 快照保持 OPEN，Message 保持 DELIVERY_UNKNOWN；独立 disposition 使聚合在行政上不再活跃，但执行结果仍未解决。未来 view/API 必须同时展示执行事实和 disposition，绝不能把 marker 转成 CANCELLED、FAILED_NO_EFFECT、Result 或成功。marker 本身就是不可变行政审计记录。其 Owner/时间/原因和调查元数据不是执行证明。`reconciliation.resolvedAt` 保留现有字段名，但在此表示调查/意图记录的时间，不是副作用已解决的时间。

`archiveUnresolvedExchange` 要求 Owner 权限、至少一条未解决 Message、每条未解决 Message 恰好一个关联的 started/ambiguous 活跃 attempt，且无剩余进行中活动。其他 Message 可以已结束。它保留快照并允许精确重放，绝不替换。不改变 transport outcome，不授权 retry/requeue，不制造 Result。Unknown→ACCEPTED/FAILED 仍必须在行政终止之前具备真实关联证据和显式 reconciliation。

`assertExchangeActive` 是创建、claim 和每次后续协议修改的 host 准入前置条件。转换、publication 和正常 close helper 也拒绝传入的权威 disposition。未来 host 必须原子加载该记录；外部调用方不能选择或省略它。行政终止不会停止已投递的外部 runtime，也不阻止其副作用；它只停止协议活动。之后的外部事实可以作为独立审计观察保留，绝不恢复已归档协议或改写原始不确定性快照。历史读取仍允许且不修改状态。本阶段未实现持久化、ACL、审计追加和 API。

## 4. 幂等性（创建）

以 **(namespace, key)** 为键，并带规范化请求摘要（对递归按键排序的 JSON 计算 SHA-256；不受支持的值和循环结构以 `DigestInputError` 拒绝）。等价重复重放相同不可变记录；同键不同摘要以 `IDEMPOTENCY_KEY_CONFLICT` 默认拒绝。内存参考 store（`src/core/reference.ts`）仅为语义参考，不具持久性。namespace/key 使用无歧义 JSON tuple 存储，不采用允许调用方使用的分隔符拼接。不透明 application evidence 必须为有限、无环的普通 JSON；core publication/read 边界拒绝 Maps/Sets/Dates、稀疏数组、symbol 和不受支持的值。publication 要求 settlement 级 runtime outcome；读取返回不可变快照，不记录语义完成。

## 5. Action grant 与端点支持

封闭 `CONTROL_OPERATIONS`：`exchange_send/get/list/cancel/result`。可选 `exchange_close` 和 `exchange_archive` 仍是独立 grant，控制 API 尚未实现。`ENDPOINT_OPERATIONS`：claim、dispatch-start、delivery report、runtime activity/settlement、publication、lease release、factual reconciliation 和 cancellation confirmation。`assertOperationSeparation` 检查目录分离，但不规定协议角色。

`AuthorizationContext { principalId, grants[] }`；每个 grant 具有 `{ action, principalId, scope }`。action 和 scope 是封闭的可辨识联合，在 typecheck 和运行时校验。send/get/result 要求 Exchange scope；cancel 要求 Message scope；claim 要求 Message+destination scope；端点修改要求 Message+Attempt+recipient scope（均包括 Exchange）。close/archive 要求 Owner scope，并将 ownerId 绑定到 context principal。listing 声明集合权限；未来 host 仍需过滤。不同 principal/Exchange/Message/Attempt/endpoint incarnation 不能复用 grant。仅有投递权限不能断言 runtime 接受。

**Context 不是凭证。**未来 host 认证身份、映射 sender/destination/owner/consumer 绑定、加载当前 grant 和权威快照，并在事务中为纯 core 规则提供 context。调用方提供的 grant、adapter kind、已实现接口或支持声明，都不能建立这些事实。本阶段不存在 host/authentication 服务。

`EndpointDeclaration { kind, capabilities }` 独立公告 delivery、observation、cancellation、follow-up 和 result-production 支持。支持取 `supported|unsupported|unknown`；可选项缺失即 unknown。方法或公告均不能创建证据或 grant。Pi 仅声明绑定形状，不公告已实现能力。未实现 ChatGPT 端点。已知投递但执行未知时，不得误标为 DELIVERY_UNKNOWN，也不得制造 runtime acceptance/settlement。未来准入策略可以在副作用发生前拒绝不受支持的工作流。

## 5a. Result 与对话回复

Result 仍是单条 Message/Attempt 的处理证据/输出。publication 要求其带 scope 的 grant、settlement 级 outcome，以及不可变重放/冲突校验。未来 host 必须对照权威已 settled 的 Message/Attempt/runtime 事实，一起检查 publication 和 RESULT_AVAILABLE 转换；helper 本身不是执行证明。

回复/后续通信是同一 Exchange 内另一条 Message，有自己的 ID、反向或显式指定的 from/to 和独立证据。不存在自动 Result-to-Message 转换、回复发送、读取即消费或 close。这不需要改变 Message/Result/EndpointRef wire schema。

## 6. 被取代的 v1 语义（记录）

| v1（PH-0001） | v2（PH-0002） | 原因 |
| --- | --- | --- |
| Handoff 实体 `ho_` | Exchange 聚合 `ho_`（相同前缀） | 修正聚合根 |
| `CONSUMED` 终态 | 移除 | 读取绝不能表示语义消费 |
| `DELIVERED` 状态，`CLAIMED→QUEUED` 形状合法 | `DISPATCHING` + 证据控制的重新入队 | 副作用前持久 dispatch-start；校验未尝试证明 |
| `piSessionRef` 源字段 | 通用 `EndpointRef` | 不透明、产品中立的路由身份 |
| `CHATGPT_TOOLS` / consumer 表面 | `CLIENT_OPERATIONS` / `AGENT_OPERATIONS` 端口 | 无产品名；字面权限互不重叠 |
| transport `delivered\|delivery_unknown`；runtime `succeeded\|failed\|…` | transport `delivered\|ambiguous\|failed`；runtime `accepted\|running\|settled\|runtime_error\|…` | 通用词汇，各层绝不借用术语 |
| （拟议）loopback HTTP + bearer token broker | 随持久 host 延后 | 不在 v2 范围内 |

被取代的 v1 测试：`schemas.test.ts` 和 `surfaces.test.ts`（已移除；不变量延续在 `entities.test.ts` 和 `capabilities.test.ts` 中）；`lifecycle.test.ts` 按 v2 状态机重写；`idempotency.test.ts` 已扩展（namespace scope、不可变记录、严格 digest 输入）。保持不变：11 个 identity/encoder 测试（`identity.test.ts`，包括 hotfix 回归）和 MCP smoke 测试（`test/control/mcp/`，由 PH-0003 移动，smoke 行为不变）。

## 7. 安全规则（冻结，沿用 v1）

绝不持久化或暴露凭证、API key、认证文件、环境秘密或隐藏模型推理。payload/Result 正文属于敏感数据：诊断通过摘要关联；Event 只携带 ID、摘要、长度和带类型的 outcome。MCP 表面不访问 `process.env`（由包检查强制）。按契约，端点身份非秘密。
