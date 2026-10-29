[English](ph0003-validation.md) | [简体中文](ph0003-validation.zh-CN.md)

> 历史验收记录。以下命令、结果、实现范围和限制只描述当时的阶段，不代表当前支持或发布资格。

# PH-0003 验证、评审和验收边界

## 基线和另行授权的修正

工作前核验初始基线：`<repository-root>`、`main`、`5a84cb1721d87a6f324d4d288ce0beac3dda1579`，干净。没有推送。

收敛前复现了冻结合同冲突：owner-abandonment 文字允许在传输仍有歧义时 UNKNOWN→CANCELLED→正常 CLOSED。最小 RED：1 项失败。工作停止，临时复现被移除，恢复干净基线并等待所有者授权。所有者明确批准独立修正；提交 `8f44553d21df67211774ace9702bdb3aa7802db7` 修复取消一致性并增加管理性 ABANDONED_UNRESOLVED disposition，没有增加运行时 outcome 或普通关闭路径。热修复 GREEN：13 个文件、131/131；Wayforge 438/438。完整 RED 详情、根因和限制保留在 `quarantine-hotfix-ph0003.md`。收敛保留其身份、修正后的事实证据规则和 disposition 语义。

## 审计和已批准设计

检查了四个实际 bridge 源码树、完整许可证和两份重要官方协议参考。ChatGPT-Bridge 的 TS 与 CJS 入口均已审计。精确 pin/源码定位/限制和能力矩阵保存在 `chat-bridge-audit-ph0003.md`；对照了 PH-0002 Pi 侧证据，没有重复调查。所有第三方结论均为 REFERENCE_ONLY；没有引入外部代码/依赖或私有/运行时集成。

所有者批准设计 C：ControlSurface + capability-oriented Endpoint integration。计划为 `plans/2026-10-06-endpoint-convergence.md`。字面 client/agent 权限已被替换，不是只改名称。普通 host context 将独立 action 绑定到 principal 和精确的 Exchange/Message/Attempt/destination/owner scope。能力声明和缺失支持不能制造证据。当时没有认证服务。

## RED → GREEN

- 针对旧角色的 scoped-authority 行为 RED：8 失败/8 通过，`/tmp/ph0003-convergence-red.log`。精确 scope 正向转换因旧角色要求而失败；role-only 负向测试揭示新批准权限合同预期的拒绝。导入错误不计入行为 RED。
- capability-declaration RED：2 项失败，缺失导出合同断言，`/tmp/ph0003-capabilities-red.log`；这是合同可用性断言，不代表旧 core 合成运行时证据。
- 架构 RED：旧门禁未拒绝未来 conversation endpoint 的 MCP SDK 导入（`0 violations`），`/tmp/ph0003-layer-red.log`。更新后的 plane/endpoint 门禁及 control↔endpoint、endpoint 间夹具会拒绝它。
- request-only guard 类型 RED：tsc 拒绝两次调用省略 lease（`/tmp/ph0003-request-lease-type-red.log`）。lease 字段现在仅在输入类型层面可选：request-only 转换无需伪造 lease；基于 attempt 的转换仍校验并要求真实 lease 证据。正向 request 和负向运行时断言验证此区别。
- 最终 GREEN：15 个文件、155/155，包含保留的身份、生命周期、不可变/读取、取消、隔离/disposition、幂等、必须构建的 stdio/内存 ping 和编译负向断言。新增测试覆盖独立 grant、外部 scope/principal/incarnation、owner 与 runtime 权限、畸形/不透明 context、reconciliation、声明支持但缺少证据、同一 peer 多个 grant、反向消息、reply 与 Result，以及跨 endpoint 类型的隔离。
- 14/14 负向夹具被拒绝；严格 `tsc --noEmit` 和构建通过。最终验证前已清理构建输出，smoke 未使用旧适配器残留输出。
- Wayforge：51 个文件、438/438，终端退出码 0，后台任务 `<validation-task>`，日志 `/tmp/ph0003-final-wayforge.log`；源码 diff 为空。
- 工作区门禁和 format/diff 空白检查通过。主动 LSP 检查：6 个路径、0 错误，4 个确认干净、2 个不确定。完整 tsc 是完整证据，不宣称六个文件均经 LSP 确认干净。
- 父会话 TypeScript-AST 比较确认每条修正转换边和 lease/evidence 要求与热修复 HEAD 一致。entity、identity、outcome、idempotency 和 reference-store 源文件没有收敛 diff。

命令（通过 mise 使用 pnpm 12.9.1）：

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
```

设计获准后，收敛由父会话直接执行并评审完整 diff；不宣称最终树经独立子代理评审。遵守了此前 PH-0002 的委派上限。实际收敛 SHA 和干净已提交工作树记录在最终 PH-0003 报告中，与热修复分开。

## 验收限制

当时已 READY，可进入中立事务性 durable-core repository 和重启/崩溃测试；没有剩余架构收敛阻塞。这不证明受支持的 ChatGPT conversation delivery API 或真实 Desktop 验收（NOT_RUN）。

后续宿主必须认证身份、加载 owner/endpoint/consumer binding、当前 grant、完整权威 snapshot/claim/disposition，强制 admission 和证据来源，并原子检查提交。不可变发布和 availability 转换必须与权威 settlement 一起检查。缺失观察仍是 unknown；不支持的工作流不能伪造证明。当时未实现持久化、CAS、fencing 分配和认证。未启动 delivery、SQLite/store、broker/network、daemon、tunnel/browser/CDP/private API、完整 MCP operation 或生产配置变更。未修改 Wayforge、生产 Pi、Moshi、Herdr 或 pi-web。没有推送或修改历史提交。
