# 新 Pi 会话的 Connect 接入

本候选实现属于 HANDOFF-CE-SESSION-ONBOARDING-01。用户级安装仍为 `0.3.1-daily.1`，本次开发不自动更新安装。CE 0.3.0 Hooks 和已有注册继续保留。

在新的交互 Pi Session 执行：

```text
/ce-tunnel connect
```

未注册的当前 Session 会收到创建独立 Endpoint 的确认。界面列出生成的 Endpoint、Peer、Store、Exchange 和权限，不要求输入 Session ID 或 Endpoint。名称由可信原生 Session ID 的 SHA-256 摘要生成，不使用项目路径或会话显示名。

新注册默认只允许向配置的 ChatGPT Peer 发消息及读取收件元数据；正文读取、接收 ACK、Hooks 均关闭，不复制旧 Session 的权限。接受后发布注册策略，由 Connect 调用 Pi 1.3.0 官方命令上下文 reload API。新扩展 runtime 重新校验策略，然后继续后台启动许可和当前会话激活确认。用户不必手动执行 register、reload、activate。

取消任一步不会进入后续阶段。注册确认完成后，如果取消后续的许可或激活，已确认的注册会保留；再次 Connect 会复用该注册。重复 Connect 不生成多个 Endpoint。撤销过的注册不会静默恢复。

用 `/ce-status` 查看本地绑定和租约，用 `/ce-tunnel status` 查看传输健康。CONNECTED 不证明消息读取、ACK 或业务任务完成。

## 共享 Tunnel 的实际限制

当前架构在 MCP 启动时捕获收件人权限，运行中只能收窄权限。注册发布和新激活也由现有 STOPPED 配置锁保护。因此，已激活 Session 可以复用兼容实例；全新 Endpoint 无法加入已经运行、未加载该 Endpoint 的 MCP。

遇到这种情况，Connect 会明确说明未注册或未激活及共享实例约束，不擅自停止 Tunnel，不删除其他 Session 的 Owner、注册或历史。需要使用者协调 Stop 后再 Connect。本候选实现尚未满足“任意新 Session 加入运行中的共享 Tunnel，无需 Stop/Start”的全部目标；不能把这一限制归因于 Pi 不支持动态工具注册。

Pi 官方 `examples/extensions/dynamic-tools.ts` 支持 Session 启动后动态注册工具。本实现选用官方 reload，是为了保留 CE 原有 factory 权限快照和可选工具注册契约；动态工具注册本身并不能改变 MCP 已加载的权限。

## 拒绝与恢复

- Current session is not registered：多会话 Profile 下由 Connect 请求创建当前 Session 的独立注册。
- Endpoint policy is not loaded：使用官方 reload 加载；缺少该命令上下文能力时明确拒绝。
- Activation requires confirmation：取消不产生激活绑定或传输启动。
- Shared tunnel is running with an incompatible configuration：先协调共享 Stop，Connect 不替用户停止其他会话的传输。
- Endpoint is owned by another session：不接管、不自动清理；正常关闭持有者或按证据排查。
- 确认期间 Session、Profile、策略或环境变化：旧操作拒绝，重新 Connect 核对当前目标。

官方 reload 失败时，已经发布的注册保留。再次 Connect 可恢复生命周期步骤，不重复注册。重载续接只是一条有限时效、同 Session/Profile/配置版本的待检查请求，消费后不会自动循环重试，不携带 grant、Owner 或 exactly-once 保证。

显式 `CE_ALLOWLIST` 和旧单会话配置仍遵循原流程，不静默转换。底层 register、activate、deactivate 命令保留供明确管理操作使用。
