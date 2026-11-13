[English](CHANGELOG.md) | [简体中文](CHANGELOG.zh-CN.md)

# 更新日志

## 0.3.3（候选）

- 将 Session Switch、显式/当前 Runtime Binding、Named Groups 与 `ce-bind` 统一纳入正式源码和构建链。
- 重建 TaskOwner Guard：私有有界 registry 读取并在每次查询前重新执行实时准入；Runtime 选择与消息投递均不授予归属权。
- 新增默认关闭、绑定精确 launch digest 的 Source Metadata Probe，仅用于一次真实 `ping` 观察，不暴露来源元数据。
- 保留 0.3.2 native-read 行为及既有消息、ACK、Hooks、Native 与 Tunnel 权限边界。范围与限制见 [0.3.3](docs/releases/0.3.3.zh-CN.md)。

## 0.3.2

- 原生读取在单次调用内保留协议结果，避免大型工具输出被展示 Hook 压缩后无法校验。注册 SDK 工具和 Hook 仍照常执行，错误与严格原生校验保持有效。
- 将 native-read 协议模块纳入制品运行依赖，覆盖展示替换后仍能精确接收的回归场景。
- 任务归属、选择器、权限和禁止重放规则不变。发布及生产升级仍需各自授权和制品证据，详见 [0.3.2 范围与限制](docs/releases/0.3.2.zh-CN.md)。

## 0.3.1（候选，尚未发布）

- 将会话引导/恢复、限定后台许可、Hook管理、可选原生接入及结构化归属反馈纳入可重建源码。
- 草稿缺失或非字符串时在输入前拒绝；保持单次尝试、全文校验及UNKNOWN历史不变。
- 本地Hook源码与npm制品范围明确区分，不自动激活或扩大权限。
- 发布仍须通过latest Tunnel及确切候选证据门。详见[0.3.1范围与限制](docs/releases/0.3.1.zh-CN.md)。

## 0.3.1-daily.1（本地整合）

- 保留已发布 0.3.0 的 Hooks 运行时、配置与打包能力，同时整合已验收的 Connect/Disconnect、持久启动许可及 TUI 改进。
- 本地制品采用独立身份，与原发布 0.3.0 不同；本轮不向 Registry 发布。

## 0.3.0

- 新增自愿启用的 `ce.message.committed.v1` Hooks，仅在消息创建确认提交后触发。静态本地命令只接收元数据，不含 Payload、凭据或权限字段；Hook 结果不改变消息持久化、ACK 或任务状态。
- `ce-multi-session-v1` 支持按注册配置 Pi Hook、按 binding 配置 MCP Hook。实际启动前检查已加载策略与当前策略的交集，撤销后可拒绝排队任务；不取消已运行脚本，不自动重放或重试，不承诺 exactly-once。
- 包含 `ce-hook-script` Agent Skill 和 Python 文件通知示例。配置方式及执行边界见 [Hooks](docs/hooks.zh-CN.md)。
- 0.3.0 需要匹配自身 runtime digest 的新兼容证据。历史 0.2.2 Cloud 证据不能用于认证此候选，发布仍受现有 Release Gate 约束。

## 0.2.2

### 修复

- 显式 `CE_TUNNEL_CLIENT_PATH` 表示用户对外部程序及安装路径写入者的信任委托，允许祖先目录 group-write；自动发现继续严格准入。仍拒绝文件自身 group-write、world-write、异常 owner、macOS allow/未知 ACL 和项目路径。
- 验证可识别的 Homebrew wrapper 字面 execTarget；不将 `$` 或反引号展开误认为字面执行身份证据。Node、Native、凭据传递、进程 ownership、Stop/Recovery 不变。
- 本地 RC 使用物理 tarball 验证，npm 正式版仍为 0.2.1。0.0.16 有本地准入/Doctor 实机证据；官方 0.0.18 尚未完成 CE 运行兼容性验证，真实 Cloud E2E 仍未验证。
- 其他有效写入者可替换获准程序，恶意 client 可读取用户 Tunnel 凭据；不承诺消除检查到执行之间的竞争窗口。无需修改 Homebrew 权限或绕过 Gatekeeper。

## 0.2.1

0.2.1 包含：

