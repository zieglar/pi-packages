[English](multi-session-usage.md) | [简体中文](multi-session-usage.zh-CN.md)

# 一个 Tunnel，多个项目与 Pi Session

每个真实 Pi Session 使用独立、稳定的 Endpoint，例如 `pi/project-A` 与 `pi/project-B`。项目目录不是身份；同一个项目也可有多个 Session，必须分别注册。ChatGPT 侧 `chatgpt/main` 是明确共享的 inbox，**不是 ChatGPT 对话隔离**。

先完成 [Tunnel 首次设置](tunnel-setup.zh-CN.md)。下面的配置操作不发送/读取/ACK 消息，也不会自动启停 Tunnel。

## Live 模式下加入新会话

在已选择 live 多会话策略的交互式 Pi 中，新会话启动时会询问是否连接到已配置的 ChatGPT 连接。选择连接后，继续确认消息权限和可选在线状态；扩展会生成该会话的内部地址并在需要时重载当前 Pi 扩展。新地址包含经过处理的项目目录名称，授权界面会显示该地址，已授权的对端可以看到它。已有共享 Tunnel 可以继续运行，无需手动填写地址或修改配置。拒绝时不会登记或连接，同一会话不会反复询问；以后仍可通过 `/ce` 中的 Connect 主动连接。

已连接的 Pi 会话中输入 `/ce`，选择在线且已同意披露在线状态的目标；菜单显示当前选择，并可进入连接与状态管理。选择属于整个 ChatGPT MCP 连接，使用该连接的所有 ChatGPT 对话共享，不能视为对话隔离。

告诉 ChatGPT 使用当前选择发送：它应先调用 `ce_endpoints` 获取 `selectedTarget.generation`，再以 `selectionVersion` 调用 `ce_send`。如果另一对话或 Pi 会话改变了选择，旧版本发送会被拒绝，需要重新查看并确认。目标离线、撤销或状态未知时也会拒绝，不会自动改投。已有使用精确 `to` 的调用仍可用；不要同时传入 `to` 和 `selectionVersion`。

目标选择只影响之后的发送，不更改既有消息或任务。新选择写入 live 策略；升级包含此功能的部署前，需确保使用同一策略的 Pi 扩展和 MCP 进程均能读取新版记录，否则旧进程会因无法识别记录而拒绝工作。

若自动桌面回复关联不可用，可在 ChatGPT 中要求列出收件箱，再明确选择并读取结果。此方式使用共享收件箱，不证明结果来自当前 ChatGPT 对话；应核对结果中提供的任务信息。

## 1. 从单 Session 显式转换

已有 single-session 配置可以继续使用，不必强制转换。需要多 Session 时：

1. 显式 `/ce-tunnel stop`，核实 transport **STOPPED**。ACTIVE/UNKNOWN 均拒绝转换，不自动 Stop。
2. 关闭所有旧 legacy Pi binding/runtime，或先更新并正常释放其 binding。旧二进制不能被新 revocation gates 约束，不能仅凭新配置就认为它们被撤销。
3. 当前旧 Session 可用 `/ce-tunnel deactivate` 确认正常解绑，不退出 Pi、不删历史、不停止 transport。未知释放停止操作，不“清理” Owner。
4. 从**未绑定**的交互 TUI 运行 `/ce-tunnel convert`；明确承认旧 runtime 限制并核对保留原 registration、Store、Exchange 与 grants。仍本地持有 legacy binding 时拒绝。

转换不创建新的默认宽权限，也不自动绑定保留的 legacy registration。

## 2. 在每个真实 Session 注册 Endpoint

从需要授权的那个 Pi Session 执行，Endpoint 必须与其他 Session 不同：

```text
/ce-tunnel register pi/project-B --payload-read --ack
```

- 仅注册当前可信 native Pi Session，不接受手填别的 Session ID；实际绑定仍需 reload 后显式 activate。
- `--payload-read` 与 `--ack` 独立可选，默认都 **off**；不要为了照抄示例就开启。
- 在确认前核对 Endpoint、当前 Session、Store、Exchange 与权限。
- register/revoke/convert 需 verified STOPPED transport；不会替你 Stop/Start，不要求重输原 credential。

使用不同项目时加载同一份扩展和同一所选 profile；不要在各项目初始化独立 Store 后期待自动路由。显式非空 `CE_ALLOWLIST` 保留 legacy 优先级，并阻止生成策略注册/转换。

## 3. 分别加载与激活

```text
/reload
/ce-tunnel activate
/ce-status
```

首次注册没有 CE mapping，reload 拒绝 `CE_HOST_MAPPING_INVALID` 可以是预期行为；随后显式 activate 并确认，以 requireUnowned 创建该 Session 的绑定。它不是 recovery，不接管已有 Owner，包括 expired Owner。

Pi grants 在 factory 加载时捕获，Save/register 不自动扩大旧运行时权限。MCP child 也需单独显式 `/ce-tunnel start`（此前已 Stop）读取所选 generation；不要把 Pi reload 视为远端 MCP reload。

`/ce-status` 中 native Pi Session 是 lookup，CE Session 是 Owner incarnation；Endpoint 是稳定消息 label，Participant 是 Exchange 中的参与者。lease/fencing 描述当前权威，不是 transport health。**Configured ≠ Pi-bound ≠ Connected ≠ 消息实证。**

## 4. 找到可用收件人

在当前已绑定、经授权的 multi-session runtime：

```text
/ce-tunnel sessions
```

它列出所选配置中 active 的精确 Endpoint IDs，可复制为 `ce_send.to`。它仍需当前 runtime、所载 registration epoch、current policy 与 process mutex 全部准入。未绑定、未加载、revoked、stale 或 uncertain 均拒绝，不列出其他目标。

