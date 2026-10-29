[English](./2026-10-23-multi-session.md) | [简体中文](./2026-10-23-multi-session.zh-CN.md)

> 历史计划（2026-10-23）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="multi-session-shared-tunnel-implementation-plan"></a>

# 多会话共享 Tunnel 实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** HANDOFF-CE-MULTI-SESSION-01：不同项目中的两个真实 Pi runtime Session，通过一个 Tunnel 和共享 chatgpt/main inbox，并发使用独立 Endpoint。

**架构：** 保留 CE Host/Storage/Ownership/capability/fencing 及固定 sender 的 MCP 界面。将操作员 Session registration 与 Transport 凭证分开。通过单个原子激活指针和显式受控 runtime reload 发布不可变、经过验证的配置 generation。本地进程互斥只是额外准入限制，绝不构成 CE 权限或租约接管。

**技术栈：** 现有 TypeScript、Node 24.21.0、node:sqlite、Pi 1.3.0、MCP SDK、Vitest 及现有 TUI/进程测试 harness。不改依赖或 Runtime Guard。

<a id="authority-and-compatibility-constraints"></a>

## 权限与兼容性约束

- 可信 Pi runtime getSessionId() 选择操作员授权的 registration；cwd 和显示名都不赋予权限。
- 每个真实 Session 使用一个不同且稳定的 Pi Endpoint；共享一个 chatgpt/main peer。不允许隐式 Pi-Pi 接收方、wildcard、最新会话 fallback、虚假 Session ID、共享 Owner 或自动接管过期 Owner。
- 继续支持现有单会话 setup。转换必须显式进行；保留旧 endpoint/mapping/Store/Exchange 及现有 registration，并通过明确评审的 opt-in 增加不同接收方。绝不静默重写 legacy config。
- 配置发布须保留 Store/Exchange/Tunnel 身份和其他 Session 条目，在读取前排除凭证路径/inode，保留结果不确定的提交供 reconciliation。不 reset/migrate Store；registration 不读取或重写凭证。
- Runtime policy 对授权增加保持不可变：新 Session/recipient 需要显式 reload。当前已发布配置只能收窄/阻止已加载 policy，尤其是撤销或身份不匹配时。未知 config/process 身份按 fail-closed 处理。
- 重复进程不得同时 resume 同一持久 CE Session。现有 Storage Owner 以 Session 为作用域，不区分 process handle，因此需要额外的已验证进程 mutex；它不签发 capability，不改变 Ownership。仅凭 PID 或记录年龄回收不足以证明安全。须区分安全的同进程 reload、重复 handle、PID 重用及未知状态。
- Transport Manager 只管理传输。Stop/Start 必须显式执行，不得成为 registration 副作用。真实 Tunnel/client/message 动作需要单独授权。

<a id="resolved-implementation-decisions-preimplementation-review-closure"></a>

## 已解决的实施决策（实施前评审关闭）

