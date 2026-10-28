# Pi Chat Exchange 扩展指南

开发候选运行基线：**Pi 1.3.0 / Node.js >=24.20.0 <=24.22.1**，另须满足 SQLite >=3.51.3、平台/编译安全与共享行为探针；不再要求固定 SQLite/source ID。Node 24.19.0、25.9.0 因已复现的 native transaction-close crash 被拒绝，24.12.0、25.2.1 因旧 SQLite WAL 缺陷被拒绝。Node 26.12.1 仅作隔离预览；Pi host 和 MCP child 分别校验。实测平台为 macOS arm64；已发布 npm 0.2.0 不变。正式安装见[独立安装指南](../docs/independent-install.md)，源码开发见 [Tunnel 用户指南](../docs/tunnel-setup.md)，Desktop stdio 见[安装路径](../docs/chatgpt-installation.md)。

## 加载与两种配置方式

在仓库根目录、已选中批准 Node 的 shell 中，先 build 再临时加载一次。mise 不是要求：

```sh
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

长期跨项目使用可在 build 后 `pi install /absolute/path/to/packages/pi-chat-exchange` 注册本地包；已安装时不要再 `-e` 第二份。批准 Node 的可信绝对路径启动方式见 [安装](../docs/tunnel-setup.md#1-前提与安装)。支持的配置路径：

1. **推荐：Tunnel 生成策略。** 初次用 Advanced Messaging 生成配对；多 Session 用显式 convert/register。profile 选中 immutable binding 与配套 sidecar，Store/Exchange 精确一致，每个真实 Pi Session 绑定独立 Endpoint，见[多 Session 指南](../docs/multi-session-usage.md)。
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

`/ce-status` 展示经当前 admission 校验的 native Pi Session、Endpoint、registered、Participant、CE Session、Exchange、lease 和 fencing。CE Session 是 Owner incarnation，不是 native Pi Session；标识符都不是认证凭据。`/ce-tunnel status` 查看 transport；`/ce-tunnel doctor` 只读检查 host/child Node 与 client 信任，不联网或读 Store。

- `session_start` 从可信 `ctx.sessionManager.getSessionId()` 查 allowlist。startup/reload/resume 有 mapping 时经 `resume()` 校验；reload 缺 mapping 拒绝，其他初始化分支可调用初始 beginSession。新/fork 不继承旧 mapping。
- 成功绑定后 `pi.appendEntry("ce-mapping", ...)` 只保存 identifiers；capability 明文仅在 Host 内存。Heartbeat 默认 30 秒 / TTL 120 秒，仅维持自身 Ownership，不收发消息。
- reload 停 timer、等待在途 renew，丢弃旧内存 capability，不结束有效 durable Ownership；新代必须重新校验 resume。Pi 1.3.0 正常 reload 路径会发 session_start，不能笼统归因为“reload 没有事件”。
- quit/Session replacement 停 timer、等待 renew，并尝试 end 一次以释放 Ownership、detach。renew/end 未确认即停工具和自动续租，持久 `ce-lifecycle-blocked` 与进程级 deny-only fallback 阻止错误 adoption。
- 若诊断持久化失败且进程退出，volatile deny fallback 也丢失；重启前需 operator 核实，不能宣称自动恢复安全。
- 显式 `/ce-tunnel activate` 只在确认生成策略、映射释放证据和 requireUnowned 前提后绑定当前 Session；不把 reload 拒绝变成隐式 provision，不接管过期 Owner。配对变更具体顺序见[生效步骤](../docs/tunnel-setup.md#让保存的策略生效)。
- `/ce-tunnel deactivate` 经当前 Session 确认后走正常 end/release/detach，停止续租但不停止 Tunnel、不撤销注册、不删除消息；取消不解绑，重复调用不重复 end。已正常释放后 reload 不自动重绑；需显式 activate。未知释放或证据写入失败仍拒绝，不因通知或标记而自授权。

`CE_HOST_AUTHORITY_ABSENT`、UNKNOWN、映射写入失败都不是盲重试信号。BUSY 只有在明确确认适合时才由调用者手动重试；INDETERMINATE 要先停止、另行核实 durable 状态。operator-only 恢复 CLI 不注册为 Pi command/model tool。

## 安全卸载

遵守[独立安装指南的停止、释放、原生移除流程](../docs/independent-install.md#5-安全卸载升级与回滚)。deactivate 不停止后台 Tunnel；退出 Pi 也不等于 STOPPED。确认相关使用者与共享资源前置条件、正常 release 后再退出自己的 Hosts，用 Pi 原生 remove 精确 source；不增加卸载 hook/CLI，不删除 Store/profile/凭据/history，不操作无关 Session，UNKNOWN 即停止。

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

隔离 harness 验证工具、权限、分页、payload/ACK、Heartbeat、reload、fork 与显式 binding 操作；不证明真实终端或云端连接。平台及人工消息验收边界见[概览](../README.md#边界与验证)。no endpoint 应按当前身份、策略和 mapping/release 证据排查，不把 reload/重启当通用修复；见[排障表](../docs/tunnel-setup.md#故障排查先定位层再进行最小修复)。
