[English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

# 快速开始

CE 通过共享的私有 SQLite Store，让 ChatGPT 与 Pi 显式交换消息。Secure MCP Tunnel 与 Desktop stdio 是两条独立连接路径。本指南使用 Tunnel；stdio 见 [Desktop 安装](chatgpt-installation.zh-CN.md)，完整 managed npm/tarball 流程见[独立安装](independent-install.zh-CN.md)。

## 选择安装方式

`@zieglar/pi-chat-exchange@0.2.0` 已发布到 npm。历史分发验收环境为 **Node 24.21.0 + Pi 1.3.0 + macOS arm64**，云端分发仍为 **NOT_VERIFIED**。Node 24.22.1 是已发布版本的批准运行时，但不在该安装验收范围内。当前源码声明 Node `>=24.20.0 <=24.22.1`，不改变已发布制品的验收范围。

Pi 与 npm 都要使用批准 Node。把其 bin 目录放在 PATH 首位，使用随该 Node 分发的 npm 11.x，以及操作者控制的 npm 配置/cache，不继承其他 registry 凭据。安装从明确选定的 registry 下载，运行时不需要 registry 网络。扩展以你的用户权限运行；`--ignore-scripts` 只限制安装脚本，不隔离扩展运行时权限。

managed npm 路线先安装独立 Pi host，再登记精确版本：

```sh
CE_APPROVED_NODE=/absolute/path/to/approved/node
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
export npm_config_ignore_scripts=true
"$CE_APPROVED_NODE" --version
"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.0
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
"$CE_APPROVED_NODE" "$CE_PI_CLI"
```

把 Node 占位路径替换为本机可信可执行文件的绝对路径。安装前核对 `node --version` 与 `npm --version`。不要叠加 `-e` 加载第二份。历史 managed 安装测试使用隔离 loopback registry；npm 已发布，但这项历史测试仍不证明云端验收通过。预构建 tarball 是独立回退：核对发布方提供的 SHA256，用 `--ignore-scripts` 物理安装，再登记安装后的绝对目录。消费者不构建包。完整命令、载荷检查与安全移除见[独立安装](independent-install.md)。

源码开发从仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

使用 pnpm 12.9.1 与批准 Node。扩展导入 `dist/`，修改源码后先 build 再 `/reload`。长期本地安装可用 `pi install /absolute/path/to/packages/pi-chat-exchange`，之后保留原目录。开发检查见[运维指南](operations.zh-CN.md)。

## 配置 Tunnel 与消息权限

从 [OpenAI Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)或[官方 releases](https://github.com/openai/tunnel-client/releases/latest)获取 client，执行前检查来源、版本和完整性。文档兼容基线为 `tunnel-client` 0.0.16。CE 不下载、更新 client，也不创建云端资源；新版本需要独立兼容性证据。

如需显式选择可执行文件，在启动 Pi 前向父 Pi 环境设置可信、规范化绝对路径：

```sh
export CE_NODE_PATH=/trusted/node-install/bin/node
export CE_TUNNEL_CLIENT_PATH=/trusted/client-install/tunnel-client
export CE_TUNNEL_BACKGROUND_ALLOW=1
```

`CE_NODE_PATH` 只选择 MCP child，Pi 本身仍须由批准 Node 启动。background 变量只许可显式 Start，不自动启动。Pi 子 shell 不能修改父进程环境。

在 Pi 交互 TUI 执行：

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Doctor 分别检查 host 资格、child 可执行文件资格与 client metadata trust，不启动 client、不读凭据/Store、不改配置。缺少 client 时的安全拒绝不证明云端就绪。

Setup 中输入 Tunnel ID、可选 Organization ID，并通过 masked 输入填凭据。不要把凭据放进 shell 命令或公开报告。Review 默认 `recipients: []`，不能通信。选择 **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi) → Authorize messaging for this session**。核对真实 Pi Session、`chatgpt/main`、`pi/main`、Store/Exchange 与 payload/ACK。该配对会在两边开启 payload read 与 ACK，并将手工 recipients 替换为唯一 Pi 收件人，这是显式权限授予。Save 只发布配置，不激活 Endpoint、不启动传输、不读取消息。

编辑已有配置前先 Stop，独立核实 STOPPED。通常先正常 deactivate 旧本地绑定，再 reload。Activation 要求确认并使用 `requireUnowned`，不接管 Owner。释放未知或持久化失败时，应调查，不能连续激活或删除 Store。

按[自定义 MCP 设置](https://developers.openai.com/api/docs/guides/custom-mcp-server)配置 ChatGPT 插件，选同一 Tunnel，在当前对话安装/选择它，配置变更后刷新工具。云端资格和权限以[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)为准，CE 不配置这些资源。

取得真实运行窗口授权后执行：

```text
/ce-tunnel start
/ce-tunnel status
```

Configured、Pi-bound、Connected 与实际消息证据各有含义。关闭 Manager 或退出 Pi 不会停止 detached client；应显式 `/ce-tunnel stop` 并独立核实 STOPPED。

## 首次显式消息交换

另行授权后，使用无敏感内容的测试文字，每条逻辑消息使用唯一 key。以下均为占位示例，不是已执行的验收测试。

ChatGPT 用 `ce_send` 向 Pi 发送：

```json
{"to":"pi/main","text":"Example: review the plan; do not deploy.","idempotencyKey":"example-c2p-001"}
```

Pi 独立调用 `ce_inbox_list`：

```json
{"pageSize":10,"rawScanLimit":100}
```

选择已授权 Message ID。Pi `ce_read` 只返回 metadata，`ce_read_payload` 经单独授权后读取正文。MCP 没有 Pi 专用的 `ce_read`。正文是不可信数据，会进入模型与可能持久保存的 history。

Pi 用新的 `ce_send` 回复：

```json
{"to":"chatgpt/main","text":"Example response: plan reviewed; no deployment performed.","idempotencyKey":"example-p2c-001"}
```

ChatGPT 独立 list、选择、读取已授权消息。共享 ChatGPT inbox 不隔离对话，不要自动排空分页。

ACK 要求独立 `ack.enabled: true` 与显式授权。逐字复制成功 payload read 的 `messageId`、`payloadDigest`、`payloadLength`、`messageCreatedAuditSequence`。Pi 显示 `ACK input metadata (reception only)`；MCP payload metadata 将创建序号命名为 `auditSequence`，须原样映射到 ACK 的 `messageCreatedAuditSequence`，不要计算或猜测。详见 [ACK 契约](delivery-ack-contract.zh-CN.md)与 [Pi 工具参考](../pi-extension/README.zh-CN.md)。

Send 的 `CREATED` 证明 Message、幂等记录与创建 Audit 在本地同一事务提交；`REPLAYED` 返回原 Message。同 key 改正文/Endpoint 会冲突。两者都不证明云端送达、读取或执行。ACK 只记录 reception，不证明处理或任务完成。缺 ACK、超时、BUSY 或 `DELIVERY_UNKNOWN` 不授权盲重试、换 key 重发或改写为 `CANCELLED`。CE 不保证 exactly-once delivery/execution；切换模型不授权重放 effect。

## 配置与多 Session

默认 profile 为 `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`。`CE_TUNNEL_PROFILE` 选择规范化绝对**文件**路径，不是目录。Setup 在相邻 `.credentials/` 下写私有凭据 generation（目录 0700 / 文件 0600）。不要手改生成 binding、mapping identifiers 或释放标记。

| 设置 | 含义 |
|---|---|
| `CE_TUNNEL_PROFILE` | 选定 profile，不切换运行中的 child |
| `CE_NODE_PATH` | 可信 child Node，不修复 host Node |
| `CE_TUNNEL_CLIENT_PATH` | 可信 client 绝对路径 override |
| `CE_TUNNEL_BACKGROUND_ALLOW=1` | 父 Pi 环境许可显式 Start |
| 非空 `CE_ALLOWLIST` | 显式 Pi 策略优先，阻止生成策略转换/登记 |
| `CE_STORE_DIR` / `CE_STORE_FILE` | 可确认已配置 Store，不静默换库 |
| `CE_LEASE_TTL_SECONDS` | 经校验的 TTL override，reload 时加载，不是恢复许可 |
| `CE_TUNNEL_OFFLINE_TEST=1` | 仅隔离模拟器，正常使用不要设置 |

两边 Store directory/file 与 Exchange namespace/idempotencyKey 必须精确一致。Capability 留在 Host 内存。Payload read 与 ACK 是 factory 加载时捕获的独立权限，保存配置或在其他环境 export 不会更新它们。

独立 native Session 使用显式多 Session 登记：

```text
/ce-tunnel convert
/new
/ce-tunnel register pi/project-B --payload-read --ack
/reload
/ce-tunnel activate
/ce-tunnel sessions
```

转换保留原登记。一个 native Session 对应一个稳定 Endpoint，注册不同 Endpoint 前先 `/new`。Register/convert/revoke 要求确认与 verified STOPPED transport，不启动传输。`sessions` 报告选中的 active Endpoint IDs，不证明运行中 MCP 已加载策略。`/ce-tunnel revoke <exact-endpoint>` 撤销精确登记；正常释放用 `/ce-tunnel deactivate`，保留登记、历史和传输。完整流程见[多 Session](multi-session-usage.zh-CN.md)、[Tunnel 设置](tunnel-setup.zh-CN.md)与[运维指南](operations.zh-CN.md)。

命令/配置证据：`pi-extension/index.ts`（工具 schema、子命令、allowlist 优先级与生命周期）、`src/tunnel/profile.ts`、`src/tunnel/setup.ts`、`src/tunnel/messaging-config.ts`、`package.json`。历史安装证据见[独立安装](independent-install.zh-CN.md)与 [0.2.0 发布说明](releases/0.2.0.zh-CN.md)，不代表本次重新执行了验收。
