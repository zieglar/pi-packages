[English](multi-session-usage.md) | [简体中文](multi-session-usage.zh-CN.md)

# 一个 Tunnel，多个项目与 Pi Session

每个真实 Pi Session 使用独立、稳定的 Endpoint，例如 `pi/project-A` 与 `pi/project-B`。项目目录不是身份；同一个项目也可有多个 Session，必须分别注册。ChatGPT 侧 `chatgpt/main` 是明确共享的 inbox，**不是 ChatGPT 对话隔离**。

先完成 [Tunnel 首次设置](tunnel-setup.zh-CN.md)。下面的配置操作不发送/读取/ACK 消息，也不会自动启停 Tunnel。

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

本页不启用自动 Inbox polling、payload execution、ACK、重试或 Wake Bridge。真实消息与 ACK 每次仍需授权；本地配置/隔离测试不替代真实用户验收。更多见 [Pi 工具指南](../pi-extension/README.zh-CN.md)与[排障](tunnel-setup.zh-CN.md#故障排查先定位层再进行最小修复)。
