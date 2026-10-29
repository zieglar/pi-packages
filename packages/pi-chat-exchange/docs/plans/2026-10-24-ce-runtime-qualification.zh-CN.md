[English](./2026-10-24-ce-runtime-qualification.md) | [简体中文](./2026-10-24-ce-runtime-qualification.zh-CN.md)

> 历史计划（2026-10-24）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ce-dual-runtime-qualification-implementation-plan"></a>

# CE 双运行时资格验证实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 在 24.21.0 之外正式验证精确 Node 24.22.1，不扩大为宽泛版本范围，不放宽 Store 权限。

**架构：** 单一显式 runtime tuple registry 将每个精确 Node 版本绑定到 SQLite version/source、安全相关 compile-option 要求及现有 platform allowlist。在准备 Store 路径前于内存检查真实身份和必需 API；生产 resolver probe 使用同一 policy，不接受环境覆盖。认证要求两个真实 binary 通过 persistence、双向 Store interoperability、recovery/concurrency 和 Host/MCP security 测试，不能只靠 API probe。

**技术栈：** TypeScript、内置 node:sqlite/fs/child_process、现有 CE Store/Host/MCP API 和 Vitest；隔离临时 runtime 安装及 Store。

<a id="approved-scope-and-baseline"></a>

## 已批准范围和基线

用户以 `continue` 批准此设计。父会话是交接 main checkout 的唯一写入者；不得并发写入、切换 branch、中间提交、push/PR/release，或改变全局 Pi/Node 配置。基线 main HEAD `00c01d43f6a83293650da75deae97e47fb0158a1`；已安装 Pi package1.3.0。只读基线证据 `/tmp/ce-runtime-qualification-3s2AZH/baseline.json`：tracked/index 干净、无冲突、upstream origin/main、ahead77/behind0，保留已有 root AGENTS.md/.herdr-web-ui；不动其他 worktree，不 fetch。

不使用真实 client/Tunnel、凭证、用户 Store 或真实消息。不修改 Store schema/trust root/Ownership/session routing/protocol/capability/ACK，不引入 migration。授权范围是精确 runtime policy 变化及更早的准入顺序，不重开持久契约。现有仅构造器可用的测试身份接缝不能成为生产绕过。

<a id="task1-acquire-and-characterize-real-identities-read-only-production-code"></a>

## 任务 1：获取并刻画真实身份（生产代码只读）

1. 只将官方 Node24.22.1 Darwinarm64 archive 下载到私有证据目录；对照官方 HTTPS SHASUMS 验证 SHA256。记录签名验证限制。不全局安装。
2. 用内置 node:sqlite 和内存 DB probe 两个真实 binary；记录真实 Node/platform/arch、SQLite version/source、完整排序 compile option 及必需 API shape。保留命令和失败。
3. 扩大支持前停止并分析任何 SQLite 差异。初始观察：两者均为 SQLite3.53.4、source 相同、50 个 compile option 相同；这是 characterization，不是 certification。
4. 记录必要 policy：线程安全、启用 mutex 的 SQLite；拒绝禁用 WAL、foreign key、trigger 或其他必需安全行为的 compile option。保留完整 compile-option 清单供评审，不固定无关 compiler-label 差异。在文件系统访问前增加真实 API 检查（defensive support、statement、transaction state）；支持缺失或异常时拒绝。

<a id="task2-test-first-registry-and-pre-path-refusal"></a>

## 任务 2：测试先行 registry 及路径处理前拒绝

**文件：** `src/storage/runtime.ts`、`src/storage/store.ts`，仅必要时改 `src/storage/connection.ts`；`test/storage/runtime.test.ts`、`test/storage/connection.test.ts` 及定向 runtime-admission 回归文件；改动前阅读 storage path/readonly API。

1. 增加失败测试：精确24.22.1 正例、未知25.x/24patch 拒绝，保留24.21行为。增加 compile option 缺失/格式错误、禁止 option、source/platform 不匹配、伪造 env version 测试。类型化 fixture 必须携带所有必需身份证据；缺失数据不能默认批准。
2. 在不合格 runtime 下增加真实 subprocess 测试，断言 initialize/open 路径不被创建或修改。通过隔离测试 mock 增加异常 SQLite API 行为测试，不加生产 override。
3. 在批准24.21 runtime 下运行 RED，保存完整日志/退出状态；随后实现最小显式 tuple registry 和真实身份收集。兼容性 export 只能明确命名为 legacy/default 值，不能成为第二套权限。
4. 确保 initialize/open/read-only 入口在路径准备或磁盘读写前验证真实 runtime；保留后续 connection safeguard 及无关拒绝语义。复查测试接缝，避免现有 domain fixture 削弱生产 preflight。
5. 运行 GREEN runtime 和 connection/lifecycle 测试。若必需认证失败，不提交候选支持；恢复24.21-only policy，同时保留证据。

