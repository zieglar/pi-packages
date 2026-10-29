# Native 驱动管理

[English](native-management.md) | 简体中文

本指南介绍 `@zieglar/pi-chat-exchange@0.2.1` 包含的 Native 就绪与管理功能，适用 Node `>=22.19.0` 和 Pi `1.3.0`。历史 npm `0.2.0` 保留 Node `24.21.0` 验收、Node `24.21.0/24.22.1` engines、Pi `1.3.0`、macOS arm64 和云端 `NOT_VERIFIED` 边界。安装 0.2.0 不会取得 0.2.1 的功能。

## 可信默认版本

Rust Native 是唯一的默认持久化驱动。没有选择文件时，CE 使用 `rust-native` `0.1.0`。`node:sqlite`（`node-sqlite`）仅供显式选择的非生产兼容用途，不自动回退。Native 就绪检查将该选择报告为 `INCOMPATIBLE`（`CE_NATIVE_DRIVER_INCOMPATIBLE`），不会因此开启生产消息功能。

生产 `NATIVE_COMPAT` 固定 [ce-sqlite-v0.1.0](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0)，即不可变 Release `427441708`，来源源码为 `a8386aafd657c84825b2905847f34a43d5b91e1e`，ABI 为 `1`，内置 SQLite 为 `3.54.1`。四个平台的 SHA-256 已与 `SHA256SUMS` 核对，七个 attestation subject 已验证绑定到该源码。这是已有的发布验收证据，本次文档修改没有重新联网校验。二进制不随 npm tarball 分发。

CE 不会自动下载、修复或升级 Native，也没有隐式回退。发现新 Release 不会授予新版本信任。

## Pi 内的命令

| 命令 | 作用 |
|---|---|
| `/ce-native` 或 `/ce-native status` | 只读检查本地就绪状态 |
| `/ce-native verify` | 只读本地校验，不下载或改变选择 |
| `/ce-native install` | 显式下载可信默认版本，校验后才修改选择 |
| `/ce-native repair confirm` | 显式修复，使用同一可信准备与选择流程 |
| `/ce-native check-updates` | 只读发现 GitHub Release，不安装或改变选择 |

先运行 `/ce-native status`。需要安装时，显式运行 `/ce-native install`，然后重启 Pi，再进行 setup 或消息操作。只有资产校验成功后才修改选择。修复必须使用完整的 `repair confirm`，单独 `repair` 不构成授权。对于哈希损坏的普通缓存文件，只有下载内容通过固定信任 pin 后才原子替换；下载失败时保留旧文件和选择。不安全的路径、所有者或权限仍会被拒绝，需要操作员检查。不要为修复驱动而删除 Store 或所有权文件。

`check-updates` 会联网读取 GitHub Release 元数据。`latest` 仅用于发现，不会因此受信任。发现不同版本时需等待 CE 兼容性更新，命令不会改变驱动选择。`status` 和 `verify` 离线运行。校验可能加载本地模块以检查身份；只读不代表完全不加载原生代码。

选择文件位于 `~/.config/pi-chat-exchange/sqlite-driver.json`，版本化缓存位于 `~/.config/pi-chat-exchange/native/`。高级隔离 CLI 验证见 [Native SQLite](native-sqlite.zh-CN.md)。切换 SQLite 实现前先停止所有 Store 使用者；同一进程内，一个活跃数据库只使用一种实现。

## 就绪状态与扩展加载

扩展加载只读，不下载、不创建 Store、不启动 Tunnel。Native 未就绪时 Pi 仍能加载，管理命令仍可用。会话警告原文如下：

```text
Chat Exchange: Native Driver is not ready. Messaging is disabled. Run /ce-native to inspect or install the trusted driver.
```

警告每个扩展实例最多出现一次，不会按事件、消息或命令重复。`test/tunnel/native-command.test.ts` 覆盖同一实例只警告一次。操作员安装可信驱动并重启 Pi 后，新的实例会静默加载。

Native 未就绪时，Store、Tunnel start 和消息操作直接拒绝。检查结果同时给出状态和具体错误码，诊断时应保留错误码。

| 状态 | 含义或示例错误码 |
|---|---|
| `READY` | 已验证模块可用（`CE_NATIVE_READY`）；Tunnel start 仍需 Store 准入检查 |
| `MISSING` | 可信缓存项缺失（`CE_NATIVE_CACHE_MISSING`） |
| `UNTRUSTED` | 资产或缓存信任校验失败，如 `CE_NATIVE_HASH_MISMATCH` |
| `INCOMPATIBLE` | 驱动选择或 Native 身份不兼容，如 `CE_NATIVE_DRIVER_INCOMPATIBLE` |
| `INITIALIZATION_FAILED` | 模块初始化失败，如 `CE_NATIVE_INITIALIZATION_FAILED` |
| `UNSUPPORTED_PLATFORM` | 平台或架构不受支持（`CE_NATIVE_TARGET_UNSUPPORTED`） |

`/ce-tunnel start` 在任何 manager、profile 或 process 副作用前重新验证 Native 就绪状态与 Store 准入检查，拒绝时给出具体 `CE_NATIVE_*` 码和 `/ce-native` 提示。`/ce-tunnel status` 单独报告 `native=<STATE> (code)`，与 transport 生命周期分开；Native 不可用不能证明 transport 为 `STOPPED`。`/ce-tunnel stop` 仍是安全清理路径，不会因 Native 缺失而被阻止。其他所有权与进程身份保护仍适用。

## Windows 与 WSL2

Windows Native 不受支持（`CE_NATIVE_TARGET_UNSUPPORTED`）。没有 Windows Native 二进制，CE 不会在 Windows 尝试加载 Linux 二进制，`/ce-tunnel start` 会拒绝。

Windows 用户建议在 WSL2 内运行 Linux Node.js、Pi 和 CE。资产按真实平台与架构选择：Linux x64 使用 `x86_64-unknown-linux-gnu`，Linux arm64 使用 `aarch64-unknown-linux-gnu`。建议将活跃 SQLite Store 放在 Linux 文件系统，避免 `/mnt/c` 等 Windows 挂载。这项建议不增加文件系统限制；现有 Store 准入规则仍适用，资产可用也不会扩大 Store allowlist。

本环境未做 WSL2 集成验证。平台测试仅覆盖目标映射与 Windows 拒绝。Node `>=22.19.0` 来自已安装 Pi `1.3.0` Host manifest，不代表每个后续 Node 构建都已取得资格。平台和测试证据见[运行时支持](runtime-support.zh-CN.md)，安全清理与发布边界见[运维](operations.zh-CN.md)。
