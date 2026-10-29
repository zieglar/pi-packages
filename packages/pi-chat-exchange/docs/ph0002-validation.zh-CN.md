[English](ph0002-validation.md) | [简体中文](ph0002-validation.zh-CN.md)

> 历史验收记录。以下实现范围、命令、结果和限制只描述 PH-0002，不代表当前支持范围或发布资格。

# PH-0002 验证和验收证据

开始工作前已验证基线：`<repository-root>`、`main`、`a645003a68c0d0217a92cba84431d4d34f7e581c`，干净。没有推送。

## 获准的停止条件恢复

PH-0001 的 80 位身份断言被证伪：编码器忽略字节 8–9，并让字节 0–7 的分组重叠。工作停止，草稿被撤回。所有者明确授权有限热修复及随后恢复 PH-0002。提交 `58b3163dd247faf5bca31853c0e5667bbb6681f3` 只修改编码器、回归测试和 `identity-hotfix-ph0002.md`。外部 `ho_`/`hr_` 格式、时间戳均不变。实际 RED：身份测试 4 失败/7 通过；GREEN：身份 11/11、原包 41/41；Wayforge 438/438。详见保留的热修复文档。

## 架构 RED → GREEN

- 最初的架构修正回归套件在重构前有 4 项断言失败：读取消费状态、产品特定 Result 来源、无保护的 requeue、产品特定操作目录。
- 编写者最初的通用测试还因缺失/新增模块路径及旧生命周期行为失败。编写者最终验证为 86/86，构建、类型检查和架构门禁通过。
- 首位独立评审者因 provider 用量限制未能开始评审。所有者授权更换模型。新的替代评审者验证初始 86 测试树并报告 OK；这不构成对下列父会话后续修正的独立验收。
- 父会话随后复现证据检查缺失。新增 `test/core/safety-regression.test.ts` 初始为 12 失败/1 通过。修复要求独立且相关联的运行时证据及已发布的关联 Result；将实时变更与最新 fenced claim 比较；允许历史 lease 恢复进入隔离；在取消时保留歧义；拒绝无效时间戳和非 JSON 的不可变结果。
- 独立的 namespace 分隔符碰撞回归在参考 store 改为无歧义 JSON tuple 前有 1 项失败。完整重写同时移除了源码中意外出现的字面 NUL。
- 新增负向架构夹具暴露两个此前未强制检查的产品标识符（`piSessionId` 和 `openaiConversationId`）；token 检查修正前门禁失败。反向 Pi→MCP 夹具也证明了适配器分离。
- 父会话最终验证：11 个文件、107/107 项测试，包括全部 11 项身份热修复回归、内存 MCP 和必须先构建的 stdio MCP smoke、核心证据、不透明应用证据、namespace replay、schema、生命周期及编译负向权限检查。类型检查和构建通过。10/10 负向架构夹具被拒绝。
- 父会话 Wayforge 回归：51 个文件、438/438，退出码 0。Wayforge 源码 diff 为空。工作区门禁和 diff 空白检查通过。
- 主动 LSP 探测在修改的规则/schema/测试中未发现错误：2 个路径确认干净、4 个不确定。完整 `tsc --noEmit` 是权威完整类型检查证据，空 LSP 缓存不是。

命令（通过 mise 使用工作区 pnpm 12.9.1）：

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
```

临时日志位于 `/tmp/ph0002-parent-{safety-red,namespace-red,gate-red,final-verify,wayforge}.log`。锁定且持久的复用证据在 `source-reuse-audit.md` 中；重建来源版本和结论不依赖临时报告。

## 验收边界

父会话在独立评审轮次达到上限后评审并接受了修正合同和测试。最终补救由父会话评审，未再经独立复审。当时没有持久 broker/SQLite/HTTP/auth、Pi consumer/injection/listener、自动 Result publisher、完整 MCP exchange API、生产安装或账户/路由/恢复变更。

规则作用于受信任的输入快照。它们不认证适配器、不分配持久 fencing token、不防止竞争，也不能靠内存运行证明持久性。后续宿主必须加载权威当前 claim、active attempt 和完整消息集，并在原子事务内强制执行规则。公开 Pi API 本身不证明相关联的接收或语义完成。应用结果保持不透明。真实 ChatGPT/桌面客户端调用验收仍为 NOT_RUN。
