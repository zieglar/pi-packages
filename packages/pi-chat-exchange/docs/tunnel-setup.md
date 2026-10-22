# ChatGPT ↔ Pi：Tunnel 用户指南、配置与排障

本页是当前 Local Dogfood 主路径。先读[概览](../README.md)；只用 Desktop 本地 stdio 插件时见[独立安装路径](chatgpt-installation.md)。所有示例均为虚构，不包含实际配置或消息。

## 1. 前提与安装

| 组件 | 当前核实基线 | 注意 |
|---|---|---|
| Pi | 1.3.0 | 向导需要 interactive TUI；非交互模式不提供 masked 设置 |
| Node.js | **24.21.0** | Pi 激活进程和 Tunnel MCP 子进程都必须满足 Store 的精确版本门槛，24.x 或 25.x 不等价 |
| pnpm | 仓库固定 12.9.1 | 见根 `package.json` |
| UI Kit | `@narumitw/pi-tui-kit` 0.66.0 | 包依赖负责安装；不是用户另外装一个 UI |
| Secure MCP Tunnel | `tunnel-client` 0.0.16 | 当前真实 Manager 固定默认 `/opt/homebrew/bin/tunnel-client`，不做 PATH 自动发现；不同版本/安装位置需独立配置能力变更与兼容验证 |
| Store 平台 | macOS arm64 / Linux x64 | 另有 SQLite、文件系统和权限门槛；不能据此宣称所有 Linux 部署已验收 |

本仓库不提供 `tunnel-client` 下载器或云端 Tunnel 创建器。按官方 Secure MCP Tunnel 分发说明安装对应客户端，再用 `/opt/homebrew/bin/tunnel-client --version` 核对实际 Manager 使用的 binary；不要把 PATH 中另一个同名程序当成它。这个固定 Homebrew 路径限制了开箱即用范围，Linux Store 资格不代表 Linux Tunnel 默认部署已支持；本次只记录限制，不修改实现。Node/Pi/provider 的安装与登录仍由操作者完成。

从仓库根目录执行：

```bash
mise exec node@24.21.0 -- pnpm install
mise exec node@24.21.0 -- pnpm --dir packages/pi-chat-exchange run build
mise exec node@24.21.0 -- node --version
pi --version
/opt/homebrew/bin/tunnel-client --version
mise exec node@24.21.0 -- pi -e ./packages/pi-chat-exchange/pi-extension/index.ts
```

这是显式临时加载方式。也可在确认路径后用 `pi install /absolute/path/to/packages/pi-chat-exchange` 注册本地包；只选一种加载方式，避免包安装、自动发现和 `-e` 重复。修改构建产物先 build，更新扩展后 `/reload`；不要重复注册命令来“修复”加载问题。

### 准备哪些值，从哪里取得

- **Tunnel ID**：从你有权管理的 OpenAI Tunnel/Connector 配置或创建 Tunnel 的控制面结果取得完整 ID，不是 URL、connector 名称、Pi Session ID。CE 本地格式为 `tunnel_` 加至少 8 个字母/数字，例如虚构的 `tunnel_Example12345678`。本地校验通过不证明云端 Tunnel 存在。
- **Organization ID**：从同一目标组织的设置/控制面元数据取得；格式 `org-` 加 1–128 个字母/数字，例如 `org-Example123`。没有组织要求可留空；组织作用域目标需核实是否必填，不要猜测或拿 project ID 替代。
- **Credential / API key**：由有权访问该 Tunnel 的操作者在对应 OpenAI 账户/组织中获取可用凭据。向导只验证输入形状，不证明云端权限。它不是 CE capability、Store host secret 或 Pi 模型登录凭据。只在专用 masked 输入中填写，绝不放在聊天、命令参数、截图或工单里。
- **ChatGPT 连接**：在支持该 MCP Tunnel 的 ChatGPT 客户端中，按其连接配置选择同一个目标 Tunnel/Connector，并在当前对话启用对应工具。CE 向导不会创建或更新 ChatGPT 的云端连接；客户端菜单和权限可能随版本变化。`CONNECTED` 不替代 ChatGPT 当前对话的工具发现。

