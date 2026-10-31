# Pi Chat Exchange

[English](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/README.md) | 简体中文

Pi Chat Exchange（CE）让 ChatGPT 和 Pi 通过显式工具交换持久化消息。你可以在两个应用之间传递问题、计划或结果，并决定各端能读取哪些消息。发送消息不授予执行任务的权限，也不证明任务完成。

<a id="当前能力与典型用法"></a>

## 功能

- SQLite 保存消息、作用域内的幂等键和审计证据。
- 经授权发现收件箱，分别访问元数据与正文，可选接收回执（ACK）。
- 显式绑定 Pi Session，支持多 Session 注册。
- 管理 Secure MCP Tunnel，另有独立的 ChatGPT Desktop stdio 连接。
- Rust Native SQLite 使用固定信任版本，提供显式安装和就绪检查命令。

<a id="系统要求与支持平台"></a>

## 环境要求与支持范围

使用 **Pi 1.3.0**、**Node >=22.19.0**，以及 Store 支持的平台：**macOS arm64 或 Linux x64 GNU**。仍须通过文件系统、所有权和运行时准入检查。其他 Native 制品不代表 Store 支持相应平台；Windows Native 不受支持，WSL2 集成尚未验证。

**0.2.1** 已发布到 npm。在 macOS arm64 上，从真实 Registry 安装的隔离 Pi 1.3.0 / Node 22.19.0 加载与持久化检查已通过。Linux x64 Native 检查在 Node 22.19.0、24.22.2 上各通过 227/227。**真实 Cloud transport 和完整 ChatGPT ↔ Pi 消息交换仍未验证。** 已测矩阵和限制见[运行时支持](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/runtime-support.zh-CN.md)，engine 范围不代表穷尽验证。

本工作区准备 **0.2.2 本地候选**：显式 `CE_TUNNEL_CLIENT_PATH` 委托信任用户管理的 client 安装，允许 Homebrew 祖先目录 group-write；自动发现仍严格。安装路径写入者可能替换程序，程序可取得当前用户权限及 Tunnel 凭据。候选 tarball 用 npm 安装到专用 prefix，再将已安装包目录登记到 Pi，具体见快速开始；这不是 Registry 安装。下方 npm 命令仍选择正式版 0.2.1 及其旧准入规则。

候选证据见[兼容矩阵](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/compatibility/README.md)。0.0.19 有与源码匹配的 macOS arm64 legacy identity 手工双向 Cloud E2E；Linux x64 CI 覆盖合成本地生命周期。历史 0.0.16 证据受运行时范围限制；0.0.18 和真实 namespaced Cloud 仍为 NOT_VERIFIED。独立 latest 监测和实际同次运行发布集成仍为 NOT_VERIFIED。受管 profile 显式设置 `MCP_STDIO_FAILURE_POLICY=exit`：0.0.19 的 child 失败会使 client 退出，不自动拉起或恢复；重新启动前应检查 ownership 并显式恢复。

<a id="安装-pi-扩展"></a>
<a id="选择连接方式"></a>

## 快速开始

已安装 Pi 后，在**系统终端**执行：

```sh
pi install npm:@zieglar/pi-chat-exchange@0.2.1
pi list
pi
```

在 **Pi TUI** 执行 `/ce-native status`。若缺少可信驱动，执行 `/ce-native install`，然后退出并重启 Pi。消息操作前，用 `/ce-native verify` 确认 `READY`。npm 不包含 Native 二进制；CE 不会自动下载，也不回退到 `node:sqlite`。

继续阅读 **[快速开始：从安装到首次交换](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/getting-started.zh-CN.md)**，完成独立可信 Tunnel client、父进程环境、Setup 显式消息授权、`/reload` → 激活 → Start、精确 recipient label、正文读取及安全 Stop。只保存传输设置不能取得消息权限，激活也不启动传输。[Desktop stdio 指南](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/chatgpt-installation.zh-CN.md)介绍独立的本地连接。

升级现有安装前，停止自己拥有的 Tunnel 并核实 `STOPPED`，释放受影响的本地 binding，再退出相关 Pi Host。保留 Store 和凭据，不要删除 Owner 或锁文件强行升级。

<a id="多项目多-session"></a>
<a id="边界与验证"></a>

## 限制与安全操作

CE 不自动调度任务或排空收件箱，共享 ChatGPT Endpoint 不隔离对话。正文读取和 ACK 各自需要授权；正文是不可信数据，可能进入模型历史。

ACK 只记录接收回执，不证明送达、已读、处理或任务完成。CE 不承诺 exactly-once delivery/execution。`DELIVERY_UNKNOWN != CANCELLED`；缺 ACK 或超时不授权盲重试或换 key 重发。保留原 Message ID/key，先查证据。

关闭 Manager 或退出 Pi 不会停止 detached Tunnel client。执行 `/ce-tunnel stop`，再用 `/ce-tunnel status` 核实 `STOPPED`。不要把凭据和 capability 放入消息、截图或报告。

<a id="阅读导航"></a>

## 文档

- [Native 管理](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-management.zh-CN.md)与 [Native SQLite](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/native-sqlite.zh-CN.md)。
- [Tunnel 设置与排障](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/tunnel-setup.zh-CN.md)。
- [多 Session](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/multi-session-usage.zh-CN.md)、[Pi 工具](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/pi-extension/README.zh-CN.md)、[ACK 契约](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/delivery-ack-contract.zh-CN.md)。
- [运维与源码开发](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/operations.zh-CN.md)。预构建 npm 安装无需仓库或编译器。
- [独立 Host / tarball 安装](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/independent-install.zh-CN.md)，提供当前0.2.1 替代路线，单独保留历史0.2.0 记录。
- [架构](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/architecture.zh-CN.md)、[存储安全](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/storage-security.zh-CN.md)、[双语文档索引](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/documentation.zh-CN.md)。

## License

[MIT](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/LICENSE)，Copyright (c) 2026 zieglar。依赖保留各自许可证，详见[许可证审计](https://github.com/zieglar/pi-packages/blob/main/packages/pi-chat-exchange/docs/licenses.zh-CN.md)。
