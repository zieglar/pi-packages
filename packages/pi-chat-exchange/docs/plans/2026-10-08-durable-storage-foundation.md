[English](./2026-10-08-durable-storage-foundation.md) | [简体中文](./2026-10-08-durable-storage-foundation.zh-CN.md)

> Historical plan (2026-10-08). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# Durable Storage Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a private, file-backed SQLite foundation for future durable chat-exchange operations without adding business operations or public storage APIs.

**Architecture:** Place host-only storage under `src/storage/` so protocol/core remain pure. A centralized connection factory owns runtime/engine qualification, filesystem checks, per-connection PRAGMAs, schema identity, and reopen validation. A synchronous `BEGIN IMMEDIATE` helper owns authoritative writes and translates driver failures into private typed errors.

**Tech Stack:** TypeScript 5.9, Node 24.21.0 `node:sqlite`, SQLite 3.53.4, Vitest 4, file-backed temporary databases.

---

### Task 1: Runtime and filesystem eligibility

**Files:**
- Create: `src/storage/runtime.ts`
- Create: `src/storage/filesystem.ts`
- Test: `test/storage/runtime.test.ts`
- Test: `test/storage/filesystem.test.ts`

1. Write tests for exact Node, SQLite, and source-id acceptance/rejection and supported platform/architecture combinations.
2. Run the focused tests and confirm failure because the private modules do not exist.
3. Implement exact runtime checks and fail-closed path, symlink, ownership, mode, production-Pi-directory, and detectable mount checks without claiming universal mount detection.
4. Run the focused tests and confirm pass.

### Task 2: Centralized connection policy

**Files:**
- Create: `src/storage/connection.ts`
- Test: `test/storage/connection.test.ts`

1. Write file-backed tests for defensive mode, per-connection runtime checks, FK/trusted-schema/busy-timeout/synchronous readbacks, WAL, auto-checkpoint, macOS fullfsync/checkpoint_fullfsync, local reinitialization, FK/UNIQUE enforcement, and wrong-engine injection seams.
2. Run and confirm expected failures.
3. Implement one private connection factory with no default path and no durability downgrade.
4. Run and confirm pass.

### Task 3: Transaction primitive

**Files:**
- Create: `src/storage/transaction.ts`
- Test: `test/storage/transaction.test.ts`

1. Write tests for `BEGIN IMMEDIATE`, commit, callback rollback, synchronous-callback rejection of Promise results, deferred-FK commit failure cleanup with transaction-state inspection, bounded busy behavior, conditional CAS, and private typed errors.
2. Run and confirm expected failures.
3. Implement the minimal synchronous transaction primitive and error mapping.
4. Run and confirm pass.

### Task 4: Private schema and store lifecycle

**Files:**
- Create: `src/storage/schema.ts`
- Create: `src/storage/store.ts`
- Test: `test/storage/store.test.ts`

1. Write tests for initialization/reopen, UUID/application/protocol metadata, version/checksum ledger, required entities/keys/FKs/uniqueness/indexes, foreign/newer/checksum/corrupt/restore-hold rejection.
2. Run and confirm expected failures.
3. Implement the minimal version-1 private schema for Exchange, Message, Attempt/current claim/fencing high-water, Result, idempotency, evidence envelope/application, reconciliation, disposition, audit event, metadata, migration ledger, and restore hold. Do not implement business mutations.
4. Run and confirm pass.

### Task 5: Architecture and metadata gates

**Files:**
- Modify: `scripts/check-contract.mjs`
- Create: `scripts/fixtures/protocol-imports-storage.fixture.ts`
- Create: `scripts/fixtures/core-imports-storage.fixture.ts`
- Create: `scripts/fixtures/public-exports-storage.fixture.ts`
- Modify: `package.json`
- Modify: `docs/architecture.md`

1. Extend architecture tests/gates so protocol/core cannot reach storage/FS/`node:sqlite`, public exports cannot expose storage/SQL/driver/transaction/migration/private evidence types, storage cannot depend on Wayforge/Pi runtime, and MCP remains ping-only.
2. Run the gate and confirm each negative fixture proves rejection.
3. Set durable-host runtime metadata to exact Node 24.21.0 while preserving source compatibility for pure modules where practical, and document the private boundary/limitations.
4. Run gate, typecheck, build, and package tests.

### Task 6: Final verification

1. Run all package checks under `mise exec node@24.21.0 pnpm@12.9.1 --`.
2. Run workspace checks where feasible without modifying unrelated packages.
3. Record exact runtime/SQLite/source identity, test counts, skips, and platform limitations.
4. Inspect `git diff --check`, `git status`, changed paths, and confirm no `packages/wayforge` changes.
5. Do not commit; parent review and one bounded commit follow.
