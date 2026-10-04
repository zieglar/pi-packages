# Wayforge Phase 1B.1 Runtime Workflow Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable an isolated, assisted Alpha 0 workflow in which native Pi Main can run work, delegate bounded Workers through pi-subagents, request runtime-composed Advisor review, and recover through the frozen Phase 1A ownership boundaries.

**Architecture:** Wayforge remains a Pi extension around the native Main session. An additive `WorkflowController` sequences policy, adapters, state, validation, and recovery; it delegates every model/recovery/health decision to the existing Phase 1A owner. New runtime types avoid changing frozen Phase 1A contracts or durable schemas.

**Tech Stack:** TypeScript ESM, Node 25, Vitest, TypeBox, `@earendil-works/pi-coding-agent@1.0.2`, `pi-subagents@0.70.0` public delegation API.

**Design:** `docs/plans/2026-10-04-wayforge-phase-1b1-runtime-workflow-design.md`

**Commit policy:** The owner requested one clean Phase 1B.1 commit. Do not make per-task commits. Commit once, only after every automated gate and assisted dogfood check passes.

---

### Task 1: Pin runtime integration and extend ownership gates

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `scripts/check-architecture.mjs`
- Modify: `scripts/pi1-dev.sh`
- Test: `test/architecture-gates.test.ts`
- Create: `test/isolated-launcher.test.ts`

**Steps:**
1. Add failing tests that require pinned `pi-subagents`, explicit isolated extension loading, no global Pi paths, one `setModel(` production callsite, no direct pi-ai transport, one runtime `RecoveryCoordinator` construction path, one runtime `HealthRegistry` construction boundary, and forbidden lifecycle/fallback APIs in narrow adapters.
2. Run `npm test -- test/architecture-gates.test.ts test/isolated-launcher.test.ts`; confirm the new assertions fail.
3. Pin `pi-subagents@0.70.0`. Update the launcher to use only repository-local Pi, `.wayforge-dev` agent/session directories, and explicit Wayforge/pi-subagents entry points. Preserve caller arguments and avoid credential copying.
4. Extend the architecture script with path-aware ownership checks and actionable errors.
5. Re-run the focused tests and `npm run check:architecture`; require PASS.

### Task 2: Add Phase 1B execution, event, and workflow state types

**Files:**
- Create: `src/workflow/contracts.ts`
- Create: `src/workflow/events.ts`
- Create: `src/workflow/workflow-state.ts`
- Create: `src/durable/in-memory-task-store.ts`
- Test: `test/workflow-state.test.ts`
- Test: `test/in-memory-task-store.test.ts`

**Steps:**
1. Write failing tests for `ExecutionRoute`, Worker outcome statuses, structured Advisor verdicts, event sequencing/redaction, one active Main invocation, child parentage, route history, recovery counters, unresolved findings, and Phase 1A `TaskStore` behavior.
2. Run both focused tests; verify failures are missing-module/behavior failures.
3. Implement additive immutable contracts. Keep raw runtime objects, credentials, provider responses, transcripts, and reasoning outside state/event types.
4. Implement a deterministic in-memory state reducer/store with a single monotonic event sink and exact task-id checks.
5. Implement `InMemoryTaskStore` against the unchanged Phase 1A interface using clone-on-read/write validated state.
6. Re-run focused tests, then `npm run typecheck`; require PASS.

### Task 3: Implement passive routing and health projection

**Files:**
- Create: `src/adapters/passive-account-adapter.ts`
- Create: `src/recovery/health-projector.ts`
- Test: `test/passive-account-adapter.test.ts`
- Test: `test/health-projector.test.ts`

**Steps:**
1. Write failing tests for configured-route enumeration, capability/role filtering, registry availability, sanitized account references, cooldown exclusion, and deterministic order.
2. Write failing health tests: exact authentication/usage facts update only correct account scope; context overflow does not poison account/provider; ambiguous 429 can only create a bounded exact-route cooldown; cancellation creates no cooldown.
3. Run focused tests and confirm failure.
4. Implement `PassiveAccountAdapter` as read/report only. It must not expose model mutation, continuation, fallback, or retry methods.
5. Implement `HealthProjector` as the sole translation into an injected `HealthRegistry`; use confidence/scope to prevent over-broad facts.
6. Re-run focused tests and architecture checks; require PASS.

### Task 4: Implement the pi-subagents Worker adapter

