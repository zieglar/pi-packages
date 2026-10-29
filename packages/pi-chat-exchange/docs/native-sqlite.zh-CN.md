# Rust Native SQLite 驱动

[English](native-sqlite.md) | 简体中文

Rust Native 是当前源码唯一的默认持久化驱动。内置 `node:sqlite` 驱动仅供显式选择的非生产兼容用途。两者共享 TypeScript 事务 helper、schema v7、SQL 算法、授权、幂等、ACK 和恢复契约，没有 sidecar 或 IPC。已发布 npm 0.2.0 制品与当前源码各有资格验证历史，安装 npm 0.2.0 不会取得后续源码功能。

## Release 与消费者信任

[Native Release `ce-sqlite-v0.1.0`](https://github.com/zieglar/pi-packages/releases/tag/ce-sqlite-v0.1.0) 已发布且不可变。中间件版本为 `0.1.0`、ABI 为 `1`、内置 SQLite 为 `3.54.1`，精确来源 SHA 为 `a8386aafd657c84825b2905847f34a43d5b91e1e`。正式[发布工作流](https://github.com/zieglar/pi-packages/actions/runs/40813628775)已成功。发布验收时，已单独下载正式 Release 资产，而非使用 CI 副本，并校验 checksum、身份和七个 subject 的 attestation 及 source-digest 绑定。这是历史发布证据，不是本次文档修改中新跑的消费者或运行时测试。

生产 `NATIVE_COMPAT` 现已固定不可变 Release `427441708`，即 `ce-sqlite-v0.1.0`。四个平台的 SHA-256 均已与 `SHA256SUMS` 核对，七个 attestation subject 均已验证绑定到源码 `a8386aafd657c84825b2905847f34a43d5b91e1e`。这些 pins 和当前源码声明尚未随 CE 发布；生产发布需另行授权。没有选择文件时，默认使用 `rust-native` `0.1.0`。显式 `node-sqlite` 兼容选择仅供非生产用途，绝不自动回退。Native 信任、加载或初始化失败时直接拒绝。

交互安装、就绪状态与 Windows/WSL2 建议见 [Native 管理](native-management.zh-CN.md)。CE 不会自动下载、修复或升级 Native。

精确八文件清单：

```text
SHA256SUMS
ce-sqlite-0.1.0-aarch64-apple-darwin.node
ce-sqlite-0.1.0-aarch64-unknown-linux-gnu.node
ce-sqlite-0.1.0-x86_64-apple-darwin.node
ce-sqlite-0.1.0-x86_64-unknown-linux-gnu.node
native-identities.json
native-manifest.json
provenance.jsonl
```

四个二进制、checksum 文件及两个元数据文件构成七个 attested subject；`provenance.jsonl` 不为自身签名。Native 二进制不在 npm tarball 中，中间件 SemVer 与 CE npm 版本独立。

## 平台证据

| 目标 | Native 制品/一致性测试 | Hosted Store 集成 |
|---|---|---|
| macOS arm64 | 发布资格验证通过 | 已验证 |
| Linux x64 GNU | 发布资格验证通过 | 已验证 |
| macOS x64 | 发布资格验证通过 | 尚未建立 |
| Linux arm64 GNU | 发布资格验证通过 | 尚未建立 |

Store allowlist 仍为 macOS arm64 / Linux x64，其他目标的制品验证不会扩大它。Linux Store 证据不认证 npm 0.2.0 安装、所有 Pi/client 组合、云传输或断电耐久。本地 Linux 仿真、hosted 集成和人工消息使用是不同证据路径。

## 驱动选择

Pi Host 与 MCP child 均读取 `~/.config/pi-chat-exchange/sqlite-driver.json`。没有选择文件时使用 `NATIVE_COMPAT.defaultVersion`（`0.1.0`）选择 `rust-native`。显式选择不从 PATH、工作目录或调用者提供的版本推断。Node 绝不作为回退。

```json
{
  "version": 1,
  "driver": "rust-native",
  "nativeVersion": "0.1.0",
  "manifestFile": "/absolute/path/to/verified-native-manifest.json"
}
```

`manifestFile` 可选；未提供时使用包内已固定的 `NATIVE_COMPAT`。操作员提供的 manifest pin 住中间件版本、ABI、目标资产和 SHA-256，属于可执行代码信任权威，必须独立核实来源。与不可信二进制一同下载的 checksum 不能作为唯一信任锚。不要使用 `latest`、自动升级或未经校验的 pin。

## Prepare、Select 与 Status

以下命令适用于当前源码已构建的 checkout，在包目录执行 `pnpm run build` 后使用。这些命令用于操作员自备 manifest 的隔离验证。日常交互安装使用 `/ce-native install` 和随包提供的信任 pins，见 [Native 管理](native-management.zh-CN.md)。

先将 `CE_NATIVE_TEST_HOME` 设为为本次验证准备的私有隔离 HOME 绝对路径，并在其中准备已验证的缓存；所有命令使用同一 HOME。生产 HOME 不受此示例授权。

```sh
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js prepare \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js select --driver rust-native \
  --version 0.1.0 \
  --manifest /absolute/path/to/verified-native-manifest.json
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js status
```

`prepare` 是显式可联网命令，下载固定目标资产，在私有临时文件中校验 SHA-256，再原子安装到版本化缓存。它不运行安装脚本、不在消费者侧编译、不覆盖另一版本，也不暴露可加载的半成品。并发准备不会替换有效缓存。默认下载 URL 为 `https://github.com/zieglar/pi-packages/releases/download/ce-sqlite-v<version>/<asset>`。

`select` 在持久化选择前校验缓存制品。`status` 离线报告驱动、目标、缓存根、模块/SQLite 身份或封闭错误码。显式切换到非生产 Node 兼容路径前，先停止所有 Store 使用者，再显式执行：

```sh
HOME="$CE_NATIVE_TEST_HOME" node dist/bin/ce-native.js select --driver node-sqlite
```

`select` 使用所选 HOME 的运行时缓存。自定义 `--root` 仅用于显式 prepare/status 资格验证，select 拒绝该选项。manifest 路径以绝对路径保存。

```text
~/.config/pi-chat-exchange/native/
  ce-sqlite/<version>/<target>/<asset>
  ce-sqlite/<version>/<target>/artifact.json
```

## 校验与失败边界

运行时加载检查缓存目录链中的 symlink、所有权及 group/other 写权限，然后在 `require()` 前检查文件所有权/模式、SHA-256、中间件 SemVer、ABI 和目标。缺失或不兼容制品均拒绝。校验与 `dlopen` 是独立操作，同一 OS 用户替换路径不在所声明的安全边界内。

Rust 准入检查真实模块、Node-API >= 8、SQLite 身份、编译选项和共享行为探针，使用内置 SQLite 3.54.1，不依赖 `process.versions.sqlite`，并保留 >=3.51.3 安全下限。Node 保留自身版本及已知缺陷规则。共享一致性测试覆盖 statement、事务、authorizer/defensive mode、扩展错误、BLOB、NULL、changes 和关闭状态。Rust 每次操作 prepare/finalize statement，authorizer 不重入 JavaScript。panic 或 native 内存故障仍可终止 Host。

同一进程内，对一个活跃数据库只使用一种 SQLite 实现。Node 和 Native 各含独立 SQLite 库，在 POSIX 上经两库打开/关闭同一数据库可能释放进程持有的锁。切换前必须停止所有使用 Store 的进程。跨驱动测试在两种实现之间先关闭连接。

未知 commit/close 结果不证明 rollback，也不会自动重试。恢复标记不是锁或 fencing token。参见[存储安全](storage-security.zh-CN.md)、[运行时资格](runtime-support.zh-CN.md)和[发布运维](operations.zh-CN.md)，工作流细节见 [Native release CI](native-release-ci.zh-CN.md)。