1. **发布要求 Tunnel 明确为 STOPPED。** 复用现有 withProfileConfigurationLock 及其 stopped-record/external-process 检查。Register/revoke 命令拒绝运行中/UNKNOWN Tunnel，并指导显式 Stop，绝不代为 stop/start。这一设计不承诺传输运行期间可实时注册，也不削弱 transport lock。传输停止时 A/B Pi binding 可继续存在。发布后另行显式 Start，加载新 MCP policy。
2. **唯一原子 policy 指针仍是 Profile command。** 引入严格验证的多会话 generation，包含封闭 registration manifest/sidecar、不可变配对字节及 digest 验证。窄范围验证的可选 launch policy reference 可标识操作员控制的 Profile，但只用于 deny-only admission；不得将 managed provenance 改作 grant。除非显式转换确认选择新模式，否则 legacy config 保持 legacy。
3. **有效 policy 为已加载 grant 与最新选中 grant 的交集。** 在 begin/resume、每次 tool/inbox advisory/target-list 调用及 heartbeat 前验证当前 generation。比较 Store/Exchange/Tunnel 身份，以及当前 registration 的 Endpoint、精确 runtime Session ID 和 registration epoch。增加 B 不得使未变的 A 失效。Revoke tombstone 保留稳定 Endpoint 身份，后续重新授权使用新 epoch，旧 A handle 不能复活。MCP admission wrapper 将已加载 recipient 限于当前活跃 registration，不经 reload 不能获得新发布 recipient。撤销/未知 policy 时所有读取均 fail-closed，不只限制写入。
4. **撤销的线性化点是原子指针快照读取，前提是该精确不可变 generation 验证成功。** 若操作的指针快照早于发布，即使 generation 验证在发布后完成，也可完成操作；发布后取得快照的调用必须观察到撤销。不声称撤销与 Storage 事务原子、不取消重叠/已准入操作，也不追溯删除 ChatGPT 已合法收到的历史。测试精确交错：读取旧指针快照 → revoke 发布 → 旧不可变 generation 验证成功 → 重叠操作可完成；之后快照拒绝。第二次指针读取不能提供更强串行化。更强撤销语义需要单独的冻结契约决策，本计划不实现。
5. **进程 mutex 设计。** 私有锁的作用域为规范 Store 位置加 Pi Endpoint/真实 runtime Session 身份。使用独占创建、严格 ownership/mode 和 no-follow 读取；holder 包含 process-instance birth identity、随机 process token 和独立 runtime-handle token。拒绝重复活跃 handle，即使同 PID。只有旧 admission 关闭且操作/heartbeat 排空后，才允许显式同进程 reload 转移，不能仅因 PID 相同而转移。不按年龄或租约到期回收；未知或部分写入的锁一律拒绝。只有证明进程已死亡/身份已替换，才能退役 mutex record；Storage resume/begin 仍独立拒绝过期/外来/缺失权限。每次 admission 和 renewal 重新检查精确锁所有权。CE 清理或 mutex release 不确定时保留 marker。
6. **逐 Pi Host projection。** 新模式 Pi Host 只接收当前可信 Session Endpoint，不接收全部 registration，另加精确 chatgpt/main recipient。严格验证完整 manifest/pair 相等性、唯一 runtime ID、唯一 Endpoint、epoch、opt-in 和身份。旧单会话 setup 必须拒绝覆盖已转换的多会话配置。
7. **目标发现仅用于显示。** 优先使用 /ce-tunnel sessions 列举精确授权活跃 Endpoint ID，再复制到 ce_send.to，不增加可选 sender 的工具，也不静默扩大 MCP schema。显示目标不证明运行中的 MCP child 已加载它。显式展示所需受控重启。

<a id="requirement--owner--concrete-verification"></a>

### 要求、负责人和具体验证

| 要求 | 实施负责人 | 验证 |
| --- | --- | --- |
| Legacy 身份/权限及当前 resume 缺口 | characterization 任务 | test/host/multi-session-characterization.test.ts 及现有 extension-lifecycle/activation 套件 |
| A/B/C 稳定唯一 registration、撤销、epoch、部分发布 | registration 实施 | 新 test/tunnel 多会话发布/验证测试，仅临时文件 |
| 固定 sender、已加载/当前交集、跨读取/ACK 拒绝 | runtime 集成 | 真实 Host/Store 和 MCP 测试；撤销/重新授权后保留旧已加载 A/B 及共享 inbox |
| 同 Session 进程/handle 互斥和安全 reload | process guard 集成 | 合成身份测试及使用 process.execPath 的真实双进程 worker；PID 重用/未知/锁丢失/不确定性负例 |
| Session 生命周期及 A 不依赖 B | runtime 集成 | 真实 extension event handler、临时 Store、多进程集成 |
| 冻结契约/隐私/验证/标准 | 父会话及四条固定目标 lane | 精确 base/target diff 和可复现命令；评审目标不可变 |

<a id="commands-and-stop-conditions"></a>

### 命令与停止条件

在 PATH 使用批准的 Node24.21.0 binary，不改全局 Node。从 packages/pi-chat-exchange 运行 `pnpm run build`、定向 `pnpm exec vitest run <specific test paths>`，随后 `pnpm run check`、`pnpm run typecheck`、`pnpm run build`、`pnpm test`，若涉及 composition/packaging 则运行 `pnpm run test:plugin-package`。记录精确路径、数量、退出状态和任何基线失败。

基线漂移、冲突/未分类改动、进程身份证明失败或不可用、expected revision 过期、generation 不完整/未验证、发布不确定、Store/Owner/lease/fencing 未知或清理不确定时，停止相关操作。不得将 unknown 当成 rollback、busy 当成权限，或将计划/测试结果当成真实 Tunnel 验收。若需改变冻结 protocol/Storage/Ownership 语义，停止生产实现。

<a id="task-1-characterize-existing-boundaries-before-production-edits"></a>

## 任务 1：生产编辑前刻画现有边界

文件：test/tunnel/extension-messaging.test.ts、test/endpoints/pi/extension-lifecycle.test.ts、test/host/endpoint-host.test.ts，按需新增定向测试文件。

