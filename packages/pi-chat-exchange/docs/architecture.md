# pi-chat-exchange 开发者架构指南

本文说明消息、Endpoint/Session authority、transport 与 Pi 适配器的边界。用户入口见[快速开始](tunnel-setup.md)，多项目操作见[多 Session 使用](multi-session-usage.md)。精确约束仍以协议、Storage 与 Ownership 契约及源码 gate 为准。

## 分层与依赖方向

```text
ChatGPT (Tunnel MCP / Desktop stdio)          Pi runtime
              |                                  |
        src/bin + src/control/mcp          pi-extension/index.ts
              |                                  |
              |                          src/endpoints/pi
              +---------- src/host ---------------+
                              |
                         src/storage
                              |
                           src/core
                              |
                         src/protocol

src/tunnel: transport/profile/setup/Manager；不替代 CE Host authority
```

| 层 | 职责 | 不应做什么 |
|---|---|---|
| `src/protocol/` | 中立实体、lifecycle、action grants、support declarations | 不依赖 Pi、MCP、网络或数据库 |
| `src/core/` | 纯证据/授权规则，reference in-memory 行为 | 不读 env、文件或真实调用 endpoint |
| `src/storage/` | 私有 SQLite、事务、schema/migrations、Ownership/fencing、最终数据授权 | 不把 private SQL/migration/evidence 类型暴露到 public barrel |
| `src/host/` | adapter-neutral durable Endpoint Host，可信 binding、Session、幂等消息与 receipt 操作 | 不从 tool 参数接受 sender/capability，不替代外层工作流完成权威 |
| `src/control/mcp/` | MCP schema/输出；默认 ping，注入 bound port 后提供 messaging | 不读任意 env、不直接 import Pi integration，不凭工具调用识别 ChatGPT 对话身份 |
| `src/endpoints/pi/` | Pi Session host 的薄适配 | 不 import MCP SDK 或其他 endpoint integration |
| `src/bin/` | stdio 组合根、可信绝对路径 `--config`、进程生命周期 | 不另造消息 broker 或平行 authority |
| `pi-extension/` | 运行时 Session lookup、工具/命令、生命周期、UI、mapping identifiers | 不持久化 capability，不代替 Storage 决定可见性 |
| `src/tunnel/` | client 生命周期、健康测量、私有配置事务、masked 输入与显式激活 UI | 不把 CONNECTED 当消息 Gate，不隐式读取/ACK/重试消息 |

核心依赖向内：`bin → control/endpoints/host → storage → core → protocol`，具体许可由 `scripts/check-contract.mjs` 的 TypeScript AST gates 决定。protocol/core 不可 reach 外层；control 与 endpoints 不互相 import；禁止借 barrel、dynamic import 或 require 绕开。tunnel 属外层组合，不提升协议权威。共享行为优先下沉已有 Host/Storage seam，不让 ChatGPT/Pi 各实现第二套 Message 系统。

## 身份模型与注册权威

- **Exchange**：关联聚合，不是一个对话或 transport 连接；namespace/idempotencyKey 只负责确定性 bootstrap。
- **EndpointRef**：`{adapter, endpointId}` 是非秘密身份。初始配对为 `chatgpt/main` 与 `pi/main`；多 Session 时每个 Pi Session 显式注册独立稳定 Endpoint（如 `pi/project-B`）。各 Endpoint 是独立 Authority，不共享 Owner；共享 ChatGPT inbox 不是对话隔离。
- **Participant**：Store/Exchange 中注册的参与者；与当前具体 Session/incarnation 分开。
- **CE Session / Ownership / fencing**：活跃执行权威与 incarnation，需 membership、lease、current owner、fencing 和精确作用域 capability 一起校验。
- **Pi runtime Session ID**：从可信 Pi API 取得，作为 operator allowlist lookup。不是 CE Session ID，也不是凭自身能发消息的凭据。
- **Recipient label**：工具 `to` 使用精确 endpointId，不是认证。labels、support declarations、工具存在和 UI 选择都不直接发 authority。
- **Capability**：Host 内存中的 scoped authority；不写 mapping/日志/配置，不让模型自选。

