[English](./2026-10-22-ce-messaging-activation.md) | [简体中文](./2026-10-22-ce-messaging-activation.zh-CN.md)

> 历史计划（2026-10-22）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ce-messaging-explicit-activation-implementation-plan"></a>

# CE 消息显式激活实施计划

> 执行方式：同一会话内的有限任务；采用 characterization/TDD，检查每项结果。在固定目标评审的全部 BLOCKER 关闭前不提交。

**目标：** 完成 HANDOFF-CE-TUNNEL-MESSAGING-INTEGRATION-01，不削弱 reload、ownership、Store、receipt 或历史边界。

**架构：** 用户于 2026-10-22 批准显式的当前会话激活步骤。普通 reload 仍只执行 resume。显式激活使用可信 runtime session id 和配置对，保留历史 mapping，且只通过现有 `beginSession(endpoint, {requireUnowned:true})` 创建绑定。变更前必须验证/释放现有活跃权限；释放或所有权未知时停止激活。新配置通过不可变 binding/allowlist generation 发布，由现有 profile command 指针选择，不增加消息路由。

**技术栈：** TypeScript、现有 CE Host/Store、Pi 1.3.0 runtime API、现有 TUI Kit、Node v24.21.0、Vitest。不改 SDK/core，不增加通用配置框架。

<a id="invariants--approved-activation-protocol"></a>

## 不变量及已批准激活协议

1. Runtime 身份只来自 `ctx.sessionManager.getSessionId()`，并由操作员确认。权限变化前再次验证身份及精确配置 revision。
2. 展示双方 Endpoint、完整 Store 文件名、Exchange namespace+idempotency key、read/ACK 和新旧 session binding。Configured、Pi-bound、Connected 和真实 Gate 证据是不同状态。
3. 显式激活与普通 reload 分开。缺失 mapping 或旧 Exchange mapping 不得触发自动 `beginSession` fallback。
4. 若已知活跃 generation，释放前停止其 heartbeat/tools，等待 renewal 结束，要求已知成功的 release+detach。UNKNOWN/失败/持久化生命周期阻塞都会停止操作；不清除失败 latch，不盲目重试。
5. 目标只在 policy/runtime/config 检查后使用现有 `beginSession(..., {requireUnowned:true})`。绝不接管现有 owner，即使该行已过期。
6. 成功绑定后只追加新 mapping 标识符，保留旧历史。持久化失败时丢弃 capability 并遵循现有失败 latch，不自动重新创建。
7. 已匹配且活跃的 generation 是幂等 no-op，不做第二次绑定。拒绝其他 runtime session/config revision。
8. 显式 Tunnel Stop/Start 仍独立；Pi 激活成功不代表传输在线或真实 C2/C3 成功。
9. 受支持 Node runtime 仍精确固定；不改变全局 Node，不削弱 Store runtime policy。

<a id="task-1--close-store-override--terminal--review-honesty-defects"></a>

## 任务 1：修复 Store override、终端显示和 Review 如实表达缺陷

文件：pi-extension/index.ts（最初仅 openHostStore）、src/tunnel/manager-panel.ts、src/tunnel/setup-ui.ts；测试 test/endpoints/pi/extension-ack.test.ts、test/tunnel/manager-panel.test.ts、test/tunnel/setup-ui-messaging.test.ts。

- RED：显式 Store 与不匹配/格式错误的 env Store override 同时出现时，open/initialize/begin 均为零；允许精确相等；没有 legacy Store 时保留现有行为。
- RED：显示的 messaging endpoint 中的换行/CR/控制字符不能逃出 panel 行；对比现有净化行为。
- RED：未重新授权就改变已有配置对的身份/接收方时，不得显示为未变或让提交不被察觉。
- GREEN：显式 Store 相等 fence、现有 sanitizer、可见的重新授权要求，以及拒绝/禁用冲突保存。不增加字段语法限制。
- 在批准的 Node 下运行小范围测试；涉及 dist 导入时先 build。保留 RED 证据，不提交。

<a id="task-2--immutable-paired-configuration-publication"></a>

## 任务 2：不可变成对配置发布

文件：src/tunnel/messaging-config.ts、src/tunnel/setup.ts、必要时 src/tunnel/managed-binding.ts；测试 test/tunnel/messaging-config*.test.ts、setup-messaging.test.ts、messaging-binding.test.ts。

