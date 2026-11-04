# CE Hooks Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete HANDOFF-CE-HOOKS-MANAGEMENT-01 with native operator Hooks CRUD, explicit offline v2 upgrade and MCP sender consent, safe fixture testing, runtime admission and local commit.

**Architecture:** Implement the reviewed D1 contract and its locator/reader clarification in the existing private policy chain. Preserve v1 behavior and all frozen Core/Store/Protocol contracts. Stage immutable configuration under the existing STOPPED Profile lock; policy consent and Profile selection remain separate observable commits. Configuration saving never starts a personal command or transport.

**Tech Stack:** TypeScript, Node 24.21.0, Vitest 4, existing Pi native TUI and immutable private configuration files.

## Authority and baseline

Latest user authorization supersedes earlier design-round no-implementation/no-commit limits. Work only in `/Users/zieglar/Code/pi-packages-ce-hooks-management-01`, branch `feat/ce-hooks-management-01`, baseline `894ea9eddd88841fa667748cda7af98815b99785`. No production configuration, installation, personal scripts, transport restart, merge, push, PR or release. Reviewed D1 and historical reports remain byte-for-byte frozen.

Stop delivery if branch/HEAD differs from this baseline, another writer changes a frozen target, required authority or dependencies are unavailable, or required verification evidence is missing. Resolve only within existing user authority; never infer permission from a remembered selection, locator or successful test. Resume review only after recording a new fixed target and its complete file/hash inventory.

## Task 1: Versioned policy and publication

Owned files: `src/tunnel/live-session-policy.ts`, focused `test/tunnel/live-session-policy-v2.test.ts` (package-relative paths throughout).

1. Write failing real-filesystem tests for preserved v1 prefix, unique upgrade marker, closed v2 parsing, independent Hook generations, full-array replacement, actor locators, missing locator rejection and CAS conflict.
2. Run focused tests and record expected missing-feature failures before implementation.
3. Extend this private module with `LivePolicyRef` v1/v2 union, v2 registration `hookGeneration`, `mcpHookConsent`, closed intents and exact transition whitelist. Retain bounds and original v1 validation.
4. Expose `prepareLivePolicyUpgrade(ref, profilePath)` returning a pinned reference; publisher `upgrade({expectedDigest, actorRuntimeSessionId, profileRevision, bindingGeneration, operationId?})`, `setPiHooks({expectedDigest, runtimeSessionId, endpointId, epoch, hooks, operationId?})`, and `setMcpHooks({expectedDigest, actorRuntimeSessionId, bindingGeneration, targets, operationId?})`. Use the same locator and exclusive-link primitives. Upgrade verifies success with the pinned v2 reader.
5. Run focused policy tests, legacy policy tests and typecheck; inspect changes before dependent integration.

## Task 2: Runtime and binding integration

Files: `src/host/mcp-binding-config.ts`, `src/tunnel/live-mcp-composition.ts`, `src/bin/mcp-stdio.ts`, `src/tunnel/multi-session-policy.ts`, `pi-extension/live-session-runtime.ts`, related runtime modules and tests as found at their existing call sites.

1. Write failing tests for binding kind refusal/acceptance, outbound Hook-only changes preserving message continuity, old runner ABA denial and official reload transfer.
2. Implement v2 binding and launch reference parsing. At every messaging/transfer comparison use identity continuity separately from v2 Hook generation.
3. Capture generations once at factory load. Check exact immutable rule, selected pair identity, consent generation, loaded/current target incarnation and event identity synchronously at actual-start admission. Keep business messaging independent of Hook-only denials.
4. Test both race schedules, new process adoption after target change, queued starts and unchanged v1/read/ACK behavior.

## Task 3: Offline orchestration and native manager

Files: existing migration/configuration/Profile/UI modules, new focused Hooks management modules where a clear boundary requires them, `pi-extension` menu entry and isolated tests.

