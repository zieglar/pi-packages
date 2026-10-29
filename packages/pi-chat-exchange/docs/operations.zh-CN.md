[English](operations.md) | [简体中文](operations.zh-CN.md)

# 运维与开发

安装见[快速开始](getting-started.zh-CN.md)，权威与生命周期细节见[架构指南](architecture.zh-CN.md)。真实传输、凭据、消息与恢复操作各自需要授权，文档编辑或隔离测试不提供这些授权。

## 安全与私有状态

扩展以你的用户权限执行。Masked 输入保护屏幕呈现，不隔离同进程恶意扩展、录屏、剪贴板访问或内存观测。不要公开凭据、capability、消息正文、完整 Session/环境、health URL 或原始日志。只分享固定拒绝码与最少非秘密上下文。公开报告中的私有文件路径、运行时标识应改为通用占位值，配置键和协议字段仍须保留原文。

Profile 默认 `~/.config/pi-chat-exchange/tunnel/tunnel.yaml`，生成内容使用规范化绝对路径。`.credentials/` 下的凭据 generation 是私有明文，目录 0700 / 文件 0600。Keep existing credential 不读内容；旧 generation 保留，没有自动 credential/generation GC。`.ce-bindings/` 保存 binding/sidecar 与 Store 状态，包括 WAL/SHM、host-secret。不要合并/复制 Store、重置 ownership，或手改生成 generation、history mapping、释放标记。

可执行文件准入检查原路径、symlink 目标及全部祖先的 ownership/权限，拒绝项目/`node_modules` 路径、可写文件/祖先与不可信链接。macOS ACL 检查未知时拒绝，只接受无 ACL 或 deny-only ACL。Homebrew 已安装不代表受信任；应选择可信独立安装并设置绝对 override，不放宽权限或执行已拒绝 binary。详见 [Tunnel 诊断](tunnel-setup.zh-CN.md)。

Storage 强制检查 identity、migration checksum、integrity、lease/fencing 与 payload 权限。文件权限不能消除所有文件系统 race、mount substitution 或 crash/power-loss 风险；内存运行时探针不证明磁盘耐久。详见 [Storage 安全](storage-security.zh-CN.md)、[Storage 契约](storage-contract.zh-CN.md)与 [Ownership 契约](ownership-contract.zh-CN.md)。

## 按层排障

| 症状 | 检查与处理 |
|---|---|
| 安装失败 / 缺少运行时文件 | 核对批准 Node/npm、制品 SHA256 与包载荷。源码用户在仓库 build，消费者使用完整预构建制品，不现场 build。不关闭运行时门槛、不删 Store。 |
| 没有 `/ce-tunnel` / `/ce-status` | 对照 `pi list`、原 source 与 `-e`，查看加载拒绝码，只加载一份。源码变更先 build 再 `/reload`。 |
| Host / child 资格拒绝 | `/ce-tunnel doctor` 分开报告。Host 用批准 Node 重启；canonical 保存配置中的 child 命令只在 verified STOPPED 后显式 migrate。`CE_NODE_PATH` 不修复运行中的 host。 |
| Client 缺失/不可信 | Doctor 不 spawn，只查 metadata。核对来源与全链权限，不绕过已拒绝 Homebrew 祖先、不执行不可信 binary。 |
| `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` | 父 Pi 环境设置精确 `CE_TUNNEL_BACKGROUND_ALLOW=1`，子 shell export 无效。 |
| Legacy profile 登记报 `CE_TUNNEL_PROFILE_INVALID` | 显式 `/ce-tunnel convert`，确认旧 runtime 已停止/更新后创建多 Session generation。不会自动转换；该拒绝也不表明 transport 状态有问题。 |
| CONNECTED 但不能通信 / `recipients: []` | 核对 Advanced Messaging、当前 Pi binding、当前 ChatGPT 工具、精确 Store/Exchange 与 recipients。不重发原消息测通。 |
| 发送失败 / 响应丢失 | 保留原 key/Message ID，检查 `/ce-status`、`/ce-tunnel status`、Endpoint 与固定拒绝码。缺 ACK、BUSY、超时或未知结果均不授权重试/换 key。 |
| `CE_HOST_MAPPING_INVALID` / 无 endpoint | 核对真实 native Session、所选登记、已加载 policy 与精确 release 证据。新/正常释放的 binding 需显式 activate；UNKNOWN 不等于普通未绑定。 |
| 无 read/ACK | 分别检查独立 opt-in 并显式加载策略。ACK 不开启 payload read。 |
| Inbox 为空 | 核对 Store directory/file、Exchange namespace/key 与 join boundary。有界空页不证明整个 Store 为空，不复制数据库、不盲重发。 |
| STARTING / READY_TIMEOUT | 等待在途终态与清理证据，核对目标/权限。UNKNOWN 不许可第二实例或无限 timeout。 |
| MANAGER_BUSY / 重复命令 | 检查 `pi list`/`-e` 重复加载并关闭多余 UI，不重复 Start。 |
| Client 拒绝旧 `admin_ui` | Verified STOPPED 后 `/ce-tunnel migrate`，只修 canonical schema/child Node，不读 key、不换 Store、不授予消息权限。 |
| 外部实例 / 锁 / STOP_UNCONFIRMED | 保留状态/ledger。Manager Stop 只处理可证明 owned 的实例；其他操作需独立 operator 授权。不删锁、不按名称 kill。 |
| 异常退出遗留 session-process mutex slot | 按 [Tunnel 排障](tunnel-setup.zh-CN.md)执行 operator-only 离线协调，独立核实全部预期身份与 owner 死亡事实。不删锁、不在真实 Store 上试 acquire。 |