1. 增加 characterization 测试，覆盖单会话不可变 config、可信 runtime lookup、固定 MCP sender、显式 recipient、独立 Owner 拒绝及 legacy reload 行为。
2. 使用批准 Node 和现有 package script；导入 dist 的测试先 build。不访问真实 daemon，记录实际命令/结果。
3. 为不同 Session Endpoint 和注册 B 时保留 A 增加失败功能测试。确认失败代表缺失行为。

<a id="task-2-registration-model-and-verified-publication"></a>

## 任务 2：Registration 模型及已验证发布

文件：src/tunnel/messaging-config.ts；src/tunnel/setup.ts 或专用新 registration 模块；只有确需严格验证的可选 policy reference 时才改 src/host/mcp-binding-config.ts；对应 test/tunnel 测试。

1. 在现有 configuration-pair publication 上设计最小显式 multi-registration generation；使用唯一 Endpoint ID 和精确 Session key，保留 Store/Exchange 和 chatgpt/main。
2. 增加 A/B/C registration、replay/resume、撤销 A 保留 B、过期 expected revision、重复 Endpoint、未知字段、错误 Store、部分 publication/fsync 不确定性测试。
3. 使用已评审 CAS/lock 边界实现独占发布；先生成不可变候选，最后原子 active pointer。未知结果拒绝，不盲目重试。
4. 显式转换前不改 legacy 读写。禁止旧单会话 wizard 覆盖 multi-session registration。

<a id="task-3-runtime-precise-routing-and-user-operations"></a>

## 任务 3：Runtime、精确路由及用户操作

文件：pi-extension/index.ts、src/bin/mcp-stdio.ts、src/host/bound-endpoint.ts 或专用 runtime admission wrapper、专用新 process guard 模块、test/endpoints/pi、test/control/mcp 和 test/tunnel 测试。

1. 暴露最小 /ce-tunnel 操作：授权 Session 列表；带权限/Store/Exchange 预览和确认的当前 Session 注册；撤销精确 registration；显式 runtime load/activation。不提供模型控制的权限操作。
2. 每个 Pi runtime 只获得自己的 Endpoint 和显式授权 chatgpt/main recipient。MCP 使用配置的精确 Pi recipient；提供等价授权目标发现，不接受 sender 参数。
3. 在全部相关 runtime 路径增加 deny-only current-policy 检查，包括 payload read、ACK 和 renewal，使已撤销/未加载/不匹配 policy 不能继续保留有效访问。
4. Resume/begin 前增加已验证逐 Session/process 互斥；reload/不确定清理期间保留 fail-closed latch。现有 capability 和 ownership 操作保持不变。
5. 确保 callback、待确认操作、Session 变化及 reload 不使用过期 runtime context 或 registration revision。

<a id="task-4-integration-verification"></a>

## 任务 4：集成验证

文件：test/ 下新增集成测试和 fixture；只补最小命令 help/usage 文档。

- 用两个隔离 OS 进程和临时合成 Store 执行真实 Store/Host/MCP/extension 路径：并发 A/B、定向 ChatGPT 发送、A/B 回复、跨 recipient read/ACK 拒绝、release/reload/resume 隔离、增加 C、撤销 A、重复同 Session 进程。
- 覆盖 legacy config、部分 generation、reload 失败、过期 policy、未知 Owner、过期 lease、过期 fencing、Store 身份不匹配及仅表示接收的 ACK 语义。
- 先定向测试，再 contract/type/build 检查和完整相关软件包测试。真实 Tunnel 和 ChatGPT 验收明确为 NOT RUN。
- 不创建真实用户 registration、不读取真实 credential/store payload，不用真实 messaging tool 替代 fixture。

<a id="task-5-fixed-target-review-and-delivery"></a>

## 任务 5：固定目标评审及交付

- 冻结精确 tree/commit，记录 base 69e3e920332316b0ccccdbf3df1235eaf19d94e2、变更路径及验证证据。
- 四条全新隔离只读 lane：A diff/privacy/docs；B authority/frozen architecture；C validation/coverage；D standards/maintainability。目标相同。目标改变后重新评审相关内容。
- 泄漏、非预期授权、Owner race、将未知持久化当 rollback 或证据不足均阻塞。若需改变冻结 Storage/protocol/Ownership 语义，停止并请求设计评审。
- 只有全部本地验收和所需评审关闭后才提交。不 push/PR/merge/release。将本地证据与另行授权的真实 A/B/Tunnel/ChatGPT 运行分别报告，不将交接标为 CLOSED。
