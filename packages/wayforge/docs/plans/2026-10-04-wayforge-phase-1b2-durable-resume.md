# Wayforge Phase 1B.2 Durable Execution & Autonomous Resume Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add crash-safe authoritative task persistence, fenced local leases, typed suspension, startup wakeup, conservative drift validation, and new Pi AgentSession continuations while preserving all Phase 1A/1B.1 ownership invariants.

**Architecture:** A single filesystem-backed `DurableTaskStore` owns versioned per-task snapshots and local lease coordination under `<agentDir>/wayforge/tasks/`. Host-neutral wakeup logic executes structured decisions from the sole `RecoveryCoordinator`; a narrow Pi launcher creates a new in-memory AgentSession from a durable continuation package. `WorkflowDiskSink` remains non-authoritative observability.

**Tech Stack:** TypeScript 5.9, Node.js 25 filesystem/crypto/child-process APIs, TypeBox, Vitest, Pi Coding Agent public SDK 1.0.2.

---

## Execution rules

- Use test-driven development for every behavioral task: failing test, focused implementation, focused passing test, then inherited regressions.
- Do not create intermediate commits. The user requires exactly one final commit after all automated and dogfood gates pass.
- Do not modify production `~/.pi`; all launch and dogfood work uses `.wayforge-dev` or temporary directories.
- Do not add a second recovery-policy owner, cooldown owner, parent model writer, or continuation owner.
- Do not persist credentials, raw provider bodies, transcripts, prompts used solely for reconstruction, or hidden reasoning.
- Use Node argument-array process APIs, never a shell, for Git inspection.
- After every source-editing task run active LSP diagnostics for changed paths.

### Task 1: Promote the durable schema and contracts

**Files:**
- Modify: `src/durable/state.ts`
- Modify: `src/durable/contracts.ts`
- Modify: `src/durable/in-memory-task-store.ts`
- Modify: `test/durable-state.test.ts`
- Modify: `test/in-memory-task-store.test.ts`
- Create: `test/helpers/durable-task-fixture.ts`

**Step 1: Write failing schema tests**

Add cases for all six statuses, lease generation, structured checkpoint content, workspace checkpoint, bounded recent attempts, typed suspension, evidence references, invocation provenance, and prepared continuation state. Add rejection cases for oversized arrays/strings, forbidden nested keys, raw prompts, transcript/reasoning fields, credentials, runtime handles, and unsupported schema versions.

**Step 2: Run focused tests and confirm failure**

Run:

```bash
npx vitest run test/durable-state.test.ts test/in-memory-task-store.test.ts
```

Expected: failures because schema v1 cannot represent the required fields and store contracts lack expected-revision/list semantics.

**Step 3: Implement schema v2 and the unified interface**

Define exact TypeBox schemas for:

- `WorkspaceCheckpoint` and path fingerprints;
- `DurableCheckpoint`;
- `DurableAttempt`;
- sanitized `DurableFailure`;
- `DurableSuspension`;
- evidence references;
- invocation provenance and continuation launch phase;
- `DurableTaskState`.

Expose one `DurableTaskStore` contract with create/load/list/update and lease acquire/heartbeat/release operations. Keep compatibility aliases only where they do not imply a second production authority. Update `InMemoryTaskStore` to clone, enumerate, and enforce expected revision.

**Step 4: Bound and sanitize state construction**

Add constructors/helpers that truncate counts and string lengths before validation. Serialization remains deterministic with recursively sorted object keys.

**Step 5: Run focused tests and diagnostics**

Expected: all focused tests pass; active LSP reports zero errors.

### Task 2: Implement crash-safe filesystem state persistence

**Files:**
- Create: `src/durable/filesystem-task-store.ts`
- Create: `test/filesystem-task-store.test.ts`
- Modify: `src/runtime/workflow-disk-sink.ts` only if root/layout helpers can be shared without changing its diagnostic semantics
- Modify: `test/workflow-disk-sink.test.ts` only for relationship/layout assertions

**Step 1: Write failing store tests**

Cover:

- schema round-trip;
- deterministic bytes;
- create/load/list;
- expected-revision conflict;
- atomic replacement with no committed temp files;
- one bounded backup;
- malformed JSON and schema corruption;
- unsupported version;
- restrictive file permissions;
- safe task-directory names and root-boundary enforcement;
- write/fsync/rename failures are surfaced rather than swallowed;
- persisted bytes exclude secret fixture values.

