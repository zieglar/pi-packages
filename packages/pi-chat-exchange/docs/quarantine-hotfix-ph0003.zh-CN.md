[English](quarantine-hotfix-ph0003.md) | [简体中文](quarantine-hotfix-ph0003.zh-CN.md)

> 历史证据记录。以下行为、命令和验收限制描述当时的热修复，不代表当前支持范围。

# PH-0003 获准的隔离/disposition 热修复

## 冻结合同冲突和批准

基线：`main`、`5a84cb1721d87a6f324d4d288ce0beac3dda1579`，干净。PH-0003 要求保留“取消不能消除歧义”的约束。基线刻意允许仅凭 client owner-abandonment 和 reconciliation 文字进行 `DELIVERY_UNKNOWN -> CANCELLED`。`CANCELLED` 是完成状态，所以 `closeExchange` 随后允许 CLOSED，尽管 attempt 仍记录传输 `ambiguous`。所有者明确拒绝此例外，授权先独立有限修正，再恢复 endpoint 收敛。PH-0002 先前验收不构成对这次明确修订后例外的接受。

## RED 证据和根因

编辑前的原始最小回归：

```text
transition: CANCELLED
exchange: CLOSED
recordedTransport: ambiguous
1 test failed: expected CANCELLED to be DELIVERY_UNKNOWN
```

保留测试为 `test/core/ph0003-quarantine-stop.test.ts`；夹具保留，修正断言要求 `IllegalTransitionError`。原始复现和日志保留在 `/tmp/ph0003-source-audit/ph0003-quarantine-stop.test.ts` 和 `/tmp/ph0003-quarantine-stop-red.log`。等待授权前已移除临时测试并确认基线干净。

根因：`TRANSITION_REQUIREMENTS["DELIVERY_UNKNOWN>CANCELLED"]` 使用 `owner_abandons`；`assertEvidence` 只检查 `ReconciliationEvidence` 存在。其 `{ resolvedAt, basis }` 字段是调查元数据，不是相关联的无效果或运行时取消证明。意图因此被转成执行终态，再转成正常关闭资格。

批准后的回归 RED：生产编辑前，四个目标文件中 20 失败/35 通过（`/tmp/ph0003-hotfix-red.log`）。管理 API 合同断言因纯函数缺失而失败；原始转换/生命周期断言则针对实际漏洞失败。

要求扩大检查的取消评审还暴露矛盾事实：安全取消/requeue 中 `dispatch = not_attempted` 可覆盖非 pending 传输结果；运行时取消不要求一致的已启动 attempt；queued 取消忽略所提供的 started/ambiguous 证明。新增 RED：5 失败/1 通过（`/tmp/ph0003-cancellation-consistency-red.log`）。这些检查在获准的取消/隔离范围内修正，不是新实现阶段。

新增 helper 边界回归还捕获校验前解引用 null attempt（RED：1 失败/17 通过）。现在先校验再访问，通过 `ExchangeDispositionError` 拒绝畸形快照。

## 修正后的执行语义

- 移除 `owner_abandons`，完全禁止 UNKNOWN→CANCELLED。当前证据词汇无法建立安全直达路径。适配器、owner 或 reconciliation 文字均不能授权此转换。
- UNKNOWN→ACCEPTED/FAILED 仍只能依赖现有相关联事实证据及显式 reconciliation。没有 requeue/retry 出口。
- 无 attempt 的取消/requeue 必须同时满足 `not_attempted` 和 `pending`，并通过现有权威 fencing 检查。
- 运行时取消要求 started/delivered attempt 和独立关联的运行时 `cancelled` 证明。该证明只确立取消，不证明此前没有副作用或应用成功。
- queued 取消拒绝所提供的矛盾 dispatch 证据。后续宿主必须提供权威状态和完整 attempt 数据；不受信调用者省略数据不能证明无效果。

## 管理性放弃的区别

正常 `CLOSED` 保留 PH-0002 的全部消息完成前提，没有扩展或改变用途。为避免 owner 无限 reconciliation，独立不可变 ExchangeDisposition 记录 ABANDONED_UNRESOLVED。聚合在管理上不活跃，但 Exchange 快照仍 OPEN，未解决 Message 仍 DELIVERY_UNKNOWN。

纯 `archiveUnresolvedExchange` 合同保留：

- 原始 DELIVERY_UNKNOWN 和传输 `ambiguous`；
- 完整原始 started/ambiguous active-attempt 快照及其 endpoint、consumer、instance、fencing 信息；
- 永久 `unresolvedSideEffects: true`；
- 经认证、由宿主提供的 owner principal ID、时间、原因和 reconciliation/调查元数据。

它接受至少有一条隔离 Message、其余均完成且没有剩余在途活动的聚合。每条未解决 Message 必须恰有一条正确关联的 active attempt。外部/缺失/重复/矛盾记录、无效时间戳和不可变记录替换均被拒绝；精确 replay 允许。

管理意图不取消外部执行，也不停止其副作用。它停止后续协议活动，不创建 Result、不改变投递事实，也不宣称成功/失败且无效果/取消。没有新执行 outcome 或身份格式。后续 API/event/UI 必须把 disposition 与未解决事实一起展示，不能概括为已取消或已解决。disposition 自身是不可变管理审计记录；原因/调查文字是敏感存储元数据，不是原始诊断日志字段。运行时 Result 读取仍是可重复、不修改状态的历史观察。

`assertExchangeActive` 是后续宿主创建、claim 和修改路径的 admission 检查。现有转换/发布/关闭 helper 拒绝已提供的权威 disposition。宿主必须在事务内自行认证真实 principal，加载 disposition、当前状态、完整 Message 集和 active attempt。标签、调用者提供的 owner 文字或适配器省略 guard 均不能建立安全性。原子性、持久化和实际 control/API 强制执行刻意未实现。

## 验证和范围

GREEN：13 个文件、131/131，含保留的隔离回归、全部取消/关闭测试、disposition 测试、未变更的 11 项身份测试，以及必须构建的 stdio/内存 ping smoke。类型检查、构建、十个负向架构夹具、工作区和空白检查通过。Wayforge：51 个文件、438/438，后台任务 `<validation-task>`，退出码 0。Wayforge 源码无变化。

没有 SQLite/store/broker/network/daemon、Pi 或 ChatGPT delivery、完整 MCP operation、生产安装或新增依赖。`exchange_archive` 仅为可选权限声明，与正常关闭分开；未注册 MCP operation。身份/outcome 格式和 ping 行为不变。修正独立提交，没有 amend PH-0001/PH-0002，也没有推送。实际 SHA 和 Wayforge 证据记录在最终 PH-0003 报告中。
