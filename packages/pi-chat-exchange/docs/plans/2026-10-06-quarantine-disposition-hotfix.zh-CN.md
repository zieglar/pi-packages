[English](./2026-10-06-quarantine-disposition-hotfix.md) | [简体中文](./2026-10-06-quarantine-disposition-hotfix.zh-CN.md)

> 历史计划（2026-10-06）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="quarantine-disposition-hotfix-implementation-plan"></a>

# Quarantine Disposition 热修复实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 修正 owner-abandonment 漏洞，不捏造执行事实、不改变身份，也不实现持久化 Host。

**架构：** 保留 Exchange `OPEN|CLOSED` 和现有的全部消息完成后才能关闭的规则。完全禁止 `DELIVERY_UNKNOWN -> CANCELLED`。管理终止采用独立且不可变的 `ExchangeDisposition`，状态为 `ABANDONED_UNRESOLVED`；它不是 Exchange 状态、Message 状态或 Result outcome。它保留精确的未解决 Attempt 快照及 owner/时间/原因/对账意图；禁止后续协议活动，但允许历史读取。

**技术栈：** 现有 TypeScript、TypeBox、Vitest 和架构检查器。只涉及纯契约和规则。

<a id="approved-design-boundary"></a>

## 已批准设计边界

负责人在基线复现后明确授权这一有限修正。曾考虑扩大 `CLOSED`，但这会改变其冻结的执行已解决前提；若同时禁止取消及任何管理终止，聚合对象就会无法退出。独立 disposition 是最小的兼容区分。Exchange 正常关闭规则不变；disposition 只对执行事实仍未解决的 Exchange 作管理终止。不增加 `ARCHIVED` 身份格式、数据库、传输、守护进程、Pi/MCP 实现或依赖。

未来经过认证的 Host 原子地提供真实 owner principal 以及完整的当前 Message/活跃 Attempt 快照。角色标签或传入的 owner 文本都不能证明身份。Host 必须在每次修改时加载 disposition；不可信调用方不能通过省略 guard 绕过它。本阶段不能在内存中证明原子性或持久性。

<a id="task-1--capture-red-regressions"></a>

## 任务 1：记录 RED 回归

文件：`test/core/ph0003-quarantine-stop.test.ts`、`test/core/disposition.test.ts`、现有 `test/core/rules.test.ts` 和 `test/protocol/lifecycle.test.ts`。

1. 原样保留 `/tmp/ph0003-source-audit/ph0003-quarantine-stop.test.ts` 和原始 RED 日志作为历史证据；调整提交的回归，使其预期拒绝，而不是成功返回 UNKNOWN。
2. 要求生命周期表不包含 UNKNOWN→CANCELLED 和 owner-abandonment 证据类别。将旧的漏洞正向预期替换为拒绝。
3. 增加独立 disposition 测试：保留关联的 unknown/ambiguous 快照；正常 close 仍被阻止；拒绝进行中或外来记录；owner 意图不产生 Result；不可变的精确重放与冲突；阻止已归档对象的修改；读取保持不变。
4. 运行 `mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/core/ph0003-quarantine-stop.test.ts test/core/disposition.test.ts test/protocol/lifecycle.test.ts`，在修改生产代码前记录失败。

<a id="task-2--minimal-contract-correction"></a>

## 任务 2：最小契约修正

文件：`src/protocol/lifecycle.ts`、`src/protocol/entities.ts`、`src/protocol/capabilities.ts`、`src/core/rules.ts`。

1. 删除 owner-abandonment 生命周期边及证据类别/处理器。保留有证据支持的 ACCEPTED/FAILED 出口及全部现有取消证据要求。
2. 增加严格且独立的 disposition schema。每个未解决条目将原始 Message 状态固定为 DELIVERY_UNKNOWN、原始 transport 固定为 ambiguous、unresolvedSideEffects 固定为 true，并保留完整关联且已启动的 DeliveryAttempt 快照。根元数据为 exchangeId、ABANDONED_UNRESOLVED、ownerId、recordedAt、reason 和 reconciliation intent。
3. 增加纯函数 `archiveUnresolvedExchange(...)`，验证完整权威快照及不可变的精确发布/重放；拒绝格式错误、外来、缺失、重复、进行中的证据及替换。绝不修改 Exchange、Message、Attempt、transport 或 Result。
4. 为现有修改 guard 增加 `assertExchangeActive(...)` 及可选的权威 disposition 快照。拒绝已归档对象的转换、结果发布和正常 close；readResult 不变。将管理归档与 close 分别声明，不实现控制 API。
5. 运行定向测试，再运行完整软件包验证。

<a id="task-3--document-verify-review-and-commit-independently"></a>

## 任务 3：独立文档、验证、评审和提交

文件：`docs/protocol-v2.md`、新建 `docs/quarantine-hotfix-ph0003.md`；保留历史 PH-0002 报告，用显式取代引用说明，不静默改写其测试数量。

命令：

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
git diff --check
```

评审全部变更文件及取消/quarantine/close 测试。确认禁止目录没有变化；仅将这一有限修正单独提交，与 Endpoint 收敛分开，不 amend、不 push。记录真实热修复 SHA 及 RED/GREEN 证据，然后恢复已固定目标的只读 PH-0003 bridge 审计。
