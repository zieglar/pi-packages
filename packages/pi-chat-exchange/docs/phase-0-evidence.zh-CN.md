[English](phase-0-evidence.md) | [简体中文](phase-0-evidence.zh-CN.md)

> 历史平台审计。以下结论描述标注日期的来源，不代表当前支持或发布资格。

# Phase 0 证据：pi-handoff 平台审计

> 归档（2026-10-06，PH-0002）：保留历史发现（ChatGPT plugin/tunnel/Work-chat 支持、公开 owning-session Pi API、拒绝 RPC、无需 Moshi/Herdr、真实 ChatGPT 验收 NOT_RUN）。项目改名为 pi-chat-exchange；当前合同：[protocol-v2.md](protocol-v2.zh-CN.md)；源码复用结论：[source-reuse-audit.md](source-reuse-audit.zh-CN.md)。

> **当时修订（2026-10-14）：** OpenAI 文档已说明 Desktop-only 本地插件可使用根级 `mcp.json` stdio entry 和 `${PLUGIN_ROOT}` 启动路径，ChatGPT Desktop 创作和私有安装支持本地/repo marketplace。因此下文历史“不能直接启动本地进程”和“必须 Secure MCP Tunnel”不再描述 Desktop-only 插件路径。参见 <https://developers.openai.com/plugins/deploy/desktop-only>、<https://developers.openai.com/plugins/build/plugins> 和[安装指南](chatgpt-installation.zh-CN.md)。公开 local-MCP 提交仍受 allowlist 限制；实际 Desktop 验收仍 **NOT_RUN**。

日期：2026-10-05。当天下载并完整阅读来源。来源未确立的事项标为 UNKNOWN。

## A. ChatGPT Desktop 本地 Plugin/MCP

结论：通过个人“custom MCP server”插件路径 SUPPORTED。Secure MCP Tunnel 是官方记录的连接 localhost/private MCP server 的机制。ChatGPT 侧安装需要人工 UI 操作，Pi 无法代用户完成；制品和步骤已在 [chatgpt-installation.md](chatgpt-installation.zh-CN.md) 准备。

| 问题 | 答案 | 来源 |
| --- | --- | --- |
| ChatGPT 能加载个人/本地插件吗？ | 能。`chatgpt.com/plugins` → plus → Create custom MCP server 创建个人插件（无需公开提交）；之后在个人插件列表中安装。桌面测试另有本地 marketplace 机制（`~/.agents/plugins/marketplace.json`，需重启桌面应用）。 | developers.openai.com/plugins/quickstart, /plugins/deploy/connect-chatgpt, /plugins/build/plugins |
| 插件能直接启动本地 MCP 进程吗？ | 无直接 localhost。连接方式为公开 HTTPS endpoint（SSE 或 streaming HTTP，通常 `/mcp`）或 Secure MCP Tunnel。本地测试也可用 development tunnel 或其他 HTTPS forwarding service。 | developers.openai.com/plugins/deploy/connect-chatgpt, /api/docs/guides/custom-mcp-server |
| localhost/private MCP 必须用 Secure MCP Tunnel 吗？ | 是，这是文档路径。`tunnel-client` 在用户机器运行，通过出站 HTTPS 向 OpenAI 长轮询，并转发到本地 stdio command 或 HTTP MCP server URL。需要 `tunnel_id`（Platform → Settings → Tunnels）、运行时 API key（`CONTROL_PLANE_API_KEY`）和 Tunnels Read+Use 权限。 | developers.openai.com/api/docs/guides/secure-mcp-tunnels, github.com/openai/tunnel-client |
| 普通 Chat 可用，还是仅 Work？ | Work。quickstart 明确把首页 Chat 切到 Work 并启动 Work chat；在 Work prompt box 中通过 `@` 调用插件。文档一致描述 web/desktop 的 Work chats。按当时文档普通 Chat 为 NO；未来版本 UNKNOWN。 | developers.openai.com/plugins/quickstart, /plugins/build/mcp-events |
| 如何安装/注册插件？ | Web UI：ChatGPT Plugins → Create custom MCP server → (Server URL or Tunnel) → “Create as a plugin” → 从个人插件安装。Desktop：本地 marketplace 文件加应用重启。 | 同上 |
| 需要 manifest/configuration 吗？ | 个人 custom MCP server 除 name/description/connection/auth 外无需其他配置。打包 manifest（`plugin.json`、`.app.json`）仅目录提交或 marketplace 分发需要。 | /plugins/build/plugins |
| 支持哪些 MCP transport？ | SSE、streaming HTTP（公开 endpoint）；tunnel-client 的 upstream 支持 stdio 或 HTTP。 | /api/docs/guides/custom-mcp-server, /api/docs/guides/secure-mcp-tunnels |
| 支持 write tool 吗？ | 是。没有 `readOnlyHint: true` 的工具视为 write action。 | /api/docs/guides/custom-mcp-server |
| write tool 需要用户确认吗？ | 是，默认需要确认；approve/deny 可按对话记忆；遵守 `readOnlyHint`。 | /api/docs/guides/custom-mcp-server |

