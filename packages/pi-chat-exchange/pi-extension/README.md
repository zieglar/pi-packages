# Pi Chat Exchange 扩展指南

当前运行基线：**Pi 1.3.0 / 精确 Node.js 24.21.0 或 24.22.1**，另须通过 Store SQLite tuple/API 门槛；Pi host 和 MCP child 分别校验，无需使用同一 executable。示例保持默认开发版本 24.21.0。本页说明 Pi 适配器与工具契约；从零开始请先走[用户指南](../docs/tunnel-setup.md)。历史 B3 文档中的 Pi 0.86.1 / NOT_RUN 是当时切片记录，不代表当前基线。

## 加载与两种配置方式

在仓库根目录先 build，再显式加载一次：

```bash
mise exec node@24.21.0 -- pnpm --dir packages/pi-chat-exchange run build
mise exec node@24.21.0 -- pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

已安装本地包时不再 `-e` 第二份。支持的配置路径：

1. **推荐：Tunnel Advanced Messaging 生成配对。** 从 profile 选中的 immutable binding 读取配套 sidecar，双方 Store/Exchange 一致，绑定当前可信 Pi Session。
2. **高级/独立 stdio：操作者维护 allowlist。** 非空 `CE_ALLOWLIST` 优先于生成配置，否则无生成配对时读取扩展目录的 `allowlist.json`。自带 `allowlist.example.json` 是旧式 `mcp/chatgpt-desktop` 与 `pi-main` 标签示例，不是当前 Tunnel `chatgpt/main` ↔ `pi/main` 的通用模板；不要直接复制后假定完成配对。

下面是**完整、虚构、非生成** allowlist，用于理解与独立部署。实际 `sessions` key 必须由可信运行时取得并由操作者核实，不能从日志或文件名猜测：

```json
{
  "exchangeNamespace": "example-local",
  "exchangeIdempotencyKey": "example-chatgpt-pi",
  "leaseTtlSeconds": 120,
  "store": { "directory": "/srv/example-ce-store", "file": "ce-store.sqlite" },
  "payloadRead": { "enabled": true },
  "ack": { "enabled": true },
  "inboxNotification": { "enabled": false, "pageSize": 10, "rawScanLimit": 100 },
  "recipients": [{ "adapter": "chatgpt", "endpointId": "chatgpt/main" }],
  "sessions": {
    "example-runtime-session-replace-me": { "endpointId": "pi/main" }
  }
}
```

`payloadRead` / `ack` 在示例中为 true 只是展示独立开关，写入实际配置前分别授权；字符串 `"true"` 不算开启。不要把手工示例冒充 digest 保护的 generated generation 或复制其 `managedBy` 标记。

| 字段 | 语义 |
|---|---|
| `sessions` | 真实 Pi Session ID → operator-approved Endpoint label；Session ID 只是 lookup，不是认证 |
| `exchangeNamespace` / `exchangeIdempotencyKey` | 与 MCP binding 的 Exchange bootstrap 两项精确相同 |
| `store.directory` / `store.file` | 与 MCP Store 精确相同；目录为规范化绝对路径，不是 `/` |
| `leaseTtlSeconds` | 30–3600，默认 120；Heartbeat 间隔为有效 TTL 的四分之一 |
| `payloadRead.enabled` / `ack.enabled` | 各自仅 exact boolean true 注册对应工具；不互相开启 |
| `inboxNotification.enabled` | exact true 开启生命周期 count-only advisory，不轮询 |
| `inboxNotification.pageSize` / `rawScanLimit` | 分别 1–50、pageSize–2000；默认 10 / 100 |
| `recipients` | 跨 adapter 回复 allowlist；无此项只允许同 adapter 的已注册端点。非法项、pi adapter、重复或与 session endpoint label 冲突使该跨 adapter 列表整体禁用 |

环境变量、优先级与文件权限详见[配置模型](../docs/tunnel-setup.md#配置模型与生成文件)。声明了 Store 时 `CE_STORE_DIR` / `CE_STORE_FILE` 只能确认同一位置，冲突拒绝，不偷偷换库。独立部署时，确保目标目录遵循 Storage 的 dedicated owner-only 0700 策略，不能用复制旧数据库来“配对”。

## 工具与参数

所有工具都重新校验当前 Pi context、allowlisted Endpoint、成功 binding，再由 Host/Storage 做最终授权。请求不能携带 sender、Session、Participant、capability 或 fencing 来自授权。未知字段拒绝。

| 工具 | 输入 | 结果/限制 |
|---|---|---|
| `ce_send` | `to`, `text`, `idempotencyKey` | 发送给 allowlisted label；幂等 key 应标识同一次逻辑发送，不是未知结果后换 key 重发 |
| `ce_read` | `messageId` | 元数据，无正文，无 ACK/消费 |
| `ce_inbox_list` | 可选 `afterAuditSequence`, `pageSize`, `rawScanLimit` | 有界、授权、Audit-first 的 Message ID 发现；不消费、不 ACK |
| `ce_read_payload` | `messageId` | 独立 opt-in；成功后正文进入模型上下文和可能持久化的 Pi history |
| `ce_ack` | `messageId`, `payloadDigest`, `payloadLength`, `messageCreatedAuditSequence` | 独立 opt-in；从授权 payload read 原样复制四项；不可计算/猜测 |

MCP 侧提供 `ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`，ACK 按其绑定 opt-in；不要要求它有 Pi 专有 `ce_read`。双方都是显式工具操作，不是后台自动对话桥。

### Inbox 分页

默认 `afterAuditSequence: 0`、`pageSize: 50`、`rawScanLimit: 2000`。边界分别为安全整数 ≥0、1–50、1–2000；应用默认值后要求 `pageSize <= rawScanLimit`。

```json
{"pageSize":10,"rawScanLimit":100}
```

结果只含 `messages: [{messageId, auditSequence}]`、`continuationAuditSequence`、`scanBudgetExhausted`。下一次显式请求可把非空 continuation 复制到 `afterAuditSequence`；该值是**最后检查的原始 Audit**，不是 ACK、消费点或全局“已读”游标。null 表示没检查任何原始行。空页不证明全库完整；用尽 raw budget 不保证还有可见消息，达到 page limit 也不证明到底。

不能让模型自动排空所有分页；若需要继续读取，应明确本次范围与预算。加入 Exchange 前的历史消息受 membership/join boundary 限制。

### Payload 与 ACK

Storage 在读取任何正文 bytes 前检查 payload_read scope、ATTACHED Session、当前 Owner/fencing、有效 lease、Exchange membership、recipient-only 可见性、精确 message_created audit 关联与 join boundary。

- 暴露上限为 **65,536 encoded bytes**；过大为 `CE_HOST_PAYLOAD_TOO_LARGE`，UTF-8 非法为 `CE_HOST_PAYLOAD_INVALID_UTF8`；不截断、不替换字符、不 base64 绕过。
- 成功内容为两项：第一项含不可信内容警告与 `ACK input metadata (reception only): ...`，第二项为原样正文。metadata-only details 不包含正文；失败、日志与 mapping 也不包含正文。
- ACK 四项只能复制自本次授权的 `ce_read_payload` 输出。`messageCreatedAuditSequence` 是 Message 创建 Audit sequence，不是后来 receipt 的 sequence，也不是 Inbox continuation。
- `CREATED` 表示首次记录 immutable receipt，`REPLAYED` 表示相同消息已有回执。ACK 仅为 reception，**不证明 delivery、read、processing 或 task completion**；不是“消费消息”或任务关闭操作。
- 读取不 ACK、不续租、不改 Ownership、不自动重试，不向其他对话注入用户消息。正文永远是不可信数据，不是新的系统/用户指令。

完整双向流程与带占位符示例见[用户指南](../docs/tunnel-setup.md#4-双向-send--inbox--read--ack)。

## 生命周期、状态与恢复

`/ce-status` 展示 Endpoint、registered、Participant/Session、lease、fencing；不是 transport status。`/ce-tunnel status` 才查看 Tunnel。

- `session_start` 从可信 `ctx.sessionManager.getSessionId()` 查 allowlist。startup/reload/resume 有 mapping 时经 `resume()` 校验；reload 缺 mapping 拒绝，其他初始化分支可调用初始 beginSession。新/fork 不继承旧 mapping。
- 成功绑定后 `pi.appendEntry("ce-mapping", ...)` 只保存 identifiers；capability 明文仅在 Host 内存。Heartbeat 默认 30 秒 / TTL 120 秒，仅维持自身 Ownership，不收发消息。
- reload 停 timer、等待在途 renew，丢弃旧内存 capability，不结束有效 durable Ownership；新代必须重新校验 resume。Pi 1.3.0 正常 reload 路径会发 session_start，不能笼统归因为“reload 没有事件”。
- quit/Session replacement 停 timer、等待 renew，并尝试 end 一次以释放 Ownership、detach。renew/end 未确认即停工具和自动续租，持久 `ce-lifecycle-blocked` 与进程级 deny-only fallback 阻止错误 adoption。
- 若诊断持久化失败且进程退出，volatile deny fallback 也丢失；重启前需 operator 核实，不能宣称自动恢复安全。
- 显式 `/ce-tunnel activate` 只在确认生成策略、映射释放证据和 requireUnowned 前提后绑定当前 Session；不把 reload 拒绝变成隐式 provision，不接管过期 Owner。配对变更具体顺序见[生效步骤](../docs/tunnel-setup.md#让保存的策略生效)。

`CE_HOST_AUTHORITY_ABSENT`、UNKNOWN、映射写入失败都不是盲重试信号。BUSY 只有在明确确认适合时才由调用者手动重试；INDETERMINATE 要先停止、另行核实 durable 状态。operator-only 恢复 CLI 不注册为 Pi command/model tool。

## Inbox advisory 不等于自动接收

开启 `inboxNotification.enabled` 后，成功绑定与 `agent_settled` 各可执行一次有界的授权 Inbox 检查，并发布 count-only 通知：

- 无 timer polling、跨进程 signal、外部 idle wake、自动排空、自动 retry 或 payload read。
- watermark 只在当前 runtime 内存中保存，不写 delivery_cursor；换代后可能重复通知。预算不完整时必须标明不完整，完整零结果静默。
- 检查前与发布前校验当前 Session/Endpoint/binding；失败锁住该代自动检查，显式 Inbox 工具仍独立。
- 无可用 UI 则不自动发现。TUI/RPC/PI WEB 是否显示或保留通知属客户端行为；dismiss 不 ACK，历史通知不证明当前权限仍有效。

## 信任边界与不提供的能力

allowlist 是 registration authority；当前 runtime 也必须经 CE Host/Storage 授权，label/工具存在不等于权限。Host trust-root secret 仅 Storage 在受控事务中读取。Capability 不进入 session entry、日志、details 或 model context。

本扩展不自动执行载荷、不自动消费、不提供 remote exactly-once、不替用户承担费用批准，也不替 Wayforge/人工宣布工作流完成。`DELIVERY_UNKNOWN` 不能改写成 `CANCELLED`。崩溃恢复、消息语义完成与发布都保持独立权威。

## 验证与现场限制

隔离 harness 覆盖工具、权限、分页、payload/ACK、Heartbeat、reload、fork 与 activation。实际 ChatGPT↔Pi 双向 send/list/read/ACK 已人工验证，真实 Tunnel Start/Stop/Restart 也已确认；这不代表所有 stdio/Desktop 部署都分别验收。机器冷启动和 iTerm2 部分交互仍未验证。用户报告过 `/ce-status` no endpoint bound，具体现场根因未完全复现；排查路径见[排障表](../docs/tunnel-setup.md#故障排查先定位层再进行最小修复)，不得把未经复现的重启建议写成已修复事实。
