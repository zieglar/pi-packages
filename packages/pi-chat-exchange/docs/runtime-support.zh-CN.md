# 运行时支持与证据

[English](runtime-support.md) | 简体中文

已发布的 npm 包 `@zieglar/pi-chat-exchange@0.2.0` 声明 Node `24.21.0 || 24.22.1` 和 Pi `1.3.0`。其分发认证覆盖 Node `24.21.0`、Pi `1.3.0` 和 macOS arm64。Node `24.22.1` 已获准入，但不在该次分发认证中；该路径的云传输为 `NOT_VERIFIED`。包已发布、运行时获准入，均不证明真实云端使用成功。

## 当前源码

当前源码 `package.json` 声明 Node `>=24.20.0 <=24.22.1`。Node 驱动另行检查候选运行时、SQLite >=3.51.3、可读 source identity、编译安全和共享行为探针。内部对 majors 24/25/26 的候选识别不代表全部版本受支持。Node `24.19.0` 和 `25.9.0` 因复现 transaction-close crash 被拒绝；`24.12.0` 和 `25.2.1` 使用受影响的 SQLite `3.50.4`。Node `26.12.1` 仍为隔离预览，不在正式 engines 声明内。

Pi Host 与 MCP child 分别过资格门槛。`CE_NODE_PATH` 只选择 child；改变 Host 运行时须用合格 Node 重启 Pi。版本标签或 UI 成功加载不能证明 Store 准入。Store 还要求本地文件系统策略、所有权、私有权限、symlink 限制、WAL/FULL，以及完整性和迁移规则。内存探针不证明磁盘锁或崩溃/断电耐久。

## Native 与平台范围

Native `ce-sqlite-v0.1.0` 使用 ABI `1`、内置 SQLite `3.54.1`，不可变发布来源为 `a8386aafd657c84825b2905847f34a43d5b91e1e`。Native 准入检查真实模块、Node-API >=8、SQLite 身份、编译选项和行为。生产 pin 仍为 `null`，因此默认 prepare/load 拒绝未 pin 二进制。默认选择为 `node-sqlite`，选择 Rust 后不会静默回退。

| 平台 | Native 制品/一致性测试 | Hosted Native Store 集成 |
|---|---|---|
| macOS arm64 | 已验证 | 已验证 |
| Linux x64 GNU | 已验证 | 已验证 |
| macOS x64 | 已验证 | 尚未建立 |
| Linux arm64 GNU | 已验证 | 尚未建立 |

Store allowlist 为 macOS arm64 / Linux x64。此矩阵不扩大 npm 0.2.0 的认证范围，也不证明所有 Pi/ChatGPT client、云连接或断电行为。自动化测试、发布验证和人工使用各有范围。

安装和拒绝处理见[入门](getting-started.zh-CN.md)、[运维](operations.zh-CN.md)和 [Native SQLite](native-sqlite.zh-CN.md)。运行时事实依据 `package.json`、`src/storage/runtime.ts`、`src/storage/native-compat.ts`、`src/runtime/executables.ts` 和运行时/一致性测试。把源码声明用于已发布制品前，先核实实际加载的代码。
