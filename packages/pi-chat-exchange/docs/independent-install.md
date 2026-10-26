# 独立安装 Pi 扩展（官方私有 tarball 路径）

本指南是 **`@zieglar/pi-chat-exchange` 的正式独立分发方式**：消费者拿到一个预先构建的 npm tarball，物理安装后用 Pi 注册。它与两条旧路径互不替代：

| 路径 | 用途 | 区别 |
|---|---|---|
| **本文（tarball）** | 正式安装给日常使用 | 预构建运行时闭包；消费者**不需要**仓库、TypeScript、pnpm、tsconfig 或任何 build |
| 仓库源码 build + `pi install <目录>` | 开发者/Dogfood | 引用开发树目录，见 [README](../README.md) |
| Desktop 插件 ZIP | ChatGPT Desktop stdio MCP | 另一个打包脚本，见 [ChatGPT 安装](chatgpt-installation.md) |

当前为 private/Local Dogfood，0.1.1：tarball 通过私有渠道（如安全拷贝）交付，**没有公开 npm 发布**。安装前核对交付时给出的 `SHA256`，抽查内容（步骤 3）后再安装。

## 0. 消费者前提

| 组件 | 要求 |
|---|---|
| Node | 精确 **24.21.0 或 24.22.1**（用户本地安装即可；mise 不是要求）。Pi host 与 MCP child 分别过 SQLite/运行时资格门槛 |
| npm | 11.x（随批准 Node 分发） |
| Pi | **1.3.0**，`pi` 可执行（全局安装或本地前缀均可） |
| 平台 | macOS arm64（Store allowlist；Linux x64 未在本路径验收） |
| Tunnel client | 可选。未安装时 `/ce-tunnel doctor` 会给出安全拒绝诊断（如 `CE_EXECUTABLE_UNTRUSTED`/缺失），这是预期行为，**不是**安装失败或兼容性证据 |

不需要：仓库 clone、pnpm、TypeScript、任何 consumer 侧 build/lifecycle 脚本（包内没有 install hooks；全程 `--ignore-scripts`）。

## 1. 生产者（作者侧，仅作者执行一次）

在完整 workspace 中构建并打包。作者必须已按 [README](../README.md) 冻结安装依赖。

```sh
# 仓库根目录，批准 Node 24.21.0/24.22.1 + pnpm 12.9.1
node --version
pnpm install --frozen-lockfile
pnpm --dir packages/pi-chat-exchange run package:pi-extension
# 产物：packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.1.1.tgz
# 可选自定义输出目录：node packages/pi-chat-exchange/scripts/package-pi-extension.mjs /path/to/out
```

该命令依次执行：`tsc` 构建 → 载荷校验（本地运行时 import 闭包、`new URL` 运行时资产、必需 native/运维脚本、无消费者 lifecycle hook）→ `npm pack --ignore-scripts` 前再校验原生清单，任何缺项都会 fail closed。**裸 `npm pack` 不是受支持的作者命令**：现在 `files` 白名单已覆盖，裸 pack 会包含 `dist/`，但它跳过上述全部载荷/闭包/清单校验，也无法产出可追溯的制品 SHA。

记录并随私有渠道交付：

```sh
shasum -a 256 packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.1.1.tgz
```

消费者**不要**重新构建或修改 tarball；如果需要新版本，请回到生产者步骤。

## 2. 消费者：物理安装 tarball 与 Pi 本体

把 tarball 放到消费者控制的目录（示例用 `~/ce-install`；路径可含空格与 scoped `node_modules/@scope` 形式，产品均已支持）：

```sh
# 本地 consumer 根：安装私有包及其运行时依赖（全部物理落盘，无 symlink 外链）
npm install --prefix ~/ce-install/consumer --omit=dev --ignore-scripts --save-exact \
  ~/ce-install/zieglar-pi-chat-exchange-0.1.1.tgz

# 独立 Pi 本体（若尚未全局安装；同样禁用 lifecycle scripts）
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
```

（可选）核对安装产物确实包含编译运行时与本地入口：

```sh
tar tzf ~/ce-install/zieglar-pi-chat-exchange-0.1.1.tgz | sort
# 必须看到 package/pi-extension/index.ts、package/dist/bin/mcp-stdio.js、
# package/dist/tunnel/multi-session-policy.js、package/native/tunnel-keychain.swift、
# package/scripts/recover-stale-ownership.mjs、package/scripts/reconcile-session-process-mutex.mjs
```

## 3. 消费者：注册到 Pi 并验证

```sh
# 填入本机批准 Node 的绝对路径（不是任意 PATH 中的 node）
CE_APPROVED_NODE=/absolute/path/to/approved/node
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
"$CE_APPROVED_NODE" --version  # 必须精确为 v24.21.0 或 v24.22.1
"$CE_APPROVED_NODE" "$CE_PI_CLI" install ~/ce-install/consumer/node_modules/@zieglar/pi-chat-exchange
"$CE_APPROVED_NODE" "$CE_PI_CLI" list   # 应列出上述物理安装目录
```

