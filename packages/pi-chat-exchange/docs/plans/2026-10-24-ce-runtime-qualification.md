[English](./2026-10-24-ce-runtime-qualification.md) | [简体中文](./2026-10-24-ce-runtime-qualification.zh-CN.md)

> Historical plan (2026-10-24). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# CE Dual Runtime Qualification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Formally qualify exact Node 24.22.1 alongside 24.21.0, with no broad version range or relaxed Store authority.

**Architecture:** A single explicit runtime tuple registry binds each exact Node version to SQLite version/source, security-relevant compile-option requirements and the existing platform allowlist. Real identity and required API checks happen in memory before Store path preparation; production resolver probes use the same policy without environment overrides. Certification requires the actual two binaries to pass persistence, bidirectional Store interoperability, recovery/concurrency and Host/MCP security tests, not merely API probes.

**Tech Stack:** TypeScript, built-in node:sqlite/fs/child_process, existing CE Store/Host/MCP APIs and Vitest; isolated temporary runtime installations and Stores.

## Approved scope and baseline

User approved this design with `continue`. Parent is sole writer on the handed-off main checkout; no concurrent writer, branch changes, intermediate commit, push/PR/release or global Pi/Node configuration changes. Baseline main HEAD `00c01d43f6a83293650da75deae97e47fb0158a1`; installed Pi package1.3.0. Read-only baseline evidence `/tmp/ce-runtime-qualification-3s2AZH/baseline.json`: tracked/index clean, no conflicts, upstream origin/main, ahead77/behind0, preexisting root AGENTS.md/.herdr-web-ui preserved; other worktrees untouched; no fetch.

No real client/Tunnel, credentials, user Store or real messages. Do not modify Store schema/trust root/Ownership/session routing/protocol/capabilities/ACK, or introduce migration. The exact runtime policy change and earlier admission ordering are authorized, not a reopening of durable contracts. Existing constructor-only test identity seams do not become production bypasses.

## Task1: Acquire and characterize real identities (read-only production code)

1. Download only official Node24.22.1 Darwinarm64 archive into the private evidence directory; compare SHA256 against official HTTPS SHASUMS. Record signature-verification limitation. Do not install globally.
2. Probe both real binaries with built-in node:sqlite and an in-memory DB; record actual Node/platform/arch, SQLite version/source, complete sorted compile options and required API shapes. Preserve commands and failures.
3. Stop to analyze any SQLite difference before broadening support. Current initial observation: both SQLite3.53.4, identical source and50 compile options; this is characterization, not certification.
4. Record essential policy: thread-safe mutex-enabled SQLite; reject compile options disabling WAL, foreign keys, triggers or other required safety behavior. Preserve complete compile-option inventories for review without pinning irrelevant compiler-label differences. Add actual API checks (defensive support, statements, transaction state) before filesystem access; missing/abnormal support refuses.

## Task2: Test-first registry and pre-path refusal

**Files:** `src/storage/runtime.ts`, `src/storage/store.ts`, `src/storage/connection.ts` only as necessary; `test/storage/runtime.test.ts`, `test/storage/connection.test.ts` and a focused runtime-admission regression file; read storage path/readonly APIs before changes.

1. Add failing exact24.22.1 positive and unknown25.x/24patch refusal tests; preserve24.21 behavior. Add missing/malformed compile options, forbidden options, mismatched source/platform and fake env version tests. Typed fixtures must carry all required identity evidence; missing data never defaults to approved.
2. Add real subprocess tests under an ineligible runtime asserting initialize/open paths are not created or modified. Add abnormal SQLite API behavior tests using isolated test mocks, not production overrides.
3. Run RED under approved24.21 runtime, save full logs/exit status; then implement the smallest explicit tuple registry and real identity collection. Preserve compatibility exports only as clearly named legacy/default values, not a second authority.
4. Ensure initialize/open/read-only entry points validate the actual runtime before path preparation or disk reads/writes; preserve all later connection safeguards and existing refusal semantics where unrelated. Recheck test-seam use so existing domain fixtures do not undermine the production preflight.
5. Run GREEN runtime and connection/lifecycle tests. If a required certification fails, do not commit candidate support; restore24.21-only policy while retaining evidence.

## Task3: Test-first portability integration

