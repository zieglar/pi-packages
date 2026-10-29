# Pi Chat Exchange

[English](README.md) | 简体中文

Pi Chat Exchange（CE）让 ChatGPT 和 Pi 通过显式工具交换持久化消息。CE 保存消息、提供经授权的收件箱、区分元数据与正文访问，并记录接收回执（ACK）。发送消息不授予执行权限，也不证明任务完成。

## 功能概览

- 使用 SQLite 保存消息、作用域内的幂等键和审计证据。
- 分别授权发送、消息发现、正文读取和 ACK。
- 为每个 Pi Session 提供稳定 Endpoint，支持显式注册、激活、停用和撤销。
- 管理 Secure MCP Tunnel；另有独立的 Desktop stdio 插件路径。
- 当前源码包含内置 `node:sqlite` 驱动和需显式选择的 Rust Native 驱动。

CE 不提供自动任务调度、自动排空收件箱或 exactly-once delivery/execution。`DELIVERY_UNKNOWN != CANCELLED`；缺少 ACK 不能作为重试操作的依据。

## 系统要求与支持平台

已发布的 npm 包是 **`@zieglar/pi-chat-exchange@0.2.0`**。历史分发认证范围为 **Node 24.21.0 / Pi 1.3.0 / macOS arm64**，该次认证中的云传输状态为 **NOT_VERIFIED**。当前源码声明 Node **`>=24.20.0 <=24.22.2`**，还需通过运行时与 SQLite 检查；源码验证不会改变已发布制品。

Node 24.21.0 仍为固定 CI/开发基线。源码上限现已纳入 macOS arm64 上真实 Node 24.22.2 Store 测试，不承诺未来补丁兼容。默认驱动不支持 Node 25：25.2.1 不满足 SQLite 安全下限，25.9.0 因复现 native transaction-close crash 而明确拒绝。已测版本与限制见[运行时证据](docs/runtime-support.zh-CN.md)。

| 平台 | 当前 Native 证据 | 范围 |
|---|---|---|
| macOS arm64 | 制品、一致性测试和 Store 集成 | 不代表所有客户端或云工作流均已认证 |
| Linux x64 GNU | 制品、一致性测试和 Store 集成 | 不扩大 npm 0.2.0 的分发认证范围 |
| macOS x64 | 仅制品与一致性测试 | 尚无 Store 集成证据 |
| Linux arm64 GNU | 仅制品与一致性测试 | 尚无 Store 集成证据 |

Store allowlist 仍为 macOS arm64 / Linux x64。运行时还检查 SQLite 行为、文件系统安全和所有权。详见 [Native SQLite](docs/native-sqlite.zh-CN.md) 和[运行时资格](docs/runtime-support.zh-CN.md)。

## 安装与升级

使用批准的 Node 可执行文件运行 Pi **1.3.0**，然后安装精确版本：

```sh
node --version
pi install npm:@zieglar/pi-chat-exchange@0.2.0
pi list
```

这是 Pi 的 managed npm source 语法，没有独立的 `ce` 安装命令。扩展以当前用户权限运行，安装前应审查包及其来源。registry 上已发布只证明版本可取得，不证明本机云连接已经可用。

预构建 tarball 和专用 Host 前缀安装见[独立安装](docs/independent-install.zh-CN.md)。升级前，停止自己拥有的 Tunnel 并确认 `STOPPED`，停用受影响绑定，再退出相关 Pi Host。保留 Store 和凭据；回滚前检查 schema 兼容性。不要删除 Owner 或锁文件强行升级。

## 快速开始

在批准的 Node 运行时下启动 Pi，在交互 Session 中依次执行：

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Setup 的 Advanced · Messaging 必须显式授权当前 Session。只保存传输设置不能取得消息权限。首次 reload 可能因缺少 mapping 而拒绝；设置完成后再显式激活。激活不会启动传输。

真实 Tunnel 还需要单独安装的可信 client、已配置的 ChatGPT 连接、父进程中的 `CE_TUNNEL_BACKGROUND_ALLOW=1`，以及显式 `/ce-tunnel start`。操作步骤见[入门](docs/getting-started.zh-CN.md)和 [Tunnel 设置](docs/tunnel-setup.zh-CN.md)。Desktop stdio 路线使用独立的[安装步骤](docs/chatgpt-installation.zh-CN.md)。

## 配置说明

