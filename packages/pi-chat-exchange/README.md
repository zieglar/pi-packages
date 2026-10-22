# pi-chat-exchange

让 ChatGPT 与 Pi 通过显式工具交换持久化消息：发送、发现收件箱、按 ID 读取，以及独立授权的接收回执（ACK）。适合人工监督的分析交接、执行反馈和后续追问；它不是自动任务调度器，也不把对话回复当作任务完成。

这是 **private / Local Dogfood** 包，当前版本 `0.1.1`，不是正式产品发布。历史名称 `pi-handoff` 已迁移，旧阶段文档保留作溯源。

## 当前支持什么

- Pi 1.3.0 扩展；Node.js **24.21.0** 的私有 SQLite Store。
- ChatGPT 侧可使用 Secure MCP Tunnel（`tunnel-client 0.0.16`），或独立的 Desktop 本地 stdio 插件路径。两种部署不要同时占用同一个 Endpoint。
- `/ce-tunnel` 提供设置向导、状态、显式后台 Start/Stop；Advanced Messaging 为当前 Pi Session 生成互补配置。
- 双方共享同一个 Store 和 Exchange，但各自持有独立 Endpoint / Session / Ownership。收件人是显式 allowlist，不自动发现。
- `ce_send`、`ce_inbox_list`、Pi 的元数据工具 `ce_read`，以及分别 opt-in 的 `ce_read_payload`、`ce_ack`。

**验证边界：** 已实际验证 ChatGPT→Pi、Pi→ChatGPT 的 send/list/read/ACK，以及真实 Tunnel Start/Stop/Restart；这是本地人工验收，不是所有客户端或平台认证。本次文档更新没有重做真实消息验证。机器冷启动、iTerm2 部分交互体验尚未验证；历史页面中的 NOT_RUN 描述对应当时的阶段，不能当作当前总体状态，也不能将后来的验收外推到未测部署。

## 安装与开始

在仓库根目录安装依赖、构建，再从同一项目目录启动 Pi：

```bash
mise exec node@24.21.0 -- pnpm install
mise exec node@24.21.0 -- pnpm --dir packages/pi-chat-exchange run build
mise exec node@24.21.0 -- pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

若未使用 mise，请用已安装的 Node 24.21.0 运行同样命令；不要切换全局 Node。已经安装此扩展时不要再用 `-e` 加载第二份。

1. 执行 `/ce-tunnel setup`，在 masked 输入中提供凭据，不要发到聊天里。
2. 在 Review → Back · Edit configuration → Advanced · Messaging 显式授权当前 Session，最后 Save。
3. 按[用户指南](docs/tunnel-setup.md)加载所选策略并显式激活 Pi，另行授权真实后台启动。
4. 依次检查 Pi-bound、Tunnel CONNECTED，再执行经授权的双向消息流程。

只想使用 Desktop 本地插件、不使用 Tunnel？走[本地插件安装](docs/chatgpt-installation.md)，不要混用两套配置位置。

## 阅读导航

| 你要做什么 | 文档 |
|---|---|
| 首次设置、Start/Refresh/Details/Stop/Close、双向消息、重启恢复 | [Tunnel 用户指南](docs/tunnel-setup.md) |
| Profile、managedBinding、Session Mapping、Store/Exchange、环境变量、排障 | [Tunnel 配置与排障](docs/tunnel-setup.md#配置模型与生成文件) |
| Pi 工具参数、Inbox/读取/ACK、生命周期与安全边界 | [Pi 扩展指南](pi-extension/README.md) |
| Desktop 本地 stdio 插件部署 | [ChatGPT 安装](docs/chatgpt-installation.md) |
| 分层、身份、授权、测试与扩展点 | [开发者架构指南](docs/architecture.md) |
| 后台进程、锁、健康证据和停止语义的详细约束 | [后台 Manager](docs/tunnel-manager-background.md) |
| 协议、Ownership、存储、ACK 的精确定义 | [协议 v2](docs/protocol-v2.md) · [Ownership](docs/ownership-contract.md) · [Storage](docs/storage-contract.md) · [ACK](docs/delivery-ack-contract.md) |
| 诊断隐私与隔离模拟器 | [Debug logging](docs/debug-logging.md) · [Offline Manager](docs/tunnel-manager-offline.md) |

## 必须理解的限制

- **Configured ≠ Pi-bound ≠ Connected ≠ 消息实证。** `CONNECTED` 只证明测得的传输健康。
- Inbox/list/read 不消费消息；ACK **仅为 reception receipt**，不是 delivery、read、processing 或 task completion 的证明。
- `DELIVERY_UNKNOWN != CANCELLED`；不保证远端 exactly-once，不盲目重试未知结果。
- 不自动启动、接管过期 Owner、清空 Store、轮询排空 Inbox，或将载荷当指令注入其他对话。
- CE 的 Message/Result/Receipt 不替代 Wayforge 工作流、Pi 运行时或人工批准的完成权威。
- 凭据存于私有文件而非加密保险箱；屏蔽输入不防恶意同进程扩展、录屏、剪贴板或内存观测。

## 开发检查

从包目录运行 `pnpm run check`、`pnpm run typecheck`、`pnpm run build`、`pnpm test`；`pnpm run verify` 还包括打包插件测试。测试前必须 build。详见[开发者指南](docs/architecture.md#验证层次)。

许可证：bootstrap 期间保持 private；首选 Apache-2.0，仍待仓库同等来源审查，不授权发布。
