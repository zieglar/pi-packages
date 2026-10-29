[English](source-reuse-audit.md) | [简体中文](source-reuse-audit.zh-CN.md)

> 历史审计记录。以下结论针对固定来源及当时阶段，不代表当前支持或发布资格。

# 源码复用审计：冻结结论（PH-0002，2026-10-06）

本文件冻结 PH-0002 架构修正采用的受控审计结论。完整只读审计报告（pin、integrity hash、逐行证据）随父会话制品保存；没有把这些来源复制到本包，也没有新增依赖。所有来源均为 MIT 许可，没有许可证阻塞。

## 可复现来源 pin

- `pi-intercom@0.16.1`：[npm 源码归档](https://registry.npmjs.org/pi-intercom/-/pi-intercom-0.16.1.tgz)，SHA-256 `9e109e9bde5b0caada2f79f157a1d864501b62c576e44d28150396078c6241c6`。完整 `LICENSE`：MIT，copyright 2026 Nico Bailon。npm 元数据无 repository URL；归档才是来源 pin，不假设 GitHub 仓库。
- `remote-pi`：[上游](https://github.com/jacobaraujo7/remote_pi)，审计提交 `79bbea2b9f6aee7e21dce344a0d4e3a7add50467`。根目录和扩展 LICENSE 均为 MIT，copyright 2026 Jacob Moura。npm 0.7.0 是较早制品（发布提交 `c6e3a3b607ffbc18fe447550865af37a1253b060`），SHA-256 `6212263034bbef33f1703a64a5a14f8470f2031a88d958c00e62234a6ec420a3`。下文行号指向审计提交，不是 npm dist。
- `@nicknisi/pi-relay@0.4.0`：[上游源码](https://github.com/nicknisi/pi-extensions/tree/main/packages/relay)、[固定归档](https://registry.npmjs.org/@nicknisi/pi-relay/-/pi-relay-0.4.0.tgz)，SHA-256 `30e59ffa7b85d06df613ddadbe86e2dda403a2133c29dcfdb36dca06cd26d261`，MIT。
- 官方 Pi：分发 `@earendil-works/pi-coding-agent@0.86.1`，`examples/extensions/handoff.ts:92,177–196`；API 文档为 `docs/extensions.md`。另检查了已安装 0.85.1，没有与 0.86.1 混淆。

## 重点实现证据

### pi-intercom

- Discovery：broker 注册/roster 和 presence 广播；精确 ID、前缀或唯一 alias 寻址，拒绝歧义名称（`types.ts:145,174–176`、`broker/broker.ts:806`、`index.ts:1588`）。
- Identity：稳定的扩展 claim/config/env fallback，然后 session ID（`index.ts:556`）；注册时生成新 endpoint epoch，发送绑定 epoch（`broker/broker.ts:470,651–674`）。仅运行时 fallback alias 不是 resume identity。
- Injection：公开 `sendMessage` 和 idle `sendUserMessage`（`index.ts:1289–1304`）；没有 terminal/PTY 注入。接收方 `received/acknowledged/injected` receipt 区分 socket/queue 接收与注入，但不证明执行或 settlement（`types.ts:100–106`）。
- Correlation：message ID、replyTo/ask edge/retryOf/supersedes（`types.ts:84–113`、`reply-tracker.ts:44–70`）。发送方 fingerprint dedupe 位于 broker 内存，限 4096 条/一小时（`broker/broker.ts:46–47,1076–1110`）；接收方 seen ID 也仅在内存（`index.ts:699–721,1368–1370`）。queued mail 仅在内存；pending ask 和已发送 session entry 会持久化（`broker/broker.ts:1213–1240`、`index.ts:1805,2280–2286`），不构成持久 inbox。
- Herdr：基于实时 snapshot 的位置（`herdr-location.ts:36–58`）；采用 `ssh-asserted` 信任的远程 SSH relay（`cross-machine-transport.ts:78–113`）。这是可选能力，不是协议依赖。
- Composition：文档化扩展 event API 有 discovery/pubsub/owner/CAS 和 outbox（`extension-api.ts:19–98`）。outbox request 按 ID 关联，但 timeout/session-end 错误泛化为失败（`index.ts:1195–1257`）。目标在本扩展能应用自身持久 receiver fencing/dedupe 前已注入。没有发布独立 broker-client library export；默认扩展为单体。仅 discovery 的组合仍可行。

### remote-pi

- UDS/named-pipe broker，register/list peer 和 cwd@name alias（`pi-extension/src/session/{ipc.ts:39–49,broker.ts:333–397,604–624}`）。UUIDv7 envelope ID 加 reply correlation（`envelope.ts:7–13,65–88`）。
- ACK `received` 在 `socket.write` 后发生（`broker.ts:539–553,588–602`），不是接收方接收或执行。接收方 pending mesh buffer 在内存中，经公开 `sendMessage` 排空（`src/index.ts:4132–4179`）。
- 没有 message idempotency/dedupe 或持久 inbox。audit append 为 best-effort，不用于恢复 replay（`broker.ts:646–673`）。发送工具允许 LLM 决定 timeout retry（`tools.ts:31–46`）；没有 unknown quarantine。
- 可参考 envelope framing、跨平台 IPC、join-or-lead 和 router boundary。没有稳定导出的 transport library；deep import 会绑定变动内部实现。daemon/RPC/mobile/hosted-relay 功能不是本项目所需，也不会安装。

### 官方 handoff 和 pi-relay

- 官方 handoff 是 TUI 上下文摘要、newSession 和 editor draft，不是 mailbox、transport、现有 session discovery 或 delivery ACK。
- Relay 的公开 `./core` export 与单体有实质区别（`package.json`、`core.ts:221–228`）。mailbox claim/精确 ID ACK/uncertain receipt 值得参考（`mailbox.ts:1–23`）。但 `index.ts:268–299` 捕获 injection 错误后尝试 steer/followUp/fallback；claim recovery 本身不能证明第一次 attempt 无效果。不能把此路径当作歧义后保证不重试的实现。

## 结论

| 来源 | 审计版本 | 结论 |
| --- | --- | --- |
| `pi-intercom` | 0.16.1（npm 归档，固定 integrity） | REFERENCE_ONLY |
| 官方 Pi handoff 示例（`examples/extensions/handoff.ts`） | 实际用户运行时 0.86.1（文档化 mise 安装路径）；子审计也覆盖已安装 0.85.1，刻意区分版本 | REFERENCE_ONLY（new-session/editor-draft 模式；现有 session injection API 证据来自官方 `extensions.md`） |
| `@nicknisi/pi-relay` | 0.4.0 | REFERENCE_ONLY（最强设计参考） |
| `remote-pi` | npm 0.7.0 / 仓库固定 SHA（快速变化；HEAD ≠ npm 制品） | REFERENCE_ONLY |

## 未宣称组合可用的原因

这些通信插件的决定性问题相同：它们都没有提供一个 seam，让本项目的持久 dedupe、lease fencing 和显式不重试决策在其自身 injection/retry 机制之前执行。内存状态、不同 ID 格式、socket 级 ACK 等次要事实记录如下，但不是拒绝依据；单独任何一项都不足以排除组合。

- pi-intercom 0.16.1 提供进程内扩展 bus，含 discovery（`listSessions`）、通用 pub/sub、owner election、epoch-fenced CAS commit 和 outbox。outbox 从自己的内存 dedupe 自动注入 `sendMessage`/`sendUserMessage`，没有钩子让本项目的持久 dispatch-start attempt record 和 lease fencing 先保护注入；outbox timeout 和 session-end 以泛化、不透明失败出现，不是相关联的 delivered/ambiguous/failed 证据。其 broker 幂等和去重在内存中（重启丢失），身份格式也不同；这些是事实，不是拒绝依据。仅 discovery 的组合（利用已安装 intercom）仍可能后续增加，本项目不依赖它。
- 官方 handoff 示例（`examples/extensions/handoff.ts`，在实际用户运行时 0.86.1 的文档化 mise 路径读取；子审计也覆盖已安装 0.85.1，版本刻意标明）：示例是 NEW-session 流程，摘要当前 session、编辑草稿、带 parent tracking 的 `newSession`。它不是现有 session injection 证据。公开 injection API（`pi.sendMessage` 的 `deliverAs`/`triggerTurn`、`pi.sendUserMessage`、session identity、`appendEntry`）证据来自在 0.86.1 验证的官方 `extensions.md`。这里只用该示例证明 new-session 模式和 editor-draft 流程。
- pi-relay 0.4.0 发布了不依赖 Pi 的持久 core（claim/ACK/requeue/recover、精确 ID dedupe、`uncertain`-never-delivered receipt），是最接近本项目隔离设计的先例。但其 delivery ladder（steer → follow-up → fallback）在 catch-all handler 和 claim recovery 内重试，这些路径可能有它无法核对的副作用。因此不能宣称组合能保留本项目 fail-closed 不重试隔离；它不符合本项目意义上的 fail-closed，也未宣称它能完全确定无效果。
- remote-pi（npm 0.7.0 / 仓库固定 SHA）：broker 在 socket write 后返回的 ACK（`received`）表示传输接收，不是运行时接收；这是语义事实，单独不是拒绝依据。拒绝原因是其 injection 路径（经 `sendMessage` 排空的内存 pending mesh buffer）没有 seam 让本项目持久 dedupe/fencing/no-retry 先运行，且重试决策交给发送 LLM。message 路径无幂等/去重、ID/寻址格式不同，也只是事实。其清楚的 transport seam（envelope framing、UDS join-or-lead、router injection boundary）仅作为设计参考。

## 采用的模式（不是代码）

区分 accepted/executed 的 receipt ladder；content-fingerprint 幂等；fencing-token key；显式 `ambiguous` outcome 和先调查后重发；audit line 使用摘要/长度，不写原始 body。避免仅内存 delivery state、不透明 timeout error 和 LLM 自主 retry。

## 冻结限制

- 公开 Pi API 可用是必要条件，不是相关联的持久 acceptance 或 settlement 证明。只有经 core rule 记录的 attempt-correlated evidence 才能推进 Message 生命周期。
- 真实客户端产品验收（ChatGPT 或其他）仍 NOT_RUN，见归档 [phase-0-evidence.md](phase-0-evidence.zh-CN.md)。
- PH-0001 的 ChatGPT support/tunnel/Work-chat、公开 owning-session API、RPC 拒绝和“无需 Moshi/Herdr”结论在归档证据中原样保留，没有重新调查。