## 2. 首次设置与 Messaging 授权

执行 `/ce-tunnel` 打开 Manager，未配置时选 **Set Up Tunnel**；或直接 `/ce-tunnel setup`。

1. Tunnel ID：输入完整 ID。
2. Organization ID：按目标组织要求输入或留空。
3. Credential：首次直接进入 masked API key 输入。已有配置则选择 **Keep existing credential** 或 Replace；Keep 不读取、不显示、不复制 key 内容。
4. Review：检查非敏感配置与 credential intent。向导默认生成最小权限 binding，**默认 `recipients: []`，不能通信**。
5. 在 Review 选择 **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi)**，明确选择 **Authorize messaging for this session**。
6. 核对 ChatGPT Endpoint `chatgpt/main`、Pi Endpoint `pi/main`、实际运行时 Session、Store/Exchange 与 payload/ACK 权限。这里授权的是**当前 Pi Session**，不是任意后续会话。已有别的 Session 时必须显式同意替换。
7. 回到 Review，完成身份/权限变更确认，最后 **Save**。只有最终 Save 才进入配置事务；保存不激活 Endpoint、不启动 Tunnel、不读写消息。

Advanced · Messaging 会将手动 Advanced · Recipients 列表替换为唯一 Pi 收件人，并在两边开启 payload read / ACK；不是在任意收件人列表上追加权限。单独 Advanced · Recipients 适合受控高级配置，不是自动配对入口。CE 没有可信 endpoint discovery。

**已有有效配置时，Manager 不一定显示 Edit Configuration。** 直接 `/ce-tunnel setup`，走 Keep existing credential，再进入上述 Review/Advanced 路径即可。不要为找入口删除 profile 或重填 key。

### 让保存的策略生效

配置保存、Pi 内存策略、Pi Ownership 与 Tunnel 子进程是不同层。按顺序操作：

1. 先 Stop Tunnel，确认已停止且 ownership 可证；ACTIVE、STARTING/STOPPING、外部 reader 或不确定锁可能阻止编辑。setup 不自动 Stop。
2. 保存新配对后，如果当前实例仍持有旧 Pi binding，执行 `/ce-tunnel activate`，按提示显式释放旧映射。这时可能显示 **Policy loaded: no**，只做 release，不会切换内存权限。
3. `/reload` 加载所选 generation。普通 reload 是 **resume-only**，没有 mapping 时允许出现 `CE_HOST_MAPPING_INVALID` 拒绝；不会替你新建 authority。
4. 再执行 `/ce-tunnel activate`，确认实际运行时 Session、双 Endpoint、完整 Store/Exchange 和权限。它以 `requireUnowned:true` 显式申请，已有匹配且有效的绑定为 no-op，不接管已有 Owner，即使已过期。
5. 用 `/ce-status` 核实当前 Pi Endpoint 的注册、lease 和 fencing；再显式 Start Tunnel，使其重新读取新 MCP binding。

首次设置没有旧映射时无需释放；不要因首次 reload 的 missing-mapping 拒绝去清理数据库。若旧映射的 released+detached 证据缺失、release 为 UNKNOWN 或映射持久化失败，应停止并核实，不要连续 activate/reload。仅写入 `ce-messaging-released` 标记不授予目标 authority；代码验证的是旧映射的精确释放证据。

## 3. 真实后台启动与 Manager

真实 Start 会建立可能计费的连接，先确认费用和运行窗口。启动许可必须存在于 **Pi 进程自身环境**，且值恰好为 `1`。在 Pi 内开一个子 shell `export` 无法修改已经运行的父 Pi。

完成正常退出后，从**同一个项目目录**恢复会话，例如已安装扩展时：

```bash
CE_TUNNEL_BACKGROUND_ALLOW=1 mise exec node@24.21.0 -- pi --continue
```

若是临时 `-e` 加载，恢复时保留相同 `-e` 参数：