MCP 身份固定于 operator-owned `--config`，不是由一次 MCP invocation 或 ChatGPT 当前文字声明认证。Pi 身份固定于可信 allowlist 与当前 context。两边共享 Store directory/file 与 Exchange namespace/key；任一不同都没有自动路由补偿。`managed`/`managedBy` 是 provenance，不是替代 recipients 或 Storage 检查的许可。

### 多 Session：配置准入不取代 durable authority

`src/tunnel/{multi-session-policy,multi-session-admission}.ts` 管理 profile 选中的不可变 registration 策略；`pi-extension/multi-session-runtime.ts` 管理当前进程 guard。注册绑定可信 native Pi Session、稳定 Endpoint、active/revoked 状态与 epoch，payload/ACK 独立 opt-in；不从项目路径或模型参数推导身份。

- convert/register/revoke 需人工确认、配置 revision 校验与 verified STOPPED transport lock；不自动启停，也不能约束仍在运行的旧二进制。
- Pi factory grants 在 reload 前不变；MCP child 在显式 Stop/Start 前不能宣称已加载新 generation。selected configured、loaded、bound、connected 分开报告。
- deny-only gates 约束后续准入，包括 read/renew；已经准入的操作可能完成。正常 end/release 不被撤销门禁阻挡；撤销不删除 Owner、Participant、历史消息或 Receipt。
- process mutex 是本地 exclusion，不是 CE authority/recovery。runtime/epoch/Store/Exchange 与 guard 均须一致，最终权限仍由原 Host/Storage 校验；不增加 takeover 或跨 Exchange router。
- `/ce-tunnel sessions` 仅在当前 runtime 经 admission 后投影所选 active Endpoint IDs；不读取 Inbox，不证明运行中的 MCP 已加载。

## Message、DeliveryAttempt、Receipt、Result 的分离

1. `ce_send` 将一次逻辑发送持久化为独立 Message；Message、幂等记录与创建 Audit 在本地 Store 同一事务提交，不证明云端传输或对端接收。key 在 Exchange 内作用域化，相同 key/请求重放原记录，改变正文或 Endpoint 则冲突；这不授予未知结果重试许可，也不承诺 exactly-once delivery/execution。反向回复/后续追问也是新 Message，不是 Result 的变形。
2. Inbox 按 creation Audit 有界扫描并应用 recipient/membership/join boundary，不 ACK、不消费、不推进 delivery cursor。
3. metadata read 与 payload read 是不同权限；后者在 materialize bytes 前完成 Storage 授权。
4. ACK 追加 immutable reception receipt，第一次 CREATED、已有则 REPLAYED。Message 创建 Audit sequence 与 receipt Audit sequence 是不同证据。
5. Result 是 immutable processing evidence，发布不自动回复、关闭 Exchange 或赋予 Wayforge completion authority。

纯 core 的完整 delivery lifecycle 仍约束 claim、dispatch intent、attempt、runtime evidence、settlement、quarantine。不能因为当前工具提供持久消息/ACK，就宣称所有远端 delivery/execution/result 流程均已落地。

**冻结安全语义：** intent 先于 effect；需相关 Message/Attempt/Endpoint/incarnation/lease/fencing 证据。模糊 delivery 进入 `DELIVERY_UNKNOWN`，不 retry/requeue，不将它改成 `CANCELLED`。已知送达但执行未知也不能合成 acceptance/settlement/Result。普通 close 需所有 Message 完结；独立授权的 `ABANDONED_UNRESOLVED` 保留未知事实，不代表 cancellation/normal close/success。

CE Receipt、Pi UI 通知、Tunnel health、runtime 执行事实和 Wayforge 工作流裁决是不同平面。任何外部完成动作仍须其本身的显式授权和证据，不能从 ACK 或模型断言推导。

## 生命周期、并发与恢复边界

