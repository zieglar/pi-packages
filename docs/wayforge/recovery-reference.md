# Wayforge Recovery Reference

A factual operator reference for Wayforge's durable recovery semantics: what happens to a governed task
across process interruption, suspension, wakeup, continuation, and startup reconciliation, which
component owns each behavior, and what an operator should (and must not) do.

Grounded in `packages/wayforge/src/recovery/wakeup-service.ts`, `startup-recovery-scan.ts`,
`recovery-coordinator.ts`, `runtime-recovery-executor.ts`, `continuation.ts`, `suspension.ts`, and
`resume-availability.ts` (same directory); `packages/wayforge/src/durable/state.ts` and
`packages/wayforge/src/durable/drift-validator.ts`; `packages/wayforge/src/runtime/durable-composition.ts`,
`durable-task-projection.ts`, and `pi-continuation-launcher.ts` (same directory);
`packages/wayforge/src/extension.ts`; and the design context in
`packages/wayforge/docs/alpha-1-durable-resume.md`.

## Purpose

This reference covers the authoritative durable behavior of governed Wayforge tasks when execution does
not run uninterrupted to a terminal status: interruption reconciliation, typed suspension, wakeup
scheduling, continuation launches, and the startup recovery scan.

It explicitly does not cover:

- reading raw durable files (the durable store is not an operator surface; use the read-only inspection
  tools in `docs/wayforge/inspection-guide.md`);