通过设置 UI 写入私有配置。`CE_TUNNEL_PROFILE` 指向绝对 profile **文件**路径；`CE_NODE_PATH` 选择 MCP child 的合格 Node 可执行文件；`CE_TUNNEL_CLIENT_PATH` 选择可信的 client 绝对路径。选择 child 或声明版本号，都不能替代对已运行 Pi Host 的资格检查。

正文读取和 ACK 分别授权。凭据应留在操作员拥有的凭据文件中，不要放入消息、截图或 issue。详见[配置与命令](docs/getting-started.zh-CN.md)及 [Pi 扩展参考](pi-extension/README.zh-CN.md)。

## 常用命令与消息流程

| 命令/工具 | 用途 |
|---|---|
| `/ce-status` | 查看当前 Pi/CE 身份和 Ownership 状态 |
| `/ce-tunnel doctor` | 检查安装和运行时资格，不启动传输 |
| `/ce-tunnel start`, `/ce-tunnel stop`, `/ce-tunnel status` | 显式管理和查看自己拥有的传输实例 |
| `/ce-tunnel sessions`, `register`, `convert`, `revoke` | 按规定策略管理 Session 注册 |
| `/ce-tunnel activate`, `/ce-tunnel deactivate` | 绑定或正常释放当前 Session |
| `ce_send`, `ce_inbox_list`, `ce_read` | 发送、发现消息和查看元数据 |
| `ce_read_payload`, `ce_ack` | 分别授权正文访问和接收回执 |

收到消息后，先发现消息 ID、读取元数据，再按需申请正文访问，仅在独立授权下记录 ACK。回复是新的 Message。ACK 仅表示接收回执，不证明 delivery、read、processing 或 completion。详见[多 Session 使用](docs/multi-session-usage.zh-CN.md)和 [ACK 契约](docs/delivery-ack-contract.zh-CN.md)。

## 架构与组件职责

Wayforge 负责受治理任务、策略、恢复和完成权威；CE 负责消息投递/生命周期规则、持久证据和对账；Pi 负责 Session、运行时和 Provider Transport。CE 的适配器共享 Host/Storage 权威，工具标签和模型声明不能授予权限。

恢复标记不是锁或 fencing token。切换模型不能重放已经产生副作用的任务。[架构文档](docs/architecture.zh-CN.md)说明组件职责，并区分已实现消息工具与更完整的协议模型。

## SQLite Native Driver

独立且不可变的 Native Release 为 [**`ce-sqlite-v0.1.0`**](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0)，ABI 为 **1**，内置 SQLite **3.54.1**，来源 SHA 为 **`a8386aafd657c84825b2905847f34a43d5b91e1e`**。它与 npm 0.2.0 独立，二进制不随 npm 包分发。

当前生产 Native trust pin 仍为 **`null`**。发布不会启用驱动：默认 prepare/load 拒绝未 pin 制品，默认驱动仍是 `node-sqlite`。操作员提供 manifest 属于另一次可执行代码信任决策。选择 Rust 后不会静默回退。详见 [Native 准备与校验](docs/native-sqlite.zh-CN.md)。

<a id="边界与验证"></a>

## 安全与故障排查

Configured、Pi-bound、Connected 和实际消息交换证据是不同状态，传输健康不能证明消息权限。结果未知时应保留未知事实，直到证据能够解析；不要盲目重试、接管 Owner 或删除 Store。

从[运维与故障排查](docs/operations.zh-CN.md)开始。报告错误码和脱敏元数据，不提交正文、凭据、capability 或完整原始日志。详细边界见[协议 v2](docs/protocol-v2.zh-CN.md)、[Ownership](docs/ownership-contract.zh-CN.md)、[Storage](docs/storage-contract.zh-CN.md)和[存储安全](docs/storage-security.zh-CN.md)。

## 开发、测试与贡献

在仓库根目录，使用合格的 Node 运行时及 pnpm **12.9.1**：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

扩展导入 `dist/`，修改源码后必须重新构建，`/reload` 不会编译 TypeScript。可选 client 和真实 Host 测试有各自前提，不能与默认测试混为一谈。参见[开发与发布运维](docs/operations.zh-CN.md)和[双语文档维护](docs/documentation.zh-CN.md)。

npm Trusted Publishing Workflow 已在本地实现，尚未推送，也未通过 hosted OIDC 发布验证。维护者已报告完成 npm publisher 连接配置；这与已发布 npm 0.2.0 制品及已验证 Native Release 是不同事实。

## License

[MIT](LICENSE)，Copyright (c) 2026 zieglar。依赖保留各自许可证，详见[许可证审计](docs/licenses.zh-CN.md)。