**Step 2: Run focused tests and confirm failure**

```bash
npx vitest run test/filesystem-task-store.test.ts test/workflow-disk-sink.test.ts
```

Expected: missing implementation failures.

**Step 3: Implement `FilesystemDurableTaskStore`**

Use random `open(..., "wx", 0o600)` temporary files, write loops, file fsync, atomic rename, and directory fsync with narrowly documented unsupported-platform handling. Resolve every task path beneath a canonical root. Never promote a backup automatically after corruption.

**Step 4: Preserve sink subordination**

Keep `WorkflowDiskSink` write-only, best-effort, and non-authoritative. Document/test that durable tasks live under `wayforge/tasks/` while legacy redacted event/status artifacts remain diagnostic siblings.

**Step 5: Run focused tests, LSP, and `git diff --check`**

Expected: focused tests pass and no diagnostics.

### Task 3: Add fenced single-machine leases

**Files:**
- Modify: `src/durable/filesystem-task-store.ts`
- Modify: `src/durable/in-memory-task-store.ts`
- Create: `test/durable-lease.test.ts`
- Create: `test/fixtures/durable-store-child.mjs`

**Step 1: Write failing lease tests**

Cover acquisition, metadata, heartbeat, release, active competing claimant, expiry, stale reclaim, owner-token mismatch, generation fencing, crash-left claim directory, and release-after-expiry behavior.

**Step 2: Add a real two-process contention test**

Build source, then spawn two Node child processes against the same temporary store and task. Synchronize their start through IPC/files, not sleeps. Exactly one child must report acquisition. Add a second test where the winner exits without release and a later process reclaims after an injected clock/expiry.

**Step 3: Run focused tests and confirm failure**

```bash
npm run build && npx vitest run test/durable-lease.test.ts
```

**Step 4: Implement atomic claim and fencing**

Use an atomic claim directory and random token. Reclaim stale claims by atomically renaming the stale directory before creating a new claim. Increment authoritative `leaseGeneration` and require token+generation for heartbeat, protected state transitions, and release. PID is diagnostic only.

**Step 5: Run focused and repeated contention tests**

Run the lease test repeatedly (at least 10 contention rounds) and confirm exactly one winner each round.

### Task 4: Implement workspace capture, drift classification, and evidence freshness

**Files:**
- Create: `src/durable/workspace-checkpoint.ts`
- Create: `src/durable/drift-validator.ts`
- Create: `src/durable/evidence-freshness.ts`
- Create: `test/workspace-checkpoint.test.ts`
- Create: `test/drift-validator.test.ts`
- Create: `test/evidence-freshness.test.ts`

**Step 1: Write failing workspace tests**

Create temporary Git repositories and assert deterministic repository/worktree identities, HEAD, changed-path records, index blob/mode, worktree hashes, symlink/missing markers, and digest stability. Assert no file contents are stored.

**Step 2: Write failing drift/evidence tests**

Cover `NO_DRIFT`, `MINOR_DRIFT`, `RECONCILABLE_DRIFT`, and `CONFLICTING_DRIFT`; task-owned incompatible modification must conflict. Verify stale evidence is invalidated on digest change. Spy on process execution and filesystem effects to prove no reset/stash/rebase/checkout/overwrite command occurs.

**Step 3: Run focused tests and confirm failure**

```bash
npx vitest run test/workspace-checkpoint.test.ts test/drift-validator.test.ts test/evidence-freshness.test.ts
```

**Step 4: Implement capture and validation**

Use `execFile`/`execFileSync` with argument arrays and bounded output. Parse NUL-delimited Git output safely. Canonicalize changed paths beneath the workspace root. Hash canonical sorted metadata and file bytes; persist only digests.

**Step 5: Run focused tests and diagnostics**

Expected: all drift/evidence tests pass with no destructive commands observed.

### Task 5: Add typed suspension and evidence-priority classification

**Files:**
- Create: `src/recovery/suspension.ts`
- Modify: `src/types/result.ts`
- Modify: `src/recovery/recovery-coordinator.ts`
- Modify: `src/recovery/health-projector.ts`
- Modify: `src/recovery/runtime-recovery-executor.ts`
- Create: `test/suspension.test.ts`
- Modify: `test/failure-normalization.test.ts`
- Modify: `test/runtime-recovery-executor.test.ts`
- Modify: `test/health-projector.test.ts`