该列表不读 Inbox，不证明 MCP child 已加载，也不证明消息已被接收；`to` 不使用 native/CE Session ID，不额外拼 adapter。ChatGPT 仍共享自己的历史/inbox，需操作者明确选择每次消息的收件 Endpoint。

请求被目标 Pi 接收后，`ce_receive_task` 会显示原始 Message ID。Pi 回复时在 `ce_send` 的 `replyTo` 填入该 ID；ChatGPT 可用 `ce_find_replies` 查询回复 ID，再按各 ID 读取内容。查询不读取正文、不消费消息，也不自动 ACK。结果每页最多 50 条；有更多结果时，将本页最后一条的 Message ID 作为 `afterMessageId` 继续查询。
请求记录创建时的目标 Owner。相同 CE Session 在有效 Owner 下恢复后可以继续回复；Endpoint 重新绑定到新的 CE Session 后，旧请求不会自动转交。迁移前的旧消息没有可验证的新关联。

### Pi `/new` 后发现新端点

在 live-policy 模式下，ChatGPT 可用已知旧收件端点查询现有只读工具，无需人工复制新 ID：

```json
{"name":"ce_endpoints","arguments":{"previousEndpointId":"pi/project-A"}}
```

只有旧侧 `session_shutdown/new` 与新侧 `session_start/new` 的文件身份相互对应，且新端点已独立注册，才可能返回 `sessionSwitch.status = "verified"` 和 `successorEndpointId`。关联描述切换事实，不代表权限继承、可达或已接收任务；仍需核对 `targets` 中注册、发送授权、活跃及可达状态，实际发送继续独立检查权限。空参数查询保留原投影。

双方 registration 必须允许 presence disclosure，且都在调用者可见范围内；只支持新 native UUID 的首次独立注册 incarnation，撤销再授权后返回 `unknown`。内存会话、文件身份或任一事件缺失、观察冲突、多个后继或查询期间策略变化也返回 `unknown`，不得靠名称、时间或活跃状态选择。新会话仍按现有流程单独授权；旧消息不自动 ACK、取消、迁移或重发，任务所有权不继承。

观察记录保存在所选 live-policy 的私有目录，只包含元数据和文件身份哈希，不读取 transcript。它信任现有本地扩展及同一 OS 用户，不是签名或对同用户恶意写入者的防护。本功能没有新增常驻服务，不修改 Hook、Task Ownership Guard 或 explicit-only 桌面策略。

## 5. 区分解绑、撤销、停止与 reload

| 操作 | 改变什么 | 不做什么 |
|---|---|---|
| `/ce-tunnel deactivate` | 确认后正常释放当前本地 CE Owner、detach 并停续租 | 不撤销 registration、不删历史、不 Stop Tunnel、不结束其他 Session |
| `/ce-tunnel revoke pi/project-B` | 确认后撤销一个确切稳定 registration 的后续准入，需 STOPPED | 不回滚已准入操作、不自动释放 durable Owner、不删消息 |
| `/ce-tunnel stop` | 停止可证明属于 Manager 的 transport 实例 | 不代表 Pi Owner 已释放或 registration 已撤销 |
| 有效 binding 的 `/reload` | 停旧 generation/drain，重验并 resume 原 durable mapping | 不创建额外 Owner、不自动 takeover |
| 已释放/未绑定 Session 的 `/reload` | 加载策略，仍不自动重绑 | 重新绑定须显式 activate；不能靠 reload 复活已结束 CE Session |

取消 deactivate 保留绑定；重复调用不重复 end。release/end 或证据持久化未知时保持 fail-closed，不把“无本地 handle”说成安全释放。正常退出/Session replacement 也走正常 end；正常 end/release 绕过 deny-only revocation 检查，便于安全归还权威。

撤销只挡之后新准入的操作（包括 reads/renew）；已准入操作可能完成。其他 registrations 和共享 ChatGPT 历史保留。重新授权使用 fresh epoch，旧 handle 仍拒绝。不要删旧注册/Owner/Store 来“重置”。

## 安全与恢复限制

process guard 只做本地 exclusion，不是 CE authority 或 crash recovery。旧 registration epoch 不能复用 reload handoff；不确定清理保留 marker 与 failure latch。append-only records 可累积，没有自动回收，即使进程已死也不自动接管。需要恢复时另行授权、核实精确 durable evidence。

### 恢复原 Pi 会话

startup、resume 和 reload 会根据完整持久历史，自动核验已注册 native Session 的绑定。分支或上下文压缩不会选回旧 CE 绑定。同一有效 Owner 走普通 resume；正常退出后可建立新的普通绑定，主动停用和没有意图字段的旧 release 则保持 Detached，直到 Activate/Connect。

首次修复历史失败要求当前 live-session v2 注册有效、原 mapping 唯一、匹配失败记录完整、完整历史已落盘，且没有旧 recovery journal。尚存的 active/expired Owner 和未 reconciliation 的 mutex 会在写入 repair attempt 前拒绝。完成已授权的离线维护，退出锁存失败的进程后恢复同一 native Session；无需 recover 命令或再次确认。

未完成 attempt、其他 Endpoint 的失败、后续失败和当前进程失败锁存仍会阻塞。完整 journal 不授予权限，当前 policy、普通 mutex 和 Host 检查仍然必需。保留原历史和 marker，共享 transport 独立管理。详见[原会话恢复操作说明](original-session-recovery.zh-CN.md)。

本页不启用自动 Inbox polling、payload execution、ACK、重试或 Wake Bridge。真实消息与 ACK 每次仍需授权；本地配置/隔离测试不替代真实用户验收。更多见 [Pi 工具指南](../pi-extension/README.zh-CN.md)与[排障](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复)。
