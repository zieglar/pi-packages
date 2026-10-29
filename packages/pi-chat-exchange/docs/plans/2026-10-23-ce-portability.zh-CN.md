[English](./2026-10-23-ce-portability.md) | [简体中文](./2026-10-23-ce-portability.zh-CN.md)

> 历史计划（2026-10-23）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="ce-runtime-portability-implementation-plan"></a>

# CE 运行时可移植性实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 让已经通过资格验证的 Node 24.21.0 安装无需 mise 或开发机路径即可使用，同时保留全部 CE 权限和运行时契约。

**架构：** 增加一个有界的可执行文件准入和 Node 资格边界，供生产 setup 与本地 Desktop 配置复用。先选择操作员显式路径，再选合格的当前可执行文件，再选固定系统位置；不搜索项目 PATH，不在文件系统信任准入前执行候选。可移植 Desktop 制品保持未配置，直到显式的逐机器操作生成经过资格验证的绝对 Node command。

**技术栈：** TypeScript、Node child_process/fs、现有 storage runtime assertion、Vitest、本地 ESM 打包脚本。

<a id="authorization-and-frozen-contracts"></a>

## 授权和冻结契约

- 基线：main 位于 ae6efc87935ab8060fccd7ce43d05649a6daafd6。父会话是唯一写入者。保留无关未跟踪文件。
- 不修改 storage/runtime.ts、批准的 Node/SQLite/source/platform 身份、Store/Session/Ownership/protocol/schema/capability/ACK 契约或多会话架构。
- 不运行真实 Tunnel/client、不读取凭证或用户 Store、不注册 Marketplace 软件、不修改全局 Pi 配置、不发送消息、不 push、不 release。
- 不做中间提交。仅在四条评审 lane 和父会话综合评审关闭 blocker 后，本地提交精确的已评审文件集。
- 两个现有只读 scout 可细化文件/API 细节；其结果是证据，不构成扩展范围的授权。

<a id="design-and-refusal-behavior"></a>

## 设计与拒绝行为

1. 显式可执行文件配置必须是可规范化的绝对路径。在任何子进程 probe 前验证原始路径、符号链接解析、可执行普通文件元数据、所有权及可写祖先。拒绝项目内可执行文件和相对/空/PATH 候选。只沿经过验证的符号链接到达可信规范目标。不接受 group/world-writable 可执行文件或可变遍历组件。临时测试使用 OS 所有、带 sticky 位的临时祖先下的私有目录。
2. Node 选择顺序：显式 CE Node 配置（无效则拒绝，不静默 fallback）、合格的当前 Pi 可执行文件、受控系统候选，再到经验证的旧 mise 位置以保持兼容。系统发现采用固定 allowlist，不依赖继承 PATH；可选 Homebrew 位置只是候选，不是必需默认值。候选执行使用 argv、不用 shell，环境最小化且不含 NODE_OPTIONS 或 loader 注入，时间和输出有界；内存 SQLite 身份 probe 由不变的 storage qualification assertion 检查。当前 Pi Host 仍独立受现有 Store runtime guard 约束；选择其他 child 不会升级 Host。
3. Client 选择：显式可信绝对 client 配置，或受控系统候选。发现期间不做版本/health/network probe。现有精确进程身份规则需要时，保留所选绝对调用路径的拼写；不放宽 wrapper 证据、UNKNOWN、跨进程锁或 stop-fail-closed 行为。缺少 client 时允许检查/修复，但在任何真实进程动作前拒绝 spawn。
4. Desktop 分发：不含开发机路径，不使用未经资格验证的 `node` command。可移植制品没有可运行 stdio server，直到本地配置操作验证所选 Node 并写入标准 MCP server entry。生成 manifest 只属于操作员本地副本，不进入可转交 ZIP/Marketplace 输出。配置不安装、注册、启动任何东西，也不访问 binding/Store。Secure Tunnel 不需要 Desktop Marketplace 插件。
5. 诊断暴露稳定拒绝原因、净化后的当前 Node/版本和修复指导，不暴露原始 child stderr、凭证、任意环境数据或私有 binding 内容。

<a id="task-1-executable-trust-and-node-qualification-tdd"></a>

## 任务 1：可执行文件信任及 Node 资格（TDD）

**文件：** 创建 `src/runtime/executables.ts` 和 `test/runtime/executables.test.ts`；只读 `src/storage/runtime.ts`。

1. 增加失败测试，覆盖显式批准选择、无效显式拒绝、当前批准可执行文件、受控发现、无 mise、忽略恶意项目 PATH、空格、符号链接目标、权限、缺失可执行文件及未批准身份。
2. 在批准 Node 下运行新 Vitest 文件，确认是行为/缺失 export 失败。
3. 将元数据准入与执行分开实现；可注入 filesystem/probe 接缝只是单元测试依赖，不是环境资格覆盖。
4. 只 probe 已准入候选；解析有界身份 JSON，并调用现有资格 assertion。版本相等不等于完整资格通过。
5. 运行测试及不变的 `test/storage/runtime.test.ts`。