- manual editing of durable state (never supported; see [Operator guidance](#operator-guidance));
- cross-session Main resume (there is none: recovery always produces a **new** invocation from a
  continuation package; no prior session, transcript, or stream is resurrected).

## Durable task statuses

The authoritative durable schema (`packages/wayforge/src/durable/state.ts`) defines exactly seven
statuses:

| Status | Meaning |
| --- | --- |
| `pending` | Schema-valid status for a task that has not started execution. The current live admission path creates governed tasks directly as `running`; nothing in the cited sources produces `pending`. |
| `running` | A live — or formerly live — governed execution. **Not proof of liveness**: a process that dies without a terminal write leaves a stale `running` record behind. |
| `suspended` | A typed, bounded suspension was persisted by a terminal `suspend` recovery decision. Wakeup-eligible when `suspension.nextCheckAtMs` is due. |
| `resuming` | The wakeup scheduler accepted the suspension and is preparing or launching a continuation. A crash-safe intent marker, never a final state. |
| `blocked` | Fail-closed outcome with a typed `lastFailure`. Nothing resumes a blocked task automatically. |
| `completed` | Terminal. Acceptance additionally requires authoritative completion evidence (`completion_authority_v1`). |
| `cancelled` | Terminal. Nothing resumes it. |

Authoritative transitions: durable status changes happen only through the durable store's leased,
revision-CAS writes. The `WakeupService` acquires a lease, revalidates `leaseGeneration` after loading,
and persists every transition at `revision + 1` under that lease; the live projection
(`LiveDurableProjection`) writes creation, suspension, cancellation, and unresolved-item updates through
the same store with revision CAS. Every graceful terminal path persists a terminal status, so a
`running` record at a fresh startup scan belongs to an execution that ended without one.

## Process interruption

When a governed runtime dies with a `running` task, recovery happens at the next process start:

1. The live extension composes the durable stack once per process and fires exactly one
   `StartupRecoveryScanner.scan(...)` asynchronously at session start (after the ownership guard
   passes). The scan never blocks session start, and repeated session starts cannot enqueue duplicate
   scans.
2. The scanner reconciles interrupted `running` tasks **first**, before any wakeup processing, so
   continuations launched later in the same scan are never self-interrupted.
3. Reconciliation (`WakeupService.reconcileInterruptedRunning`) selects `running` tasks from the store,
   excluding tasks owned by the current process via the caller-supplied `isOwnedTask` predicate.
4. Per stale task, under a fresh lease (default TTL 30,000 ms):
   - an actively held lease (`lease_contended`) means a live owner or a concurrent reconciler: the task
     is **skipped safely**, never interrupted;
   - after loading, a task whose `leaseGeneration` no longer matches the lease, or whose status is no
     longer `running`, has legitimately advanced and is skipped;
   - otherwise the task transitions to `blocked` with `lastFailure.code = "interrupted_execution"`
     ("previous governed execution ended before terminal state"), persisted by revision-CAS.
5. Fencing/CAS conflicts on that update (`stale_task_revision`, `lease_contended`, `lease_expired`,
   `lease_token_mismatch`, `lease_race`, `lease_corrupt`, `lease_missing`, `task_not_found`) lose
   safely: the reconciler skips instead of fighting a live owner.

In the live composition the operator is notified how many `running` tasks were marked
`blocked (interrupted_execution)`.

## Suspension and wakeup

A durable suspension is authored only by the `RecoveryCoordinator` (the schema's `decidedBy` also
permits the literal `operator`, but no production path authors one). Suspension fields: `kind`
(`usage_limit`, `rate_limit`, `provider_outage`), bounded `reason`, `scope` (`route`, `account`,
`model`, `provider`) with `scopeKey`, `observedAtMs`, `resumeNotBeforeMs`, `nextCheckAtMs`, `strategy`
(`explicit_reset`, `retry_after`, `known_quota_window`, `availability_probe`, `bounded_continuation`),
`checkCount`, `maxChecks`, the sanitized `originatingFailure`, and `decidedBy`.

Scheduling bounds (`packages/wayforge/src/recovery/suspension.ts`): every schedule is clamped into
`[now, now + maxScheduleDelayMs]`. Executor defaults: `maxResumeChecks` 5 (hard-capped at 20 by the
scheduler), `availabilityProbeDelayMs` 30,000 ms, `boundedContinuationDelayMs` 60,000 ms,
`maxScheduleDelayMs` 24 hours.

Wakeup scheduling belongs to `WakeupService` alone — a single-pass deterministic scheduler with **no
timer or loop**; the caller chooses when to scan (in the live extension: once per process, inside the
startup scan). A task is due when it is `suspended` with `nextCheckAtMs <= now`, or `resuming` with no
continuation record or one in phase `reserved` or `launching`.

Resume conditions: time-based strategies (`explicit_reset`, `retry_after`, `known_quota_window`) become
available once `resumeNotBeforeMs` has elapsed; probe strategies (`availability_probe`,
`bounded_continuation`) consult the live `HealthRegistry`. Without a live registry the default
composition reports `health_unavailable` and the scheduler **reschedules** instead of resuming
optimistically: `checkCount` increments, `nextCheckAtMs` moves out by 30,000 ms, and
`recoveryCounters.resumeChecks` increments. Exhausting `maxChecks` while unavailable blocks the task
with `resume_check_budget_exhausted`.

`resuming` means the scheduler passed the availability gate and is preparing a continuation. It is
fail-closed across restarts:

- `resuming` with continuation phase `launching` (the process died after the durable launch intent):
  blocked with `continuation_outcome_ambiguous` — never blindly replayed;
- `resuming` with no persisted suspension: blocked with `resuming_suspension_missing`;
- `resuming` with continuation absent or `reserved`: restored to `suspended` and re-entered
  deterministically under lease.

Bounded budgets guard every resume: `recoveryAttempts` (default max 5) and `continuationLaunches`
(default max 3) block with `recovery_attempt_budget_exhausted` / `continuation_launch_budget_exhausted`
when exhausted. Before launch the scheduler recaptures the workspace; capture failure blocks with
`workspace_capture_failed`, a missing authoritative checkpoint with `workspace_checkpoint_missing`, and
`CONFLICTING_DRIFT` (changed repository/worktree identity, changed task write set, or changed task-owned
fingerprints) blocks with `workspace_drift_conflict` — before any launch intent is persisted.

## Continuation packages

A continuation package (`packages/wayforge/src/recovery/continuation.ts`) is the host-neutral,
exact-allowlist reconstruction input for a **new** invocation. It carries: task and continuation
identity, checkpoint revision, sanitized invocation provenance (`currentInvocationId`,
`previousInvocationId`, `continuationOf`), objective, completion criteria, current phase, the checkpoint
summary plus completed/remaining work lists, unresolved items, the newly verified workspace checkpoint,
fresh evidence references, stale evidence references (contextual only — stale evidence **cannot
authorize completion**), the suspension record, recovery counters, and the fixed policy constraints
`new_invocation_required`, `no_destructive_workspace_recovery`,
`no_advisor_for_infrastructure_recovery`, and `bounded_resume_checks`.

It never carries an SDK session, provider body, transcript, prompt history, runtime handle, live stream,
credential, or chain-of-thought. Privacy bounds: every text field is truncated to a per-field maximum
and passed through secret-pattern redaction (`sk-`/`rk-` keys and `Bearer` tokens become `[redacted]`),
and the durable schema itself rejects secret-shaped content on write.

Launch is at-most-once after the durable launch intent, not exactly-once: the scheduler persists
continuation phase `reserved`, builds the package, persists `launching`, and only then calls the
launcher. A launch that throws or returns no authoritative result after the durable intent blocks with
`continuation_outcome_ambiguous`. The live launcher (`PiContinuationLauncher`) verifies the persisted
continuation identity (mismatch refuses with `continuation_identity_mismatch`), creates a completely
fresh in-memory Pi session in an isolated agent directory — never production Pi configuration — working
in the checkpoint's workspace root, and prompts it with the rendered package. A successful launch
persists status `running`, clears the suspension, marks the continuation `launched`, records
continuation provenance, and increments `continuationLaunches` and `recoveryAttempts`.

## Planning vs execution

Ownership is split deliberately:

- `RecoveryCoordinator` is the **sole planner**: pure and deterministic, it returns decisions only and
  never performs transitions. Precedence: cancellation stops; temporary current-route failures retry
  within budget; account-scoped failures rotate account; model-scoped failures fall back by model;
  provider-scoped failures fall back by provider; only this coordinator may author a durable suspension
  once no healthy bounded route remains; otherwise it blocks. Infrastructure failures never produce
  advisor semantics.
- `RuntimeRecoveryExecutor` **executes** decisions and never decides policy: it records cooldowns
  through the `HealthProjector` into the single `HealthRegistry` (the only availability/cooldown
  authority), emits the recovery events, decrements budgets, and mints linked retry invocations.
- `WakeupService` owns wakeup scheduling only; the `StartupRecoveryScanner` owns one ordered startup
  pass and has no timer or loop of its own.

Stated honestly: in the live composition the controller calls the executor's `plan(...)` once per failed
worker delegation, and a terminal `suspend` decision reaches durable state through the live projection
reacting to the `recovery_applied` event. The executor's bounded multi-step `run(...)` retry loop exists
in source but is **not wired** into the live controller today, and no background wakeup driver exists —
wakeups happen at startup scans.

## Operator guidance

Supported next actions per status (matching the inspection projection's `nextAction`):

- `completed` — no action required; verify acceptance via the authoritative completion marker, not a
  runtime message.
- `cancelled` — terminal; start a new task if desired.
- `blocked` — inspect `lastFailure` (`kind`/`code`), correct the cause, and start a **new governed
  task**. A blocked task never resumes itself.
- `suspended` — wait for the existing resume condition in the suspension window; do not restart
  manually.
- `resuming` — recovery is underway; no operator action is required yet.
- `pending` — the task has not started execution yet.
- `running` — liveness is not established by inspection; a stale `running` record is reconciled to
  `blocked` at the next startup scan.

Rules:

- **Never manually edit durable state.** The schema is a strict exact allowlist with fencing and
  revision CAS; hand edits break those assumptions and are not a supported recovery path.
- **Liveness caveat**: in the live composition wakeup scans run only at process startup, so a suspended
  task whose window passes mid-session is processed at the next session start, not in real time.
- Start a new governed task when a task is `blocked`, `cancelled`, or settled with a negative review —
  corrected work re-enters through a new governed task lifecycle.

## Failure codes

Recovery-related typed codes an operator can see in `lastFailure` or scan notifications (all
`WakeupService` blocks are `capability`/`task`/`certain`):

| Code | Meaning |
| --- | --- |
| `interrupted_execution` | Previous governed execution ended before terminal state; reconciled to `blocked` at startup. |
| `continuation_outcome_ambiguous` | Continuation launch outcome is ambiguous after a restart or launch failure; blocked instead of replayed. |
| `resuming_suspension_missing` | A `resuming` task has no persisted suspension to recover. |
| `recovery_attempt_budget_exhausted` | The bounded recovery-attempt budget is exhausted. |
| `continuation_launch_budget_exhausted` | The bounded continuation-launch budget is exhausted. |
| `resume_check_budget_exhausted` | Bounded wakeup checks are exhausted while availability remains unavailable. |
| `workspace_capture_failed` | Workspace capture failed before continuation launch. |
| `workspace_checkpoint_missing` | A suspended task has no authoritative workspace checkpoint. |
| `continuation_reservation_missing` | The continuation reservation was not persisted. |
| `continuation_launch_record_missing` | The continuation launch record was not persisted. |
| `workspace_drift_conflict` | Conflicting workspace drift on task-owned paths; blocked before launch intent. |
| `continuation_identity_mismatch` | Persisted continuation identity does not match the launch intent (launcher refusal). |
| `pi_continuation_launch_failed` | The Pi continuation launch did not return an authoritative completion result. |
| `recovery_stopped` | Terminal recovery decision: cancellation stopped recovery. |
| `recovery_suspended` | Terminal recovery decision: the task suspended with a resume window. |
| `recovery_blocked` | Terminal recovery decision: no recovery rule matched, budget exhausted, or the step limit was reached. |

Fail-closed reconciliation loss codes — never surfaced as task failures; their presence makes the
reconciler skip safely: `stale_task_revision`, `lease_contended`, `lease_expired`,
`lease_token_mismatch`, `lease_race`, `lease_corrupt`, `lease_missing`, `task_not_found`.

## Open questions

- The durable schema admits `pending`, but the cited live admission path creates tasks directly as
  `running`; which component, if any, will ever produce `pending` is not settled by the sources.
- The suspension schema permits `decidedBy: "operator"`, but no production path authors an operator
  suspension; whether one will exist is unsettled.
- The executor's bounded `run(...)` retry loop is implemented but unwired in the live controller;
  whether it will be wired is unsettled.
- No periodic/background wakeup driver exists in the cited sources — only the startup-invoked scan;
  whether mid-session wakeups will ever be driven is unsettled.