<a id="task3-test-first-portability-integration"></a>

## 任务 3：测试先行可移植性集成

**文件：** `src/runtime/executables.ts`、`src/runtime/diagnostics.ts`、`src/tunnel/profile.ts`、必要 package engines/docs 及定向 `test/runtime/*`、setup/extension runtime 测试。

1. 增加显式24.22.1、当前24.22.1 及两个受控 legacy 位置测试；24.21 仍接受，其他真实版本全部拒绝。Resolver discovery 必须来自 registry，不能另建批准列表。
2. 扩展已准入 child probe，收集 compile 证据并检查真实必需 SQLite capability。不执行 project PATH；trust/ACL/symlink/mode 检查不变；格式错误显式设置仍拒绝，不 fallback。
3. 更新诊断，标识真实 Host/child 和接受的精确版本，不暗示必须使用同一可执行文件。更新精确 package engine constraint 和有限安装文档，不改全局工具。
4. 在每个 binary 下运行定向测试，包括复制到 mise 外的 Node 及带空格路径。依赖 dist 的测试先 build。

<a id="task4-formal-cross-version-persistence-certification"></a>

## 任务 4：正式跨版本持久化认证

**文件：** `test/storage/` 或 `test/runtime/` 下新增定向资格测试/支持脚本；复用现有 Store/transaction/identity/ledger/trust API，不能只用独立探索 SQLite 作为证明。

1. 增加 subprocess fixture：创建真实临时 CE Store，记录稳定 UUID/schema/identity/ledger 证据及已知提交的合成状态，正常关闭，再用另一个真实 Node binary 重新打开并验证这些证据。
2. 执行24.21→24.21、24.21→24.22.1、24.22.1→24.21、24.22.1→24.22.1。运行 pragma/integrity/foreign-key/identity/migration-ledger 检查；断言没有 migration，trust-root 身份不变。
3. 使用现有 fault/process 测试和跨版本 fixture 边界，执行真实 Store WAL/FULL transaction、锁争用/并发、进程异常退出和恢复、未知写结果处理。不声称 process-kill 测试证明断电持久性。
4. 保留首次失败及全部退出状态；建立兼容矩阵，逐项记录精确 binary/identity/command 和 pass/fail/not-tested。关键持久化缺口阻塞认证。

<a id="task5-hostmcp-and-full-relevant-matrix"></a>

## 任务 5：Host/MCP 及完整相关矩阵

1. 在每个批准 runtime 下运行现有 storage/host/endpoints/MCP/bin 套件，覆盖 Endpoint/Session/Ownership/capability 拒绝及 Inbox/PayloadRead/ACK 授权。只使用合成 fixture 和隔离消息/Store。
2. 在两个批准 Node 下，通过生成的本地 manifest 运行真实 stdio MCP ping/tool discovery；使用 mise 外私有 binary 副本、最小 PATH、隔离 accountHome/binding。不 install/register Desktop，不启动真实 Tunnel。
3. 在每个 runtime 下，从 `packages/pi-chat-exchange` 运行有界的相关完整套件：

   ```sh
   pnpm run check
   pnpm run typecheck
   pnpm run build
   pnpm exec vitest run --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
   pnpm run test:plugin-package
   pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
   ```

   仅为该命令将 child PATH 设为选中 runtime 的绝对 bin，不改全局 config。不运行不受限 `pnpm verify`/`pnpm test`；real-client compatibility suite 的3个用例必须排除。记录 skip、独立 compiler exit envelope 和精确 runtime 身份。保留任何默认并发/时限失败，不因重跑通过而抹去。

<a id="task6-fixed-review-and-local-delivery"></a>

## 任务 6：固定评审及本地交付

1. 所有必需矩阵单元通过后，才冻结最终未提交文件 manifest、byte hash、patch、baseHEAD 和 aggregate fingerprint。资格验证未完成时，候选支持不提交。
2. 四条独立全新上下文 lane A diff/privacy/docs、B authority/frozen architecture、C validation/coverage、D standards/maintainability 评审同一固定目标。记录请求和实际模型；路由 fallback 到同家族时，不伪称跨家族独立。
3. 用测试证据关闭 blocker；重新冻结/评审变化目标。父会话综合保留分歧、证据限制和显式资格矩阵。
4. 精确 stage 已评审文件；仅在全部必需认证和评审通过后创建一次授权本地提交。验证已提交字节和 parent，不 push/PR/merge/release。
5. RESULT 报告：HANDOFF ID/status/verdict/files/commit、两个完整身份、兼容矩阵、执行测试/退出状态、跨版本 Store 结果、四 lane 证据、首次失败/skip/平台风险和下一步。等待 ChatGPT 接受。
