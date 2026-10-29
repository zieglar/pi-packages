[English](./2026-10-06-quarantine-disposition-hotfix.md) | [简体中文](./2026-10-06-quarantine-disposition-hotfix.zh-CN.md)

> Historical plan (2026-10-06). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# Quarantine Disposition Hotfix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Correct the owner-abandonment loophole without manufacturing execution facts, changing identities or implementing a durable host.

**Architecture:** Preserve Exchange `OPEN|CLOSED` and its existing all-messages-finished close rule. Forbid `DELIVERY_UNKNOWN -> CANCELLED` entirely. Administrative termination is a separate immutable `ExchangeDisposition` with status `ABANDONED_UNRESOLVED`, not an Exchange state, Message state or Result outcome. It preserves exact unresolved attempt snapshots and owner/time/reason/reconciliation intent; it prohibits further protocol activity while permitting historical reads.

**Tech Stack:** Existing TypeScript, TypeBox, Vitest and architecture checker. Pure contracts/rules only.

## Approved design boundary

Owner explicitly authorized the bounded correction after a baseline reproduction. Alternatives considered: broadening `CLOSED` would change its frozen execution-resolution precondition; forbidding both cancellation and any administrative termination would strand the aggregate. Separate disposition is the smallest compatible distinction. Normal Exchange close remains unchanged; a disposition administratively terminates an Exchange whose execution facts remain unresolved. No `ARCHIVED` identity format, database, transport, daemon, Pi/MCP implementation or new dependency.

The future authenticated host supplies the actual owner principal and complete current message/active-attempt snapshots atomically. Neither a role label nor supplied owner text authenticates anything. The host must load the disposition alongside every mutation; guard omission by an untrusted caller must never bypass it. This phase cannot prove atomicity or durability in memory.

## Task 1 — Capture RED regressions

Files: `test/core/ph0003-quarantine-stop.test.ts`, `test/core/disposition.test.ts`, existing `test/core/rules.test.ts` and `test/protocol/lifecycle.test.ts`.

1. Retain `/tmp/ph0003-source-audit/ph0003-quarantine-stop.test.ts` and original RED log unchanged as historical evidence; adapt the committed regression to expect rejection, rather than expecting a successful UNKNOWN return.
2. Require the lifecycle table to omit UNKNOWN→CANCELLED and owner-abandonment evidence class. Replace the old positive loophole expectation with rejection.
3. Add independent disposition tests: correlated unknown/ambiguous snapshots retained; normal close still blocked; no in-flight or foreign records accepted; owner intent does not produce a Result; immutable exact replay versus conflict; archived mutation blocked; reads remain unchanged.
4. Run `mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange exec vitest run test/core/ph0003-quarantine-stop.test.ts test/core/disposition.test.ts test/protocol/lifecycle.test.ts` and record failures before production edits.

## Task 2 — Minimal contract correction

Files: `src/protocol/lifecycle.ts`, `src/protocol/entities.ts`, `src/protocol/capabilities.ts`, `src/core/rules.ts`.

1. Delete the owner-abandonment lifecycle edge and evidence class/handler. Keep evidence-backed ACCEPTED/FAILED exits and all existing cancellation evidence requirements.
2. Add strict separate disposition schema. Each unresolved entry fixes original Message state to DELIVERY_UNKNOWN, original transport to ambiguous, unresolvedSideEffects to true, and preserves the full correlated started DeliveryAttempt snapshot. Root metadata: exchangeId, ABANDONED_UNRESOLVED, ownerId, recordedAt, reason, reconciliation intent.
3. Add pure `archiveUnresolvedExchange(...)` validation over complete authoritative snapshots and immutable exact publication/replay; reject malformed/foreign/missing/duplicate/in-flight evidence and replacement. Never modify Exchange, Message, Attempt, transport or Result.
4. Add `assertExchangeActive(...)` and optional authoritative disposition snapshots to existing mutation guards. Archived transition, result publication and normal close are rejected; readResult is untouched. Declare administrative archive separately from close; implement no control API.
5. Run targeted tests, then full package verification.

## Task 3 — Document, verify, review and commit independently

Files: `docs/protocol-v2.md`, new `docs/quarantine-hotfix-ph0003.md`; preserve historical PH-0002 reports with explicit supersession references rather than silently rewriting their test counts.

Commands:

```sh
mise x pnpm@12.9.1 -- pnpm --filter @zieglar/pi-chat-exchange run verify
mise x pnpm@12.9.1 -- pnpm --filter wayforge test
node tooling/check-workspace.mjs
mise x pnpm@12.9.1 -- pnpm run format:check
git diff --check
```

Review all changed files and cancellation/quarantine/close tests. Verify forbidden directories unchanged; commit only this bounded correction separately from endpoint convergence, never amend or push. Record the actual hotfix SHA and RED/GREEN evidence. Then resume the already pinned read-only PH-0003 bridge audits.
