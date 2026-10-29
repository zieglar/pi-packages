# 运行时支持与证据

[English](runtime-support.md) | 简体中文

已发布的 `@zieglar/pi-chat-exchange@0.2.1` 要求 Node `>=22.19.0` 和 Pi `1.3.0`，包含 Native 默认驱动、就绪检查和管理功能。在 Node 22.19.0 / macOS arm64 上，从真实 Registry 安装后的隔离 Pi 加载、首次运行和持久化已通过。[发布候选 Hosted CI](https://github.com/zieglar/pi-packages/actions/runs/40925049158)在 Linux x64 Node 22.19.0、24.22.2 上各通过 Native 227/227。云传输仍为 `NOT_VERIFIED`。历史 npm 0.2.0 的 Node24.21.0/Pi1.3.0/macOSarm64 资格范围不变。

## 当前包与历史运行时证据

0.2.1 的 `package.json` 声明 Node `>=22.19.0`，与 Pi 1.3.0 一致。这是 Host 最低要求，不代表全部后续 Node 版本均已验证。

Rust Native 是唯一的默认持久化驱动。没有选择文件时，CE 使用 `NATIVE_COMPAT.defaultVersion`（当前 `0.1.0`）选择 `rust-native`。`node-sqlite` 仅保留为显式选择、延迟加载的非生产兼容驱动。Native 加载或信任校验失败时直接拒绝，绝不回退到 Node。

Native 使用内置 SQLite `3.54.1`，不依赖 `process.versions.sqlite`。准入检查 Node-API >=8、实际模块、ABI、目标、可信缓存、SQLite 身份、编译选项与行为。内置 `node:sqlite` 的版本及已知缺陷限制仅适用于显式兼容选择。驱动各自的硬约束仍然有效，包括 SQLite 安全下限和共享探针。

以下结果均在本地 Darwin arm64 上针对当前 Native 默认候选重新执行。CI-list 表示在本地执行的 CI 测试列表，不是 hosted CI。

| 运行时 | 本地 Native 证据 |
|---|---|
| Node 22.19.0 | 真实 Native status 与 CI-list 209/209；native-default 9/9 |
| Node 24.22.2 | 完整 Rust suite：1030 通过、4 跳过；CI-list 209/209 |
| Node 24.19.0 / 25.9.0 | 先前运行：1009 通过、2 失败、4 跳过；失败均为仅针对 Node 驱动的测试 |
| Node 25.2.1 | 当前运行：1027 通过、3 失败、4 跳过；失败为显式 Node 驱动测试及内置 SQLite 持锁 fixture 的 stderr 预期 |
| Node 26.12.1 | 仅场景探针：真实 Store、零次 `node:sqlite` 调用；未跑完整 suite |

Pi 1.3.0 安装后 Host 首跑已在 Node 22.19.0、24.22.2、25.2.1、25.9.0、26.12.1 全部通过：每个版本均实际解析 Native 二进制，`node:sqlite` 解析次数为 0，安装、Host 加载、首跑及 profile/policy/mutex/store 检查全部通过。这些是隔离离线运行，云传输和 Native 卸载后重装仍未验证。[PX-0017 Hosted CI](https://github.com/zieglar/pi-packages/actions/runs/40907970721) 已使用生产 trust pins，在 Linux x64 的 Node 22.19.0 和 24.22.2 上各通过 Native 227/227。这些结果不证明所有版本兼容、云端资格或生产已启用。

Pi Host 与 MCP child 分别准入。`CE_NODE_PATH` 只选择 child，改变 Host 需要重启 Pi。Store 的文件系统策略、所有权、私有权限、symlink 限制、WAL/FULL、完整性和迁移检查仍然有效。内存探针不证明磁盘锁或崩溃/断电耐久。

## Native 与平台范围

Native `ce-sqlite-v0.1.0` 使用 ABI `1`、内置 SQLite `3.54.1`，不可变发布来源为 `a8386aafd657c84825b2905847f34a43d5b91e1e`。Native 准入检查真实模块、Node-API >=8、SQLite 身份、编译选项和行为。0.2.1 包含不可变 Release `427441708` 的生产 `NATIVE_COMPAT` pins；四个平台的 SHA-256 已与 `SHA256SUMS` 核对，七个 attestation subject 已验证绑定到该源码。

## Native 就绪与 Windows/WSL2

扩展加载只读，不下载、不创建 Store、不启动 Tunnel。Native 缺失时 Pi 和管理命令仍可用，警告及当前 factory 范围见 [Native 管理](native-management.zh-CN.md)；Store、Tunnel start 和消息操作直接拒绝。CE 不会自动下载、修复或升级 Native，也不会回退。`/ce-native` 安装、检查与警告原文见 [Native 管理](native-management.zh-CN.md)。

Windows Native 不受支持（`CE_NATIVE_TARGET_UNSUPPORTED`）：没有 Windows 二进制，CE 不会在 Windows 加载 Linux 二进制，`/ce-tunnel start` 会拒绝。建议在 WSL2 内运行 Linux Node.js、Pi 和 CE，由真实 Linux 平台选择 x64/arm64 资产。建议将活跃 SQLite Store 放在 Linux 文件系统，避免 `/mnt/c` 等 Windows 挂载；现有文件系统准入规则不变。本环境未做 WSL2 集成验证，平台测试仅覆盖目标映射与 Windows 拒绝。

| 平台 | Native 制品/一致性测试 | Hosted Native Store 集成 |
|---|---|---|
| macOS arm64 | 已验证 | 已验证 |
| Linux x64 GNU | 已验证 | 已验证 |
| macOS x64 | 已验证 | 尚未建立 |
| Linux arm64 GNU | 已验证 | 尚未建立 |

Store allowlist 为 macOS arm64 / Linux x64。此矩阵不扩大 npm 0.2.0 的认证范围，也不证明所有 Pi/ChatGPT client、云连接或断电行为。自动化测试、发布验证和人工使用各有范围。

安装与拒绝处理见[快速开始](getting-started.zh-CN.md)、[运维](operations.zh-CN.md)与 [Native SQLite](native-sqlite.zh-CN.md)。运行时事实来自 `package.json`、`src/storage/runtime.ts`、`src/storage/native-compat.ts`、`src/runtime/executables.ts` 及其测试。早期候选矩阵保留实测范围，不代表每份已发布制品都经过完整矩阵测试。
