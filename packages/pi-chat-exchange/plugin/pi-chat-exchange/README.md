# Pi Chat Exchange — ChatGPT Desktop 本地插件

这是 Desktop-only stdio 插件，不是 Tunnel client。它启动 bundled CE MCP server，提供 `ping`、`ce_send`、`ce_inbox_list`、`ce_read_payload`；`ce_ack` 仅在外置 binding 的独立 ACK opt-in 为 true 时提供。payload 工具存在不代表实际读取已获授权。

## 安装前配置

插件不包含实际 Endpoint、Store、credential 或 capability。将 `config/binding.example.json` 复制到系统账户的：

```text
~/.config/pi-chat-exchange/mcp-binding.json
```

把模板身份和路径替换为操作者核准的值，收紧文件权限。Store directory 必须是规范化绝对 POSIX 路径且不是 `/`。Pi 侧需互补 allowlist，并精确对齐 Store directory/file、Exchange namespace/idempotencyKey；两个 Endpoint 的 Ownership 仍独立。

`payloadRead.enabled` 和 `ack.enabled` 各自默认关闭，只有明确授权后才分别开启。ACK 仅记录 reception，不是 delivery、read、processing 或 task completion 的证明。

launcher 从系统 home 取得固定 binding 路径，不接受模型参数或环境变量选择身份。本地包诊断可显式传 `server/launch.mjs --config /normalized/absolute/path.json`；shipped `mcp.json` 不使用此 override。

## Runtime 与已知部署限制

- 支持 local plugins 的 ChatGPT Desktop；macOS 或 Linux。
- Store-approved **Node.js 24.21.0**。`mcp.json` 的 command 必须指向本机可执行的批准 Node，不能依赖 Desktop 受限 PATH。
- 当前源码仍固定开发机 Node 绝对路径，打包不自动适配另一台机器；安装前必须核实。路径可移植性需单独配置变更，不因本说明而视为已修复。
- 重新打包/刷新插件后用新对话发现工具；不要同时用 Tunnel 与本地插件争用同一个 Endpoint。

源码仓库中的 [ChatGPT 安装指南](../../docs/chatgpt-installation.md)包含打包、marketplace、完整虚构 binding 和恢复限制。本 README 随 artifact 分发时，相对链接可能没有仓库 docs，请回到源码仓库阅读。
