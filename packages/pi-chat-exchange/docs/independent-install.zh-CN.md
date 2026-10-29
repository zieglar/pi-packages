[English](independent-install.md) | [简体中文](independent-install.zh-CN.md)

# 独立 Host 与 tarball 安装（0.2.1）

已有 Pi 安装请从[快速开始](getting-started.zh-CN.md)进入。本页替代路线使用独立 Pi1.3.0 Host，Node **>=22.19.0**、**macOS arm64 / Linux x64 GNU**，文件系统须通过 Store 准入。当前已发布包为 `@zieglar/pi-chat-exchange@0.2.1`，源码构建见[运维](operations.zh-CN.md)。

## 当前 0.2.1：独立 Host

在使用可信受支持 Node/npm 的系统终端执行。若 `~/ce-install/host` 已供其他安装使用，应选择新目录。先替换 Node 占位路径，并将同一 Node 安装放在 PATH 首位供 npm 使用。

```sh
CE_APPROVED_NODE=/absolute/path/to/approved/node
node --version
npm --version
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
CE_PI_CLI="$HOME/ce-install/host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
export npm_config_ignore_scripts=true
"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.1
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
"$CE_APPROVED_NODE" "$CE_PI_CLI"
```

成功条件：Pi 列出精确0.2.1 source。继续[准备 Native 和首次交换](getting-started.zh-CN.md#4-准备-native)，该指南中的 `pi` 均改用此 Host 入口。`/ce-native install` 后须完整重启 Pi。启动前配置父进程的可执行文件路径和 background opt-in，不会自动 Start Tunnel。

## 当前 0.2.1：Registry tarball 替代路线

取得精确已发布归档 `https://registry.npmjs.org/@zieglar/pi-chat-exchange/-/pi-chat-exchange-0.2.1.tgz`。发布时验证的 SHA256 为 `786ba02ebb4e20631bcbfba571a10d1d7ee2b3215118c1259778eedbf36c406f`，安装前核对，不匹配即停止。使用新建且由操作员拥有的 consumer 目录。

```sh
shasum -a 256 ~/ce-install/zieglar-pi-chat-exchange-0.2.1.tgz
npm install --prefix ~/ce-install/consumer --omit=dev --ignore-scripts --save-exact \
  ~/ce-install/zieglar-pi-chat-exchange-0.2.1.tgz
"$CE_APPROVED_NODE" "$CE_PI_CLI" install "$HOME/ce-install/consumer/node_modules/@zieglar/pi-chat-exchange"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
```

成功条件：物理包 manifest 为0.2.1，Pi 列出该精确目录。目录注册不安装依赖，必须先完成 npm 安装。不要把 tarball URL 传给 Pi（URL 属于 Git source）、混用 managed npm 路线或叠加 `-e`。Native 只经显式准备下载，不包含在归档中。

真实 Registry0.2.1 的安装/加载/首次运行/持久化已在隔离 Pi1.3.0/Node22.19.0/macOSarm64 通过。[发布](https://github.com/zieglar/pi-packages/actions/runs/40925828108)与 [Linux x64 Native CI](https://github.com/zieglar/pi-packages/actions/runs/40925049158)各有独立证据，真实 Cloud 交换仍未验证。

卸载时用 `pi list` 记录真实 source，再按[安全卸载流程](#5-安全卸载升级与回滚)操作。其旧0.2.0 命令仅用于当时安装的示例；必须移除实际记录的 source（当前 managed 安装为0.2.1），不能假定版本。

## 历史 0.2.0 安装与资格记录

以下保留0.2.0 命令、运行时限制和验收证据，属于历史示例，不是当前安装基线。其中旧候选实验也只描述当时状态，当前 Native 运行时要求以上文为准。不要在0.2.1 checkout 上执行旧生产者命令并期待产出0.2.0。


开发候选说明：下文历史 0.2.0 操作及认证描述的是未变更的已发布制品。本地构建候选声明 Node `>=24.20.0 <=24.22.2`，还要求 SQLite >=3.51.3、平台/编译安全与共享行为检查，不再要求 SQLite/source 精确相等。Node 24.19.0/25.9.0 因复现 native crash 被拒绝，26.12.1 仅作预览。候选测试使用隔离 Store 和 macOS arm64 上的真实 Pi 1.3.0。不要把候选结论用于 npm 0.2.0。

`@zieglar/pi-chat-exchange@0.2.0` 已发布到 npm，可安装精确版本；也可取得预构建 npm tarball，物理安装后用 Pi 注册。它与两条旧路径互不替代：

| 路径 | 用途 | 区别 |
|---|---|---|
| **本文（tarball）** | 正式安装给日常使用 | 预构建运行时闭包；消费者**不需要**仓库、TypeScript、pnpm、tsconfig 或任何 build |
| 仓库源码 build + `pi install <目录>` | 开发者/Dogfood | 引用开发树目录，见 [README](../README.zh-CN.md) |
| Desktop 插件 ZIP | ChatGPT Desktop stdio MCP | 另一个打包脚本，见 [ChatGPT 安装](chatgpt-installation.zh-CN.md) |

本包版本为 **0.2.0**。CE 自有代码已获所有者 MIT 授权（Copyright (c) 2026 zieglar，见包内 LICENSE）；第三方许可证证据已闭合，manifest 已按所有者条件移除 `private: true`。

原生 managed npm 路径为：先按下面步骤安装独立 Pi 1.3.0、设置批准 Node 与 npm，再执行 `"$CE_APPROVED_NODE" "$CE_PI_CLI" install npm:@zieglar/pi-chat-exchange@0.2.0`。Pi 将依赖物理安装到其作用域内的 npm 根；不要另装 consumer 目录或叠加 `-e`。0.2.0 的此命令证据是在隔离 loopback 测试 registry 上取得的，不是公共 npm 安装验收证据；0.2.0 现已发布，但发布事实不扩大历史安装或云端验证范围。安装前确认精确版本在所信任 registry 可解析。

下文 tarball 是独立的资产回退：从发布方提供的 GitHub release asset 或私有安全交付取得预构建 `.tgz`，先核对 SHA256 再物理安装。不要把 asset URL 直接传给 Pi（URL 是 Git source），也不要将 monorepo Git source 当作本包 npm 安装。源码开发路径仍引用开发树。

## 0. 消费者前提

| 组件 | 要求 |
|---|---|
| Node（已发布 0.2.0） | 精确 **24.21.0 或 24.22.1**（用户本地安装即可；mise 不是要求）。Pi host 与 MCP child 分别过原 SQLite/运行时资格门槛；本地开发候选要求见页首 notice |
| npm | 11.x（随批准 Node 分发） |
| Pi | **1.3.0**，`pi` 可执行（全局安装或本地前缀均可） |
| 平台 | macOS arm64（Store allowlist；Linux x64 未在本路径验收） |
| Tunnel client | 可选。未安装时 `/ce-tunnel doctor` 会给出安全拒绝诊断（如 `CE_EXECUTABLE_UNTRUSTED`/缺失），这是预期行为，**不是**安装失败或兼容性证据 |

不需要：仓库 clone、pnpm、TypeScript、任何 consumer 侧 build/lifecycle 脚本（包内没有 install hooks；全程 `--ignore-scripts`）。

0.2.0 的认证目标仅 **Node 24.21.0 + Pi 1.3.0 + macOS arm64**；24.22.1 是已有运行时批准版本，不属于 0.2.0 的认证范围；Linux 未验证，cloud NOT_VERIFIED。

包管理器也必须使用批准 Node：将其 bin 目录置于 PATH 首位，先核对 `node --version` 为 v24.21.0、`npm --version` 为随该 Node 分发的 11.x；不要借用另一个全局 npm/Node。使用自己控制的 npm userconfig/globalconfig/cache，设置 `npm_config_ignore_scripts=true`，不要继承其他 registry 的 token；安装阶段才允许明确的 registry 下载，运行时不需要 registry 网络。本包无消费者 build 或 lifecycle hooks。

## 1. 生产者（作者侧，仅作者执行一次）

在完整 workspace 中构建并打包。作者必须已按 [README](../README.zh-CN.md) 冻结安装依赖。

```sh
# 仓库根目录，批准 Node 24.21.0/24.22.1 + pnpm 12.9.1
node --version
pnpm install --frozen-lockfile --ignore-scripts
pnpm --dir packages/pi-chat-exchange run package:pi-extension
# 产物：packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.0.tgz
# 可选自定义输出目录：node packages/pi-chat-exchange/scripts/package-pi-extension.mjs /path/to/out
```

该命令依次执行：`tsc` 构建 → 载荷校验（本地运行时 import 闭包、`new URL` 运行时资产、必需 native/运维脚本、无消费者 lifecycle hook）→ `npm pack --ignore-scripts` 前再校验原生清单，任何缺项都会 fail closed。**裸 `npm pack` 不是受支持的作者命令**：现在 `files` 白名单已覆盖，裸 pack 会包含 `dist/`，但它跳过上述全部载荷/闭包/清单校验，也无法产出可追溯的制品 SHA。

记录并随私有渠道交付：

```sh
shasum -a 256 packages/pi-chat-exchange/.pi-artifacts/zieglar-pi-chat-exchange-0.2.0.tgz
```

消费者**不要**重新构建或修改 tarball；如果需要新版本，请回到生产者步骤。

## 2. 消费者：物理安装 tarball 与 Pi 本体

把 tarball 放到消费者控制的目录（示例用 `~/ce-install`；路径可含空格与 scoped `node_modules/@scope` 形式，产品均已支持）：

```sh
# 本地 consumer 根：安装私有包及其运行时依赖（全部物理落盘，无 symlink 外链）
npm install --prefix ~/ce-install/consumer --omit=dev --ignore-scripts --save-exact \
  ~/ce-install/zieglar-pi-chat-exchange-0.2.0.tgz

# 独立 Pi 本体（本指南必需，即使已有全局 Pi；同样禁用 lifecycle scripts）
npm install --prefix ~/ce-install/host --ignore-scripts --save-exact \
  @earendil-works/pi-coding-agent@1.3.0
```

（可选）核对安装产物确实包含编译运行时与本地入口：

```sh
tar tzf ~/ce-install/zieglar-pi-chat-exchange-0.2.0.tgz | sort
# 必须看到 package/LICENSE、package/pi-extension/index.ts、package/dist/bin/mcp-stdio.js、
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

最后的 `/ce-tunnel deactivate` 是验证正常解绑的演示，不是发消息前置步骤。若接下来要做首次消息验证，暂不执行该行、保持已授权 binding；若已停用则重新显式 activate。安装本身不证明云端可用：另行获准后按 [Tunnel 双向消息验证](tunnel-setup.zh-CN.md#4-双向-send--inbox--read--ack)完成 client/ChatGPT 连接、显式 Start 与独立 read/ACK；不得把离线合成流程当作真实云端验收。

`convert` 不会清空或重命名原登记：若复用原 Session 和原 endpoint，省略 `/new` 与不同 endpoint 的 `register`，继续 reload/activate 即可；同一 native Session 尝试登记另一个 endpoint 会被拒绝。上列实测流程选择 `/new` 后为新 Session 登记 `pi/distribution`，原登记保留。

`CE_TUNNEL_PROFILE` 指定 profile 文件的规范化绝对路径（不是目录）；Setup 将凭据保存在该文件所在目录的 `.credentials/` 下（默认见 [Tunnel 指南](tunnel-setup.zh-CN.md#配置模型与生成文件)）；凭据以 owner-only 文件（0600，0700 目录）落盘，绝不明文进 profile。Configured ≠ Pi-bound ≠ Connected；启动真实 Tunnel 仍需 `CE_TUNNEL_BACKGROUND_ALLOW=1` 与显式 `/ce-tunnel start`，见 [Tunnel 用户指南](tunnel-setup.zh-CN.md)。

多 Endpoint / 多 Session 的注册、解绑与撤销语义见 [多 Session 使用指南](multi-session-usage.zh-CN.md)。

### 本指南已验证的范围与未验证项

上述首次运行序列已在真实安装 + 独立 Pi 1.3.0 + 真实 PTY 上验证到：安装、Host 加载、首次保存、转换、注册、激活、停用，以及磁盘持久状态（profile/凭据权限、策略登记、互斥释放、合成 Store 模式）。验证环境为**离线合成模式**：`PI_OFFLINE=1`、未安装真实 Tunnel client（doctor 会给出 `CE_EXECUTABLE_UNTRUSTED` 安全拒绝，这是预期诊断，不是兼容性或就绪证据）。**真实云传输（CLOUD_TRANSPORT）未验证**：需要单独安装可信 client、`CE_TUNNEL_BACKGROUND_ALLOW=1` 与显式 `/ce-tunnel start`，不属于本指南的验证范围。

## 4. 信任与安全注意

- Pi 扩展以你的完整用户权限运行；安装前审查源码与制品来源。`--ignore-scripts` 只限制安装脚本，不会隔离扩展运行时权限。
- tarball 可经可信渠道交付；安装前核对 SHA256，必要时 `tar tzf` 抽查（上面的必需文件清单即核对锚点）。
- 全程 `--ignore-scripts`：本包没有也不需要任何 install/prepack/prepare hook。
- 安装后的依赖树全部物理存在于 consumer 前缀内（内部 bin symlink 属正常；不应出现指向外部/开发树的链接）。
- Desktop ZIP 与本路径不通用；不要混装同一 Endpoint。
- 卸载、升级、回滚必须遵守下方安全步骤；退出 Pi 不等于停止后台 transport。

### 依赖与 Host 提供的运行时包

本包声明 `peerDependencies: { "@earendil-works/pi-coding-agent": "1.3.0" }`：tarball 前缀安装时 npm 会把该精确版本装入 consumer 树（原生 managed npm 使用 `--legacy-peer-deps` 抑制 peer 自动安装；Host 从独立 1.3.0 树提供），满足 `pi-tui-kit` 的 `"*"` peer，避免自动拉入与 Host 不同代的完整 Pi 运行时（例如 1.4.x）。`@earendil-works/pi-tui` 与 `@sinclair/typebox` 保留为**锁定版本的 dependencies**（不是 peer）：编译后的 ESM（TUI 键序、TypeBox 运行时校验）在本地包模式下必须能从安装树物理解析，盲改为 `"*"` peer 会让 npm 拉最新版本、引入与 1.3.0 Host 的代差。代价是 Pi 启动时会提示“Host 提供的包应声明为 peerDependencies”的警告——这是当前分发架构的已知权衡（两份同版本运行时代码副本），不影响加载与首次运行；重新设计 host 映射不属于本指南范围。

## 5. 安全卸载、升级与回滚

以下是人工前置条件，不是新增卸载 CLI，也不是全机 Session 扫描授权。先用 `pi list` 记录精确 source 及 personal/project 作用域、实际包根、批准 Node/Pi/npm、profile、Store/Exchange 与有关 Session/进程。不要依据历史 PID 或文件名发信号。

1. 在可证明拥有目标实例的 Manager 中显式 `/ce-tunnel stop`；再独立 `/ce-tunnel status`，必须确认退出完成且 **STOPPED**。`/ce-tunnel doctor` 仅是资格诊断，不是退出证明。外部 Owner、UNKNOWN、STOP_UNCONFIRMED、未知 lease/lock 一律停止操作，不删目录、不 bulk kill、不重试未知结果。没有启动过 transport 也要核实 STOPPED；不要为卸载启动它。
2. 对每个受影响的、自己拥有的本地绑定，执行 `/ce-tunnel deactivate` 并确认正常 release/detach；用 `/ce-status` 核对。不使用 revoke 或 Recovery 替代正常释放。未确认释放、证据写入失败或 UNKNOWN 都停止。
3. 与其他使用者确认目标包/Node 前缀、profile、Store、后台实例及共享资源不再被依赖；其他独立 Session 或其他安装仍依赖时，必须在原生 remove 前 STOP：不得卸载、取消注册或删除相关目录。现有命令**不能自动证明**全机/其他用户均不再使用；不能确认就 STOP，保留现场，不擅自停止他们的 Session。
4. 正常退出所有相关、自己拥有的 Pi Hosts（包括仍能加载旧代码者），确认退出完成；退出本身不替代前述 transport Stop。保持其他无关 Session 不变。
5. 使用记录的原生 Pi source 和同一作用域移除：

```sh
# 仅适用于原生 managed npm 安装（0.2.0 的安装证据来自私有 loopback registry）
"$CE_APPROVED_NODE" "$CE_PI_CLI" remove "npm:@zieglar/pi-chat-exchange@0.2.0"
"$CE_APPROVED_NODE" "$CE_PI_CLI" list
# 若原来是 --local 安装，remove 同样加 --local，勿扩大到其他作用域。
# tarball/源码目录路线：remove 后面的参数必须改为 pi list 中原始绝对目录 source。
```

Pi 1.3.0 的 `removeAndPersist` 先执行原生 remove 再取消声明；npm source 由 `uninstallNpm` 调用 npm uninstall，**已删除** managed 包文件。不要再对 Pi managed 根执行 rm/npm uninstall；该根可承载其他扩展。local-directory source 仅取消注册，不删除其原目录。remove 部分失败或登记持久化未确认时同样 STOP，保留证据，不盲重试或手工删目录。

6. 只有对独占、自己拥有、已证实无其他依赖的 **tarball consumer 或专用 host 前缀**，才可以另行人工删除该前缀；不要删除共享 Node、Pi managed 根、其他安装或源代码树。任何归属/依赖不明均不删。默认保留 Store（含 WAL/SHM/host-secret）、profile、凭据、bindings、history 及状态/日志证据，勿 purge、删锁、清理 Owner 或重发未 ACK 消息。

升级：先记录并保留原精确版本制品、SHA256、安装 source、锁文件与配置位置，按上述停止/释放/退出流程，再用原生 Pi remove 旧精确 source、install 新精确版本；tarball 路线物理安装到新的独占 consumer 前缀再注册，避免覆盖仍使用的目录。重新启动 Host 后 doctor/status，核对选中配置和 Store，再显式 activate，不自动 Start。

回滚/重装：先确认目标版本的 Store/schema/运行时兼容性；未知即 STOP，不降级、覆盖或删除 Store。兼容且获准后按同一停止/释放/退出流程移除当前版本、重装留存的精确旧制品/版本、核对真实加载路径与配置。重装 0.2.0 使用相同精确 npm source；保留配置不等于自动重新授权，仍须显式 activate。缺 ACK、超时或 DELIVERY_UNKNOWN 不是重试许可。