`pi install` 只登记已物理安装的本地包（Pi 不会替你安装依赖）；不要对同一包再叠 `-e` 加载第二份。本地 `npm install --prefix` 的 bin 链接在 `host/node_modules/.bin/pi`，不是 `host/bin/pi`。下文所有 `pi` 命令统一使用 `"$CE_APPROVED_NODE" "$CE_PI_CLI"`（无子命令即启动 TUI），避免 shebang 误用 PATH 中未批准的 Node 或另一个全局 Pi。Host 与 MCP child 均须分别通过运行时资格诊断；本路径实测 Node 24.21.0，24.22.1 是批准版本但不在此次安装实测范围。

首次运行（在工作目录启动 `pi`，交互 TUI 中按顺序执行；每步都有显式确认）：

```text
/ce-tunnel doctor        # 只读资格诊断；client 未装 → 安全拒绝是预期，不算失败
/ce-tunnel setup         # Tunnel ID → Organization(可空) → masked API key → Advanced ·
                         #   Messaging 授权本 Session → Review → Confirm → Save
/ce-tunnel convert       # 转为 multi-session；保留当前 native Session 的原 endpoint
/new                     # 若要登记不同 endpoint，必须先新建 native Session
/ce-tunnel register pi/distribution  # 为新 Session 登记不同的稳定 endpoint；不启动传输
/reload                  # 载入新 policy（首 reload 可能报 mapping 拒绝，随后显式 activate）
/ce-tunnel activate      # 确认框默认 Cancel，必须下移选择 "Activate current session"
/ce-status
/ce-tunnel deactivate    # 正常释放本 Session 绑定；登记与历史保留
```

`convert` 不会清空或重命名原登记：若复用原 Session 和原 endpoint，省略 `/new` 与不同 endpoint 的 `register`，继续 reload/activate 即可；同一 native Session 尝试登记另一个 endpoint 会被拒绝。上列实测流程选择 `/new` 后为新 Session 登记 `pi/distribution`，原登记保留。

Setup 保存的 profile/凭据在 `CE_TUNNEL_PROFILE` 指定目录（默认见 [Tunnel 指南](tunnel-setup.md#配置模型与生成文件)）；凭据以 owner-only 文件（0600，0700 目录）落盘，绝不明文进 profile。Configured ≠ Pi-bound ≠ Connected；启动真实 Tunnel 仍需 `CE_TUNNEL_BACKGROUND_ALLOW=1` 与显式 `/ce-tunnel start`，见 [Tunnel 用户指南](tunnel-setup.md)。

多 Endpoint / 多 Session 的注册、解绑与撤销语义见 [多 Session 使用指南](multi-session-usage.md)。

### 本指南已验证的范围与未验证项

上述首次运行序列已在真实安装 + 独立 Pi 1.3.0 + 真实 PTY 上验证到：安装、Host 加载、首次保存、转换、注册、激活、停用，以及磁盘持久状态（profile/凭据权限、策略登记、互斥释放、合成 Store 模式）。验证环境为**离线合成模式**：`PI_OFFLINE=1`、未安装真实 Tunnel client（doctor 会给出 `CE_EXECUTABLE_UNTRUSTED` 安全拒绝，这是预期诊断，不是兼容性或就绪证据）。**真实云传输（CLOUD_TRANSPORT）未验证**：需要单独安装可信 client、`CE_TUNNEL_BACKGROUND_ALLOW=1` 与显式 `/ce-tunnel start`，不属于本指南的验证范围。

## 4. 信任与安全注意

- tarball 为私有交付；安装前核对 SHA256，必要时 `tar tzf` 抽查（上面的必需文件清单即核对锚点）。
- 全程 `--ignore-scripts`：本包没有也不需要任何 install/prepack/prepare hook。
- 安装后的依赖树全部物理存在于 consumer 前缀内（内部 bin symlink 属正常；不应出现指向外部/开发树的链接）。
- Desktop ZIP 与本路径不通用；不要混装同一 Endpoint。
- 卸载：`pi remove` 取消注册，再删除 consumer 前缀即可；不动任何全局配置。

### 依赖与 Host 提供的运行时包

本包声明 `peerDependencies: { "@earendil-works/pi-coding-agent": "1.3.0" }`：安装时 npm 会把该精确版本装入 consumer 树，满足 `pi-tui-kit` 的 `"*"` peer，避免自动拉入与 Host 不同代的完整 Pi 运行时（例如 1.4.x）。`@earendil-works/pi-tui` 与 `@sinclair/typebox` 保留为**锁定版本的 dependencies**（不是 peer）：编译后的 ESM（TUI 键序、TypeBox 运行时校验）在本地包模式下必须能从安装树物理解析，盲改为 `"*"` peer 会让 npm 拉最新版本、引入与 1.3.0 Host 的代差。代价是 Pi 启动时会提示“Host 提供的包应声明为 peerDependencies”的警告——这是当前分发架构的已知权衡（两份同版本运行时代码副本），不影响加载与首次运行；重新设计 host 映射不属于本指南范围。