**Step 1: Write failing classification tests**

Cover explicit reset timestamp, Retry-After, known quota window, reliable structured usage metadata, provider outage, and ambiguous 429. Assert ambiguous 429 remains route-level `rate_limit` and never produces a long account cooldown.

**Step 2: Write failing RecoveryCoordinator tests**

Assert cancellation stops, available fallback remains preferred, and only the coordinator creates structured suspend decisions after fallbacks are unavailable. Assert durable components do not invent fallback policy.

**Step 3: Run focused tests and confirm failure**

```bash
npx vitest run test/suspension.test.ts test/failure-normalization.test.ts test/runtime-recovery-executor.test.ts test/health-projector.test.ts
```

**Step 4: Implement sanitized resume plans**

Add deterministic strategy selection and bounded initial scheduling. Extend coordinator decisions with a safe resume plan. Keep health projection as the only cooldown writer and use its injected clock consistently rather than direct `Date.now()`.

**Step 5: Run focused tests and inherited recovery tests**

Expected: all tests pass; cancellation never creates a suspension.

### Task 6: Implement continuation packages and the host-neutral launcher port

**Files:**
- Create: `src/recovery/continuation.ts`
- Create: `test/continuation.test.ts`
- Modify: `src/durable/contracts.ts`

**Step 1: Write failing package tests**

Assert reconstruction includes objective, criteria, phase, completed/remaining/unresolved work, bounded findings, current workspace, evidence freshness, suspension/recovery context, and policy constraints. Assert it excludes transcript, raw prompts, raw provider data, secrets, and hidden reasoning.

**Step 2: Define `ContinuationLauncher` port and result**

The port accepts a durable package plus preallocated continuation ID and returns a new invocation/session identity and sanitized progress outcome. It has no Advisor dependency.

**Step 3: Implement deterministic package rendering**

Produce a concise structured prompt from exact-allowlist state. Avoid carrying arbitrary previous assistant text beyond bounded sanitized findings.

**Step 4: Run focused tests and diagnostics**

```bash
npx vitest run test/continuation.test.ts
```

### Task 7: Implement WakeupService and startup state machine

**Files:**
- Create: `src/recovery/wakeup-service.ts`
- Create: `test/wakeup-service.test.ts`
- Create: `test/startup-resume.test.ts`
- Modify: `src/workflow/events.ts`

**Step 1: Write failing wakeup tests**

Cover not due, due, lease rejected, unavailable→reschedule, available→resuming, bounded backoff, maximum checks→blocked, continuation budget→blocked, cancellation ignored, completed/blocked/cancelled ignored, and no Advisor calls.

**Step 2: Write crash-boundary tests**

Cover:

- suspended state survives restart;
- resuming before reservation can revalidate;
- reserved continuation proceeds once;
- `launching` without receipt blocks as ambiguous;
- launched/running provenance prevents relaunch;
- successful continuation before release does not duplicate.

**Step 3: Run focused tests and confirm failure**

```bash
npx vitest run test/wakeup-service.test.ts test/startup-resume.test.ts
```

**Step 4: Implement scan and single-task processing**

Persist every authoritative transition before the next side effect. Hold and heartbeat the lease during revalidation/launch. Release only with matching token/generation. Emit all required sanitized events.

**Step 5: Implement timer scheduling**

Add a single unref'd timer for the nearest due time, injectable for tests. `nextCheckAt` on disk remains authoritative; startup always scans independently of prior timers.

**Step 6: Run focused tests and diagnostics**

Expected: all tests pass and launcher call count proves no duplicates.

### Task 8: Implement the public-SDK Pi continuation launcher

**Files:**
- Create: `src/runtime/pi-continuation-launcher.ts`
- Create: `test/pi-continuation-launcher.test.ts`
- Modify: `scripts/check-architecture.mjs`
- Modify: `test/architecture-gates.test.ts`

**Step 1: Write failing launcher tests with a public-SDK seam**

Assert each launch creates a new session identity, uses `SessionManager.inMemory()`, resolves the requested registered model, sends only the structured continuation package, records `continuationOf`, and disposes the session. Assert no old transcript/session manager is reused and no `setModel` occurs.

**Step 2: Add static ownership tests**

