[English](./2026-10-08-durable-storage-foundation.md) | [简体中文](./2026-10-08-durable-storage-foundation.zh-CN.md)

> 历史计划（2026-10-08）。下文的提案、命令、约束和观察记录属于当时的工作，不代表当前实现、支持范围、发布状态或执行授权。当前用法见[软件包文档](../../README.zh-CN.md)。

<a id="durable-storage-foundation-implementation-plan"></a>

# 持久存储基础实施计划

> **供 Claude 使用：** 必须使用子技能 superpowers:executing-plans，逐任务执行本计划。

**目标：** 为未来持久化 chat-exchange 操作增加私有、基于文件的 SQLite 基础，不增加业务操作或公开存储 API。

**架构：** Host 专用存储放在 `src/storage/`，使 protocol/core 保持纯粹。集中式连接工厂负责运行时/引擎资格、文件系统检查、每连接 PRAGMA、schema 身份及重新打开验证。同步 `BEGIN IMMEDIATE` helper 负责权威写入，并将驱动失败转换为私有类型化错误。

**技术栈：** TypeScript 5.9、Node 24.21.0 `node:sqlite`、SQLite 3.53.4、Vitest 4、基于文件的临时数据库。

---

<a id="task-1-runtime-and-filesystem-eligibility"></a>

### 任务 1：运行时和文件系统资格

**文件：**

- 创建：`src/storage/runtime.ts`
- 创建：`src/storage/filesystem.ts`
- 测试：`test/storage/runtime.test.ts`
- 测试：`test/storage/filesystem.test.ts`

1. 为精确 Node、SQLite、source-id 的接受/拒绝，以及受支持的平台/架构组合编写测试。
2. 运行定向测试，确认因私有模块尚不存在而失败。
3. 实现精确运行时检查，以及 fail-closed 的路径、符号链接、所有权、权限模式、生产 Pi 目录和可检测挂载检查，不声称能普遍检测所有挂载。
4. 运行定向测试并确认通过。

<a id="task-2-centralized-connection-policy"></a>

### 任务 2：集中式连接策略

**文件：**

- 创建：`src/storage/connection.ts`
- 测试：`test/storage/connection.test.ts`

1. 编写基于文件的测试，覆盖 defensive mode、每连接运行时检查、FK/trusted-schema/busy-timeout/synchronous 回读、WAL、auto-checkpoint、macOS fullfsync/checkpoint_fullfsync、本地重新初始化、FK/UNIQUE 强制约束及错误引擎注入测试接缝。
2. 运行并确认预期失败。
3. 实现单一私有连接工厂，不提供默认路径，也不降低持久性要求。
4. 运行并确认通过。

<a id="task-3-transaction-primitive"></a>

### 任务 3：事务原语

**文件：**

- 创建：`src/storage/transaction.ts`
- 测试：`test/storage/transaction.test.ts`

1. 为 `BEGIN IMMEDIATE`、commit、回调 rollback、同步回调拒绝 Promise 结果、检查事务状态后的延迟 FK 提交失败清理、有界 busy 行为、条件 CAS 和私有类型化错误编写测试。
2. 运行并确认预期失败。
3. 实现最小同步事务原语和错误映射。
4. 运行并确认通过。

<a id="task-4-private-schema-and-store-lifecycle"></a>

### 任务 4：私有 schema 和 Store 生命周期

**文件：**

- 创建：`src/storage/schema.ts`
- 创建：`src/storage/store.ts`
- 测试：`test/storage/store.test.ts`

1. 为初始化/重新打开、UUID/application/protocol 元数据、version/checksum ledger、必需实体/键/FK/唯一性/索引，以及 foreign/newer/checksum/corrupt/restore-hold 拒绝编写测试。
2. 运行并确认预期失败。
3. 实现最小 version-1 私有 schema，包含 Exchange、Message、Attempt/current claim/fencing high-water、Result、idempotency、evidence envelope/application、reconciliation、disposition、audit event、metadata、migration ledger 和 restore hold。不实现业务修改操作。
4. 运行并确认通过。

<a id="task-5-architecture-and-metadata-gates"></a>

### 任务 5：架构和元数据门禁

**文件：**

- 修改：`scripts/check-contract.mjs`
- 创建：`scripts/fixtures/protocol-imports-storage.fixture.ts`
- 创建：`scripts/fixtures/core-imports-storage.fixture.ts`
- 创建：`scripts/fixtures/public-exports-storage.fixture.ts`
- 修改：`package.json`
- 修改：`docs/architecture.md`

1. 扩展架构测试/门禁：protocol/core 不得到达 storage/FS/`node:sqlite`；公开导出不得暴露 storage/SQL/driver/transaction/migration/私有 evidence 类型；storage 不得依赖 Wayforge/Pi runtime；MCP 仍仅提供 ping。
2. 运行门禁，确认每个负向 fixture 都能证明拒绝。
3. 将持久化 Host 运行时元数据设为精确 Node 24.21.0，同时在可行时保留纯模块的源码兼容性，并记录私有边界和限制。
4. 运行 gate、typecheck、build 和软件包测试。

<a id="task-6-final-verification"></a>

### 任务 6：最终验证

1. 在 `mise exec node@24.21.0 pnpm@12.9.1 --` 下运行所有软件包检查。
2. 在可行时运行工作区检查，不修改无关软件包。
3. 记录精确 runtime/SQLite/source 身份、测试数量、跳过项和平台限制。
4. 检查 `git diff --check`、`git status`、变更路径，确认没有 `packages/wayforge` 改动。
5. 不提交；随后由父会话评审并进行一次有限提交。
