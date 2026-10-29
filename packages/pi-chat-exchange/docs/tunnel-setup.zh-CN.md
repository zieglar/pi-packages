[English](tunnel-setup.md) | [简体中文](tunnel-setup.zh-CN.md)

# ChatGPT ↔ Pi：Tunnel 用户指南、配置与排障

这是 Secure MCP Tunnel 路径；不需要 Desktop stdio 插件。只用 Desktop 本地插件请走 [Desktop stdio 指南](chatgpt-installation.zh-CN.md)。正式安装给日常使用请用已发布精确 npm 版本或预构建 tarball 的[独立安装指南](independent-install.zh-CN.md)，无需本页的仓库构建。示例均为占位值，不是已生效配置。

## 1. 前提与安装

| 组件 | 要求 |
|---|---|
| Pi | 1.3.0；设置与确认操作使用交互 TUI |
| Pi host / MCP child Node | 开发候选声明 **>=24.20.0 <=24.22.2**，分别满足 SQLite >=3.51.3、平台/编译安全与共享行为探针；不固定 SQLite/source ID。24.19.0、25.9.0 有已复现的 native crash，明确拒绝；已发布 npm 0.2.0 不变 |
| 仓库构建工具 | pnpm 12.9.1；UI 依赖由包安装，不需另装 UI |
| Tunnel client | 当前兼容基线 `tunnel-client` 0.0.16；可信绝对路径或受控系统目录发现 |
| Store 平台 | allowlist 为 macOS arm64 / Linux x64；本轮实际回归为 macOS arm64，Node 26.12.1 仅作隔离预览，不表示未来版本、Linux 或所有客户端已验收 |

### 安装和加载扩展

从仓库根目录，在已选中批准 Node 的 shell 执行。mise 可以使用，但不是要求；也不要修改全局 Node 来修一个 Session。

```sh
node --version
pnpm install --frozen-lockfile
pnpm --dir packages/pi-chat-exchange run build
pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

长期跨项目使用可在 build 后执行 `pi install /absolute/path/to/packages/pi-chat-exchange`，以后从各项目正常运行 Pi。该本地包引用原目录；不要移动目录或重复用 `-e` 加载。`pi list` 可核对包声明。扩展入口导入包内 `dist/`，不会现场编译源码；更新源码后先 build，再在需要更新的 Session 中 `/reload`，否则仍可能运行陈旧 `dist/`。

如果 shell 中的 Pi 不由批准 Node 启动，使用本机可信绝对路径执行已安装 Pi 的实际 JavaScript 入口；所有路径须先替换为本机值：

```sh
CE_NODE_PATH="/trusted/node-install/bin/node" \
CE_TUNNEL_CLIENT_PATH="/trusted/client-install/tunnel-client" \
CE_TUNNEL_BACKGROUND_ALLOW=1 \
"/trusted/node-install/bin/node" "/absolute/installed-pi/dist/cli.js" \
  -e "/absolute/path/to/packages/pi-chat-exchange/pi-extension/index.ts"
