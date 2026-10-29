# Pi Chat Exchange

[English](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/README.md) | 简体中文

Pi Chat Exchange（CE）让 ChatGPT 和 Pi 通过显式工具交换持久化消息。CE 保存消息、提供经授权的收件箱、区分元数据与正文访问，并记录接收回执（ACK）。发送消息不授予执行权限，也不证明任务完成。

## 功能概览

- 使用 SQLite 保存消息、作用域内的幂等键和审计证据。
- 分别授权发送、消息发现、正文读取和 ACK。
- 为每个 Pi Session 提供稳定 Endpoint，支持显式注册、激活、停用和撤销。
- 管理 Secure MCP Tunnel；另有独立的 Desktop stdio 插件路径。
- Rust Native SQLite 是唯一的默认持久化驱动；`node:sqlite` 仅作为显式选择的非生产兼容驱动保留。

CE 不提供自动任务调度、自动排空收件箱或 exactly-once delivery/execution。`DELIVERY_UNKNOWN != CANCELLED`；缺少 ACK 不能作为重试操作的依据。

## 系统要求与支持平台

**0.2.1** 包含 Native 默认持久化驱动、就绪检查和显式驱动管理，要求 Node **`>=22.19.0`**，与 Pi 1.3.0 的 `engines.node` 一致。本地 Node 22 / Pi 1.3.0 首次运行与持久化检查已通过。Linux x64 hosted 检查在 Node **22.19.0** 和 **24.22.2** 上均通过 **227/227**；这些结果不代表云传输已获验证。

历史 npm **0.2.0** 分发认证范围为 **Node 24.21.0 / Pi 1.3.0 / macOS arm64**，云传输为 **NOT_VERIFIED**。0.2.1 的验证结果不改变该历史范围。

Pi 1.3.0 的实际安装 manifest 声明 **Node >=22.19.0**。Native 使用 bundled SQLite，要求 Node-API >=8，不以内置 SQLite 版本决定兼容性。已测版本不构成所有后续版本的兼容承诺；显式 `node:sqlite` 兼容路径保留自身的候选版本和已知缺陷拒绝条件。测试矩阵与限制见[运行时证据](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/runtime-support.zh-CN.md)。

| 平台 | 当前 Native 证据 | 范围 |
|---|---|---|
| macOS arm64 | 制品、一致性测试和 Store 集成 | 不代表所有客户端或云工作流均已认证 |
| Linux x64 GNU | 制品、一致性测试、Store 集成与 hosted 检查 | Node 22.19.0 和 24.22.2 均通过 227/227；云传输未验证 |
| macOS x64 | 仅制品与一致性测试 | 尚无 Store 集成证据 |
| Linux arm64 GNU | 仅制品与一致性测试 | 尚无 Store 集成证据 |

Store allowlist 仍为 macOS arm64 / Linux x64。运行时还检查 SQLite 行为、文件系统安全和所有权。详见 [Native SQLite](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-sqlite.zh-CN.md) 和[运行时资格](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/runtime-support.zh-CN.md)。

## 安装与升级

使用批准的 Node 可执行文件运行 Pi **1.3.0**，然后安装精确版本：

```sh
node --version
pi install npm:@zieglar/pi-chat-exchange@0.2.1
pi list
```

这是 Pi 的 managed npm source 语法，没有独立的 `ce` 安装命令。扩展以当前用户权限运行，安装前应审查包及其来源。registry 上已发布只证明版本可取得，不证明本机云连接已经可用。

预构建 tarball 和专用 Host 前缀安装见[独立安装](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/independent-install.zh-CN.md)。升级前，停止自己拥有的 Tunnel 并确认 `STOPPED`，停用受影响绑定，再退出相关 Pi Host。保留 Store 和凭据；回滚前检查 schema 兼容性。不要删除 Owner 或锁文件强行升级。

## 快速开始

在批准的 Node 运行时下启动 Pi，先执行 `/ce-native status`。若缺少可信驱动，执行 `/ce-native install`，然后退出并重启 Pi，再进行 setup 或消息操作。CE 不会自动下载 Native。在重启后的交互 Session 中依次执行：

```text
/ce-tunnel doctor
/ce-tunnel setup
/reload
/ce-tunnel activate
/ce-status
```

Setup 的 Advanced · Messaging 必须显式授权当前 Session。只保存传输设置不能取得消息权限。首次 reload 可能因缺少 mapping 而拒绝；设置完成后再显式激活。激活不会启动传输。

真实 Tunnel 还需要单独安装的可信 client、已配置的 ChatGPT 连接、父进程中的 `CE_TUNNEL_BACKGROUND_ALLOW=1`，以及显式 `/ce-tunnel start`。操作步骤见[入门](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/getting-started.zh-CN.md)和 [Tunnel 设置](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/tunnel-setup.zh-CN.md)。Desktop stdio 路线使用独立的[安装步骤](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/chatgpt-installation.zh-CN.md)。

## 配置说明

通过设置 UI 写入私有配置。`CE_TUNNEL_PROFILE` 指向绝对 profile **文件**路径；`CE_NODE_PATH` 选择 MCP child 的合格 Node 可执行文件；`CE_TUNNEL_CLIENT_PATH` 选择可信的 client 绝对路径。选择 child 或声明版本号，都不能替代对已运行 Pi Host 的资格检查。