```bash
CE_TUNNEL_BACKGROUND_ALLOW=1 mise exec node@24.21.0 -- pi \
  -e ./packages/pi-chat-exchange/pi-extension/index.ts --continue
```

`--continue` 选择最近会话；不确定时用 `pi --resume` 选择，或 `--session <path|id>` 指定已核实会话。不要新建另一个 Session 然后假设它继承配对。环境许可不等于 Start：恢复后仍需显式操作。

| 操作 | 实际含义 |
|---|---|
| Start Tunnel / `/ce-tunnel start` | 显式后台启动。先返回 STARTING，再异步测得结果；同 Session 在途的重复 Start 会合并 |
| Refresh | 更新健康/配置投影；可能执行真实 probe，不是重新启动、重新授权或重试消息 |
| Details | 查看配置与运行时证据、拒绝码、经过终端净化的 profile 路径；不显示 credential 内容/引用 |
| Stop Tunnel / `/ce-tunnel stop` | 只停止可证明属于 Manager 的实例；退出未确认不算 STOPPED；不自动杀 MCP 子进程 |
| Close | 只关闭 Manager 界面；不会停止后台启动任务或 daemon |
| `/ce-tunnel status` | 查看配置与实测 Tunnel 运行状态；不自动 Start |
| `/ce-status` | 查看当前 Pi 的 CE Endpoint / Ownership lease / fencing，不是 Tunnel 健康检查 |

Manager 占用 custom UI 时，`/ce-status` 用普通通知输出；不要为看状态重复开 Manager。后台 daemon 设计上可跨 Pi 会话存活，退出 Pi 不等于 Stop。没有自动 respawn；需要显式 Start。详细的锁、PID/启动时间/命令身份核验见[后台 Manager](tunnel-manager-background.md)。

### 不要混淆这些状态

| 状态/事实 | 能证明什么 | 不能证明什么 |
|---|---|---|
| Configured | profile/binding/credential 元数据投影可用 | Pi 已绑定、云端认证成功或有消息权限 |
| STARTING | 已确认启动请求，readiness 尚未成立 | CONNECTED 或消息已送达 |
| CONNECTED | 在有效时限内，真实 health probe 满足控制面 poll 等条件 | 当前 ChatGPT 工具有权发送、对端加入 Exchange、ACK 或完成 |
| STOPPED | 测得/可证的停止状态 | 配置无效、CE Session 已安全释放 |
| UNKNOWN | 健康、进程或所有权证据不足/过期 | 不得映射成 STOPPED，不得据此再 Start 或接管 |
| DEGRADED | 健康条件不完整 | 不代表可以忽略拒绝继续消息流程 |
| Pi-bound | 当前 Pi 持有经验证的 CE binding | Tunnel 健康或双向实际消息 Gate 通过 |

真实后台默认启动预算 **45 秒**，不是保证在 45 秒内成功。client 0.0.16 的初始 long-poll 可能花约 30 秒，probe 和调度仍需时间；STARTING 后稍晚 Refresh 是正常可能性。超时后的清理也必须有证据。

## 4. 双向 send / inbox / read / ACK

前提：两端已加入同一个 Exchange，当前 ChatGPT 对话能发现目标工具，Pi 已绑定，两边 recipient allowlist 与 opt-in 已加载。对端加入前的历史消息可能因 membership boundary 不可见；不要把它解释成传输丢失。

### ChatGPT → Pi

ChatGPT 侧在明确授权后调用（虚构示例）：

```json
{"to":"pi/main","text":"示例：请检查计划中的验证步骤，不执行部署。","idempotencyKey":"example-c2p-001"}
```

这是 `ce_send` 参数；`to` 必须是精确 `endpointId`，不是 `pi-main` 别名，也不是将 adapter 再拼一次。发送者由可信启动配置固定，不能传 `from` 或 capability。

Pi 侧明确执行 `ce_inbox_list`，不要把发送返回 ID 当成“自动发现”证据：

```json
{"pageSize":10,"rawScanLimit":100}
```