```

`CE_NODE_PATH` **只选择 MCP child**，不会修复已经运行的 Pi host。`CE_TUNNEL_BACKGROUND_ALLOW=1` 仅许可显式 Start，不自动连接；在 Pi 子 shell 中 export 不能修改父 Pi 环境。不要把 credential 写入上述命令。

### Client 安装与只读诊断

从 [OpenAI Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)提供的下载入口或[官方 release](https://github.com/openai/tunnel-client/releases/latest)取得对应平台的 client；在执行前核实来源、版本及发布方提供的完整性信息。最新版本不自动等于本包已兼容版本。CE 不下载、安装或更新 client，也不创建云端 Tunnel。

进入 Pi 后运行：

```text
/ce-tunnel doctor
```

它分别报告当前 host、独立选择的 child Node 与 client 路径信任结果；不启动 client、不读 credential/Store、不改 profile，也不证明云端认证或 readiness。child 检查的是当前 resolver 候选，不是已保存 profile command 或正在运行 child 的实测身份；已有 profile 还须核对 Review/Details，必要时在 verified STOPPED 下显式 migrate。根据闭合诊断结果区分 Node 不合格、client 缺失与 client 信任拒绝。

- 显式 `CE_TUNNEL_CLIENT_PATH` / `CE_NODE_PATH` 必须是可信、规范化绝对路径；显式非法 override 不应靠别的候选掩盖。
- 系统候选仅来自 `/usr/local/bin`、`/usr/bin`、`/bin`、`/opt/homebrew/bin`，不扫描项目 PATH。Node 另兼容验证当前进程 executable 和旧 mise 安装位置；不是依赖 mise。
- executable、原路径与 symlink 真实目标的所有祖先均检查 ownership/权限；拒绝项目、`node_modules`、可写文件/祖先及不可信 symlink 链。macOS 只接受无 ACL 或 deny-only ACL，未知/失败拒绝。
- **Homebrew 已安装不等于可执行路径受信任。** 若其 wrapper 或 Cellar 祖先可被 group/other 写入，即使最终 binary 不可写仍拒绝。不要 chmod 放宽、绕过 symlink 检查或直接运行来“证明可信”；选择满足全链门槛的独立安装，再设置绝对 override。诊断不自动搬运 Homebrew 文件或清除 ACL。

缺失或不可信 client 不会触发 spawn；可以先检查 Node、阅读文档和准备配置，但不能据此 Start。

### 准备云端配置与 ChatGPT 连接

1. 在 [Platform Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)核实目标 Tunnel、所属 Platform organization 与允许使用它的 ChatGPT workspace。创建/管理需相应 Manage 权限，运行 key 与使用者需相应 Use 权限；详见[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。不要为排障重复创建已有资源。
2. 取得完整 Tunnel ID（本地形状 `tunnel_` 加至少 8 位字母/数字）、目标 Organization ID（需要时为 `org-...`）及有权使用该 Tunnel 的 credential。它们不是 CE Session/capability。只在向导 masked 输入中填 key；本地形状检查不证明云端权限。
3. 按[官方自定义 MCP 指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)，在 [ChatGPT Plugins](https://chatgpt.com/plugins)选择 **+ → Add custom MCP server**，填写名称，在 **Connection** 选择 **Tunnel** 并选同一个目标。按目标配置认证、审阅风险提示，再 **Create as a plugin**。组织/客户端资格以当前官方页面为准；CE 不配置云端插件。
4. 安装该插件，在当前对话用 `@` 选择它。配置变更后在插件详情刷新工具，再核对当前对话实际可见工具；Tunnel CONNECTED 不替代这一步。不要把 Desktop marketplace 当作这条路径的前置要求。

## 2. 首次设置与 Messaging 授权

执行 `/ce-tunnel setup`，或 `/ce-tunnel` → **Set Up Tunnel**：

1. 输入 Tunnel ID、需要时的 Organization ID、masked credential。已有配置选择 **Keep existing credential**，不需重新输入或读取原 key。
2. Review 默认只生成基本 transport 配置，`recipients: []`，**不能通信**。
3. Review → **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi)** → **Authorize messaging for this session**。
4. 核对当前真实 Pi Session、ChatGPT Endpoint `chatgpt/main`、初始 Pi Endpoint `pi/main`、Store/Exchange 及 payload/ACK。该便捷配对在两边开启 payload read / ACK，并将手工 recipients 替换为唯一 Pi 收件人；不是隐含最小权限。需要不同权限时按明确的配置流程授权。
5. 最终 **Save** 才发布配置 generation；它不激活 Endpoint、不启动 Tunnel、不读写消息。已有配对的替换需额外明确确认。

不同项目/Session 使用独立注册而不是轮流覆盖 `pi/main`；见[多 Session 使用](multi-session-usage.zh-CN.md)。

### 让保存的策略生效

编辑已有配置前，需显式 Stop 并核实 transport STOPPED；未知锁、活动 reader 或外部实例均不能当作已停止。向导不自动 Stop。

1. 如当前仍持有旧 CE binding，运行 `/ce-tunnel deactivate`，确认正常释放当前本地绑定。它不停止 transport，也不撤销注册。旧版 activate 的 policy-not-loaded 分支也仅释放旧映射并提示 reload，不会切换权限。
2. `/reload` 加载所选 generation。未绑定或已释放的 mapping 不自动 provision；`CE_HOST_MAPPING_INVALID` 不表示应删除 Store。
3. `/ce-tunnel activate`，确认当前真实 Session、双 Endpoint、Store/Exchange 与权限。只以 requireUnowned 显式绑定；匹配的有效 binding 为 no-op，不接管已有 Owner（包括已过期者）。
4. `/ce-status` 核对身份、Owner lease/fencing；再单独 `/ce-tunnel start` 加载 MCP 侧所选配置。

首次配置没有旧绑定则跳过第 1 步。release 为 UNKNOWN、精确 released+detached 证据缺失或持久化失败时停止并核实，不连续 activate/reload。不手改 identifiers 或伪造释放标记。

## 3. 真实后台启动与 Manager

真实 Start 可能计费，先授权运行窗口。在父 Pi 环境带精确 `CE_TUNNEL_BACKGROUND_ALLOW=1` 的前提下，显式 `/ce-tunnel start`。若需改变父环境，正常退出并以批准 Node、相同扩展加载方式恢复同一 Pi Session；`--continue` 选择最近会话，`--resume` 可人工选择。环境许可不等于已经启动。

| 操作 | 实际含义 |
|---|---|
| `/ce-tunnel` | 打开持久 Manager 界面 |
| Start / `/ce-tunnel start` | 先确认启动请求，再异步测量 readiness；不自动重连 |
| Refresh / Details | 更新健康、查看净化后的非秘密配置与进程证据，不重新授权 |
| Stop / `/ce-tunnel stop` | 只停止可证明属于 Manager 的实例；退出未确认不算 STOPPED |
| Close | 仅关闭界面，不停止后台启动任务或 daemon |
| `/ce-tunnel status` | 查看实测 transport 状态，不自动 Start |
| `/ce-status` | 查看经当前 admission 校验的 Pi / CE 身份、Exchange、Owner lease/fencing |
| `/ce-tunnel deactivate` | 确认后正常结束当前本地 CE binding；不改 registration/历史、不 Stop Tunnel |

后台 daemon 可跨 Pi Session 存活；退出 Pi 不等于 Stop。默认启动预算 45 秒，不是成功保证；client 初始 long-poll 可能约 30 秒。未知进程/lease 不能用第二次 Start、删锁或 bulk kill 解决。详见[后台 Manager](tunnel-manager-background.zh-CN.md)（当前源码打包清单已纳入；已发布历史制品内容以实际检查为准）。

**Configured ≠ Pi-bound ≠ Connected ≠ 消息实证。** Configured 是配置；Pi-bound 是当前 CE authority；CONNECTED 仅为及时测得的健康与控制面 polling；STOPPED 不表示 CE 已释放，UNKNOWN 更不等于 STOPPED。任何一项都不证明 ACK 或任务完成。

## 4. 双向 send / inbox / read / ACK

两端先加入同一 Exchange，核对已加载的 recipients/opt-in 和当前对话工具。每一步独立授权；不要为诊断读取真实 Inbox。

`ce_send` 的 `CREATED` 表示 Message、幂等记录与创建 Audit 已在本地 Store 同一事务提交；`REPLAYED` 返回原 Message，不创建第二条。它们不是云端送达、对端读取或任务执行的证明。Tunnel 传输工具调用与响应，双方通过同一 Store 发现消息；CE 不承诺 exactly-once delivery/execution。

`idempotencyKey` 在 Exchange 内标识一次逻辑发送：相同 key 与相同请求可重放原记录；同 key 换正文或 Endpoint 是不可重试的冲突，不是覆盖。新逻辑消息使用新 key。超时、缺 ACK、BUSY 或未知结果均不授权重试；不要换 key 重发，也不要把 `DELIVERY_UNKNOWN` 改写为 `CANCELLED`。

首次人工验收仅在单独授权后使用无敏感信息的测试文字与本次唯一 nonce/key，记录两向 Message ID；逐向核对 send → 独立 inbox → 授权 payload read → 单独授权 ACK，不以 CONNECTED 或历史验收替代本次证据。

### ChatGPT → Pi

`ce_send` 虚构参数：

```json
{"to":"pi/main","text":"示例：请检查计划，不执行部署。","idempotencyKey":"example-c2p-001"}
```

多 Session 时将 `to` 换为确切的 active Endpoint（如 `pi/project-B`），不是 native/CE Session ID，也不额外拼 adapter。发送者不能由参数指定。

Pi 独立执行 `ce_inbox_list`：

```json
{"pageSize":10,"rawScanLimit":100}
```

从结果中选授权 Message ID；`ce_read` 只看元数据，`ce_read_payload` 才读取正文。正文进入模型与可能持久保存的 history，是不可信数据，不是指令。

### Pi → ChatGPT

```json
{"to":"chatgpt/main","text":"示例反馈：计划已检查，未执行部署。","idempotencyKey":"example-p2c-001"}
```

ChatGPT 独立 list → 选择 Message ID → 授权 payload read。MCP 不提供 Pi 专有 `ce_read`。共享 ChatGPT inbox 不隔离不同对话；不要自动排空分页。

### 接收 ACK（两边独立进行）

只有 `ack.enabled: true` 且已授权本次接收回执才调用 `ce_ack`。逐字复制成功 payload read 的四项：`messageId`、`payloadDigest`、`payloadLength`、`messageCreatedAuditSequence`；不计算/猜测。

Pi 文本直接显示 `ACK input metadata (reception only)`。MCP 的 payload read metadata 将 Message 创建 Audit 命名为 `auditSequence`，须原样映射为 ACK 的 `messageCreatedAuditSequence`；它不是 receipt 或 Inbox continuation。首次为 CREATED，已有为 REPLAYED。list/read 不消费、不 ACK、不推进 delivery cursor。ACK 仅 reception，不证明 delivery/read/processing/completion。完整参数和分页见[Pi 指南](../pi-extension/README.zh-CN.md)。

## 卸载或升级前

先按[安全卸载、升级与回滚](independent-install.zh-CN.md#5-安全卸载升级与回滚)执行：仅 owned Manager Stop → 独立 status 证明 STOPPED → 相关 binding 正常 deactivate/release → 确认其他使用者不依赖共享资源（不明即 STOP）→ 退出自己相关 Hosts → 原生 Pi remove 精确 source。不是退出 Pi 后直接删目录，也不是批量停止其他 Session。保留 Store/profile/凭据/history；外部 Owner、...

## 5. Pi 重启、恢复与安全编辑

- **有效 binding 的 `/reload`**：停旧 timer、drain、丢弃旧 capability；保留 durable Ownership，新代重新 resume 校验。
- **正常 deactivate / quit / Session replacement**：正常 end/release/detach；重新使用需显式 activate，不复活已终结的 CE Session。取消解绑不改变 binding；不确定释放保持拒绝。
- **新/fork/切换 Session**：不是恢复原身份。以可信 native Session ID 注册新 Endpoint；文件名与项目路径不是 authority。
- **崩溃、租约过期、UNKNOWN**：不自动 takeover/recovery；停止并单独核实。恢复属于[独立 operator 流程](chatgpt-installation.zh-CN.md#显式-stale-ownership-恢复)，不是日常安装步骤。
- **编辑**：先核实 STOPPED，再 Setup → Keep credential；保存、Pi reload/activate 与 MCP Stop/Start 分别生效。Save 前取消不改变有效配置；Save 后 durability uncertain 不等于回滚，不盲重试。

## 配置模型与生成文件

默认 profile：`~/.config/pi-chat-exchange/tunnel/tunnel.yaml`。`~` 仅为说明，生成内容使用规范化绝对路径。

| 对象 | 作用与编辑政策 |
|---|---|
| Profile | transport 与唯一 activation pointer；选择 MCP command 的 `--config`；不等于 CE authority |
| `.credentials/credential-<uuid>` | 私有 plaintext key generation，目录 0700 / 文件 0600；不 cat、不提交 |
| `.ce-bindings/` | 私有 binding/sidecar；messaging generation digest 同时保护两份内容，不覆盖/手改 |
| `.ce-bindings/ce-store.sqlite`、WAL/SHM、host-secret | Store/信任根；目录 0700 / 文件 0600，Storage 独占 secret；不复制合并或清理 Owner |
| background state / lock / ledger | 进程所有权证据；不删锁、不按名称 kill |
| health URL / log | 本机受限诊断；不要公开 URL、完整日志或 credential reference |
| `ce-mapping` / `ce-messaging-released` / `ce-lifecycle-blocked` | Pi history 中的标识符/释放/拒绝证据，不含 capability，不手工编辑 |

Store directory/file 与 Exchange namespace/idempotencyKey 四项精确一致才配对；Endpoint、Participant、CE Session/Owner、native Pi Session 各有含义。registration 不是 live Owner，recipient label 不是认证。配置发布先生成 immutable binding/sidecar，profile rename 才逻辑提交；不是跨文件 crash-atomic 事务，无自动 credential/generation GC。

| 环境变量 | 作用与生效时点 |
|---|---|
| `CE_TUNNEL_PROFILE` | 选择规范化绝对 profile；不自动切换运行中的 child |
| `CE_NODE_PATH` | MCP child 的可信批准 Node；不改变运行中的 Pi host |
| `CE_TUNNEL_CLIENT_PATH` | 可信 client 绝对路径 override，不是 profile 字段 |
| `CE_TUNNEL_BACKGROUND_ALLOW=1` | 父 Pi 许可显式 Start，不自动启动 |
| 非空 `CE_ALLOWLIST` | 显式 Pi 策略优先；阻止生成策略 conversion/registration，不建议普通 Tunnel 用户设置 |
| `CE_STORE_DIR` / `CE_STORE_FILE` | 已声明 Store 时仅可确认同一位置，冲突拒绝；不偷偷换库 |
| `CE_LEASE_TTL_SECONDS` | 覆盖配置 TTL，仍受 Host 合法范围限制，需重载；不是恢复开关 |
| `CE_TUNNEL_OFFLINE_TEST=1` | 仅隔离模拟器，正常使用不要设置 |

未设置显式 allowlist 时优先所选完整生成策略，再用扩展旁 allowlist。权限在 factory 加载时捕获；Save/其他 shell export 不会自动扩大内存 grants。child 只继承最小环境，不能用任意 `OPENAI_*` 改消息身份。

## 故障排查：先定位层，再进行最小修复

| 症状 | 检查与安全处理 |
|---|---|
| 安装失败 / 缺少运行时文件 | 可能是错误 Node/npm、制品不完整或源码未 build；先 `node --version`、`npm --version` 并核对制品 SHA256；tarball 按[独立安装指南](independent-install.zh-CN.md)核对载荷，不在 consumer build；源码在仓库根目录重新执行 `pnpm --dir packages/pi-chat-exchange run build`。不要用关闭资格门槛或删 Store 修安装 |
| Pi 中没有 `/ce-tunnel` / `/ce-status` | 可能未加载、加载失败或仍引用旧目录；先 `pi list` 对照原 source 与启动时 `-e`，查看加载拒绝码；仅保留一份扩展。源码先 build 再 `/reload`，已安装包则核对物理入口；不要再叠加第二份加载 |
| 发送失败 / 发送响应丢失 | 可能是未绑定、recipient 未授权、四项配对不符或结果未知；先 `/ce-status`、`/ce-tunnel status` 与固定拒绝码，核对当前精确 Endpoint；保留原 key/Message ID，未知结果停止核实，不以新 key、缺 ACK 或再次 Start 作为重发许可 |
| host / child Node 不合格 | doctor 分开看两者；批准 Node 必须通过 SQLite 全资格。host 需用正确 Node 启动；child canonical profile 修复用显式 migrate，先核实 STOPPED |
| client 缺失或信任拒绝 | doctor；核实独立安装及全链权限，不复制绕过不可信 Homebrew 祖先、不运行未准入 binary、不放宽 guard |
| `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` | 核实父 Pi 的精确许可；在子 shell export 无效 |
| legacy 单 Session profile 的 register / sessions / revoke 拒绝 `CE_TUNNEL_PROFILE_INVALID` | 需先显式 `/ce-tunnel convert` 创建多 Session generation，按提示分别确认旧 runtime 已停止或更新及转换授权；不自动转换，不是 transport 未 STOPPED |
| `recipients: []` / CONNECTED 但不能发 | 核对 Advanced Messaging、Pi binding、当前 ChatGPT 工具、Store/Exchange/recipient，不重发原消息测通 |
| unclean exit 后 `CE_HOST_UNAVAILABLE` 且提示 local session-process mutex unreleased slot | 仅 operator 在完整离线维护窗口（所有 Pi/CE、heartbeat、后台启动器、自动重启和 recovery jobs 均停止并禁止重启，覆盖检查、协调、持久化和复查全程）并独立确认 owner 已死亡后，显式运行 `pnpm run reconcile:session-mutex --expect-store-dir <canonical-dir> --expect-store-file <basename> --expect-endpoint <endpoint> --expect-runtime-session <session> --expect-slot <slot> --expect-owner-version 1 --expect-owner-scope <sha256> --expect-owner-pid <pid> --expect-owner-birth <birth> --expect-owner-process-token <token> --expect-owner-handle-token <token> --expect-owner-sha256 <raw-byte-sha256> --expect-store-dev <dev> --expect-store-ino <ino> --expect-slot-dev <dev> --expect-slot-ino <ino> --expect-owner-dev <dev> --expect-owner-ino <ino> --offline-window-confirmed --owner-death-evidence <independent-reference>`（无 `--audit-log` 参数，未知参数一律拒绝，脚本不写任何 audit 文件）；参数均须独立核实，无默认值。仅协调本地 mutex receipt，不是 CE ownership / Operator Recovery，不证明 CE end/detach；恢复本地可用性不授权恢复业务操作、CE read/ACK、detach、takeover 或 recovery，必须等待单独授权决定；不删锁、不对活 PID 协调、不在真实 Store 上试 acquire；发布分两阶段：先以 O_EXCL 写 `release-pending.json`（0600、内容与 owner 原始字节完全一致），fsync 文件与各层目录并完成全量复查后，才以原子 rename 为 `released.json` 作为唯一提交点；rename 之前的任何失败都原样保留 pending 制品并以固定理由退出；rename 抛错时仅当 `released.json` 与所准备的字节/身份完全一致才按已提交成功对待，否则同样硬停；rename 之后不再执行任何可失败操作；任何失败均要求人工复查，绝不重试、覆盖或删除 |
| no endpoint / `CE_HOST_MAPPING_INVALID` | 先核对当前 native Session、所选注册、加载策略与 release 证据；新/正常释放后显式 activate；UNKNOWN 不当作普通未绑定 |
| read/ACK 不可用 | 两个 opt-in 分别核对并显式加载；ACK 不开启 payload read |
| Inbox 看不到消息 | 核对四项配对与 join boundary；空页不是全库证明，不复制 DB/盲重发 |
| STARTING / READY_TIMEOUT | 等待在途终态与清理证据，核对目标/权限；UNKNOWN 不加第二个实例或无限 timeout |
| 重复命令 / MANAGER_BUSY | 核对 `pi list` 与 `-e` 是否重复，关闭多余 UI；不连按启动 |
| client 拒绝旧 `admin_ui` | 核实 STOPPED 后 `/ce-tunnel migrate`，只修 canonical schema/child Node，不扩大权限 |
| 外部实例 / 锁 / STOP_UNCONFIRMED | 保留状态和 ledger；Manager 可证 Stop 之外需另行人工授权，不删锁、不按进程名 kill |

renew/end/映射持久化未知均 fail-closed，不连续 activate/reload。record-backed run 最多一次 SIGTERM；重复 Stop 不保证重发信号。`migrate` 不读取 key、不换 Store、不授权消息，不是任意 YAML formatter。

Masked 输入不是保险箱：同进程恶意扩展、录屏、剪贴板、内存观测不在隔离保证内。只分享固定码与最少非秘密标识，勿贴 key、capability、正文、完整 Session/环境。隔离 harness、packaged tool discovery、实际 Tunnel 健康和人工消息验收是不同证据；本次变更不重做真实消息验收。
