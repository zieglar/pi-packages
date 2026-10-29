[English](./2026-10-06-endpoint-convergence.md) | [简体中文](./2026-10-06-endpoint-convergence.zh-CN.md)

> 历史计划（2026-10-06）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ph-0003-endpoint-convergence-implementation-plan"></a>

# PH-0003 Endpoint 收敛实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 冻结 ControlSurface 与面向 capability 的 Endpoint 集成，不实现投递或持久化。

**架构：** 负责人在源码级比较后批准方案 C。控制面暴露请求、读取和管理操作；Endpoint 集成只提供受支持的投递和运行时证据。接口或 capability 声明本身不能授权操作：未来经过认证的 Host 提供绑定 principal 的 action grant、精确作用域及权威事务快照。

**技术栈：** 现有严格 TypeScript、TypeBox、Vitest、TypeScript-AST 架构门禁；不增加依赖。

<a id="approved-design"></a>

## 已批准设计

保留字面的 client/agent 权限分类会错误归类对端。只给两个 adapter 改名，又会混淆 API 调用与向可寻址会话投递。因此将 `control/mcp` 与 `endpoints/pi` 分开，通用 `protocol` 和 `core` 位于两者内层。不实现 ChatGPT Endpoint、占位实现、守护进程或私有 API 集成。

保留所有 Exchange/Message/Result schema 和线上身份格式。追问与回复都是 Exchange 中独立路由的 Message。Result 是不可变的处理证据，不会自动作为回复发送。保留另行批准的 quarantine/disposition 热修复：未解决事项的管理归档记录歧义，不会正常关闭 Exchange，也不会捏造取消或结算事实。

分别声明投递、观察、取消、追问和结果产生能力为 supported/unsupported/unknown。可选或缺失的支持信息表示 unknown，不能作为证明。现有 core 规则要求实际关联证据。传输已确认但执行不可观察时，不得错误归类为投递歧义。

用封闭的 action 名称及下列 grant 作用域替换 client/agent 判别字段：

- exchange send/get/result：精确 Exchange；
- listing：集合（未来 Host 仍须过滤获得授权的记录）；
- cancellation request：精确 Exchange 和 Message；
- claiming：精确 Exchange、Message 和目标 Endpoint；
- dispatch、delivery、runtime progress/settlement、result publication、lease release、reconciliation 和 cancellation confirmation：精确 Exchange、Message、Attempt 和接收方 incarnation；
- close/archive：精确 Exchange 和 owner principal，分别授权。

一次转换可能需要多个 grant：仅有 delivery reporting 不能断言 acceptance；仅有 ambiguity reconciliation 不能提供 runtime acceptance。运行时取消确认同时需要 runtime reporting 和 cancellation confirmation 权限；证明从未尝试过的取消不会凭空产生运行时证据。grant 作用域不能替代租约、fencing 或事实证据。Context 是普通契约，不是密码学 token。只有未来 Host 在认证真实 adapter/runtime，并在事务中加载 grant、活跃 claim/attempt/disposition/全部 Message 后，才能构造可信 context。本阶段不声称已实现认证或调用方签发的安全边界。

<a id="task-1--red-authority-and-capability-regressions"></a>

## 任务 1：权限与 capability 的 RED 回归

创建 `test/core/endpoint-authority.test.ts` 和 `test/protocol/endpoint-model.test.ts`。用新 context 在旧角色 guard 上执行真实转换；验证拒绝字面角色、跨 Message/Attempt/实例/principal 作用域、无关 grant、owner/runtime 越权，以及只宣称 capability 却缺失证据的情况。测试 Message 反向路由、独立回复与 Result、不修改状态的读取、显式 close，以及各类 Endpoint 的 fail-closed quarantine。正向测试必须在旧契约下失败；导入错误不算行为 RED。

运行：
`mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/core/endpoint-authority.test.ts test/protocol/endpoint-model.test.ts`
将失败输出保存到 `/tmp/ph0003-convergence-red.log`。

<a id="task-2--small-authority-migration"></a>

## 任务 2：小范围权限迁移

将 `src/protocol/capabilities.ts` 改为封闭的 control/endpoint 目录及经过 schema 验证的强类型 action grant/context。增加纯函数 `src/core/authorization.ts`，精确匹配 principal/action/scope，拒绝格式错误或非 JSON context。增加仅用于声明的 `src/protocol/endpoint-capabilities.ts`。将 `src/protocol/lifecycle.ts` 的要求改为 action 数组，并让 `src/core/rules.ts` 在现有证明检查前检查带作用域的 grant。为不可变发布增加作用域授权；纯粹且不修改状态的读取验证保持独立。将归档 owner 意图绑定到获得授权的 principal。不改变生命周期边、身份生成或运行时语义。

更新现有测试 fixture，使其提供显式可信测试 context；保留每一条已有行为断言。将角色编译负例替换为操作/作用域和 control/endpoint 负向契约。分层迁移前确认 RED 测试转为 GREEN。

<a id="task-3--red-physical-boundary-fixtures-then-move"></a>

## 任务 3：先建立物理边界 RED fixture，再移动文件

为 core→control、protocol→endpoint、MCP control→Pi endpoint、Pi endpoint→MCP control、未来 ChatGPT endpoint→MCP SDK/control 增加有意义的 fixture。更新门禁前，证明旧门禁无法拒绝这些新角色路径。通过 Git 移动：
`src/adapters/mcp/*` → `src/control/mcp/*`；
`src/adapters/pi/contract.ts` → `src/endpoints/pi/contract.ts`；
MCP 测试 → `test/control/mcp/*`。
更新 bin 导入、fixture、门禁路径谓词和 Pi 声明；不增加 Endpoint 代码。对所有 control↔endpoint 及 Endpoint 间依赖执行传递检查，包括 barrel；protocol/core 不得到达外层或 bin；Endpoint 代码不得依赖 MCP SDK。必需的 ping 冒烟测试行为保持不变。

<a id="task-4--durable-audit-and-corrected-docs"></a>

## 任务 4：持久审计记录与文档修正

从 `/tmp/ph0003-source-audit/audit-findings.md` 创建 `docs/chat-bridge-audit-ph0003.md`，保留精确版本固定、许可证、源码引用、负面发现和两项重要官方参考。更新当前 README/architecture/protocol/adapter 文档。保留 PH-0001/2 证据和热修复历史，通过取代说明标注，不改写历史主张。

<a id="task-5--verification-review-one-convergence-commit"></a>

## 任务 5：验证、评审和一次收敛提交

运行软件包 verify（门禁、负向 fixture、tsc、build、全部测试）、工作区检查、格式和 diff 检查；后台运行 Wayforge 回归，并在报告完成前检查终端退出状态和数量。评审完整 diff，确认没有禁止的源码/配置改动或新增依赖。只提交授权的软件包变更，不 amend 早期提交，不 push。验证提交树和干净工作区。在精确 PH-0003 报告中分别记录热修复与收敛提交。

若新证据推翻冻结契约，应停止并报告，不得静默修复。本阶段不开始持久化实现。