Extend architecture gates so Pi imports are allowed only at existing boundaries plus `runtime/pi-continuation-launcher.ts`; exactly one production Pi launcher construction is allowed; no low-level `pi-ai` import or Advisor dependency is allowed in wakeup/durable code.

**Step 3: Run focused tests and confirm failure**

```bash
npx vitest run test/pi-continuation-launcher.test.ts test/architecture-gates.test.ts
```

**Step 4: Implement with public Pi SDK**

Use `createAgentSession`, `SessionManager.inMemory()`, current model registry resolution, isolated agent directory, and task cwd. The launcher creates a genuinely new session and awaits the new prompt lifecycle. Persist only sanitized result/provenance through the caller.

**Step 5: Run focused tests and architecture gates**

Expected: launcher tests pass and architecture gate count increases with all gates green.

### Task 9: Project workflow transitions into durable authority

**Files:**
- Create: `src/workflow/durable-task-projector.ts`
- Create: `test/durable-task-projector.test.ts`
- Modify: `src/workflow/workflow-state.ts`
- Modify: `src/workflow/workflow-controller.ts`
- Modify: `src/workflow/runtime-factory.ts`
- Modify: `test/workflow-state.test.ts`
- Modify: `test/workflow-controller.test.ts`
- Modify: `test/runtime-factory.test.ts`

**Step 1: Write failing projection tests**

Assert task creation, checkpoint, validation, recovery counters, suspension, cancellation, and completion are revision-checked into durable state. Assert disk failure becomes typed workflow failure where authority is required, unlike diagnostic sink failure.

**Step 2: Write ownership regression tests**

Assert runtime factory still constructs exactly one coordinator, health registry, and health projector; the projector never makes recovery decisions; cancellation never resumes.

**Step 3: Run focused tests and confirm failure**

```bash
npx vitest run test/durable-task-projector.test.ts test/workflow-state.test.ts test/workflow-controller.test.ts test/runtime-factory.test.ts
```

**Step 4: Add the projection seam**

Inject `DurableTaskStore` and workspace capture into runtime creation. Persist authoritative transitions with monotonic revisions. Do not make the diagnostic event callback authoritative.

**Step 5: Run focused and inherited workflow tests**

Expected: all pass and no extra policy owner appears.

