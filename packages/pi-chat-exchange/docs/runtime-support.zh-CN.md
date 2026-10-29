# 运行时支持与证据

[English](runtime-support.md) | 简体中文

已发布的 npm 包 `@zieglar/pi-chat-exchange@0.2.0` 未改变。历史分发认证覆盖 Node `24.21.0`、Pi `1.3.0` 和 macOS arm64，云传输为 `NOT_VERIFIED`。下文当前源码的 Native 行为和 Host 最低要求不扩大该已发布制品的认证范围。

## 当前源码

当前源码 `package.json` 声明 Node `>=22.19.0`，与实际安装的 Pi 1.3.0 Host manifest 一致。这是 Host 最低要求，不代表全部 Node 22 及以后版本、Node 25 或 Node 26 均已验证。

Native 是目标默认驱动。没有选择文件时，CE 使用 `NATIVE_COMPAT.defaultVersion`（当前 `0.1.0`）选择 `rust-native`。`node-sqlite` 仅保留为显式选择、延迟加载的非生产兼容驱动。Native 加载或信任校验失败时直接拒绝，绝不回退到 Node。

Native 使用内置 SQLite `3.54.1`，不依赖 `process.versions.sqlite`。准入检查 Node-API >=8、实际模块、ABI、目标、可信缓存、SQLite 身份、编译选项与行为。内置 `node:sqlite` 的版本及已知缺陷限制仅适用于显式兼容选择。驱动各自的硬约束仍然有效，包括 SQLite 安全下限和共享探针。

以下结果均在本地 Darwin arm64 上针对当前 Native 默认候选重新执行。CI-list 表示在本地执行的 CI 测试列表，不是 hosted CI。

| 运行时 | 本地 Native 证据 |
|---|---|
| Node 22.19.0 | 真实 Native status 与 CI-list 209/209；native-default 9/9 |
| Node 24.22.2 | 完整 Rust suite：1030 通过、4 跳过；CI-list 209/209 |
| Node 24.19.0 / 25.9.0 | 先前运行：1009 通过、2 失败、4 跳过；失败均为仅针对 Node 驱动的测试 |
| Node 25.2.1 | 当前运行：1027 通过、3 失败、4 跳过；失败为显式 Node 驱动测试及内置 SQLite 持锁 fixture 的 stderr 预期 |
| Node 26.12.1 | 仅场景探针：真实 Store、零次 `node:sqlite` 调用；未跑完整 suite |

Pi 1.3.0 安装后 Host 首跑已在 Node 22.19.0、24.22.2、25.2.1、25.9.0、26.12.1 全部通过：每个版本均实际解析 Native 二进制，`node:sqlite` 解析次数为 0，安装、Host 加载、首跑及 profile/policy/mutex/store 检查全部通过。这些是隔离离线运行，云传输和 Native 卸载后重装仍未验证。新增 Linux x64 Native CI job 指定 Node 22.19.0 / 24.22.2，但 hosted 执行仍为 UNVERIFIED。本地结果不证明所有版本兼容、云端资格或生产已启用。

Pi Host 与 MCP child 分别准入。`CE_NODE_PATH` 只选择 child，改变 Host 需要重启 Pi。Store 的文件系统策略、所有权、私有权限、symlink 限制、WAL/FULL、完整性和迁移检查仍然有效。内存探针不证明磁盘锁或崩溃/断电耐久。

## Native 与平台范围

Native `ce-sqlite-v0.1.0` 使用 ABI `1`、内置 SQLite `3.54.1`，不可变发布来源为 `a8386aafd657c84825b2905847f34a43d5b91e1e`。Native 准入检查真实模块、Node-API >=8、SQLite 身份、编译选项和行为。生产 pin 仍为 `null`，因此默认 prepare/load 拒绝未 pin 二进制。Native 默认切换与生产 pins 必须在另行授权 pin 后作为同一发布单元交付。pins 仍为 null，默认构建不可发布，生产尚未启用。

| 平台 | Native 制品/一致性测试 | Hosted Native Store 集成 |
|---|---|---|
| macOS arm64 | 已验证 | 已验证 |
| Linux x64 GNU | 已验证 | 已验证 |
| macOS x64 | 已验证 | 尚未建立 |
| Linux arm64 GNU | 已验证 | 尚未建立 |

Store allowlist 为 macOS arm64 / Linux x64。此矩阵不扩大 npm 0.2.0 的认证范围，也不证明所有 Pi/ChatGPT client、云连接或断电行为。自动化测试、发布验证和人工使用各有范围。

安装和拒绝处理见[入门](getting-started.zh-CN.md)、[运维](operations.zh-CN.md)和 [Native SQLite](native-sqlite.zh-CN.md)。运行时事实依据 `package.json`、`src/storage/runtime.ts`、`src/storage/native-compat.ts`、`src/runtime/executables.ts` 和运行时/一致性测试。把源码声明用于已发布制品前，先核实实际加载的代码。