- MCP startup bind 使用 `requireUnowned`；独立 heartbeat 续租。SIGINT/SIGTERM/stdio-close 走一次 release/end，不自动接管 crashed Owner。
- Pi `session_start` 按可信 runtime lookup 选择 Endpoint；有 mapping 的 startup/reload/resume 校验恢复。reload 缺 mapping 拒绝，新/fork 不继承旧 authority。
- Pi reload 结束旧内存 generation/timer，不结束有效 durable Ownership；正常退出/Session replacement 尝试 end/release/detach。renew/end 未知或 diagnostic persistence 失败锁住后续路径。
- `ce-mapping`、`ce-messaging-released`、`ce-lifecycle-blocked` 仅存 identifiers/拒绝证据，不携带 capability。释放标记不能独立授予新权威，需验证旧 mapping 的 exact released+detached proof。
- 显式 activation 在 profile lock 下核实当前配置/环境/runtime，只有 requireUnowned 可绑定。匹配已有有效 binding 为 no-op；未知释放、映射写入失败或旧 Exchange 证据不符拒绝，不自动 takeover。
- `/ce-tunnel deactivate` 在确认与当前 generation/Session fence 后复用 `shutdownCe()` 正常结束路径；仅释放本地 CE binding，保留 registration/history/transport。未知 end 或证据持久化失败仍关闭操作；已释放 mapping 不在 reload 时自动重绑，只有显式 activate 可重新申请。
- Tunnel 管理的是 detached client 的进程所有权，不是 CE Owner。跨进程 directory lock、PID+exact command+start key、write-ahead termination ledger 共同避免误杀/双启动；UNKNOWN 不等于进程消失。
- 每个 record-backed run 最多一次 SIGTERM，不 SIGKILL、不 name-based bulk kill。intent 持久后信号丢失允许零次实际 signal；不能删除 ledger 以便重发。client MCP child 属 client，不由 Manager 擅自终止。

恢复 CLI 是另行授权的 operator-only 路径，既不注册为 MCP tool 也不由模型自动调用。进程恢复、CE Owner 恢复、消息未知结果调查是三个不同问题。

`/ce-tunnel doctor` 是独立只读安装诊断：host qualification、child executable qualification 与 client metadata trust 分开；复用现有 executable admission，不启动 Manager/client、不读取 credential 或 Store、不发布配置。它不证明 profile 当前 child 命令、client schema 兼容、云端权限或网络健康；对应证据仍由配置/真实兼容测试和 Manager 提供。

## 配置 generation 与原子迁移

源码定位：`src/tunnel/{profile,managed-binding,messaging-config,setup}.ts`，UI 在 `setup-ui.ts` / `secure-input.ts`，加载/激活在 `pi-extension/index.ts`。

- Profile 是唯一 activation pointer。普通 binding 由完整 Tunnel/Organization/adapter 身份生成，文件名短尾只显示，不承担完整 identity 比较。
- Advanced Messaging 发布完整 binding 与 Pi allowlist sidecar，名称 `messaging-<full SHA-256>.yaml` 及其 `.pi-allowlist.json`。digest 同时覆盖两份 bytes；generation 使用 no-overwrite link，loader 拒绝不完整/不符 pair。
- 两个文件发布不是跨文件 crash-atomic；最终 profile temp+rename 才是逻辑提交点。失败可能保留未选中的私有 staging/generation，不回滚或删除不确定属于谁的文件。
- Credential 替换先创建 0700 目录与 0600 exclusive generation，同步目录/内容，再提交引用；macOS 先清 inherited ACL。Keep 不读取内容，旧代保留，无自动 GC。
- postcommit sync 失败只能报 durability uncertain，不能说 rollback。ACTIVE/UNKNOWN 不能被 UI 文字绕过为可编辑。
- `/ce-tunnel migrate` 仅修 canonical generated YAML：移除 client 0.0.16 拒绝的 admin_ui 项并修批准 Node command，保留 identity/credential reference/binding/Store/recipient bytes；不是任意 YAML formatter。

## Storage 运行契约

当前开发候选的正式 Node 声明为 **>=24.20.0 <=24.22.1**；内部仅将稳定 Node 24（>=24.12.0）、25、26 作为候选，不能据此宣布全部兼容。准入要求 SQLite **>=3.51.3**（排除已知 WAL-reset 缺陷）、可读且格式合法的 source identity、必要编译选项（`THREADSAFE=1`、`MUTEX_PTHREADS`；禁止 `OMIT_WAL`、`OMIT_FOREIGN_KEY`、`OMIT_TRIGGER`、`OMIT_CHECK`、`OMIT_COMPILEOPTION_DIAGS`）以及共享 defensive、statement、事务/savepoint authorizer、提交/回滚、STRICT、JSON、CHECK、FK 与 trigger 行为探针；不再固定 SQLite 3.53.4 或 source ID。Node 24.19.0、25.9.0 因隔离实验复现 native transaction-close SIGSEGV 明确拒绝，Node 26.12.1 仅作预览。Store 路径准备前拒绝不合格 runtime；环境版本标签不是资格证据。平台 allowlist 仍为 macOS arm64 / Linux x64，实际回归为 macOS arm64；详细矩阵见仅仓库保留的 `docs/runtime-qualification.md`。已发布 npm 0.2.0 的精确白名单不变。文件系统、ownership、0700/0600、symlink 限制与 writer WAL/FULL、foreign keys、trusted-schema OFF、有界 busy wait、macOS fullfsync/checkpoint_fullfsync 要求保持不变。