### Task 10: Wire startup scan and durable continuation into the Pi extension

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/runtime/extension-tools.ts`
- Modify: `test/extension-runtime.test.ts`
- Modify: `test/extension-discovery.test.ts`
- Modify: `test/ownership-guard.test.ts`
- Modify: `scripts/pi1-dev.sh` only if the isolated directory needs new subdirectories

**Step 1: Write failing extension lifecycle tests**

Assert:

- one production filesystem store is rooted under isolated `PI_CODING_AGENT_DIR`;
- `session_start` runs ownership guard then startup scan;
- due tasks resume without operator reconstruction;
- future tasks are ignored;
- lease contention is harmless;
- `session_shutdown` does not convert an already suspended task into cancellation;
- explicit `wayforge_cancel` persists cancellation and can never resume;
- startup corruption/conflicting drift is surfaced as blocked;
- production `~/.pi` is not accessed when isolated.

**Step 2: Run focused tests and confirm failure**

```bash
npx vitest run test/extension-runtime.test.ts test/extension-discovery.test.ts test/ownership-guard.test.ts
```

**Step 3: Wire the composition root**

Construct one `FilesystemDurableTaskStore`, one `PiContinuationLauncher`, and one `WakeupService` in the extension lifecycle. Preserve the sole parent model writer and existing tool ownership guard. Do not add legacy continuation/fallback plugins.

**Step 4: Add bounded operational status**

Expose sanitized durable status through the existing status tool without adding an unbounded transcript or secret-bearing fields. Keep assisted Alpha 0 behavior compatible.

**Step 5: Run extension tests, discovery probe, and Alpha 0 gate**

```bash
npx vitest run test/extension-runtime.test.ts test/extension-discovery.test.ts
npm run check:alpha0
```

### Task 11: Add the real cross-process restart integration harness

**Files:**
- Create: `test/durable-restart-integration.test.ts`
- Create: `test/fixtures/durable-runtime-child.mjs`
- Create: `scripts/check-alpha1.mjs`
- Modify: `package.json`

**Step 1: Write the child-process scenario**

The first process creates a real durable task, records useful checkpoint work, applies a deterministic synthetic `usage_limit` decision from the real coordinator, persists suspension, reports readiness, and is terminated.

The second process starts against the same isolated store after the availability fixture advances. It performs startup scan, lease acquisition, workspace validation, evidence invalidation where applicable, and launches exactly one synthetic continuation through the real launcher port boundary.

**Step 2: Assert process-level evidence**

Verify persisted task ID/revisions, suspension and `nextCheckAt`, different old/new invocation IDs, `continuationOf`, one launch record, running/progress state, and zero duplicate launches across a third startup.

**Step 3: Add a process-level drift-block scenario**

Suspend a fixture task, externally alter a task-owned path, restart, and assert persisted `blocked`, `CONFLICTING_DRIFT`, zero launches, and unchanged external file/Git state.

**Step 4: Run the harness**

```bash
npm run build
npx vitest run test/durable-restart-integration.test.ts
node scripts/check-alpha1.mjs
```

Expected: both positive restart and negative drift scenarios pass without provider traffic.

### Task 12: Documentation, isolated launcher smoke, and dogfood preparation

**Files:**
- Modify: `README.md`
- Create: `docs/alpha-1-durable-resume.md`
- Create: `docs/evidence/phase-1b2-alpha1-restart-dogfood.json` after the run
- Modify: `scripts/check-alpha1.mjs`

**Step 1: Document authority boundaries and limitations**

Document persisted/session-only/never-persisted data, filesystem layout, crash windows, host-offline limitation, four drift classes, manual blocked recovery, and no external daemon.

**Step 2: Document deterministic digest and security properties**

Specify digest inputs, path containment, no file contents in state, atomic write sequence, fsync behavior, corruption policy, lease fencing, and ambiguous continuation crash handling.

**Step 3: Smoke the isolated launcher**

Rebuild `.wayforge-dev` shims and run extension discovery plus a non-provider startup scan. Record that production `~/.pi` metadata remains unchanged.

**Step 4: Prepare reversible dogfood task**

Choose a small documentation/test improvement in a controlled isolated worktree. Capture the initial workspace checkpoint and task write-set before starting.

### Task 13: Run positive and negative restart dogfood

**Files:**
- Modify only the selected reversible dogfood target
- Create/update: `docs/evidence/phase-1b2-alpha1-restart-dogfood.json`

**Step 1: Positive cycle**

Demonstrate Main start, useful work, controlled typed suspension, checkpoint persistence, process stop, new process startup scan, lease claim, acceptable drift classification, new Pi continuation identity, `continuationOf`, continued work, and validation.

**Step 2: Negative conflicting-drift cycle**

In a controlled fixture, suspend a task, externally modify a task-owned path incompatibly, restart, and prove `blocked`, no continuation, and no reset/stash/rebase/overwrite.

**Step 3: Curate sanitized evidence**

Persist only task IDs, revisions, timestamps, classifications, invocation linkage, validation commands/results, and changed paths/digests. Exclude credentials, transcript, prompts, raw provider bodies, and hidden reasoning.

### Task 14: Final review, verification, and single commit

**Files:**
- Review all changed files
- No new scope unless a failing gate requires a focused correction

**Step 1: Run security and ownership review**

Check path traversal, symlink/TOCTOU exposure, unsafe temporary files, command injection, secret persistence, lease races, unbounded data, and low-level transport bypass. Confirm no unnecessary Pi import in host-neutral modules.

**Step 2: Run clean verification**

```bash
npm ci
npm audit --omit=dev
npm run check:architecture
npm test
npm run typecheck
npm run build
npm run check:alpha0
npm run check:alpha1
git diff --check
```

Also run active LSP diagnostics over every changed TypeScript path. Investigate every warning against current filesystem/compiler state.

**Step 3: Verify safety evidence**

Confirm production `~/.pi` unchanged, legacy plugins untouched, isolated restart harness green, positive dogfood green, negative drift dogfood blocked safely, and no credentials/transcripts/reasoning in durable files or evidence.

**Step 4: Inspect final Git state**

Confirm parent is `442ae7675895b3e42089803853fc72e341e62c35`, the branch contains no intermediate commits, and all intended files are staged exactly once.

**Step 5: Create the only commit**

```bash
git add <reviewed Phase 1B.2 files>
git commit -m "Phase 1B.2: add durable execution and autonomous resume"
```

**Step 6: Verify post-commit state**

Confirm clean worktree, commit SHA/parent, and stop before Phase 1B.3.