- RED：在最终发布操作注入外来替换；不得覆盖或 unlink 目标。创建碰撞时拒绝，或复用精确且自有的不可变字节。
- 用不可变 pair generation 替换可变固定 sidecar 替换/补偿。Sidecar 路径由 profile 选中的 binding generation 无歧义推导；两个配置具有精确相同 Store+Exchange。Session/policy 变化产生不同 generation。
- 用 no-overwrite 操作发布完整配置。拒绝后保留已完成但未引用的 generation，不作破坏性补偿。Profile 现有受 guard 保护的原子 rename 是激活提交点。提交前失败时，旧 profile/pair 仍有效。
- 保留凭证排除、mode/owner/有界读取、session pair 变化的显式替换同意、无关 allowlist/config、批准 runtime 及现有 profile 元数据。
- Loader 跟随选中的 binding generation，验证 provenance 和完整 pair；选中 generation 格式错误时，不回退到无关权限。
- 测试失败后旧 profile/config 的精确字节、fsync 失败、外来碰撞、重试、凭证别名元数据和打开 fd 的排除，以及不会选中部分 pair。配置工作不写 Store/历史。

<a id="task-3--actual-activation-lifecycle-regressions"></a>

## 任务 3：真实激活生命周期回归

文件：新建 test/endpoints/pi/extension-messaging-activation.test.ts；按需扩展真实 factory/wizard setup 集成测试。

- RED：真实 Setup save → 新 factory → session_start(reload)，没有有效 mapping 时仍拒绝；显式激活通过真实隔离 CE Host/Store 创建并持久化授权 mapping。
- 覆盖旧 Exchange mapping 历史保留与显式激活、活跃/过期外来 owner 拒绝、错误 runtime session、配置变化、已绑定 no-op、旧 release 失败/UNKNOWN、append 失败 latch，以及不允许自动 reload fallback。不使用生产凭证/配置或消息。
- 必要时使用现有 host/storage 证明持久 ownership/mapping/receipt 语义，不能只测工具注册或 mock 返回值。

<a id="task-4--add-explicit-activation-entry-and-policy-snapshot-lifecycle"></a>

## 任务 4：增加显式激活入口及 policy snapshot 生命周期

文件：pi-extension/index.ts、src/tunnel/setup-ui.ts（现有 Advanced 界面）；仅按需修改 src/tunnel/manager-ui.ts/panel projection。

- 与任务 1 的源码写入保持顺序。为已配置的当前会话增加显式 Advanced action；可选命令入口必须调用同一确认，不形成独立权限路径。
- 在操作员确认前后捕获并复查可信 config 与 runtime session。只用现有 Host API。现有 `session_start` resume 检查保持完整。
- 显式且经过检查地释放已知旧 generation；目标 `requireUnowned` 拒绝 ownership 冲突。保留失败 latch 和历史 mapping 语义。
- Reload 后注册工具使用当前配置 policy；不把 capability 写入 session entry、transcript 或通知。
- 运行任务 3 测试 RED→GREEN；确保普通 extension-lifecycle 套件保持不变且通过。

<a id="task-5--complete-visibility--documentation-and-all-validation"></a>

## 任务 5：补齐可见信息、文档和全部验证

文件：domain/UI messaging projection、docs/tunnel-setup.md 及相关测试。

- 在 Details 显示实际 Store 目录/文件及不同的 namespace/idempotency key；在 Advanced/Review 如实显示预览/选中值和待激活/重新授权状态。
- 保存后指导改为显式激活，不再声称 reload 会自动绑定。解释安全拒绝、受支持 runtime、独立 Tunnel 重启及真实 Gate。
- 先 build，再运行定向 tunnel/endpoint lifecycle 套件、typecheck、contract、完整测试、独立 extension compiler 和插件打包。调查现有 60s 打包超时；不得单纯放宽限制或用重试循环隐藏失败。

<a id="task-6--fixed-target-review-local-commit-external-real-gates"></a>

## 任务 6：固定目标评审、本地提交和外部真实 Gate

- 在基线 94de4cbbb861c2d8ba3799f3ed14408ab6245843、空 index 上冻结完整 diff 和每文件 hash。启动四个新评审 lane，前后检查完整性；lane 活跃时禁止写源码/测试/文档。原始 lane 重新验证全部 blocker。
- 全部 blocker 关闭且新验证通过后，只创建一次本地提交。绝不 stage AGENTS.md 或 .herdr-web-ui/，不 push/merge/release。
- 真实配置预检必须区分实际部署 pair/runtime/当前会话授权与代码测试。当时真实配置尚未迁移；此前观察到 Pi runtime 为 Node25.2.1，激活 Host 前须通过受支持方式启动。
- 真实 C2/C3 必须回到当前 ChatGPT 工具。Pi 不得模拟 sender/reader/ACK 或读取无关消息。没有真实双向证据，不得宣称 ACCEPT/REAL_GATE_PASS。