migration ledger/checksum、application/store identity、integrity 与 restore hold 会拒绝 foreign/newer/corrupt Store，不自动 reset。能执行 Pi UI 不代表能打开 CE Store。实际准入以 `src/storage/runtime.ts` 与 [Storage contract](storage-contract.md) 为准；内存探针不证明磁盘锁或崩溃耐久，文件权限不能消除所有 TOCTOU、mount substitution、OS crash/power loss 风险。

## 验证层次

从包目录、批准 Node 运行：

```bash
pnpm run check
pnpm run typecheck
pnpm run build
pnpm test
pnpm run test:plugin-package
# 可选（需本机已安装 tunnel-client；不属于默认门禁）
pnpm run test:installed-client
# 可选（真实 Pi CLI + PTY 的 crash/resume 回归；数分钟，不属于默认门禁）
CE_HOST_REGRESSION_KEEP=1 pnpm run test:host-regression
# 完整串行门禁（build 在 test 前）
pnpm run verify
```

| 层次 | 证据范围 | 不能替代 |
|---|---|---|
| AST/type/compile-negative | 依赖方向、封闭 schema、类型拒绝 | 真实 runtime/客户端行为 |
| core/protocol unit | 纯状态转移、scope、quarantine/authority | 文件事务/远端结果 |
| Storage 事务/故障/多进程 | identity、lease/fencing、crash、并发、read/ACK privacy | ChatGPT UI 或云端连接 |
| Host/MCP/Pi isolated harness | 参数、工具发现、mapping、activation、payload/ACK、生命周期 | 实体终端和端到端用户 Gate |
| Tunnel offline / TUI harness | 合成 health、取消/在途/通知/屏幕契约 | 真实 client schema、认证、计费连接、终端物理表现 |
| `test/tunnel/real-client-compat.test.ts` | 真实 client doctor 与本地 schema 兼容；可选 lane（`pnpm run test:installed-client`），需本机已安装 tunnel-client，未安装时按可用性跳过；已排除出 `pnpm test` 与 `pnpm run verify` | 真实网络 readiness 或双向消息 |
| `test/tunnel/offline.integration.test.ts` | 真实 client 的离线集成；同一可选 lane，需本机已安装 tunnel-client，未安装时大声失败而非静默跳过；已排除出 `pnpm test` 与 `pnpm run verify` | 真实网络 readiness 或双向消息 |
| `test/host-regression/real-host-recovery.test.ts` | 真实 Pi 1.3.0 CLI + 真实 PTY 的 crash→mutex 拒绝→离线 reconcile→resume→租约续期→授权路由完成→策略收窄拒绝→expired Owner 拒绝（含 reason/hint、fencing、slot 计数）回归；可选 lane（`CE_HOST_REGRESSION_TEST=1 pnpm run test:host-regression`），先以 `git archive HEAD` 出树编译并比对 blob 身份，全合成 Store/loopback provider，零 tunnel-client 执行；前置缺失或未设 opt-in 时大声失败而非跳过；已排除出 `pnpm test` 与 `pnpm run verify` | 真实 Tunnel/Exchange、真实凭据/网络、ChatGPT UI、installed client、Operator Recovery 执行 |
| packaged plugin tests | 可移植包内容、stdio 启动、tool discovery | Desktop 安装菜单/资格/对话更新 |
| 人工 real Gate | 当前 ChatGPT 对话与 Pi 的实际 send/list/read/ACK、Tunnel 启停 | 冷启动、所有平台、所有客户端或正式发布资格 |