对 smoke 的含义：`pi-handoff` 通过 stdio 提供 MCP（可与 `tunnel-client --mcp-command` 配合，无开放端口）；`ping` 携带 `readOnlyHint: true`，让 ChatGPT 视为只读。

## B. Pi 运行时集成

结论：SUPPORTED_PUBLICLY。在已安装 Pi 0.86.1 的公开文档 API 下，首选架构“现有 Pi session 通过扩展消费 handoff”可行。

| 问题 | 答案 | 来源 |
| --- | --- | --- |
| 能向 owning session 编程注入 prompt 吗？ | 能。`pi.sendUserMessage(content, options?)` 发送如用户输入的真实用户消息，总会触发 turn；streaming 时 `deliverAs: "steer" \| "followUp"` 入队；`nextTurn` 延期。 | pi docs extensions.md — ExtensionAPI Methods |
| 有哪些相关 hook/event？ | `session_start`（startup/reload/new/resume/fork）、`agent_start`、`agent_end`（run message）、`agent_settled`（不再自动继续）、`turn_start`/`turn_end`（message + toolResults）、`message_*`。 | extensions.md — Events |
| session identity/custom entry？ | `ctx.sessionManager.getSessionFile()`、`getEntries()`；`pi.appendEntry(customType, data?)` 持久化扩展数据（可在 `session_start` 恢复）；`ctx.cwd` 表示工作区。 | extensions.md — ExtensionContext / appendEntry |
| EventBus？ | 扩展中 `pi.events`；SDK host 用 `createEventBus()`；同一 Pi 进程内扩展间通信。 | sdk.md — Event Bus |
| RPC 是否适用？ | 不适用此架构：`pi --mode rpc` 是独立 headless session 协议，会在 Moshi/Herdr 旁创建竞争 session，handoff 明确拒绝。 | rpc.md |
| 如何加载扩展？ | `~/.pi/agent/extensions/*.ts`（全局）、`.pi/extensions`（项目）、`settings.json → extensions` 路径或 pi package。后续 pi-handoff 扩展通过这些公开位置安装。 | extensions.md — Extension Locations |

冻结设计无需私有 Pi API。后续若超出 `sendUserMessage` + lifecycle event + appendEntry，必须报告缺口，不能用私有 API 补齐。

## C. Moshi / Herdr 边界

结论：NOT_REQUIRED。Moshi 和 Herdr 保持 UI/runtime host 角色：它们已支持启动带扩展的 Pi，pi-handoff 扩展在现有 session 内运行。源码或 API 证据均未要求为 handoff 协议直接集成 Moshi/Herdr。

## 停止条件检查

handoff §18 的停止条件均未触发：

- ChatGPT 支持假定的本地 MCP 机制（经 tunnel）。
- 安装虽手动，但有完整文档，不依赖未记录技巧。
- 公开 Pi API 可以注入现有 session。
- smoke 无需修改生产 Pi/Moshi/Herdr。
- repo 工作树基线干净；仅修改预期文件。
- 本包没有复制或暴露凭证。
- 未使用私有 Pi API。

## 真实 ChatGPT 验收

NOT_RUN。ChatGPT 侧 tunnel 创建、插件创建/安装及 Work-chat 调用需要用户手工交互和凭证。这符合预期且不阻塞 Phase 1：协议级测试证明服务端路径；用户可按 [chatgpt-installation.md](chatgpt-installation.zh-CN.md) 执行 ChatGPT 侧步骤。只有 ChatGPT 自身成功调用 `ping` 后才能宣称验收。
