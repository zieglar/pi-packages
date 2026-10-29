[English](pi-integration-readiness.md) | [简体中文](pi-integration-readiness.zh-CN.md)

> 历史实现记录。以下状态、行为和测试边界描述 B3-P3D/P4D，不代表当前完整功能或支持承诺。

# Pi 运行时集成就绪情况：CE-0002 B3-P3D

状态：已实现显式、有界 Inbox 集成，扩展 B3-P3B host adapter 和 Extension。此前 Pi 0.86.1 运行时证据属于 B3-P3B；新增 `ce_inbox_list` 有真实 Store Host 测试和隔离 fake Pi API 框架。真实双进程 Inbox dogfood 仍是独立 NOT_RUN 验收阶段。未增加外部投递、ACK、自动消费、注入或轮询。

## 架构

```
Pi process A                          Pi process B
┌─────────────────────┐              ┌─────────────────────┐
│ .pi extension       │              │ .pi extension       │
│  (lifecycle, tools) │              │  (lifecycle, tools) │
│        │            │              │        │            │
│ CeSessionHost (A)   │              │ CeSessionHost (B)   │
│  memory-only tokens │              │  memory-only tokens │
└────────┼────────────┘              └────────┼────────────┘
         │                                   │
         └──────────┬────────────────────────┘
                    ▼
        shared durable SQLite store (schema v6)
        host trust-root secret (uid-owned, mode 600)
```

- `src/endpoints/pi/session-host.ts` 是唯一宿主侧组合层，不导入 Pi SDK 类型；普通数据输入、普通数据输出。
- `packages/pi-chat-exchange/pi-extension/index.ts` 是 Pi 运行时适配器，自身不持有凭证；全部权限委托给 host seam。
- Chat Exchange 负责 Participant/Session/message 权限。Pi 负责运行时和 SessionManager。Wayforge 保留 Completion Authority。系统之间不转移权限。

## 身份映射

| 身份 | 来源 | 稳定性 |
|---|---|---|
| Pi session id | `pi --session-id`（否则 uuidv7） | 运维控制的标签；`/new`、`/fork` 时变化；`/reload` 时稳定 |
| CE Participant | 宿主配置的不可变 `(adapter, endpointId)` 绑定 | 永久持久 |
| CE Session | 配置时宿主生成的 `ses_…` | 持久；终止 detach 前为 ATTACHED |

Pi session id 仅是运维 allowlist 的查找键，不是 CE Session id 或凭证。fork 或 new 会产生新 id；未加入 allowlist 时不解析到 endpoint，扩展保持不活动（fail closed）。

持久映射（`pi.appendEntry("ce-mapping", …)`）只携带 `{endpointId, participantId, sessionId, exchangeId}` 标识符。`startup` / `reload` / `resume` 时，宿主依据持久状态校验 Participant binding、Session ATTACHED、当前 ownership row 和活跃 lease，再重新发放 Session-bound capability。过期、外部、detached 或无 owner 映射以 `CE_HOST_MAPPING_INVALID` 或 `CE_HOST_AUTHORITY_ABSENT` 拒绝；不会隐式修复或接管。

## 四种可见状态（不可混淆）

1. Stored：`sendMessage` 提交 Message + idempotency + audit。
2. Extension-visible：显式 `ce_inbox_list` 发现合格 ID，`ce_read` 只返回元数据。运维 opt-in 后，`ce_read_payload` 独立为显式 ID 返回经 Storage 授权的 UTF-8 文本。
3. Conversation-visible：显式工具的成功结果通过普通工具处理进入调用方 Pi 对话。SQLite 写入不会自行出现；此扩展不注入用户消息。
4. Model-visible：成功 payload 工具内容通过正常 Pi 上下文处理供活跃模型使用。可见性不证明语义消费、投递 settlement 或 Completion Authority。

B3-P3B 和 B3-P3D 提供元数据操作。B3-P4D 增加 opt-in 显式 payload 暴露：最多 65,536 编码字节，完整 fatal UTF-8 解码并保留开头 BOM。payload 文本仅在成功工具 content 中出现，不进入 details 或 mapping，可能进入持久 Pi 对话历史。未接入自动读取、轮询、ACK、cursor advance、消费、注入、lease renewal 或 ownership takeover。

