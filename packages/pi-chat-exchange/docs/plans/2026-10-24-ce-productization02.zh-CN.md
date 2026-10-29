[English](./2026-10-24-ce-productization02.md) | [简体中文](./2026-10-24-ce-productization02.zh-CN.md)

> 历史计划（2026-10-24）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ce-productization-02-implementation-plan"></a>

# CE Productization 02 实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 通过有文档的命令、显式当前会话停用及安全只读安装诊断，让现有 Chat Exchange setup 和多会话操作可用。

**架构：** 复用现有 Pi 命令族、生命周期 shutdownCe/Host end 接缝、运行时资格及可执行文件准入。不引入第二套权限、installer、router 或 ownership recovery 路径。已安装的在线源码和真实 Tunnel/Store/Session 受到保护；实施与验证只在该隔离 worktree 中使用合成私有 fixture。

**技术栈：** Pi 1.3.0、TypeScript 5.9.3、具备批准 SQLite identity/API 的 Node 24.21.0 或 24.22.1、Vitest 4.1.11、pnpm 12.9.1。

<a id="approved-design-and-boundaries"></a>

## 已批准设计及边界

用户在只读 Gap Analysis 后批准“最小 UX + 文档”。Base：1578a7bb6d672819ff9b3fe1479d26f008cb5e60；branch：feat/ce-productization02。基线 build 和五个定向套件通过（105 个测试），使用 Node 24.21.0。

- 增加 `/ce-tunnel deactivate`，验证真实当前会话身份并要求操作员显式确认。只通过正常 end/release/detach 结束本地持有的当前 CE binding，取消 renewal，保留 registration 和历史。绝不 start/stop transport。取消/没有本地 binding 时不写入。未知 release/persistence 保持 fail-closed，绝不报告解绑成功。重复调用不得结束两次。此后需要显式 activation；reload 不得静默重绑已释放 mapping。不创建新持久 opt-out policy，复用精确现有 release 证据。
- 增加只读安装诊断 `/ce-tunnel doctor`。区分当前 Pi Host 资格、MCP child 选择及 client 元数据准入。不执行不可信 client、不 fetch/install、不读取凭证内容、不修改 profile/Store、不实例化或启动 transport。保留不安全祖先/符号链接/ACL/project/PATH 拒绝。优先使用封闭诊断结果和无秘密修复指导；不打印原始子进程输出/错误、环境值或任意输入。
- 改善 `/ce-status`，在现有 Endpoint、Participant、CE Session/Owner lease/fencing 之外显示当前 native Pi Session 和 Exchange。只通过现有准入披露标识符；拒绝时不暴露 capability 材料，不枚举其他会话。
- 重写面向用户的入口：软件包 README、pi-extension README、plugin README、docs/tunnel-setup.md、docs/chatgpt-installation.md、docs/architecture.md、docs/multi-session-usage.md。仅记录真实当前 CLI：不虚构独立 ce binary、不要求 mise、不含开发机路径、不写历史 Handoff/commit/process 叙述。分开 Tunnel 与 Desktop；解释 Configured/Pi-bound/Connected/message evidence、逐 Session 独立 Endpoint、共享 ChatGPT inbox、撤销与正常解绑、reload/resume。保留精确 Node runtime qualification 及平台认证限制。
- 不 push、PR、merge、release、发送真实消息/receipt、清理 Store、自动 recovery、改变冻结 protocol/core/storage/host policy、升级依赖或实现 Wake Bridge。不编辑/构建父 checkout 或其他 worktree。

<a id="task-1-characterize-and-implement-explicit-deactivation-tdd"></a>

## 任务 1：刻画并实现显式停用（TDD）

文件：pi-extension/index.ts、test/endpoints/pi/extension-messaging-activation.test.ts、test/endpoints/pi/extension-multi-session.test.ts；可选 src/tunnel/ 与 test/tunnel/ 下的小范围 confirmation 模块和测试。