1. Write failing tests for list/add/edit/enable/disable/remove, exact native Session scope, full preview confirmation and cancellation, no execution while configuring, STOPPED lock refusal, marker/consent committed but Profile pending, and safe fixture-only test behavior.
2. Implement explicit offline upgrade and sender candidate staging using existing private pair writer and checked Profile rename. No automatic rebase/retry/rollback after uncertain outcomes; retain reconciliation evidence.
3. Connect the native Hooks menu for each direction. Pi rules belong only to current native registration; incoming rules belong to MCP sender configuration. Saving requires full candidate confirmation. Clearly report configured versus adopted versus eligible. Explicit reload/start remains separate.
4. After a marker or sender consent commits but Profile selection is pending, require an explicit native continuation with the exact candidate binding path and operation ID. A fresh management object must validate the actor locator, published intent, pinned v2 reference, original Profile scope, enabled-rule coverage and current target tuples under the real STOPPED lock. Complete only the checked selection: publish no new marker/grant and do not rebase, infer consent or roll back. Test both upgrade and sender continuation, already-selected evidence, wrong actor, missing locator, wrong pair, changed epoch, superseded consent and uncertain rename/fsync refusal.
5. Safe test uses a fixed harmless fixture and metadata-only input; it never selects or runs a personal command.
6. Run focused UI/orchestration and integration tests, including `test/tunnel/hooks-management-legacy.test.ts`: actual `/ce-hooks` native menu audit must display the captured CE_ALLOWLIST snapshot independently of live-edit eligibility, without saving or executing configured commands.

## Task 4: Verification, review and local delivery

1. Use temporary dependency links to parent checkout only for local verification; remove them before fixed-diff review/commit. Build with `mise exec node@24.21.0 -- node node_modules/typescript/bin/tsc -p tsconfig.build.json`; typecheck with the same compiler and `--noEmit -p tsconfig.json` from the package directory.
2. Run the mandatory test command below; retain exact commands, Node version, exit status and bounded result summaries. Tests import emitted dist, so build first. Every listed target must appear in the retained command; a passing count alone is insufficient.
3. Probe changed TypeScript with active LSP diagnostics, inspect diff and run `git diff --check`.
4. Freeze the complete implementation delta, including untracked task files, with a sorted file/SHA-256 manifest against the stated baseline. Verify every hash and the complete inventory at reviewer start and end, then dispatch spec/security/quality review with configured routes. Do not edit the target until all reviewers finish. A missing required test, changed hash, incomplete scope or unavailable authority blocks delivery until resolved. Address findings and repeat relevant checks/review.
5. Write a final implementation evidence report distinguishing configured/adopted/eligible/executed and limitations. Stage only this Handoff's package files, commit locally after checks/review, verify branch/HEAD/status. No merge or publication.

## Mandatory final targeted suite

Run from the package directory after build; require exit 0 and all tests except the existing root-only owner test to pass.

```sh
mise exec node@24.21.0 -- node node_modules/vitest/vitest.mjs run \
  test/tunnel/live-session-policy-v2.test.ts \
  test/tunnel/live-session-policy.test.ts \
  test/tunnel/hooks-management.test.ts \
  test/tunnel/hooks-management-ui.test.ts \
  test/tunnel/hooks-management-characterization.test.ts \
  test/tunnel/live-mcp-hooks-v2.test.ts \
  test/tunnel/live-mcp-hooks-v2-stdio.test.ts \
  test/host/mcp-binding-config-v2.test.ts \
  test/endpoints/pi/hooks-v2-runtime.test.ts \
  test/endpoints/pi/live-hooks-v2-integration.test.ts \
  test/tunnel/live-adoption-probe.test.ts \
  test/tunnel/live-connection-status.test.ts \
  test/tunnel/live-session-migration.test.ts \
  test/hooks \
  test/host/mcp-binding-config.test.ts \
  test/host/mcp-binding-config-ack.test.ts \
  test/tunnel/messaging-config.test.ts \
  test/tunnel/messaging-config-security.test.ts \
  test/tunnel/multi-session-policy.test.ts \
  test/tunnel/multi-session-policy-validation.test.ts \
  test/tunnel/live-mcp-composition.test.ts \
  test/endpoints/pi/extension-hooks.test.ts \
  test/endpoints/pi/extension-multi-hooks.test.ts \
  test/endpoints/pi/extension-hooks-real.test.ts \
  test/endpoints/pi/live-session-profile.test.ts \
  test/endpoints/pi/live-session-runtime.test.ts \
  test/endpoints/pi/live-session-onboarding.test.ts \
  test/bin/stdio-messaging.test.ts \
  test/bin/stdio-multi-session.test.ts \
  test/tunnel/live-mcp-stdio.test.ts \
  test/endpoints/pi/extension-live-hooks-v2-real.test.ts \
  test/tunnel/hooks-management-legacy.test.ts \
  --maxWorkers=4
```
