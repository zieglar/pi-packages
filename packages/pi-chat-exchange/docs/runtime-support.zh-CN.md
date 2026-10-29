# 运行时支持与证据

[English](runtime-support.md) | 简体中文

已发布的 npm 包 `@zieglar/pi-chat-exchange@0.2.0` 声明 Node `24.21.0 || 24.22.1` 和 Pi `1.3.0`。其分发认证覆盖 Node `24.21.0`、Pi `1.3.0` 和 macOS arm64。Node `24.22.1` 已获准入，但不在该次分发认证中；该路径的云传输为 `NOT_VERIFIED`。包已发布、运行时获准入，均不证明真实云端使用成功。

## 当前源码

当前源码 `package.json` 声明 Node `>=24.20.0 <=24.22.2`。Node 驱动另行检查候选运行时、SQLite >=3.51.3、可读 source identity、编译安全和共享行为探针。内部对 majors 24/25/26 的候选识别不代表全部版本受支持。Node `24.19.0` 和 `25.9.0` 因复现 transaction-close crash 被拒绝；`24.12.0` 和 `25.2.1` 使用受影响的 SQLite `3.50.4`。Node `26.12.1` 仍为隔离预览，不在正式 engines 声明内。

下界 `24.20.0` 和上界 `24.22.2` 是有边界的包支持区间，不是穷尽式运行时硬白名单。此前上界 `24.22.1` 是记录时最新的已测补丁，并非依赖或 SQLite API 上限。除非专门测试另一个合格运行时，CI/开发仍推荐固定 Node `24.21.0`。本次未升级依赖，CI 也保留该基线。

| 运行时 | 证据与决定 |
|---|---|
| Node 24.20.0 / 24.21.0 / 24.22.0 / 24.22.1 | 既有 macOS arm64 Store/Host 资格验证，保留历史结果 |
| Node 24.22.2，SQLite 3.53.4 | 本次 macOS arm64 runtime/Store 检查 317 项通过；与 24.21.0 的双运行时持久化/崩溃矩阵 12 项通过 |
| Node 25.2.1，SQLite 3.50.4 | 真实运行时因 SQLite 安全下限拒绝 |
| Node 25.9.0，SQLite 3.51.3 | 真实运行时因既有 transaction-close crash 证据拒绝 |
| 后续 Node 24 补丁 / 其他 Node 25 构建 | 本次不作支持声明，不能按版本顺序推断兼容 |

Node 25.2.1、24.19.0 和 25.9.0 的已知缺陷路径检查共 15 项通过，均在持久路径准备前拒绝。本次不增加 Node 25 支持：按 2026-10-29 的官方 Node 发布索引，Node 25 最新版本为 25.9.0，默认 Node 驱动明确拒绝它。此后发布的 Node 25 构建不在本说明范围内。Native Node-API 兼容性不能证明默认驱动路径安全。这些本地 macOS arm64 检查不扩大 hosted CI、云端、平台或已发布 npm 的资格范围。

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