1. 阅读 shutdownCe、activation、session_start、持久 release proof 及现有 cancellation/generation fencing。改变 Pi extension/UI API 用法前完整阅读已安装文档；适合时复用现有 confirmation 接缝。
2. 编写失败用例：legacy 和 multi-session 正常 release 成功、无 transport 影响、取消、无 binding、重复调用、identity/config 漂移、busy dialog 和并发 teardown、未知 end/persistence、撤销安全清理，以及 release/reload 后显式 activate 且不自动重绑。
3. 实现前运行这些测试，保留 RED 原因。
4. 将新显式命令路由到既有 shutdownCe normal-end 路径，使用当前会话 fence 和共享 operation latch。保留未知生命周期状态；只有 release proof 验证成功后报告成功。
5. Build，再以 `pnpm exec vitest run <files> --maxWorkers=1` 重跑受影响套件。通过后只提交授权文件。

<a id="task-2-read-only-doctor-and-identity-status-tdd"></a>

## 任务 2：只读 doctor 和身份状态（TDD）

文件：src/runtime/executables.ts、src/runtime/diagnostics.ts、pi-extension/index.ts、test/runtime/{executables,diagnostics}.test.ts、test/tunnel/extension-runtime-diagnostic.test.ts；新增诊断测试限于必要范围。

1. 增加失败测试：缺少 client 与拒绝 client 的区别、可信候选、不安全祖先/符号链接/ACL、显式无效 override、Host/child 独立资格、无 client 执行、不 install/改变 profile/Store/process，以及拒绝时安全的身份状态。
2. 使用现有准入及内存 Node probe；不削弱文件系统信任，不输出原始 probe 内容。当前 Host 资格独立于 CE_NODE_PATH。
3. 接入 doctor 的 help/completion/command，不创建 background manager；status 只报告通过准入的当前身份。
4. Build、运行定向测试、check/typecheck。提交小范围 runtime delta。

<a id="task-3-user-focused-docs"></a>

## 任务 3：面向用户的文档

文件：README.md、pi-extension/README.md、plugin/pi-chat-exchange/README.md、docs/{tunnel-setup,chatgpt-installation,architecture,multi-session-usage}.md。

1. 根据源码和 Pi 文档验证 install/loading/package script 及本地 plugin configure 接口。若添加精确 ChatGPT UI 步骤，依据当时官方最新文档验证；否则链接官方指导，不猜测。
2. 提供一条清楚的 Tunnel quickstart 和独立 Desktop stdio 路线。包含安全 Node/client 诊断、显式环境准备、profile 选择、generation、activation 及实际测得 health。不强制 version manager，不提供不安全可执行文件绕过。
3. 解释独立 Endpoint registration、status 身份、deactivate/revoke/stop 区别、正常 reload resume 和显式 activation。需要 STOPPED transport 的变化只写成指导，不在此执行。
4. 根据源码检查相对链接、命令示例、软件包版本、隐私及剩余主张。文档不含真实 credential/profile/session/message 数据。

<a id="task-4-verify-and-freeze-review-target"></a>

## 任务 4：验证并冻结评审目标

1. 串行或使用有界 worker 运行 check、typecheck、build、相关 lifecycle/runtime/tunnel/multi-session 套件及打包插件测试；记录真实命令/结果和跳过项。
2. 可行时使用有界 worker 运行完整套件；报告完成前调查失败。检查最终 diff 中的意外权限变化或私有路径。
3. 提交 implementation/docs，确认 tracked/index 干净，冻结精确 base..HEAD。评审元数据不得移动该目标。
4. 四个全新只读叶子评审会话：A diff/privacy/docs；B authority/frozen contracts，使用 N0–N3 分类；C validation/coverage；D standards/maintainability，区分 HARD VIOLATION 和 JUDGMENT CALL。父会话综合有证据的发现，顺序修复，再按需重新冻结和评审变化范围。
5. 保留隔离 worktree 和本地提交，报告 SHA/range、测试、评审结果及限制。父 checkout 和在线 runtime 不动；没有授权不 integration/push 或清理。