**Files:**
- Create: `src/adapters/pi-subagent-worker-adapter.ts`
- Create: `src/runtime/concurrency-limiter.ts`
- Test: `test/pi-subagent-worker-adapter.test.ts`

**Steps:**
1. Build a deterministic fake owner for the public `prompt-template:subagent:*` delegation events; do not mock private executors.
2. Add failing tests for fully resolved request payloads, explicit `provider/model:thinking`, fresh context, depth, timeout, tool/token budgets, cwd, request correlation, and selected-model evidence.
3. Add failing tests for success, typed terminal failure, selected-model mismatch, timeout, exact cancellation tuple, listener disposal, one failed Worker not aborting Main, and bounded parallel concurrency.
4. Run the focused test and confirm failures.
5. Implement the event adapter and fixed concurrency limiter. Normalize terminal responses with `normalizeError`; never treat Worker text as control authority.
6. Re-run focused tests, typecheck, and architecture checks; require PASS.

### Task 5: Implement runtime-composed Advisor review

**Files:**
- Create: `src/adapters/pi-advisor-adapter.ts`
- Create: `src/workflow/advisor-trigger-policy.ts`
- Create: `src/workflow/advisor-evidence.ts`
- Test: `test/pi-advisor-adapter.test.ts`
- Test: `test/advisor-trigger-policy.test.ts`
- Test: `test/model-runtime-sentinel.test.ts`

**Steps:**
1. Write failing trigger tests for manual, repeated reasoning, repeated validation, and before-done triggers; ensure cancellation/infrastructure/quota/provider failures never trigger.
2. Write failing input tests that permit bounded objective/criteria/diff/validation/Worker findings while redacting credential keys, raw bodies, transcripts, and reasoning.
3. Write failing Advisor tests for one `NestedInvoker` attempt, explicit route/thinking/budget, strict `approve | changes_requested | unable` parsing, typed findings, cancellation, and malformed output.
4. Build a deterministic registered provider and wrapper sentinel using the real Pi `ModelRuntime`/ModelRegistry path. Assert the wrapper marker is observed, proving nested calls preserve provider composition without paid traffic.
5. Implement the trigger, evidence builder, and Advisor adapter using the existing `NestedInvoker`; add no retry loop.
6. Re-run focused tests and architecture checks; require PASS.

### Task 6: Execute centralized bounded recovery

**Files:**
- Create: `src/recovery/runtime-recovery-executor.ts`
- Test: `test/runtime-recovery-executor.test.ts`

**Steps:**
1. Write failing tests for retry-same-route, account rotation, model fallback, provider fallback, suspension/block, budget exhaustion, cancellation stop, and deterministic counter consumption.
2. Assert every route-changing action creates a new invocation linked to the failed invocation; retry does not erase provenance.
3. Assert only injected `RecoveryCoordinator.plan` decides action and only injected `HealthProjector`/`HealthRegistry` updates cooldown state.
4. Run the focused tests and confirm failure.
5. Implement a single-step executor plus an explicitly bounded `run` method. It may execute only the exact authorized action and must emit decision/application/budget events.
6. Re-run focused tests, typecheck, and architecture checks; require PASS.

### Task 7: Implement WorkflowController and native Main lifecycle

**Files:**
- Create: `src/workflow/workflow-controller.ts`
- Create: `src/workflow/runtime-factory.ts`
- Test: `test/workflow-controller.test.ts`

**Steps:**
1. Write failing tests for start, one active Main invocation, native Main route observation, direct Main completion, conditional Worker/Advisor use, Worker failure returning control to Main, structured validation, before-done Advisor gate, cancellation propagation, and no false completion.
2. Add tests that every Main fallback calls an injected `MainModelController`; the controller must never receive raw `ExtensionAPI.setModel`.
3. Add tests that policy selects routes, recovery selects recovery action, health owns cooldown, and `WorkflowController` only sequences those outputs.
4. Run the focused test and confirm failure.
5. Implement the controller and one runtime composition root. Construct exactly one `RecoveryCoordinator` and one `HealthRegistry` there.
6. Re-run focused tests and the full Phase 1A regression suite; require PASS.

### Task 8: Wire the extension and fail-closed ownership guard

**Files:**
- Modify: `src/extension.ts`
- Create: `src/runtime/ownership-guard.ts`
- Create: `src/runtime/extension-tools.ts`
- Test: `test/extension-runtime.test.ts`
- Test: `test/ownership-guard.test.ts`

