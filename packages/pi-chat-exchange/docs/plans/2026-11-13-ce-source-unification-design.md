# CE 正式源码统一设计

## 目标

以公开 `0.3.2` 正式源码为唯一底座，整合 Session Switch、Runtime Binding、Named Groups、`ce bind`、TaskOwner Guard 和 Source Metadata Probe。构建与测试不得读取私有 daily 安装目录。

## 方案

- 复用 `pi-packages-dev` 已保留且有测试/摘要证据的 Session Switch、Runtime Binding、Named Groups 和 `ce bind` TypeScript；只移植产品源码与行为测试，不移植部署候选、兼容补丁或生产证据脚本。
- TaskOwner Guard 重新实现为三个边界：闭合的 `ce_task_owner` 查询协议、私有只读 registry、MCP composition 的每次查询准入。查询只返回经 schema、exchange、from、to 和 messageId 同时匹配的登记；其余情况返回 `UNVERIFIED` 或在 authority/admission 缺失时明确拒绝。
- Sidecar 只选择 registry 位置和可选 Pi Endpoint，不授予权限。TaskOwner 查询前重新检查 bound Endpoint 为 ACTIVE、当前 inbox admission 和 live recipient snapshot。Runtime/Endpoint binding、消息 CREATED/ACK/UNKNOWN 均不能授权 TaskOwner。
- Source Metadata Probe 保持默认关闭，仅在受信 launch scope 显式启用后对已准入的合法 ping 采样一次；接线在 TaskOwner/Runtime 整合后完成。

## 数据与权限流

1. 启动边界验证 binding config 和可选 TaskOwner sidecar；任何 malformed、非私有路径、歧义 recipient 或 selector/live-policy 不一致均拒绝启动。
2. Composition root 从已建立的 Host/Bound Endpoint 获取 exchange 身份，构造固定 `{exchangeId, from, to}` registry port。
3. `tools/list` 只有在 port 存在时广告 `ce_task_owner`。每次调用先经过通用 admission，再经过 TaskOwner 专属 admission，之后读取一个精确 messageId 文件。
4. Registry 读取使用绝对规范路径、私有目录/文件、no-follow、有界读取、唯一 JSON keys 和闭合 schema；错误不泄漏路径或内容。
5. Session/Runtime/Named Group 仅影响显式 discovery 与本地 operator binding，不迁移 TaskOwner selector，不重放任务，不改变消息/ACK 权威。

## 验证

采用 TDD：先建立 TaskOwner 工具、registry、server admission、stdio composition 的失败测试；再移植已有功能及原测试。最终运行受影响测试、typecheck、build、包闭包/接口兼容检查，并对固定 diff 进行权限、安全、覆盖和维护性审查。