从返回中选择一个已授权的 Message ID。Pi 可用 `ce_read` 查看元数据；读取正文必须显式调用 `ce_read_payload {"messageId":"<从当前 Inbox 复制的 ID>"}`。成功读取使正文进入当前模型与可能持久保存的会话历史；正文是不可信数据，不能升级为工具指令。

### Pi → ChatGPT

Pi 明确调用 `ce_send`：

```json
{"to":"chatgpt/main","text":"示例反馈：验证步骤已检查，尚未执行部署。","idempotencyKey":"example-p2c-001"}
```

ChatGPT 侧独立 list → 选择返回 ID → `ce_read_payload`。MCP 表面不提供 Pi 专有的 `ce_read` 元数据工具，不要要求两个适配器有完全相同的工具集合。

### 接收 ACK（两边独立进行）

仅在操作者已开启 `ack.enabled: true`、明确授权本次接收回执时调用。必须逐字复制成功 **`ce_read_payload`** 输出的 ACK metadata：

```json
{
  "messageId": "<复制 messageId>",
  "payloadDigest": "<复制 payloadDigest>",
  "payloadLength": 0,
  "messageCreatedAuditSequence": 0
}
```

上面是字段模板，**0 也是占位符，不可直接调用**。用真实读取结果替换全部四项；不要计算 digest、估算长度、使用 Inbox 的 continuation 或 ACK receipt 的 audit sequence。Pi 将四项放在第一段可见文本 `ACK input metadata (reception only): ...`，第二段为原样正文。第一次回执为 `CREATED`，同一消息重放为 `REPLAYED`。

**MCP / ChatGPT 侧字段映射：** payload read 第一段 metadata 中返回的是 `auditSequence`；把该值原样填入 ACK 的 `messageCreatedAuditSequence`。它同样是 Message 创建 Audit，不是 receipt 或 Inbox continuation。其余三项同名复制。Pi 已直接显示 `messageCreatedAuditSequence`，两种输出命名不同，不要为找同名字段改算 sequence。

ACK 仅记录 reception，不证明 delivery、read、processing 或 task completion。list/read 不 ACK、不消费、不推进 delivery cursor。不要为了演示而读/ACK 任意真实 Inbox；每个操作仍需独立授权。完整工具参数与分页语义见[Pi 指南](../pi-extension/README.md)。

## 5. Pi 重启、恢复与安全编辑