**Steps:**
1. Write failing tests against a real extension-registration harness for `/wayforge`, task/status/delegate/advise/recover/complete tools, `before_agent_start`, `agent_end`, and session shutdown cancellation.
2. Write failing provenance tests that allow canonical pi-subagents Worker ownership and reject active shift-router, multi-account, advisor-flow, duplicate Wayforge, or unknown competing owner sources with an actionable diagnostic.
3. Verify non-Wayforge Main turns stay native and no model transition happens at startup.
4. Run focused tests and confirm failure.
5. Implement the extension factory, TypeBox tool schemas, lifecycle callbacks, runtime instance ownership, and guard. Tool errors must be typed/redacted and must not throw raw provider data.
6. Re-run focused tests, architecture checks, typecheck, and build; require PASS.

### Task 9: Add Alpha 0 docs, fixtures, and automated gate

**Files:**
- Modify: `README.md`
- Create: `docs/alpha-0-assisted-dogfood.md`
- Create: `scripts/check-alpha0.mjs`
- Modify: `package.json`
- Test: `test/alpha0-gate.test.ts`

**Steps:**
1. Write a failing Alpha 0 gate test requiring frozen baseline ancestry, isolated paths, pinned package versions, ownership checks, Worker/Advisor sentinel tests, and absence of credential-like tracked files.
2. Run the focused test and confirm failure.
3. Implement `check:alpha0`, document isolated install/login/start/status/cancel flow, and add explicit limitations: in-process only, no restart resume, no ambient account plugin, no autonomous continuation.
4. Document the dogfood evidence schema and commands without including credentials, transcript, hidden reasoning, or raw provider data.
5. Run `npm run check:alpha0`; require PASS.

### Task 10: Automated verification and independent review

**Files:**
- Review all changed source, tests, scripts, and docs.

**Steps:**
1. Run `npm ci` in the repository and confirm the lockfile reproduces.
2. Run `npm run check:architecture`.
3. Run `npm test` and record exact test/file counts.
4. Run `npm run typecheck`.
5. Run `npm run build`.
6. Run `npm run check:alpha0`.
7. Run `npm audit --omit=dev`; classify any findings.
8. Inspect `git diff --check`, `git status --short`, and verify no `.wayforge-dev`, credential, session, or artifact content is tracked.
9. Request independent code review focused only on ownership violations, unsafe persistence, hidden retry loops, mismatched model evidence, cancellation leaks, and false composition claims. Fix blockers test-first and rerun affected/full gates.

### Task 11: Assisted isolated dogfood

**Files:**
- Create after run: `docs/evidence/phase-1b1-alpha0-dogfood.json`
- Modify through dogfood: `README.md` (small troubleshooting improvement only)

**Steps:**
1. Stop for the operator to run repository-local isolated `/login` under `.wayforge-dev`; do not read or copy production auth.
2. Confirm `scripts/pi1-dev.sh --list-models` reports at least one authenticated route while production paths remain unchanged.
3. Start Wayforge with the objective: add a concise Alpha 0 troubleshooting section to `README.md` covering ownership-guard rejection and Worker/Advisor diagnostics.
4. Require Main to delegate at least one bounded Worker, apply/validate the docs change, request before-done Advisor review, and return to Main.
5. Save only the redacted structured event/evidence projection: task/invocation ids, selected sanitized routes, statuses, budget counters, validation commands/results, Advisor verdict, changed paths, and manually inspected/inferred labels.
6. Inspect the README change and evidence file. Remove any credential, transcript, raw provider response, or hidden reasoning if present and treat such presence as a bug requiring a test.
7. Re-run all automated gates from Task 10.

### Task 12: Final acceptance and one clean commit

**Files:**
- All Phase 1B.1 changes.

**Steps:**
1. Compare implementation against the approved design and original requirements; list any non-blocking deferred Phase 1B.2 work explicitly.
2. Confirm every todo and acceptance gate has evidence and no tests are skipped.
3. Run the complete gate one final time from a clean dependency install if lockfile changed.
4. Stage only intended files and inspect `git diff --cached --stat` plus credential-name/content checks.
5. Commit exactly once with `git commit -m "Phase 1B.1: enable Wayforge runtime workflow"`.
6. Verify clean worktree and report branch, commit hash, automated evidence, manually inspected dogfood evidence, inferred claims, limitations, and stop before Phase 1B.2.
