# 恢复原 Pi 会话

已注册的 native Pi Session 会在 startup、resume 和 reload 时自动核验自己的 CE 绑定。使用原 Session 文件启动：

```sh
pi --session /absolute/path/to/original-session.jsonl
```

无需单独执行 recover 命令，也无需再次确认恢复。对话分支和上下文压缩不会改变 native Session 的 CE 生命周期；完整追加历史决定最新绑定。新建或 fork 一个 native Session 会改变身份，不能恢复原注册。

## 绑定行为

- 原绑定仍有有效的同一 ACTIVE Owner 时，走普通 Host resume，保留 CE Session 和 fencing token。
- 正常退出会记录退出意图。再次启动同一 native Session 时，可通过普通 `requireUnowned` admission，为原 Endpoint、Participant 和 Exchange 建立新的 CE Session。
- 主动停用 messaging 后保持 Detached，直到使用现有 Activate/Connect 流程。没有意图字段的旧 release 记录也要求显式激活。
- 首次修复旧的持久化 lifecycle 失败时，要求原 mapping 唯一、匹配的失败记录完整、当前 live-session v2 注册有效、完整历史已落盘，且没有旧 recovery journal。修复保留原身份和历史，建立新的 CE Session。

所有路径仍须通过当前 policy、process mutex 和 Host 检查。journal 只记录诊断证据，不授予权限。共享 transport 独立管理；恢复 Pi 绑定不会启动 transport。

## 何时需要离线维护

自动恢复不会接管 Owner，也不会处理遗留 mutex。尚存的 active/expired Owner、未 reconciliation 的 mutex、进程失败锁存、无效历史或结果未知的 attempt，都会阻止恢复。反复 reload 不能清除进程失败。

维护前记录 native Session ID/文件、Endpoint、Participant、Exchange、旧 CE Session、Owner fence 和完整 lease term。备份 Session 文件、配置/策略和一致 SQLite 快照。日志中不要输出凭据、capability 或消息正文。

为所有能打开该 Store 或获取该 mutex scope 的进程协调维护窗口，包括其他 Pi 会话、MCP child、heartbeat、后台 launcher 和自动重启任务。停止共享 transport 会影响其他会话；发送协调消息不证明对方已接收或同意。

1. 停止相关进程并抑制自动重启，独立确认原 mutex Owner PID 已死亡。即使 CE lease 已过期，PID 仍存活也会被拒绝。
2. 按[现有 mutex 操作说明](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复)，使用 `scripts/reconcile-session-process-mutex.mjs`，核验精确 scope、slot、PID/birth、owner bytes SHA256 和 Store/slot/owner 的 dev/inode。不要删除 marker 或手写 release receipt。
3. 按[过期 Owner 恢复说明](chatgpt-installation.zh-CN.md#显式-stale-ownership-恢复)，使用 `scripts/recover-stale-ownership.mjs`。操作者配置必须指向原 Pi adapter 和 Endpoint；`chatgpt/main` binding 对应另一个 Participant。传入重新核验的完整 Owner tuple，保存 receipt，并确认最终 UNOWNED、fencing high-water 增加、临时 recovery Session 已 DETACHED。
4. 遇到拒绝、证据变化或结果未知时停止检查。这些工具检查不同边界，不共享事务；不要靠重复执行判断未知结果。

完成已授权的清理后，加载已验证的扩展并恢复同一 native Session。符合条件的恢复会在启动时执行。原注册、Session 文件、消息、失败记录、policy chain 和 mutex 历史均保留。

## 持久化与中断

恢复首先只读确认原 Participant、Exchange 和 membership 仍存在，且与当前策略一致。已知 Owner 或 mutex 尚未清理时，在记录 attempt 前拒绝。普通 mutex admission 成功后，先持久化并校验 repair attempt，再执行 Host authority 写入；新 ACTIVE mapping 和精确 resolution 均落盘后才显示 Attached。

扩展通过同一个 regular-file descriptor，核对完整 JSON 持久历史与真实 native Session 文件。未落盘、坏行、部分行、意外追加、截断或文件替换均会拒绝。文件同步不构成硬件或断电持久性的保证。

未完成的 attempt 会阻止该 native Session 的自动重试与显式 Activate/Connect；无效 journal 或其他 Endpoint 的失败同样阻止这两条路径，需要单独人工调查，不能靠重新激活绕过。完整且匹配的 commit 只支持后续普通重新核验。后续失败以及当前进程或全局失败锁存仍会拒绝；UNOWNED 本身不能消除未知写入结果。恢复不删除失败标记或改写 Session 历史，对话回退也不能隐藏已提交的绑定或未完成 attempt。

## 验收

核实原 native Session、Endpoint、Participant、Exchange，以及真实的 `Current Session Attached`。修复后的绑定还须确认新的 CE Session 和增加的 fencing。验证 heartbeat、reload 连续性、正常退出后重新启动，以及主动停用行为。

按既有授权验证真实 send、inbox、payload read 和 ACK，再验证所需 Hook 行为。ACK 只记录接收；transport Connected、UI Attached 和隔离测试通过，都不能代替原 Session 的消息与 Hook 验收。