真实 Host lane 的证据留在原始临时根目录，不复制到另一处。`CE_HOST_REGRESSION_KEEP=1` 保留成功运行的证据；测试、进程/provider 清理（含本地超时）或清理记录写入失败时不启动删除，并尽力打印原始路径。仅在所有测试成功、驱动已等待并回收其自有子进程、合成 provider 已关闭、清理记录写入成功且未设 KEEP 时删除根目录。递归删除本身失败可能已部分移除证据；此时聚合错误以 `possibly-partially-removed` 标明状态并尽力打印原始路径，不承诺完整保留。两次离线 reconcile 均由驱动确认并记录**当前启动实例**的退出/回收身份，且在串行离线窗口前后再确认无存活自有 Store-capable 进程；未确认退出即拒绝执行，不以 `/quit` 加固定等待代替。默认收集的 `test/host-regression/*-cleanup.test.ts`、`failure-path.test.ts` 与 `refusal-comparator.test.ts` 只验证合成进程清理、离线屏障、故障证据状态和拒绝前后完整 message/audit 数组比较，不启动真实 Pi/client 或业务恢复。

本地测试只对其实际执行的固定版本与环境提供证据，跳过项和平台限制必须明示。人工消息验收与隔离回归互不替代；不要将历史报告的测试数当作当前变更的新鲜执行证据。公共验收边界见[README](../README.md)。

### 高价值回归入口

- `test/tunnel/{setup-messaging,messaging-config,messaging-config-security,messaging-binding}.test.ts`：配对、immutable publication、权限/文件与失败路径。
- `test/endpoints/pi/extension-messaging-activation.test.ts`：旧映射释放、reload、显式 activation、deny paths。
- `test/endpoints/pi/extension-ack.test.ts` 与 `test/control/mcp/messaging-ack-tool.test.ts`：独立 opt-in、四字段与模型可见 metadata。
- `test/tunnel/{background-manager,extension-deferred-start,real-client-compat}.test.ts`：进程证据、异步启动和真实 schema。
- `test/storage/delivery-ack*.test.ts`、`inbox-*.test.ts`：receipt、privacy、事务/进程边界与分页。

## 扩展点与已知债务

- 新 ControlSurface 必须使用既有 Host port、封闭请求 schema 与 adapter-neutral 规则；不能从不可信 label 自授权。
- 新 endpoint integration 声明独立 support，不假设 peer capabilities 对称；unsupported/unknown 保持明确，需真实 evidence 才能声称实现。
- 新 client 版本要真实 schema/doctor 回归，不能仅用 offline fixture；新 Node/SQLite/平台先独立资格验证，不能放松 runtime guard。
- UI/异步任务要保留 draft/commit 边界、Session generation、在途合并、取消/teardown 的权限分离；不以通知成功当显示/送达成功。
- 仍待后续：credential/generation 的显式安全 GC、机器冷启动与部分实体终端交互、受控 client 安装/升级流程。Desktop 已支持对私有副本显式配置本机批准 Node；这不是自动跨机安装或 Desktop UI 验收。
- 不在当前范围：自动 Inbox draining/idle wake、自动业务重试/Owner takeover、自动远端执行、任意 Store 合并或跨 Exchange router、以 ACK 代替任务完成。

## 文档事实溯源与维护

| 事实 | 首要源码/证据 |
|---|---|
| 版本与 scripts | `../package.json`、仓库根 `package.json`、`src/storage/runtime.ts` |
| Pi 加载与 session_start/reload | Pi 1.3.0 CLI help / extensions 文档与运行时 `AgentSession.reload`；本包 `pi-extension/index.ts` |
| Tunnel 字段/格式/child env | `src/tunnel/profile.ts`、`setup-ui.ts`、`background-manager.ts` |
| binding closed schema / opt-in | `src/host/mcp-binding-config.ts`、`src/control/mcp/` |
| generation/Store/Exchange 一致性 | `src/tunnel/{managed-binding,messaging-config,setup}.ts` |
| 工具参数/ACK metadata/状态 | `pi-extension/index.ts`、Host port、对应 extension-ack / messaging-ack tests |
| 当前支持与验收边界 | [README](../README.md)、对应隔离测试与独立人工验收；公共文档不复制原始消息/Session/日志 |

历史 plans/audits/validation 报告保留其时间截面，不应机械改写为“今日已全部完成”。发现代码/配置与文档目标冲突时记录限制、另开实现任务；文档提交不偷偷改 runtime 或冻结契约。