- Rust Native SQLite 成为唯一的默认持久化驱动，沿用 `ce-sqlite-v0.1.0` 的固定信任 pins，不自动下载，也不回退到 `node:sqlite`。
- Native 就绪检查：未就绪时保留 Pi 管理功能，拒绝 Store、消息操作和 Tunnel start。提供显式 `/ce-native` 状态、校验、安装、修复和更新发现命令；安装后需重启 Pi，再进行 setup 或消息操作。
- Node 下限为 `>=22.19.0`，与 Pi 1.3.0 Host 一致。本地 Node 22 / Pi 1.3.0 首次运行与持久化检查已通过；Linux x64 hosted 检查在 Node 22.19.0 和 24.22.2 上均通过 227/227。Linux arm64 Store 资格、WSL2 集成和云传输仍未验证。
- 精简 npm 分发，包含预构建运行时文件，通过 GitHub 链接提供操作指南；修复发布 CI 和已安装 Host 测试夹具。

### 发布流程说明

ACK changeset 已消费，并与 0.2.0 中已描述的行为协调。这属于版本流程整理，不是 0.2.1 新增的 ACK 功能。下方历史 0.2.0 条目保持原样。

## 0.2.0

已在 npm 发布为 `@zieglar/pi-chat-exchange@0.2.0`。下列资格及功能声明描述该发布，不代表后续开发支持。

这是扩展首个打包发布系列。0.1.1 仅为内部私有版本，从未发布 npm，因此下列内容不构成从公共版本升级。CE 自有代码经所有者授权采用 MIT，Copyright (c) 2026 zieglar。第三方许可证证据已完整，manifest 已移除 `private: true`。

### 消息

- 新增默认禁用、自愿启用的 `ce_ack` MCP 工具，仅在 binding 声明 Session 授权 ACK 能力时公布。Host 提供全部权限字段，等价调用重放原回执。ACK 记录接收方的接收声明，不证明投递、阅读、处理或任务完成。BUSY 回滚及不确定结果从不授予重试权限。

### Tunnel 生命周期命令

- 新增 `/ce-tunnel doctor`：只读资格诊断。未安装受信客户端时，返回安全拒绝，例如 `CE_EXECUTABLE_UNTRUSTED`。这是预期诊断，不是安装失败；`doctor` 永不是退出证明。
- 新增 `/ce-tunnel deactivate`：有界、正常释放本 Session 自己的 binding，保留注册与历史。它不属于 revoke 或 Recovery。

### 多 Session 与运行时

- 支持共享 Tunnel 上的独立 Pi Session：`/ce-tunnel convert` 保留当前原生 Session 的原端点；`/ce-tunnel register` 为新 Session 分配自己的稳定端点，不启动传输。
- 支持用于固定 Node 启动路径的受信 portable runtime 安装。

### 运行时资格

- 0.2.0 认证目标精确为 **Node 24.21.0 + Pi 1.3.0 + macOS arm64**。
- Node **24.22.1** 曾作为第二个允许运行时准入，并仍在 `engines` 中声明。该历史准入**不属于** 0.2.0 认证。Linux 为实验性、未验证。

### 打包与文档

- 准备预构建 Pi 扩展 npm 分发及消费端文档闭合。消费端 tarball 携带操作指南以及协议、所有权、存储、ACK、Store 安全契约，无需仓库访问即可按文档安全操作。第三方审计以三层证据闭合后移除 `private: true`。所有者授权的 MIT LICENSE 随预构建 tarball 分发；依赖许可证独立，安装/再分发时必须保留。
- 记录自有传输 Stop、独立确认 STOPPED、正常释放 binding，再经原生 Pi 移除的顺序；保留 Store、profile、凭证、历史。
- 区分 managed npm、物理 tarball fallback、monorepo 源码开发路径。
- 云传输为 NOT_VERIFIED；仅有离线合成夹具。

### 发布流程说明

排队中的 `.changeset/ce-e2b-ack-mcp.md` patch 条目描述相同 `ce_ack` 行为，已反映于此 0.2.0 条目。此条目刻意**不消费**该 changeset：Changesets 仍是仓库版本权威，未来 Changesets version PR 必须将它与手写 0.2.0 条目及 0.2.0 版本 pin 一并协调、消费。本变更未触及根 Changesets 配置或排队条目。移除 `private` 后，`privatePackages.version: false` 不再使该 changeset 保持不活动，下一次 version PR 须显式负责协调。

**第三方证据已完整；已移除 `private: true`。** 101 项依赖闭包已完整审计。两个原证据缺口（pi-tui、Host peer）以三层精确版本证据闭合：registry tarball MIT 声明，加上游 `v1.3.0` tag 根 LICENSE（MIT，(c) 2025 Mario Zechner）；产物缺少许可证文本属于上游打包遗漏，不是不兼容。逐版本审计记录为 `docs/license-audit.md`，仅保留仓库，不随 tarball 分发。所有者授权仅覆盖 CE 自有代码，不授予依赖再许可权。
