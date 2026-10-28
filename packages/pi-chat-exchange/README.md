# Pi Chat Exchange

让 ChatGPT 与 Pi 通过显式工具交换持久化消息：发送、发现收件箱、授权读取，以及独立授权的接收回执（ACK）。它不是自动任务调度器，也不把 ACK 或对话回复当作任务完成。

本包版本为 **0.2.0**。CE 自有代码已获所有者授权采用 **MIT**（见 [LICENSE](LICENSE)）；第三方许可证证据已按三层证据闭合（逐版本审计记录为 `docs/license-audit.md`，仅仓库保留、不随 tarball 分发）。0.2.0 的认证范围仅 **Node 24.21.0 / Pi 1.3.0 / macOS arm64**；cloud transport 为 NOT_VERIFIED，Linux 未验证。

Development candidate (`HANDOFF-PI-NODE-SQLITE-COMPAT-02`): runtime admission uses a Node 24 candidate window plus SQLite identity/platform/compile requirements and behavioral probes. This does not change the published npm 0.2.0 artifact or its historical qualification scope. The final tested versions, declaration and limitations are recorded in the repository-only `docs/runtime-qualification.md`.

## 当前能力与典型用法

- **持久化消息**：ChatGPT 发来计划或问题，Pi 显式查看 inbox、授权读取，再以新 Message 回复检查结果。
- **独立接收回执**：按需授权 payload read 与 ACK；接收回执不等于任务完成，也不触发正文执行。
- **多 Session**：多个项目中的真实 Pi Session 使用独立 Endpoint，共享 Tunnel；ChatGPT inbox 仍不隔离对话。

当前不提供自动任务调度、自动执行或 exactly-once delivery/execution。只需自动远端执行而不逐次授权时，本项目不适用。

## 选择连接方式

- **推荐：Secure MCP Tunnel。** `/ce-tunnel` 提供设置向导、显式激活、后台 Start/Stop 和健康状态；无需 Desktop stdio 插件。按 [Tunnel 快速开始](docs/tunnel-setup.md)操作。
- **Desktop 本地 stdio 插件。** 由支持本地插件的 ChatGPT Desktop 启动 bundled MCP server；需配置本机 Node 与外置 binding。见 [ChatGPT 安装](docs/chatgpt-installation.md)。不要与 Tunnel 同时争用同一 Endpoint。

## 安装 Pi 扩展

**信任提示：Pi 扩展以你的完整用户权限运行。安装前审查源码与制品来源；消息授权门槛不等于操作系统沙箱。**

正式日常使用请用**独立安装路径**：作者交付预构建私有 tarball，消费者物理安装后 `pi install` 注册，无需仓库/build，见 [独立安装指南](docs/independent-install.md)。下面是开发者源码路径。

开发候选版本使用 Pi **1.3.0**、pnpm **12.9.1**，Node 声明为 **>=24.20.0 <=24.22.1**。准入还要求 SQLite >=3.51.3、平台/编译安全及共享行为探针，不再匹配固定 SQLite 版本或 source ID。Node 24.19.0、25.9.0 因复现 native transaction-close crash 被拒绝；24.12.0、25.2.1 因受影响的 SQLite 3.50.4 被拒绝。Node 26.12.1 仅作隔离预览，不进入正式 engines 声明。Pi host 与 MCP child 分别校验；已发布 npm 0.2.0 不变。

从仓库根目录，在已选中批准 Node 的 shell 中执行：

