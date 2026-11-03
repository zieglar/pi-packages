# Live Session Connect

live 模式让每个可信的原生 Pi Session 使用稳定、独立授权的 Endpoint，同时共享现有 ChatGPT peer 和受管理的 Tunnel。只有显式选中的 `ce-live-session-v1` launch descriptor 才会启用此模式。它不修改 Protocol、Store schema、Owner 恢复规则或任务完成权限。参见[架构](architecture.md)和[原有多会话使用说明](multi-session-usage.zh-CN.md)。

## 显式迁移到 live 模式

`/ce-tunnel migrate-live` 是独立的高级离线操作，Connect 不会自动执行它。先关闭本地 binding，并停止所有 legacy writer。命令要求 Native readiness、明确确认、精确的当前 Profile revision，以及 Manager 验证通过的 STOPPED configuration lock。迁移创建新的私有策略链并发布不可变的 launch reference，不执行 Stop 或 Start。完成后显式 reload Pi。失败或持久化结果不确定时应先核查，不能自动重试。

legacy `ce-multi-session-v1` 保持原行为：首次 onboarding 注册仍为 payload read=false、ACK=false；已有注册直接返回 ready，不修改 consent；配置与激活仍要求 STOPPED lock，并按原流程显式 reload、Stop/Start。legacy Disconnect 可能停止共享 Tunnel，应阅读确认内容。

## 在各自 Session 中 Connect

在目标原生 Pi Session 内运行 `/ce-tunnel connect`。首次 live 注册，或将当前 Session 尚未启用的 read/ACK 升级时，确认框会展示精确 Endpoint、Store、Exchange 和 peer。接受后为当前 Session 启用 payload read 和 ACK；ACK 只表示接收确认。新注册没有 Hooks。此前独立授权的 Hooks 保持不变，消息授权不启用 Hook，也不执行任务。

确认框明确披露：配置的 peer 可见精确 Endpoint 标签。即使不披露可选 presence，真实首次 send 的结果也可能暴露 first join 或可寻址状态变化。另一个独立、可拒绝的确认覆盖 Exchange membership/first join 以及当前 Owner/lease 活跃状态。拒绝此项会让依赖 presence 的 discovery 状态保持 unknown。有效的 true/true 注册复用已有权限，不重复请求消息 consent，也不会悄悄启用 presence。Connect 不恢复已撤销注册。

拒绝消息 consent 不写入注册。等待确认期间，Session、环境、所选 Profile 或策略变化会阻止继续操作。存在未解决的发布记录时拒绝再次发布；提交后的取消不抹除已提交 grants。结果未知时不会自动 rebase、重发、接管或恢复。

发布只保存配置，不代表 binding。factory 需要加载新 grants 时，Connect 使用 Pi 官方 reload，再重新核对同一 Session 和策略。binding 只使用当前 Session 的投影；已有 Owner 会被拒绝，复制 Session ID 不能认领另一个会话。live 发布与激活无需停止兼容且正在运行的共享 transport。对已停止的 transport，启动仍需精确 Profile/client/script/credential-reference scope 的显式许可。记住选择不等于获得许可，scope 变化须重新确认。Connect 可以启动已获许可且停止的 transport，或复用经过身份验证的现有 run。transport 健康本身不能证明 MCP 已采用策略或消息已就绪。

live 模式的 `/ce-tunnel disconnect` 只关闭并释放当前 Pi binding，保留注册、grants 和历史，其他 Owner 与共享 Tunnel 不变。`/ce-tunnel stop` 是独立的高级共享 transport 操作。释放结果未知时继续 fail-closed，Connect 不自动修复。

## 选择精确接收者

可选、仅限 live 的 MCP 工具 `ce_endpoints` 接受空对象，返回调用者自身 identity/有效操作布尔值，以及当前获准发送的精确目标标签。composition 在观察前完成过滤，不暴露原生 Session ID、其他 Endpoint 的 read/ACK/Hooks 权限、隐藏目标数量或任意标签探测接口。Pi 未接入 discovery port 时，`/ce-tunnel liveSessions` 只报告当前调用者自身 identity，不枚举完整注册表。

discovery 是参考信息，实际 send 每次重新授权。`ce_send.to` 必须使用用户打算发送的精确标签。只有用户明确要回复该会话时，才可沿用来信 sender；存在歧义时应让用户选择目标。服务器验证精确寻址权限，不能证明用户意图。当前没有签名目标选择凭证，不按最新 Session 推断、不回退到 `pi/main`，也不自动重定向。共享 `chatgpt/main` inbox 不隔离不同 ChatGPT 对话。

| 状态 | 含义与边界 |
| --- | --- |
| Registered | 当前策略中的有效注册，不代表已加入 Exchange、存在 Owner 或正在处理消息。 |
| Authorized | 当前调用者具有该操作/接收者 grant，仍须通过最终 Host/Storage 检查。 |
| Active | 对当前 Owner、ATTACHED Session 和 ACTIVE lease 的参考观察，明确区分 false 与 unknown。 |
| Reachable | 在已采用策略及服务中的 transport 下可持久寻址的参考状态，包含 membership 条件，与接收者是否正在处理消息分开。 |