正文读取和 ACK 分别授权。凭据应留在操作员拥有的凭据文件中，不要放入消息、截图或 issue。详见[配置与命令](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/getting-started.zh-CN.md)及 [Pi 扩展参考](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/pi-extension/README.zh-CN.md)。

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

收到消息后，先发现消息 ID、读取元数据，再按需申请正文访问，仅在独立授权下记录 ACK。回复是新的 Message。ACK 仅表示接收回执，不证明 delivery、read、processing 或 completion。详见[多 Session 使用](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/multi-session-usage.zh-CN.md)和 [ACK 契约](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/delivery-ack-contract.zh-CN.md)。

## 架构与组件职责

任务治理、策略、恢复和完成裁决属于使用 CE 的外部工作流或操作员。CE 负责消息投递/生命周期规则、持久证据和对账；Pi 负责 Session、运行时和 Provider Transport。CE 的适配器共享 Host/Storage 权威，工具标签和模型声明不能授予权限。

恢复标记不是锁或 fencing token。切换模型不能重放已经产生副作用的任务。[架构文档](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/architecture.zh-CN.md)说明组件职责，并区分已实现消息工具与更完整的协议模型。

## SQLite Native Driver

独立且不可变的 Native Release 为 [**`ce-sqlite-v0.1.0`**](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0)，ABI 为 **1**，内置 SQLite **3.54.1**，来源 SHA 为 **`a8386aafd657c84825b2905847f34a43d5b91e1e`**。0.2.1 使用同一独立 Native Release，二进制不随 npm 包分发。

0.2.1 将 Native 作为默认驱动，即使 selection file 不存在也如此；`node:sqlite` 仅在显式选择后延迟加载，Native 信任、加载或初始化失败均 fail closed，绝不回退。生产 `NATIVE_COMPAT` pins 现已信任不可变 Release `427441708`：四个平台的 SHA-256 已与 `SHA256SUMS` 核对，七个 attestation subject 已验证绑定到该源码。0.2.1 包含这些固定信任 pins。

## Native 就绪与管理（0.2.1）

用 `/ce-native status` 或 `/ce-native verify` 检查 Native，不下载或修改选择。显式 `/ce-native install` 仅安装可信默认版本，校验成功后才更改选择；随后重启 Pi。`/ce-native repair confirm` 是显式修复。`/ce-native check-updates` 只读取 GitHub Release 元数据，`latest` 不会因此受信任或改变选择。CE 不会自动下载、修复或升级 Native。

扩展加载只读，不下载、不创建 Store、不启动 Tunnel。Native 未就绪时 Pi 仍可加载，管理命令仍可用；Store、Tunnel start 和消息操作直接拒绝。`/ce-tunnel start` 在任何 manager/profile/process 副作用前重新验证 Native 与 Store 准入，拒绝时给出 `CE_NATIVE_*` 码和 `/ce-native` 提示。status 单独报告 `native=<STATE> (code)`，不据此推断 transport 为 `STOPPED`；stop 仍可用于安全清理。

Windows Native 不受支持（`CE_NATIVE_TARGET_UNSUPPORTED`），没有 Windows 二进制，CE 也不会在 Windows 尝试加载 Linux 二进制。建议在 WSL2 内运行 Linux Node.js、Pi 和 CE，按真实平台选择 Linux x64/arm64 资产。建议将活跃 SQLite Store 放在 Linux 文件系统，避免 `/mnt/c` 等 Windows 挂载。本环境未做 WSL2 集成验证；平台测试仅覆盖目标映射与 Windows 拒绝。现有 Store 文件系统规则仍适用。警告原文、命令和修复边界见 [Native 管理](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-management.zh-CN.md)。

<a id="边界与验证"></a>

## 安全与故障排查

Configured、Pi-bound、Connected 和实际消息交换证据是不同状态，传输健康不能证明消息权限。结果未知时应保留未知事实，直到证据能够解析；不要盲目重试、接管 Owner 或删除 Store。

从[运维与故障排查](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/operations.zh-CN.md)开始。报告错误码和脱敏元数据，不提交正文、凭据、capability 或完整原始日志。详细边界见[协议 v2](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/protocol-v2.zh-CN.md)、[Ownership](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/ownership-contract.zh-CN.md)、[Storage](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/storage-contract.zh-CN.md)和[存储安全](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/storage-security.zh-CN.md)。

## 开发、测试与贡献

在仓库根目录，使用合格的 Node 运行时及 pnpm **12.9.1**：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

扩展导入 `dist/`，修改源码后必须重新构建，`/reload` 不会编译 TypeScript。可选 client 和真实 Host 测试有各自前提，不能与默认测试混为一谈。参见[开发与发布运维](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/operations.zh-CN.md)和[双语文档维护](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/documentation.zh-CN.md)。

npm 包包含预构建扩展与运行时文件。详细操作指南通过 GitHub 链接提供，npm tarball 不包含 `docs/`。

## License

[MIT](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/LICENSE)，Copyright (c) 2026 zieglar。依赖保留各自许可证，详见[许可证审计](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/licenses.zh-CN.md)。