```sh
node --version
pnpm install --frozen-lockfile
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

扩展入口会导入包内 `dist/`；修改源码后须重新运行上述 build，再在已加载的 Session 中 `/reload`。`/reload` 不会编译源码，旧 `dist/` 会继续运行旧逻辑。

这是临时加载。若要长期从不同项目使用，在 build 后执行 `pi install /absolute/path/to/packages/pi-chat-exchange` 注册本地包，再正常启动 Pi。本地安装引用该目录，不复制源码；不要同时安装和 `-e` 加载第二份。本包不提供独立的 `ce` 安装 CLI；安装只经 Pi 的 managed npm / tarball / 本地目录三条路径。

进入交互 TUI 后：

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Setup 的 Advanced · Messaging 必须显式授权当前 Session；只保存基本 transport 设置时默认不能通信。首次 reload 缺少 mapping 时可能拒绝，随后显式 activate，不清理数据库。启动真实 Tunnel 还需父 Pi 环境的 `CE_TUNNEL_BACKGROUND_ALLOW=1` 和单独 `/ce-tunnel start`；完整步骤、可信绝对路径启动方式和 ChatGPT 自定义 MCP 配置见 [Tunnel 指南](docs/tunnel-setup.md)。

## 多项目、多 Session

每个真实 Pi Session 注册不同的稳定 Endpoint；项目目录本身不是身份。共享的 `chatgpt/main` inbox **不是 ChatGPT 对话隔离**。

- `/ce-status`：当前 Pi / CE 身份与 Ownership 状态。
- `/ce-tunnel sessions`：经当前运行时授权的、所选配置中 active Endpoint 列表，不证明 MCP 已加载。
- `/ce-tunnel deactivate`：确认后正常解绑当前本地 CE binding，不删注册/历史，也不停止 Tunnel。
- `/ce-tunnel revoke <exact-endpoint>`：撤销注册的后续权限；需先核实 transport STOPPED，不等于正常解绑。
- `/reload`：有效 binding 重新校验并恢复；已正常释放或未绑定的 Session 需要显式 activate。

转换、注册、权限和生效顺序见 [多 Session 使用指南](docs/multi-session-usage.md)。不要直接修改生成文件或删除 Store/Owner 作为排障。

## 阅读导航

| 目标 | 文档 |
|---|---|
| **独立安装（正式日常使用，预构建 tarball）** | [独立安装指南](docs/independent-install.md) |
| 首次设置、可信安装诊断、ChatGPT 连接、启动与排障 | [Tunnel 用户指南](docs/tunnel-setup.md) |
| Desktop stdio 打包与本机配置 | [ChatGPT 安装](docs/chatgpt-installation.md) |
| 工具参数、Inbox、payload/ACK、生命周期 | [Pi 扩展指南](pi-extension/README.md) |
| 多项目/Session 注册、解绑、撤销 | [多 Session 使用](docs/multi-session-usage.md) |
| 分层、身份、授权、验证与扩展点 | [架构指南](docs/architecture.md) |
| Rust Native SQLite 驱动、独立版本、缓存与发布边界 | [Native SQLite](docs/native-sqlite.md) |
| 后台进程所有权与停止约束 | [后台 Manager](docs/tunnel-manager-background.md) |
| 精确安全契约 | [协议 v2](docs/protocol-v2.md) · [Ownership](docs/ownership-contract.md) · [Storage](docs/storage-contract.md) · [ACK](docs/delivery-ack-contract.md) · [Store 安全边界](docs/storage-security.md) |

独立安装包（tarball）随包分发上表所有文档、CHANGELOG 与本版本 release notes，消费者无需访问仓库即可取得操作与安全契约。仅作者侧的治理与证据记录（如 `docs/license-audit.md`、`docs/runtime-qualification.md` 及各阶段审计记录）仅仓库保留，不进入消费者制品。

## 边界与验证

**Configured ≠ Pi-bound ≠ Connected ≠ 消息实证。** `CONNECTED` 只证明测得的传输健康；ACK 仅为 reception receipt，不证明 delivery、read、processing 或 task completion。

不自动启动/重连、接管过期 Owner、排空 Inbox、执行 payload、合并 Store 或重试未知结果。`DELIVERY_UNKNOWN != CANCELLED`。凭据文件不是加密保险箱；不要把 key、capability、正文或完整日志贴入诊断。

Store 平台 allowlist 为 macOS arm64 / Linux x64；本开发候选的 Node 回归平台为 macOS arm64，当前版本矩阵与限制记录在仓库内的 `docs/runtime-qualification.md`。Native 独立测试范围见 [Native SQLite](docs/native-sqlite.md)。不声明未来版本、完整 Linux Store、断电耐久或每种 Desktop UI 已验收。已有人工双向消息与 Tunnel 启停验收不替代本次隔离测试。

开发检查：从包目录执行 `pnpm run verify`（check → typecheck → build → test → plugin-package test）；扩展测试前须 build。证据层次见[架构指南](docs/architecture.md#验证层次)。

许可证：**MIT**，Copyright (c) 2026 zieglar。第三方依赖保留各自许可，不由 CE 的 MIT 重新授权；`@earendil-works/pi-tui@1.3.0` 与 Host peer 的制品未随包附带 LICENSE 文本（上游打包省略；经 registry 制品与上游 v1.3.0 标签根 LICENSE 三层核实为 MIT）。完整逐版本审计记录为 `docs/license-audit.md`（仅仓库保留，不随 tarball 分发）。0.2.0 的认证范围仅 Node 24.21.0 / Pi 1.3.0 / macOS arm64；cloud NOT_VERIFIED，Linux 未验证。见 [0.2.0 release notes](docs/releases/0.2.0.md) 与 [安全卸载/升级/回滚](docs/independent-install.md#5-安全卸载升级与回滚)。