<a id="task-2-production-setup-and-diagnostics-tdd"></a>

## 任务 2：生产 setup 和诊断（TDD）

**文件：** 修改 `src/tunnel/setup.ts`、`src/tunnel/profile.ts` 及相关 setup/profile 测试；仅在诊断/配置集成需要时修改 `pi-extension/index.ts`。

1. 增加回归测试，证明生产选择可使用 mise 之外的批准绝对 Node，拒绝未批准或不可信候选，拒绝后不写可运行 profile。
2. 保留现有纯 profile grammar 和 legacy command 迁移。现有测试中的显式构造器依赖接缝不得变为生产环境绕过。
3. 在生产选择位置集成已准入 resolver。Host Store guard 与 child selection 保持独立，提供可操作的 Host runtime 修复消息。
4. 运行 profile/setup/extension 测试套件。检查 channel token、credential reference、binding reference 和 manager barrier 均不变。

<a id="task-3-portable-client-selection-tdd"></a>

## 任务 3：可移植 client 选择（TDD）

**文件：** 修改 `src/tunnel/background-manager.ts`；扩展 `test/tunnel/background-manager.test.ts` 或定向可移植性测试。

1. 增加失败测试，覆盖可信非 Homebrew 显式 client、受控发现、缺少 client 时不 spawn 而拒绝，以及不执行恶意 PATH。
2. 集成发现，不改变 identity comparison、wrapper parsing、manager record 格式、锁或 stop 行为。
3. 运行 background manager、stop/concurrency、setup barrier 测试；断言旧注入 client fixture 仍执行原始权限逻辑。

<a id="task-4-per-machine-desktop-manifest-tdd"></a>

## 任务 4：逐机器 Desktop manifest（TDD）

**文件：** 修改 `plugin/pi-chat-exchange/mcp.json`、`scripts/package-local-plugin.mjs`、`test/plugin/local-plugin-package.test.ts`、`package.json`；创建有界本地配置脚本及定向测试。

1. 替换固定开发机路径的测试，改为要求未配置分发、不含 `/Users/` 机器路径、不含未验证的 `command: node`。
2. 增加测试：本地 manifest 生成接受批准可信绝对路径（含空格），拒绝不安全/未批准路径，不改变分发模板，不访问 Store/config 凭证，不注册软件。
3. 使用共享准入/资格代码实现显式本地配置；只向选中本地副本写入标准绝对 command manifest，拒绝不安全文件目标。
4. 打包测试只配置临时/本地测试副本，然后在 `/usr/bin:/bin`、无 mise 变量下启动 manifest 的真实 command。只使用临时 binding/Store、ping/tool discovery，不使用 CE 消息。

<a id="task-5-documentation-and-validation"></a>

## 任务 5：文档和验证

**文件：** 有限更新软件包 README、`docs/tunnel-setup.md` 和插件 README。

1. 说明 Host 与 MCP child 资格、显式路径设置、受控发现、不用 mise 的安装、client 修复，以及独立的 Desktop stdio 与 Secure Tunnel 路线。
2. 每项任务后运行定向测试。在批准 Node 下，从 `packages/pi-chat-exchange` 运行下列限定序列；本次交接不得运行不受限的 `pnpm verify` 或 `pnpm test`，因为 installed-client 兼容性套件可能执行真实 client。明确排除它的三个测试。使用有界并发避免已观察到的默认 worker 5 秒超时；不得放宽生产或测试超时。

   ```sh
   pnpm run check
   pnpm run typecheck
   pnpm run build
   pnpm exec vitest run --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
   pnpm run test:plugin-package
   pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
   ```

3. 在新临时证据目录记录命令、真实 Node 身份、退出状态和完整日志。不声称验证了跳过的 privilege 测试或真实 Desktop UI 安装。
4. 使用 mise 之外的真实批准 Node 副本，无 MISE 变量、受控 PATH，复现无 mise 执行；在临时根目录验证真实 MCP ping 和不变的 Store create/reopen。

<a id="task-6-fixed-four-lane-review-and-local-commit"></a>

## 任务 6：固定四 lane 评审及本地提交

1. 冻结精确未提交 delta：base SHA、文件 manifest、patch、SHA-256 fingerprint 及验证证据。
2. 独立运行 lane：A diff/privacy/docs；B authority/frozen contracts；C validation/coverage；D standards/maintainability。记录真实模型 provenance；若路由使用同一模型家族，不声称跨家族独立。
3. 修复 blocker，重跑相关验证，重新冻结/评审变化目标。父会话综合评审必须在同一不变最终 fingerprint 上关闭所有阻塞发现。
4. 只 stage 已评审 manifest，创建一次授权本地提交。不 push/PR/release。
5. 报告 HANDOFF-CE-PORTABILITY-01 RESULT，包含 verdict、文件、提交、测试证据、四 lane 结果、无 mise 证据、未测风险及下一步。等待 ChatGPT 接受，不开始 Node 24.22 工作。
