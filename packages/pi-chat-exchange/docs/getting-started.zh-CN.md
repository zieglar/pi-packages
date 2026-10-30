[English](getting-started.md) | [简体中文](getting-started.zh-CN.md)

# 快速开始

## 1. Pi Chat Exchange 是什么？

Pi Chat Exchange（CE）让 ChatGPT 和 Pi 通过显式工具交换持久化消息。ChatGPT 经 Secure MCP Tunnel 调用本地 MCP server，两个 Endpoint 使用同一个私有 SQLite Store。发送、发现和读取消息都由你决定。消息本身不授予执行任务的权限，也不证明任务完成。

本指南面向 **0.2.2 本地 Release Candidate**，配置一组 ChatGPT ↔ Pi 配对。当前 npm 正式版仍为 **0.2.1**，其不可变包不包含本次 Homebrew 显式路径修复；验证候选时使用下方已审查的本地 tarball。独立的 [Desktop stdio 连接](chatgpt-installation.zh-CN.md)无需 Tunnel。**真实 Cloud transport 及完整 ChatGPT ↔ Pi 消息交换仍未验证。**

## 2. 前提条件

- Pi **1.3.0**，系统终端中可用 `pi` 命令。Setup 与确认对话框需要交互式 Pi TUI。
- Pi 与 MCP child 均使用 Node **>=22.19.0**。已测版本和限制见[运行时支持](runtime-support.zh-CN.md)；版本范围不代表所有后续版本都经过测试。
- **macOS arm64 或 Linux x64 GNU**，Store 所在的本地文件系统须通过准入检查。其他 Native 制品不代表 Store 支持相应平台。Windows Native 不受支持，WSL2 集成尚未验证；若使用 WSL，Store 应放在 Linux 文件系统，避免 `/mnt/c`。
- 单独安装并由你信任的 `tunnel-client`。CE 已对 **0.0.16** 做本地准入与 Doctor 实机检查；官方较新的 **0.0.18 尚未完成 CE 运行兼容性验证**。安装入口见[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)和[官方 releases](https://github.com/openai/tunnel-client/releases)。CE 不负责 client 的安装、升级或供应链审计。
- 一个 Tunnel、获准使用它的凭据，以及具备该 Tunnel 使用资格的 ChatGPT workspace/account。云端权限和最新界面步骤以[官方 Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)为准，CE 不创建这些云端资源。

首次交换使用无敏感内容的文字。扩展以当前用户权限运行，安装前应审查包。不要把凭据放入 prompt、shell history、截图或消息。

## 3. 安装

在 Pi 之外的**系统终端**执行：

```sh
node --version
pi --version
npm install --prefix /absolute/path/to/ce-rc-prefix --omit=dev --ignore-scripts /absolute/path/to/zieglar-pi-chat-exchange-0.2.2.tgz
pi install /absolute/path/to/ce-rc-prefix/node_modules/@zieglar/pi-chat-exchange
pi list
```

先将两处路径替换为已审查的制品和专用安装 prefix；`pi install` 登记的是已安装包目录，不是 `.tgz` 文件。成功条件：`pi list` 显示该目录，已安装 manifest 为 `@zieglar/pi-chat-exchange`、版本 `0.2.2`。这是本地制品安装，**不是 Registry 安装验证**。消费者无需编译，不要叠加 `-e`。正式版仍可通过 `npm:@zieglar/pi-chat-exchange@0.2.1` 安装，但保留旧准入策略。

在**同一个系统终端**设置以下变量后再启动 Pi。先把两个可执行文件路径替换为本机可信、规范化的绝对路径：

```sh
export CE_NODE_PATH=/trusted/node-install/bin/node
export CE_TUNNEL_CLIENT_PATH=/opt/homebrew/bin/tunnel-client
export CE_TUNNEL_BACKGROUND_ALLOW=1
pi
```

`CE_NODE_PATH` 只选择 MCP child；Pi 本身仍须由受支持的 Node 启动。background opt-in 只许可稍后显式 Start，不会自动启动。Pi 内的子 shell 不能修改父 Pi 进程环境。普通使用时不要设置 `CE_TUNNEL_OFFLINE_TEST`。

设置 `CE_TUNNEL_CLIENT_PATH` 即表示你对该外部程序及安装路径写入者的显式信任委托。此模式允许祖先目录 group-write，不另设确认或授权数据库；自动发现仍严格准入。其他有效写入者可能替换程序，恶意 client 能以你的身份运行并读取 Tunnel 凭据；检查与执行之间的竞争窗口仍存在。文件/world-write、owner、macOS ACL、项目路径等拒绝规则继续生效。请使用本机实际绝对路径；Homebrew 示例不是白名单。

若已有 CE 配置或运行中的 Tunnel，修改前先遵循第 5 步的现有安装注意事项。专用 Host 前缀、tarball 安装和源码开发见[专题文档](#10-专题文档)。

## 4. 准备 Native

在 **Pi TUI** 执行：

```text
/ce-native status
```

若状态为 `MISSING`，显式安装固定信任版本的 Native 驱动：

```text
/ce-native install
```

成功条件：命令报告可信版本已安装并选定。**正常退出 Pi，再从已设置环境变量的系统终端重新启动。** 安装后需要重启 Pi，不能用 `/reload` 替代这一步。在重启后的 Pi TUI 执行：

```text
/ce-native verify
/ce-tunnel doctor
```

成功条件：Native 显示 `READY` / `CE_NATIVE_READY`。Doctor 分别检查 host Node、MCP child Node 与 client 路径信任，不启动 client，也不测试云端认证。Start 前先处理缺少或不可信可执行文件的诊断，详见[client 路径检查](tunnel-setup.zh-CN.md#client-安装与只读诊断)。

Native 是唯一的默认持久化驱动。缺失或不可信时，Pi 和管理命令仍可用，Store、消息操作和 Tunnel Start 会拒绝。CE 不会自动下载、修复、升级或回退。遇到 `UNTRUSTED` 等状态时，按 [Native 管理](native-management.zh-CN.md)处理；不要删除 Store 或改选兼容驱动来绕过拒绝。

## 5. 配置 Tunnel

从 Setup 到激活和首次交换，始终使用**同一个 Pi Session**。新 Session 是不同的身份。

现有安装应先执行 `/ce-tunnel stop`，再用 `/ce-tunnel status` 核实 `STOPPED`。若当前 Pi Session 持有旧 CE binding，修改配置前先 `/ce-tunnel deactivate` 并确认正常释放。`UNKNOWN` 不等于已停止，应按 [Tunnel 排障](tunnel-setup.zh-CN.md)调查。全新安装、没有旧 binding 或 transport 时可跳过这些清理动作。

在 **Pi TUI** 执行：

```text
/ce-tunnel setup
```

1. 输入真实 Tunnel ID，按需填写 Organization ID。获准使用的凭据只在 masked 输入中填写。现有配置可选 **Keep existing credential**。
2. 在 Review 选择 **Back · Edit configuration → Advanced · Messaging (ChatGPT ↔ Pi) → Authorize messaging for this session**。
3. 核对当前 Pi Session 及配对 `chatgpt/main` ↔ `pi/main`。此动作授权两端互发消息，并在**两端开启 payload read 和 ACK**，同时用 Pi Endpoint 替换 Advanced recipient list。只有确实需要这些权限时才继续。
4. 选择 **Back · Review → Review**，核对提议，按提示确认身份或路由变化，最后选 **Save configuration**。

成功条件：CE 报告 configuration saved 和 Messaging configured。只保存传输设置会保留 `recipients: []`，不能发消息。Save 不激活 Endpoint、不启动 Tunnel，也不读收件箱。

仍在 **Pi TUI** 中加载已保存的策略并显式绑定此 Session：

```text
/reload
/ce-tunnel activate
/ce-status
```

在激活对话框中核对两个 Endpoint、Store/Exchange 与权限，再选择 **Activate current session**。成功条件：显示 `Pi messaging bound`（或 already bound），随后 `/ce-status` 显示 `endpoint=pi/main`、`registered=true`、`lease=ACTIVE`。

首次 reload 可能在显式激活前报告缺少 mapping。若激活界面出现 **Release current binding for policy reload**，说明选定策略尚未加载：按该提示释放，执行 `/reload`，再显式激活。释放结果未知、持久化失败或已有 Owner 时应调查，不要连续激活或删除 Store。激活不会接管 Owner，也不启动 Tunnel。

## 6. 连接 ChatGPT

在 **ChatGPT / Platform 网页**按[自定义 MCP 设置指南](https://developers.openai.com/api/docs/guides/custom-mcp-server)创建使用 **Tunnel** 的自定义 MCP 连接，选择同一个 Tunnel ID 和获准的 organization/workspace。核对认证与权限，在当前对话安装或选中插件；配置变更后刷新工具。Tunnel 路线无需安装 Desktop stdio 插件。

确认真实运行窗口及可能产生的费用后，在 **Pi TUI** 执行：

```text
/ce-tunnel start
/ce-tunnel status
```

成功条件：status 最终测得 `CONNECTED`。Start 初期可能显示 `STARTING`，用 status 或 Manager Refresh 观察进度，不要再次 Start 来强行就绪。遇到 `DEGRADED` / `UNKNOWN` 时按 [Tunnel 指南](tunnel-setup.zh-CN.md)排查。

在 **ChatGPT** 刷新或选中连接，确认除 `ping` 外还可见 `ce_send`、`ce_inbox_list`、`ce_read_payload`，以及按上述授权启用的 `ce_ack`。Ping 或 `CONNECTED` 不能单独证明消息可用。若只见 ping，按 [Tunnel 设置](tunnel-setup.zh-CN.md)核对连接和已加载的 binding。

## 7. 发送第一条消息

以下示例仅适用于**上述单配对 Setup**。源码核对确认 `pi/main`、`chatgpt/main` 是生成的 Endpoint ID。`ce_send.to` 接受配置中的**精确 Endpoint ID**，不接受额外 adapter 前缀、Session ID 或文件路径。不要向 `pi:pi/main`、`chatgpt:chatgpt/main` 发送。Advanced Recipients 编辑器的 `adapter:endpointId` 是另一种配置格式。若使用其他已注册配对，应填写其实际获准的 Endpoint ID。

以下 JSON 是工具参数示例，不是 slash command 或 shell 命令。请在指定应用中要求模型调用工具，并授权发送及具体的正文读取。每次手动验证都将 key 中的 `RUN_NONCE` 换成新值；保留每次逻辑发送的 key 和返回的 Message ID，便于对账。

### ChatGPT → Pi

在 **ChatGPT** 中要求调用一次 `ce_send`，参数为：

```json
{"to":"pi/main","text":"Hello from ChatGPT. Please reply with a short greeting; do not run any other actions.","idempotencyKey":"first-c2p-RUN_NONCE"}
```

成功条件：`CREATED` 返回 `messageId` 和 audit sequence。`REPLAYED` 指向已有 Message。两者都只是本地 Store 结果，接下来还要观察收件端。

在 **Pi** 中明确要求用 `ce_inbox_list` 查询一页：

```json
{"pageSize":10,"rawScanLimit":100}
```

从发送或 list 结果中选择本次测试的精确 `messageId`。Pi 可先用 `ce_read` 查看元数据，再授权 Pi 对该 ID 调用 `ce_read_payload`：

```json
{"messageId":"MESSAGE_ID_FROM_THIS_RUN"}
```

成功条件：Pi 读到 ChatGPT 发出的原样问候。正文会进入当前模型，也可能留在对话历史中；它是不可信数据，不授予执行指令的权限。List 和 read 都不消费消息，也不记录 ACK。

### Pi → ChatGPT

在 **Pi** 中另行授权用 `ce_send` 回复：

```json
{"to":"chatgpt/main","text":"Hello from Pi. I received the test greeting.","idempotencyKey":"first-p2c-RUN_NONCE"}
```

在 **ChatGPT** 中明确调用 `ce_inbox_list`，使用相同的分页参数，选择回复的精确 ID，再授权 `ce_read_payload` 读取。MCP 没有 Pi 上的 metadata-only `ce_read` 工具。成功条件：ChatGPT 读到 Pi 的原样回复。ChatGPT inbox 由配置的 Endpoint 共享，不隔离对话；不要自动排空分页或读取无关消息。

### 可选：接收回执

若还授权 `ce_ack`，从成功的 payload read 中逐字复制四个字段：`messageId`、`payloadDigest`、`payloadLength`、`messageCreatedAuditSequence`。Pi 会显示 **ACK input metadata (reception only)**。ChatGPT/MCP 的 read 结果将创建序号命名为 `auditSequence`，须原样填入 ACK 的 `messageCreatedAuditSequence`。不要自行计算或猜测，详见 [ACK 契约](delivery-ack-contract.zh-CN.md)。

ACK 只记录接收回执，不证明送达、已读、处理或任务完成。缺 ACK、超时或结果未知都不授权再次发送、换 key 重发，或把 `DELIVERY_UNKNOWN` 改成 `CANCELLED`。CE 不承诺 exactly-once delivery/execution。保留原 key/Message ID，先查持久证据再决定下一步。

## 8. 验证并停止

记录本轮两次发送的 Message ID 及各自获准的正文读取结果。两端都读到原样问候，才构成你本次首次交换的证据。配置、本地测试、ping 和传输健康不能替代它。本指南维护时**未执行**这项真实 Cloud 交换。

运行窗口结束前，在 **Pi TUI** 执行：

```text
/ce-tunnel stop
/ce-tunnel status
```

成功条件：自己拥有的 transport 被测得为 `STOPPED`。关闭 Manager 或退出 Pi **不会**停止 detached client。Stop 仅作用于 CE 能证明自己拥有的进程。退出未确认或状态为 `UNKNOWN` 时应调查，不要当作已停止，也不要批量 kill 无关进程。

如需同时释放本地 Pi messaging binding，再执行 `/ce-tunnel deactivate` 并确认。它保留注册和历史，本身不停止 transport。用 `/ce-status` 确认 no endpoint bound；下次使用需显式激活。

## 9. 故障排查

| 现象 | 下一步 |
|---|---|
| `/ce-native` 或 `/ce-tunnel` 不存在 | 检查 `pi list`、精确版本及选中的 Pi 安装；重启或 reload 该 Host，不要加载第二份扩展。 |
| Native 缺失或未就绪 | 按第 4 步及 [Native 管理](native-management.zh-CN.md)处理；安装后重启，修复需显式确认。 |
| Doctor 拒绝 host/child/client | 按[client 路径检查](tunnel-setup.zh-CN.md#client-安装与只读诊断)修正父进程环境。0.2.2 可显式选择用户管理的 Homebrew client；自动发现仍严格。不要为满足 CE 修改 Homebrew 权限或 ACL。 |
| No endpoint bound / `CE_HOST_MAPPING_INVALID` | 确认 Setup 授权了此 Session，reload 策略后显式激活。旧 mapping、外来 mapping 或释放未知时按[恢复指引](tunnel-setup.zh-CN.md)处理，不手改标识。 |
| `CE_HOST_ENDPOINT_NOT_ALLOWED` | 将 `to` 与配置中的精确 Endpoint ID 比较；不要加 adapter 前缀或自造收件人。 |
| 缺少 payload/ACK 工具 | 确认 Setup 权限、Pi reload 和新 Tunnel MCP binding，刷新 ChatGPT 工具；现有连接需单独 Stop/核实，再 Start。 |
| Start 拒绝或始终未到 `CONNECTED` | 查看 `/ce-tunnel doctor`、`/ce-tunnel status` 和 [Tunnel 排障](tunnel-setup.zh-CN.md)；云凭据/权限与路径信任分别检查。 |
| 超时、`CE_HOST_UNCERTAIN` 或缺 ACK | 保留原 key/Message ID，重试前先查证据，不换 key 重发。 |

## 10. 专题文档

- [Native 管理](native-management.zh-CN.md)：就绪状态、显式安装/修复和信任边界。
- [Tunnel 设置与恢复](tunnel-setup.zh-CN.md)：路径检查、现有 profile、生命周期和拒绝码。
- [多 Pi Session](multi-session-usage.zh-CN.md)与 [Pi 工具](../pi-extension/README.zh-CN.md)：注册及完整工具契约。
- [运行时支持](runtime-support.zh-CN.md)、[运维与源码开发](operations.zh-CN.md)、[安全](storage-security.zh-CN.md)。
- [独立 Host / tarball 安装](independent-install.zh-CN.md)：当前0.2.1 替代路线，下方单独保留历史0.2.0 记录。
- [Desktop stdio 安装](chatgpt-installation.zh-CN.md)：有独立前提的本地 MCP 路线。