Renew/end 未知或 mapping 持久化失败会阻断后续操作，不能连续 activate/reload 绕过。每个 record-backed run 最多一次 SIGTERM，重复 Stop 不保证重发信号。UNKNOWN 不等于 STOPPED、release 或 cancellation。

## 恢复与生命周期

正常 `/ce-tunnel deactivate` 经确认后只释放当前本地 CE binding，保留登记、历史与传输。Revoke 改变后续 registration admission，不删除 Owner/Participant/message/Receipt。Reload 替换内存 generation，保留有效 durable Ownership。新/fork Session 不继承权威；显式 activation 使用 `requireUnowned`，不接管过期或 crashed Owner。

进程协调、CE Ownership recovery 与未知送达调查是三个流程。`recover:ownership`、`reconcile:session-mutex` 是 operator 脚本，不是模型工具或日常设置步骤。详见[显式 stale-ownership 恢复](chatgpt-installation.zh-CN.md#显式-stale-ownership-恢复)与 [Tunnel 排障](tunnel-setup.zh-CN.md)中的精确 CLI 契约。不猜缺失参数、不从失败命令删除未知 flag 后重试，不把 receipt 当成恢复业务 effect 的权威。

Mutex 协调要求完整离线维护窗口：检查、协调、持久化、复查全程停止并阻止相关 Pi/CE、heartbeat、后台 launcher、自动重启与 recovery job 再启动，并独立证明 owner 已死亡。脚本要求精确预期 Store/Endpoint/runtime/slot/owner/process/file 身份，以及 `--offline-window-confirmed`、`--owner-death-evidence`。无默认值或 `--audit-log`，未知参数拒绝，不写 audit 文件。使用前核对链接中的完整命令与脚本。

发布先用 O_EXCL 创建 `release-pending.json`，mode 0600，字节与 owner record 完全一致；fsync 文件/目录并复查全部身份后，原子 rename 为 `released.json`，这是唯一提交点。此前失败保留 pending 并拒绝。Rename 抛错时，只有 `released.json` 的字节/身份精确匹配才能确认已提交，否则停止；成功 rename 后不再执行可失败操作。失败需人工检查，不重试/覆盖/删除。这只协调本地 mutex receipt，不证明 CE end/detach，不授权 takeover 或 Operator Recovery。标记不是锁、fencing token 或 exactly-once 保证。

`DELIVERY_UNKNOWN` 保持未知，不改为 `CANCELLED`。缺 ACK 不授权重试。已知送达但执行未知不证明 acceptance、settlement 或 Result。外部工作流或操作员负责任务/策略/恢复/完成裁决；CE 负责消息交付/生命周期/证据/协调；Pi 负责 Session/runtime/provider transport。切换模型不授权重放 effect。

## 卸载、升级与回滚

遵循完整[安全移除流程](independent-install.zh-CN.md#5-安全卸载升级与回滚)。从 `pi list` 记录精确 source 与 personal/project scope、包根、版本、profile、Store/Exchange 和相关 owned 进程。不依据历史 PID 或文件名发信号。

1. 在可证明拥有实例的 Manager 中显式 Stop，独立核实退出完成且 STOPPED。Doctor 不证明退出。UNKNOWN、外部 ownership 或锁/lease 未确认时停止流程。
2. 正常 deactivate 每个受影响 owned 本地 binding，用 `/ce-status` 核对 release/detach。不用 revoke 或 recovery 代替；释放未知或证据持久化失败时停止。
3. 确认其他用户/Session/安装不依赖共享资源。现有命令不能证明全机无人使用；不确定就停止移除，不擅自停其他人的 Session。
4. 正常退出全部相关 owned Pi host，包括仍可加载旧代码者。Host 退出不替代 transport Stop。
5. 按原 scope 移除原精确 source，再检查 `list`：

```sh
"$CE_APPROVED_NODE" "$CE_PI_CLI" remove "npm:@zieglar/pi-chat-exchange@0.2.0"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
```

原安装用了 `--local`，移除也用它。目录安装须将 npm source 改为原绝对目录 source。Pi 原生 npm remove 先删除 managed 包文件，再持久化取消登记；不要对共享 managed 根额外 rm/npm uninstall。本地目录 remove 只取消登记，不删原目录。移除/持久化部分失败时调查，不盲重试。

后续人工删除仅限独立 owned、独占且已证实无依赖的 tarball consumer/专用 host 前缀。默认保留 Store/WAL/SHM/host-secret、profile、凭据、binding、history 与诊断证据。不 purge、不清 Owner、不删锁、不重发未 ACK 消息。

升级前保留旧精确制品、SHA256、source、lockfile 与配置位置。先 Stop/release/exit，移除旧精确 source，再安装新精确版本；tarball 使用新独占前缀。Host 重启后 doctor/status，核对配置/Store，再显式 activate，不自动 Start。回滚还需确认 Store/schema/runtime 兼容；未知时不降级/覆盖/删除。重装保留配置不自动重新授权 binding。

## 开发与贡献

使用批准 Node、pnpm 12.9.1 与冻结 workspace lockfile。从仓库根目录执行：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run verify
```

`verify` 串行运行 contract/native check、typecheck、build、默认 tests 与 packaged-plugin tests。Installed-client、real-host、distribution、native-specific lane 分开执行，证据与前置条件见[架构验证层次](architecture.zh-CN.md#验证层次)。跳过/可选 lane 不算通过，隔离测试不算 dogfooding。本次文档变更不重新执行这些门禁。

默认测试 lane 在每次调用的私有 HOME 中显式选择 `node-sqlite`。Rust lane 使用操作员已验证的 HOME、manifest 和缓存。隔离离线 Pi Host 首跑已在 Node 22.19.0、24.22.2、25.2.1、25.9.0、26.12.1 全部通过；新增 Linux x64 Node 22.19.0 / 24.22.2 Native job 的 hosted 执行为 UNVERIFIED。本地矩阵见[运行时支持](runtime-support.zh-CN.md)。

贡献须保留向内依赖、封闭 schema、独立 payload/ACK grants、可信 Session lookup 与最终 Storage authority。复用 Host/Storage seam，不另建消息系统。保留 intent 先于 effect、显式未知结果和正常释放路径。新 runtime/client/platform 支持需要独立真实资格验证。测试应检查可观察行为、隐私/拒绝、失败证据与生命周期边界，不用真实消息、私有路径或 Session 标识作公开 fixture/证据。回归入口与已知债务见[架构指南](architecture.zh-CN.md)。

生产者从仓库根目录打包：

```sh
pnpm --dir packages/pi-chat-exchange run package:pi-extension
shasum -a 256 packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.0.tgz
```

该命令构建并检查运行时 import closure/assets、必需 native/运维文件、无 consumer lifecycle hook，再执行 `npm pack --ignore-scripts`。裸 `npm pack` 跳过这些检查，不是受支持的生产者命令。Desktop 使用独立 `package:desktop-plugin`，ZIP 不等于 Pi npm 包。

## Native 就绪运维（当前源码）

用 `/ce-native status` 和 `/ce-native verify` 只读检查本地状态。`/ce-native install` 显式下载可信默认版本，校验后才修改选择，完成后需重启 Pi。修复需执行 `/ce-native repair confirm`。`/ce-native check-updates` 只读取 GitHub Release 元数据，`latest` 不会因此受信任或改变选择。CE 不会自动下载、修复或升级 Native，也不会回退。

扩展加载只读，不下载、不创建 Store、不启动 Tunnel。Native 缺失时 Pi 和管理命令仍可用，警告原文见 [Native 管理](native-management.zh-CN.md)；Store、Tunnel start 和消息操作直接拒绝。`/ce-tunnel start` 在任何 manager/profile/process 副作用前重新验证就绪状态与 Store 准入，拒绝时给出具体 `CE_NATIVE_*` 码和 `/ce-native` 提示。status 单独报告 `native=<STATE> (code)`，不据此推断 transport 为 `STOPPED`；stop 仍可用于安全清理。

Windows Native 与 Tunnel start 以 `CE_NATIVE_TARGET_UNSUPPORTED` 拒绝，不尝试加载 Linux 二进制。建议在 WSL2 内运行 Linux Node.js、Pi 和 CE，选择真实 Linux x64/arm64 资产。建议将活跃 Store 放在 Linux 文件系统，避免 `/mnt/c` 等 Windows 挂载；现有文件系统准入规则不变。本环境未做 WSL2 集成验证，平台测试仅覆盖目标映射与 Windows 拒绝。

## 发布证据与限制

npm 0.2.0 已发布、历史 Node 24.21.0 / Pi 1.3.0 / macOS arm64 验收、云端分发 **NOT_VERIFIED** 是不同事实。当前源码 engines `>=22.19.0` 描述本地候选，不扩大已发布制品验收范围。npm 发布 workflow 仍在本地且未推送，没有 hosted OIDC 证明。所有者报告 publisher connection 已配置，不等于 hosted 发布证据。

Native middleware 有独立不可变发布 `ce-sqlite-v0.1.0`、ABI 1、SQLite 3.54.1，源码 `a8386aafd657c84825b2905847f34a43d5b91e1e`，历史下载/attestation 已验证。Hosted Native Store integration 覆盖 macOS arm64 / Linux x64；macOS x64 / Linux arm64 只有 artifact/conformance。生产 `NATIVE_COMPAT` 现已固定不可变 Release `427441708`，四个平台的 SHA-256 已与 `SHA256SUMS` 核对，七个 attestation subject 已验证绑定到该源码。Rust Native 是唯一的默认持久化驱动，没有选择文件时使用 `rust-native` `0.1.0`；显式 `node-sqlite` 仅供非生产兼容用途。失败不触发回退。这些源码变更与 pins 尚未发布，生产发布需另行授权。这些事实不证明广泛云端/e2e 支持，也不自动开启 native。详见[原生 SQLite](native-sqlite.zh-CN.md)与[原生发布 CI](native-release-ci.zh-CN.md)。

历史 plans/audits 保留有日期的设计/测试陈述。本地 commit 不等于 release，workflow 意图不等于 hosted 执行，publisher 已配置不等于 OIDC 证明。Release/push/publication 需单独授权。

运维证据：`pi-extension/index.ts`、`src/runtime/diagnostics.ts`, `src/tunnel/{profile,background-manager,setup,messaging-config}.ts`、`src/storage/{runtime,sqlite-driver-selection,native-compat}.ts`、`scripts/reconcile-session-process-mutex.mjs`、`scripts/recover-stale-ownership.mjs`、`scripts/package-pi-extension.mjs`、`package.json`。真实执行恢复前必须核对脚本，本指南不授予恢复执行权。