**Files:** `src/runtime/executables.ts`, `src/runtime/diagnostics.ts`, `src/tunnel/profile.ts`, necessary package engines/docs and focused `test/runtime/*`, setup/extension runtime tests.

1. Add tests for explicit24.22.1, current24.22.1 and both controlled legacy locations;24.21 remains accepted, all other actual versions refuse. Resolver discovery must derive from registry, not a second approval list.
2. Extend admitted child probe to collect compile evidence and check actual required SQLite capabilities. No project PATH execution, trust/ACL/symlink/mode checks unchanged; malformed explicit settings still refuse without fallback.
3. Update diagnostics to identify actual host/child and accepted exact versions without implying they need the same executable. Update precise package engine constraint and bounded installation docs; no global tool changes.
4. Run focused tests under each binary, including copied non-mise Node and paths containing spaces. Build before dist-based tests.

## Task4: Formal cross-version persistence certification

**Files:** new focused qualification tests/support scripts under `test/storage/` or `test/runtime/`; reuse existing Store/transaction/identity/ledger/trust APIs rather than independent exploratory SQLite as the only proof.

1. Add subprocess fixture that creates an actual temporary CE Store, records stable UUID/schema/identity/ledger evidence and known committed synthetic state, closes cleanly, and reopens/verifies that evidence using the other actual Node binary.
2. Execute24.21→24.21,24.21→24.22.1,24.22.1→24.21,24.22.1→24.22.1. Run pragma/integrity/foreign-key/identity/migration-ledger checks; assert no migration occurred and trust-root identity unchanged.
3. Exercise real Store WAL/FULL transactions, lock contention/concurrency, process abnormal exit and recovery, and unknown write-result handling using existing fault/process tests plus cross-version fixture boundaries. Do not claim process-kill tests prove power-loss durability.
4. Preserve first failed run and all exit statuses; create compatibility matrix with exact binaries/identities/commands and pass/fail/not-tested per requirement. Critical persistence gaps block certification.

## Task5: Host/MCP and full relevant matrix

1. Under each approved runtime, run existing storage/host/endpoints/MCP/bin suites covering Endpoint/Session/Ownership/capability refusal and Inbox/PayloadRead/ACK authorization. Only synthetic fixtures and isolated messages/Stores.
2. Run actual stdio MCP ping/tool discovery via generated local manifest under both approved Nodes; use private copied binaries outside mise, minimal PATH and isolated accountHome/binding. Do not install/register Desktop or start a real Tunnel.
3. Under each runtime run the bounded relevant full suite from `packages/pi-chat-exchange`:

   ```sh
   pnpm run check
   pnpm run typecheck
   pnpm run build
   pnpm exec vitest run --exclude test/tunnel/real-client-compat.test.ts --maxWorkers 2
   pnpm run test:plugin-package
   pnpm exec tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --lib ES2023 --types node --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --skipLibCheck pi-extension/index.ts
   ```

   Set child PATH to the selected absolute runtime bin only for this command, never global config. No unrestricted `pnpm verify`/`pnpm test`: real-client compatibility suite3cases must remain excluded. Record skips, independent compiler exit envelopes and exact runtime identity. Keep any default-concurrency/time-limit failure rather than erasing it after rerun.

## Task6: Fixed review and local delivery

1. Freeze final uncommitted file manifest, byte hashes, patch, baseHEAD and aggregate fingerprint only after all required matrix cells pass. Keep candidate support uncommitted while qualification is incomplete.
2. Four independent fresh-context lanes A diff/privacy/docs, B authority/frozen architecture, C validation/coverage, D standards/maintainability must review the same fixed target. Record requested and actual models; do not pretend cross-family independence when routing falls back to the same family.
3. Close blockers with test evidence, re-freeze/re-review changed targets; parent synthesis retains disagreements, evidence limitations and explicit qualification matrix.
4. Stage exactly reviewed files; one authorized local commit only after all required certification and review passes. Verify committed bytes and parent; no push/PR/merge/release.
5. RESULT report: HANDOFF ID/status/verdict/files/commit, full two identities, compatibility matrix, executed tests/exit statuses, cross-version Store results, four-lane evidence, first failures/skips/platform risks and next action. Wait ChatGPT acceptance.