- **正常退出**会尝试结束 CE Session（释放 Ownership、detach）；再次进入同一 Pi 会话时不能假定终态 mapping 自动复活。按状态和显式激活流程处理，不删 mapping 来绕过拒绝。
- **扩展 reload**保留有效 durable Ownership，丢弃旧内存 capability，新实例必须 resume 校验。Pi 1.3.0 正常已绑定运行时的 reload 会发送 `session_start(reason: reload)`；“reload 从不发 session_start”不是已证实的原因。
- **崩溃/租约过期/UNKNOWN**不自动接管。正常启动也不能因 lease 已过期而绕过 requireUnowned。Store 恢复是另行授权的 operator 操作，不是 retry 按钮；见[恢复入口与限制](chatgpt-installation.md#显式-stale-ownership-恢复)。
- **新建/fork/切换 Session**不是恢复原 Session。当前配对从可信 `ctx.sessionManager.getSessionId()` 取得 ID；不能从文件名、日志或猜测值授予权限。需要新配对时先核实旧 authority，显式替换授权并按 release/load/activate 顺序执行。
- **编辑已有配置**先 Stop 并核实所有权，再 `/ce-tunnel setup` → Keep existing credential。改 Tunnel/Organization/recipients 需重新授权；保存后 reload Pi 策略并 Stop/Start Tunnel 加载新 binding。不要手改被 digest 保护的 generation。
- Escape/Cancel/timeout 在 Save 前不改变有效配置、不启动网络；文件系统失败可能留下未引用私有文件，不能宣称绝对零磁盘痕迹。Save 后出现 `durability: uncertain` 表示提交点已过但持久性未证，不应当作已回滚再保存。

## 配置模型与生成文件

### 名称、权威与引用关系

| 名称 | 含义与权威来源 |
|---|---|
| Profile | `tunnel.yaml`：client 的 transport 配置，含 Tunnel/Organization、credential reference、health 与 MCP command；不是 CE 授权对象 |
| managedBinding | CE 生成、由 profile 的 `mcp.commands[0].command --config` 选中的 MCP binding 文件；`managed` 只是 provenance，不授予权限 |
| Endpoint | `{adapter, endpointId}`；消息身份，ChatGPT 与 Pi 不共享同一个 Owner |
| Recipient Label | `ce_send.to` 使用配置允许的精确 `endpointId`，例如 `pi/main`；不是认证凭据 |
| PiSessionMapping | `ce-mapping` 自定义 Pi session entry，保存恢复所需标识符；无 capability，必须经 Host resume 校验 |
| Pi allowlist | `sessions[真实 Pi Session ID].endpointId`、recipients、Store/Exchange 与 opt-in；Session ID 是查找标签，不自带 authority |
| Store / Exchange | Store directory + filename 确定数据库；Exchange namespace + idempotency key 确定 bootstrap 关联；四项都须一致，无自动跨库/跨 Exchange 路由 |
| credential reference | profile 的 `control_plane.api_key: file:<absolute path>`；密钥值留在私有文件，非 inline/env 引用 |
| Advanced | 人工显式修改 messaging/recipients 的入口；不会自动发现端点或提升任意会话权限 |

### 默认文件布局与编辑政策

以 `~/.config/pi-chat-exchange/tunnel/` 为默认 profileDir。`~` 是说明用法，文件里的路径是规范化绝对路径，不含 shell 变量展开。

| 文件/位置 | 用途 | 权限与手改政策 |
|---|---|---|
| `tunnel.yaml` | 生效指针及 client 配置 | 生成文件 0600；优先 setup/migrate，不任意改写 YAML |
| `.credentials/credential-<随机 UUID>` | plaintext API key generation | 目录 0700、文件创建即 0600；macOS 先移除继承 ACL；不 cat、不提交、不复制到报告 |
| `.ce-bindings/ce-<Tunnel尾6>-<Org尾6或none>.yaml` | 普通最小权限 binding；变更可能加 digest 后缀 | 私有目录 0700 / 文件 0600；后缀虽为 YAML，生成内容使用 JSON；不可按文件尾部片段推断完整身份 |
| `.ce-bindings/messaging-<64位摘要>.yaml` | 配对的 ChatGPT MCP binding | 0600、不可变 generation，不覆盖/手改 |
| 上述 messaging 文件加 `.pi-allowlist.json` | 同 generation 的 Pi 配置 | 0600、与 binding 共同校验 digest，不移作任意 Session 的授权 |
| `.ce-bindings/ce-store.sqlite` 及 WAL/SHM | 生成配置所选的持久 Store | 懒创建；目录 0700、DB/WAL/SHM 0600，不复制历史到新库来“对齐” |
| `.ce-bindings/host-secret`（生成 Store） | Storage 的本地信任根，位于所选 Store directory 内 | 0600、exclusive/no-follow 创建；Storage 独占读取；不是 Tunnel key，不提供给模型或写进 mapping |
| `background-state.json`、其 `.lock.d` | 后台所有权记录及目录锁 | state 0600，含内部进程/路径证据；不要贴原文，不手删锁或 ledger |
| `health.url`（setup 默认）与 `background-tunnel.log`（stateDir 默认） | loopback 健康入口与诊断 | profile 的 `health.url_file` / Manager 记录为准；日志按 0600 创建并收紧旧权限，health 文件由 client 管理，不额外宣称 CE 验证其权限；不公开 URL/原始日志 |
| Pi 自身 Session 中的 `ce-mapping` / `ce-messaging-released` / `ce-lifecycle-blocked` | 标识符恢复、释放或拒绝证据 | 不是独立的可编辑 allowlist 文件；遵守 Pi session 存储权限，不手工伪造/删除条目 |

原子 profile rename 是配置逻辑提交点；binding/sidecar 先以 no-overwrite link 发布，完整配对验证后才加载。这**不是**跨文件 crash-atomic 事务。未引用 generation、staging 和旧 credential 可能保留；无自动 GC，不批量删除“旧文件”。Keep 不读取 key 内容，但 client 真正连接时仍会读取它。

### 环境变量、优先级与生效时点

| 变量 | 行为 |
|---|---|
| `CE_TUNNEL_PROFILE` | 选择规范化绝对 profile 路径；默认 `~/.config/pi-chat-exchange/tunnel/tunnel.yaml` |
| `CE_TUNNEL_BACKGROUND_ALLOW` | 只有精确字符串 `1` 才允许真实 Start；不自动启动 |
| `CE_ALLOWLIST` | 非空时保留显式 Pi 策略，不被生成 sidecar 自动覆盖；否则优先 profile 选中的完整生成配对，再用扩展旁 `allowlist.json` |
| `CE_STORE_DIR` / `CE_STORE_FILE` | 显式/generated Store 已声明时只能精确匹配；冲突直接拒绝。旧无 Store allowlist 才使用环境值或扩展旁 `store/ce-store.sqlite` 默认 |
| `CE_LEASE_TTL_SECONDS` | 非空时以 Number 转换后优先于 allowlist.leaseTtlSeconds，再由 Host 校验；未设则配置值或默认 120。保留合法范围，修改需重载，不能借此恢复 expired authority |
| `CE_TUNNEL_OFFLINE_TEST=1` | 仅隔离测试的模拟器选择，不是真实连接证据；正常使用不要设置 |

扩展工具权限在加载时捕获，不会因另一个 shell 改环境或 Save 自动刷新。Pi 环境变化应重启原 Session；Pi 策略变化需 reload/显式激活；Tunnel 配置变化需 Stop 后 Start。child 环境是最小 allowlist，不透传父进程所有 `OPENAI_*`、`CONTROL_PLANE_*` 等变量；不能靠这些环境值偷偷改组织或发送者。

MCP binding 是封闭 schema：`version`、可选 `managed`、`store`、`exchange`、`endpoint`、`recipients`、`lease`、`payloadRead`、`ack`、`debugExecutionGuard`。未知字段拒绝；payload/ACK 独立开关，只有 boolean `true` 开启。调试 execution guard 正常配对为 false，不是安全认证替代物。完整的非生成手工配置示例见[独立安装路径](chatgpt-installation.md)。

## 故障排查：先定位层，再进行最小修复

默认只看固定拒绝码、版本、Manager Details 和 `/ce-status` 的必要投影。不要贴原始 key、credential reference、Store 内容、完整 Session 日志或进程环境。未知写入结果、UNKNOWN、release/persistence 失败均**不盲重试**。

| 症状 | 常见原因 | 安全诊断 | 最小处理与停止条件 |
|---|---|---|---|
| `CE_TUNNEL_BACKGROUND_UNAUTHORIZED` | 父 Pi 没有精确 `...ALLOW=1` | 核对启动方式，不 dump 全部 env | 正常退出后以本文进程级环境恢复同 Session；不改全局配置，不在子 shell export 后连按 Start |
| `CE_TUNNEL_READY_TIMEOUT` | long-poll、认证/组织不符、健康条件未在预算内满足 | Details 中看固定码与最终状态；核实版本、目标非敏感元数据 | 等待在途任务/清理终态；确认可证 STOPPED 后再获授权启动。UNKNOWN/stop 未确认时停止操作，不加无限 timeout 掩盖问题 |
| CONNECTED 但不能发 | transport 健康而 Pi 未绑定、工具未启用、recipient/Store/Exchange 不一致 | 分别看 `/ce-status`、ChatGPT 当前工具列表、Review 的非敏感权限 | 修正对应配置层，reload/activate 和 Stop/Start 各司其职；不是重发原消息来测通 |
| `recipients: []` | 只做了四步基本设置，未授权 Messaging | `/ce-tunnel setup` 的 Advanced/Review | Keep key，显式授权当前 Session 的 Messaging 后 Save/加载；不随意放宽所有 recipient |
| 对端 Inbox 看不到消息 / Store 或 Exchange 不一致 | directory/file/namespace/key 任一不同，或对端加入边界更晚 | 在本机核对四项配置一致，不导出 Store/正文 | 选定正确配置并显式重新授权；不复制数据库、合并历史或盲重发；空页也不是全局完整性证明 |
| read/ACK 工具缺失或 disabled | 两个 opt-in 独立，或仍加载旧 generation | 核对两端各自 boolean 设置和工具发现 | 明确授权后加载策略；ACK 四字段必须从授权 payload read 复制，不从 metadata read 猜测 |
| Store runtime / child Node mismatch | Pi 或 profile command 用了非 24.21.0 | Pi 启动 runtime 与 profile command 的 node 路径分别核实版本，不读取凭据 | 用批准 Node 启动 Pi；停止且所有权安全后 `/ce-tunnel migrate` 修 canonical profile 的 child Node。它不会改变正在运行 Pi 的 Node |
| STARTING / Refresh 延迟 | 异步启动、client 初始 poll 或 probe 尚未结束 | 区分 spawn acknowledgement 与实测 CONNECTED | 等待一次终态，再 Refresh；同 Session 重复 Start 合并，不保证跨 Session 请求排队，勿开第二份 client |
| 重复命令、队列、Manager already open | 重复加载扩展、前一个 custom UI 或 Start 在途 | `pi list` 与实际 `-e`/发现路径核对；关闭多余 UI | 一份扩展、一份 Manager；Close 不 Stop。去掉重复加载后正常 reload，不批量重复命令 |
| client schema 拒绝 `admin_ui` | 老 profile 含 `allow_remote_ui` 或 `log_buffer_events: 0` | 固定错误/版本，勿公开原始 profile | 停止并核实 ownership 后 `/ce-tunnel migrate`；只修 canonical CE YAML，保留 identity/key reference/binding/Store；任意手改 YAML 可能需人工审查 |
| `MANAGER_BUSY`、external instance、锁/ownership UNKNOWN | 另一进程持锁、PID 身份不符、ledger 不可读或 reader 活跃 | Details、操作者在本机核对精确命令与 start key | 不删锁、不清 ledger、不按进程名 kill。只用 Manager 可证的 Stop；不确定时保留现场，另行授权人工身份核验恢复 |
| `/ce-status` 显示 no endpoint bound | 当前运行时无绑定：Session 不在所载 allowlist，配置未加载或 lifecycle 未完成等 | 对照启动通知、当前真实 Session 与所选策略、拒绝码；不是仅看 Tunnel | 普通 Pi 1.3.0 reload 有 session_start 路径，不能直接断言“reload 不发事件”。先核实加载/映射；新映射按 activate，UNKNOWN 按拒绝处理。该具体用户现场根因尚未完全复现，不以重启当作通用已证修复 |

`/ce-tunnel migrate` 仅原子修复 canonical CE 生成 profile 的已知 client schema 项与批准 child Node 路径，不改 key 内容、不选择其他 Store、不扩大消息权限。`CE_TUNNEL_STOP_UNCONFIRMED` 下不要假设再次 Stop 会重新发信号：record-backed run 最多一次 SIGTERM；可能需要另行授权的人工身份核验终止，详见[后台约束](tunnel-manager-background.md)。

## 安全与验证边界

Masked 输入是 CE 在 Pi 1.3.0 `ctx.ui.custom()` 中的专用组件，不是 Pi 原生密码保险箱。JS 字符串无法可靠清零；同进程恶意扩展、外部录屏/剪贴板/内存观测不在隔离保证内。loopback `/ui` 对同机进程的可达性也没有被掩盖为完全关闭。

当前实证边界见[README](../README.md)：真实双向消息与 Start/Stop/Restart 已验证；冷启动与部分实体终端交互未验证。Kit harness、offline simulator、`tunnel-client doctor` 和真实用户 Gate 是不同证据，不互相替代。
