[English](./2026-10-24-ce-productization02.md) | [简体中文](./2026-10-24-ce-productization02.zh-CN.md)

> Historical plan (2026-10-24). Proposals, commands, constraints and recorded observations below belong to that dated work. They do not establish current implementation, support, release status or authorization to execute these steps. See the [current package documentation](../../README.md) for current usage.

# CE Productization 02 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make existing Chat Exchange setup and multi-session operation usable through documented commands, explicit current-session deactivation, and safe read-only installation diagnostics.

**Architecture:** Reuse the existing Pi command family, lifecycle shutdownCe/Host end seam, runtime qualification, and executable admission. Do not introduce a second authority, installer, router, or ownership recovery path. Installed live source and real Tunnel/Store/Sessions are protected; implementation and validation run only in this isolated worktree with synthetic private fixtures.

**Tech Stack:** Pi 1.3.0, TypeScript 5.9.3, Node 24.21.0 or 24.22.1 with approved SQLite identity/API, Vitest 4.1.11, pnpm 12.9.1.

## Approved design and boundaries

The user approved “minimal UX + documentation” after a read-only Gap Analysis. Base: 1578a7bb6d672819ff9b3fe1479d26f008cb5e60; branch feat/ce-productization02. Baseline build and five targeted suites passed (105 tests), using Node 24.21.0.

- Add `/ce-tunnel deactivate`, with real current-session identity validation and explicit operator confirmation. It ends only a locally held current CE binding through normal end/release/detach, cancels renewal, and retains registration and history. It never starts/stops transport. Cancel/no local binding are non-writing. Unknown release/persistence remains fail-closed, never a successful unbind report. Repeated calls must not end twice. Explicit activation is required afterward; reload must not silently rebind a released mapping. Do not create a new persistent opt-out policy; reuse exact existing release evidence.
- Add `/ce-tunnel doctor` as read-only installation diagnostics. Distinguish current Pi host qualification from MCP child selection and client metadata admission. Do not execute an untrusted client, fetch/install anything, read credential contents, mutate profiles/Store, or instantiate/start transport. Preserve unsafe ancestor/symlink/ACL/project/PATH refusal. Prefer closed diagnostic outcomes and non-secret repair guidance; do not print raw subprocess output/errors, environment values or arbitrary input.
- Improve `/ce-status` with current native Pi Session and Exchange alongside existing Endpoint, Participant, CE Session/Owner lease/fencing. Only disclose identifiers through existing admission; never expose capability material or enumerate other sessions on denial.
- Rewrite user-facing entry points in package README, pi-extension README, plugin README, docs/tunnel-setup.md, docs/chatgpt-installation.md, docs/architecture.md and docs/multi-session-usage.md. Real current CLI only: no invented standalone ce binary, no mandatory mise, no developer-machine paths, no historical Handoff/commit/process narrative. Separate Tunnel and Desktop; explain Configured/Pi-bound/Connected/message evidence, independent per-session Endpoints, shared ChatGPT inbox, revocation versus normal unbinding, and reload/resume. Preserve exact Node runtime qualification and platform certification limits.
- No push, PR, merge, release, real messages/receipts, Store cleanup, automatic recovery, frozen protocol/core/storage/host policy changes, dependency upgrades, or Wake Bridge. No edits/builds in the parent checkout or other worktrees.

## Task 1: Characterize and implement explicit deactivation (TDD)

Files: pi-extension/index.ts; test/endpoints/pi/extension-messaging-activation.test.ts; test/endpoints/pi/extension-multi-session.test.ts; optional narrow confirmation module and tests under src/tunnel/ and test/tunnel/.

1. Read shutdownCe, activation, session_start, persisted release proofs, and existing cancellation/generation fencing. Read installed Pi extension/UI docs in full before changing their API usage; use existing confirmation seam if suitable.
2. Write failing cases for successful normal legacy and multi-session release, no transport effect, cancellation, no binding, repeated call, identity/config drift, busy dialogs and concurrent teardown, unknown end/persistence, revocation-safe cleanup, and explicit activate after release/reload without automatic rebinding.
3. Run those tests before implementation; retain the RED reason.
4. Route the new explicit command through the established shutdownCe normal-end path with a current-session fence and shared operation latch. Retain unknown lifecycle state; report success only after verified release proof.
5. Build and rerun affected suites with `pnpm exec vitest run <files> --maxWorkers=1`. Commit only authorized files after green.

## Task 2: Read-only doctor and identity status (TDD)

Files: src/runtime/executables.ts; src/runtime/diagnostics.ts; pi-extension/index.ts; test/runtime/{executables,diagnostics}.test.ts; test/tunnel/extension-runtime-diagnostic.test.ts; narrowly scoped new diagnostic tests if needed.

1. Add failing tests for missing client versus rejected client, trusted candidates, unsafe ancestor/symlink/ACL, explicitly invalid override, host/child independently qualified, no client execution, no install/profile/Store/process changes, and deny-safe identity status.
2. Use existing admission and in-memory Node probe; no filesystem trust weakening or raw probe output. Keep current host qualification independent of CE_NODE_PATH.
3. Wire doctor into help/completions and commands without creating a background manager; status reports only admitted current identity.
4. Build, run targeted tests, check/typecheck. Commit the small runtime delta.

## Task 3: User-focused docs

Files: README.md; pi-extension/README.md; plugin/pi-chat-exchange/README.md; docs/{tunnel-setup,chatgpt-installation,architecture,multi-session-usage}.md.

1. Verify install/loading/package scripts and local plugin configure interface against source and Pi docs. Verify external ChatGPT UI instructions against official current documentation if adding exact UI steps; otherwise link official guidance and avoid guessing.
2. Provide one clear Tunnel quickstart and a separate Desktop stdio route. Include safe Node/client diagnostics, explicit environment setup, profile selection, generation, activation and measured health. No mandatory version manager or unsafe executable workaround.
3. Explain independent Endpoint registration, status identity, deactivate versus revoke versus stop, normal reload resume and explicit activation. Changes requiring STOPPED transport are instructions only, never executed here.
4. Check relative links, command examples, package versions, privacy and remaining claims against source. No real credential/profile/session/message data in docs.

## Task 4: Verify and freeze review target

1. Run check, typecheck, build, relevant lifecycle/runtime/tunnel/multi-session suites and packaged plugin tests serially or with bounded workers; record actual commands/results and any skips.
2. Run full test suite with bounded workers when feasible; investigate failures before completion claims. Inspect final diff for accidental authority changes or private paths.
3. Commit implementation/docs, ensure tracked/index clean, and freeze exact base..HEAD. Review metadata must not move this target.
4. Four fresh read-only leaf review sessions: A diff/privacy/docs; B authority/frozen contracts with N0–N3 classification; C validation/coverage; D standards/maintainability with HARD VIOLATION versus JUDGMENT CALL. Parent synthesizes supported findings, remedies sequentially, then re-freezes and re-reviews changed scope as necessary.
5. Retain isolated worktree and local commits, report SHA/range, tests, review outcome and limitations. Parent checkout and live runtime remain untouched; no integration/push or cleanup without authorization.