Active 与 Reachable 使用 `true`、`false`、`unknown`。拒绝 presence 会遮蔽依赖 membership 的信息；缺失或过期证据、策略变化、观察不确定均不能当作成功。进入 terminal blocked 状态的 MCP port 不会因为 transport 健康或后来新增注册而恢复就绪。注册、授权、活跃 lease、可达、本地 Message 持久化、云端投递、ACK/Receipt 和业务任务完成各自需要证据。discovery 不执行 send、join、renew、payload read 或 Hook。

## 观察与恢复限制

精确运行子进程观察依赖 managed run identity、进程祖先与启动身份、launch identity，以及新鲜的 bound-port/Owner 证据。真实进程观察路径目前仅有 macOS 测试证据；代码支持 Linux 不等于已完成该平台验证。包含空白的路径和无法消除 argv 歧义的 wrapper 保持 UNVERIFIED。仅有 PID、最近写入的文件或 CONNECTED 状态不够；没有新鲜 attestation 就应报告 UNVERIFIED，不能推断云端投递或重启其他 Session 的 runtime。本文不声称真实云端 A/B、安装验收、ACCEPT 或 CLOSED。

策略链使用不可变的排他 next-slot 发布，sequence 上限为 65,536，历史总量上限 64 MiB，单个策略文件上限 65,536 bytes。每个原生 Session 的发布 reconciliation 最多处理 1,024 个 intent locator。达到上限会拒绝新写入，不自动压缩历史。operation-ID locator 用于区分已观察到的发布、竞争提交和未解决尝试。已提交历史缺少其必需 locator 可以被检测；同一 OS 用户删除尚未提交的 locator 后，新进程可能没有证据可查。私有文件权限与 watermark 不是防篡改存储、锁或 exactly-once 保证。持久化未知不允许自动重试或倒退历史。

策略链前进后，选择旧 manifest 或删除历史可能恢复已撤销注册和旧 grants。回退需要单独审查的离线迁移，在停止并验证所有 writer 后，保留当前事实、撤销记录、epoch 和 permission generation。不得将链指针倒退、删除 commit，或将二进制回退当作恢复 consent。本文不授权生产迁移、安装或发布。

## 本地验证

在 `packages/pi-chat-exchange` 中，使用仓库现有脚本及指定 Node 版本；本轮实现的聚焦证据使用 Node 24.21.0：

```sh
pnpm run build
pnpm run typecheck
pnpm test --maxWorkers=4 test/endpoints/pi/extension-live-connect.test.ts test/endpoints/pi/live-session-onboarding.test.ts test/endpoints/pi/extension-multi-session.test.ts
pnpm test --maxWorkers=4 test/tunnel/live-session-policy.test.ts test/tunnel/live-session-migration.test.ts test/tunnel/live-process-observation.test.ts test/tunnel/live-connection-status.test.ts test/control/mcp/endpoint-discovery.test.ts
```

package typecheck 不能代替实现审查中的 extension 独立类型检查。合成 Manager/Store 测试只证明实际覆盖的边界；真实 peer、安装、平台与云端验收仍需独立授权和证据。本地 commit/review 由父级工作流处理，上述命令不构成发布授权。

## 显式重新授权与诊断

`/ce-tunnel reauthorize <exactEndpoint> [--payload-read] [--ack]` 仅用于 live 模式，只能恢复当前原生 Session 自己的精确 tombstone Endpoint。Connect 和 register 不会恢复它。确认框展示 revoked epoch → epoch+1 及明确的 read/ACK 布尔值；可选 presence 独立确认，默认 false。通过省略 Hooks 字段保留此前独立授权的规则。旧 factory generation 在官方 reload 前继续被拒绝。重新授权不改变 Owner 或 capability，不执行 takeover：旧 Owner 仍被持有时须正常释放，已过期或状态不确定时须单独由 operator 恢复。撤销最后一个注册可能永久停止当前 MCP incarnation 的 renew；后来重新授权不会重启 heartbeat。

live Connect 在确认或 ready 复用前检查全局 MCP payload-read 和 ACK ceiling；任一关闭都须通过显式离线配置解决，不发布 Session grant。高级 register/reauthorize 只能请求 ceiling 允许的权限位，仍可显式创建 false/false 的 metadata-only 注册。被动加载 descriptor 不会启用 grants。

执行 `migrate-live` 前，legacy MCP 的全局 payload-read 与 ACK ceiling 必须都已启用，否则迁移在任何写入前拒绝，不能隐式扩大 launch grants。legacy fallback 仅适用于从未选中过、且不存在的 Profile。已选中的 Profile 丢失、不可读或不可用时，必须报告 unavailability 错误（S6），不能悄悄改用 legacy 默认值。unavailability 表示读取或访问边界失败；unknown 是观察结果，不证明对象不存在，也不授予权限。

dead-recorder observation 模块只提供诊断或测试证据，其记录不能作为 readiness 验收依据，也不能取代新鲜的 bound-port attestation。