## 显式 Inbox 集成

`CeSessionHost.listInbox` 组合现有内存权限、当前 fencing preflight 和私有 `discoverInboxMessages` 操作。Storage 在现有事务内重新校验精确 Session-bound read capability、ATTACHED、ownership、fencing、active lease、membership 和不可变 endpoint binding。Extension 不接收原始 Store，也不重复实现 CE 授权。

每次调用 `ce_inbox_list` 时访问受保护 `ctx.sessionManager`，查找 Pi Session 在 allowlist 中的 endpoint，并与成功启动绑定比较。此检查与同步 Host 调用之间没有 await。Shutdown 和每次新 startup 都使 Inbox binding 失效；过期 context 被拒绝。

输入仅为 `afterAuditSequence`、`pageSize`、`rawScanLimit`；默认 0/50/2000，要求安全整数，范围分别为 1..50、1..2000，且有效 P <= K。未知字段和携带权限的字段被拒绝。输出仅投影 Message ID、Audit Sequence，以及未变的 `continuationAuditSequence` 和 `scanBudgetExhausted`。非 null continuation 是最后检查的原始 Audit（包括被过滤事件），不是 ACK 状态。调用方显式请求下一页；不持久化 cursor。空页不是全局完整性证明，缺少创建 Audit 的消息不在 Audit-first discovery 范围内。预算耗尽不证明还有合格 Message。

拒绝复用现有净化 Host code/reason/retryable flag。不暴露不可靠的 `CeHostRefusal.outcome`、原始 cause 或 stack。BUSY 只能显式重试；INDETERMINATE 要求运维重新打开/检查后才能重试。

## 失败模型

| 情况 | 行为 |
|---|---|
| lease 内 Pi 重启 | `resume` 从已校验映射标识符重新发放 capability |
| lease 到期后 Pi 重启 | `CE_HOST_AUTHORITY_ABSENT`；运维可在精确 expired-owner preflight 后运行显式 recovery caller；Pi 不自动接管 |
| `/reload` | 同一 Pi session id；校验后重新采用 mapping；运行时拒绝捕获的过期 context |
| `/new` / `/fork` | 忽略继承的 `ce-mapping`；只有新 Pi id 在 allowlist 内才重新配置 |
| capability 到期/撤销 | `CAPABILITY_REJECTED` 净化拒绝；重新发放需要 host policy |
| CE Session detached | 终态；拒绝 mapping；需要新 binding |
| SQLite BUSY | 整体回滚；`CE_HOST_BUSY`（可重试） |
| INDETERMINATE | `CE_HOST_UNCERTAIN`；重试前重新打开并检查持久状态；绝不盲重试 |
| 重复 send | Exchange 范围幂等 replay 原结果；一条持久 Message |

## Host 信任边界

- 运维 allowlist 是唯一注册权限；模型/工具参数不能注册 Participant、发放 capability 或改变 ownership。
- capability 明文只在内存中：不记日志、不持久化到 Pi session entry、不进入工具结果或模型可见上下文。
- host trust-root secret 仅由 storage plane 在自有事务内读取。
- 没有第二凭证权限、第二 SessionManager 或通用 credential broker。

## 验证映射

- adapter 单元测试：`test/endpoints/pi/session-host.test.ts`。
- Extension 注册/context 框架：`test/endpoints/pi/extension-inbox.test.ts`。
- 有界 Storage discovery：`test/storage/inbox-discovery.test.ts`、`test/storage/inbox-discovery-concurrency.test.ts`。
- P3A 权限链：`test/storage/message-send-read.test.ts`、`message-send-concurrency.test.ts`、`message-send-crash.test.ts`。
- 真实双进程运行时 smoke：`docs/plans/2026-10-11-pi-integration-slice.md`。
- P4D 授权 payload read：`test/storage/message-payload-read.test.ts`、`test/endpoints/pi/session-host-payload.test.ts`、`test/endpoints/pi/extension-payload.test.ts`（扩展框架；不宣称真实 Pi dogfood）。
- 新 Inbox dogfood 程序（B3-P3D 实现中未执行）：`packages/pi-chat-exchange/pi-extension/README.md`，隔离双进程验收。
