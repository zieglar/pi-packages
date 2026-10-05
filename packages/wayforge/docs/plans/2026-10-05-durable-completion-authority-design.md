# Phase 1B.3 Durable Completion Authority Design

## Status

Approved design for the frozen Phase 1B.3 baseline `d8e7b88e7d1ebb601ffba8349ec82de0b39da181`.

## Goal

Make one `CompletionAuthority` the sole production owner of governed durable completion. A workflow may become visibly completed only after deterministic readiness, fresh workspace-bound validation, candidate-bound Advisor approval, revalidation, and a lease-fenced durable compare-and-swap have succeeded.

## Frozen constraints

- Preserve the Advisor output contract (`approve | changes_requested | unable`, summary, findings), 800-token budget, and high thinking level.
- Preserve the sole `RecoveryCoordinator` and existing recovery taxonomy.
- Do not add account integration, routing/fallback policy, packages, release work, or a second durable store.
- Persist no credentials, raw provider payloads, hidden reasoning, transcripts, or workspace contents.

## Pre-implementation completion map

| Current location | Current role | Classification | Required change |
| --- | --- | --- | --- |
| `src/runtime/extension-tools.ts` `wayforge_complete` | Calls `WorkflowController.complete()` | Request surface | Become an async request surface only. |
| `src/workflow/workflow-controller.ts` `complete()` | Checks in-memory validations/latest Advisor verdict, sets workflow `completed`, emits `completion_ready` | `AUTHORITATIVE` (weak in-memory authority) | Delegate the complete transaction to `CompletionAuthority`; project workflow-visible completion only after durable success. |
| `src/runtime/durable-task-projection.ts` `completion_ready` branch | Converts the in-memory event into durable `completed` without a lease | `PROJECTION_ONLY` | Remove durable completion writing; the event becomes notification only. |
| `DurableTaskStore.update()` | Generic revision CAS, optionally fenced | Persistence primitive | Keep generic; only `CompletionAuthority` may use it to write governed `completed`. |
| Completed-state fixtures | Build test states | `TEST_ONLY` | Retain as fixtures, never production authority. |

No other production `status = completed` writer was found. Schema literals and worker/continuation terminal statuses are not task-completion writers.

## Current ownership audit

1. `WorkflowController.complete()` currently decides permission to complete.
2. `WorkflowController.advise()` currently calls Advisor.
3. `PiAdvisorAdapter` validates the strict Advisor JSON result.
4. Only in-memory booleans are checked as task validation evidence; no component checks durable evidence freshness for completion.
5. No explicit completion gate checks in-flight governed workers.
6. `captureWorkspaceCheckpoint()` computes workspace identity/digest, but the completion path does not consume it.
7. `WakeupService` owns recovery leases; the current completion path owns no lease.
8. `LiveDurableProjection` currently writes durable `completed`.
9. Workflow state can become completed before durable persistence agrees.
10. A weak in-memory `completion_ready` event can currently cause durable completion.

## Chosen architecture

### Single entry and owner

`wayforge_complete` invokes a single asynchronous `CompletionAuthority.requestCompletion(...)`. Manual `wayforge_advise` remains available as non-authoritative semantic consultation; its verdict cannot be reused to authorize completion.

`CompletionAuthority` owns this exact sequence:

```text
acquire fenced lease
→ capture current workspace
→ deterministic readiness
→ immutable candidate
→ Advisor review of that candidate
→ revalidate lease, state, workspace, evidence, and pending work
→ one fenced durable CAS persisting evidence + completed
→ workflow-visible completed projection
```

The authority is composed once in the live workflow composition. Advisor remains semantic only. Recovery remains an input lifecycle state, not a completion owner.

### Completion readiness

A small pure `CompletionReadiness` evaluator returns `READY` or a typed `NOT_READY` reason. Before Advisor can consume budget it checks:

- the durable task exists and is structurally valid;
- lifecycle is `running` (not suspended, resuming, blocked, cancelled, or already completed);
- no unresolved suspension or completion-relevant unresolved item exists;
- latest required validation evidence exists and passes;
- each accepted validation is explicitly bound to the current workspace digest;
- the workspace/repository/worktree identity is current;
- no required governed worker/subtask is pending;
- a fenced lease was acquired.

The refusal taxonomy stays limited to cases required by the phase: validation required/stale, workspace changed, pending work, lifecycle refusal, Advisor refusal/invalid result, lease conflict, state conflict, and already completed.

### Validation evidence binding

`wayforge_record_validation` becomes asynchronous. Through the completion domain it captures the current workspace checkpoint and records typed durable validation evidence with:

- validation name;
- pass/fail outcome;
- bounded summary;
- `validAtWorkspaceDigest`;
- recorded timestamp.

No control flow parses prose summaries. Existing evidence references are extended compatibly with typed validation outcome fields; old unbound command evidence is not completion-ready.

The current event projection stops writing unbound validation evidence. In-memory workflow validation is updated only after its durable evidence write succeeds.

### Pending governed work

The existing workflow state gains only bounded in-process ownership data:

- `pendingGovernedWorkCount`;
- monotonic `governedWorkEpoch`.

Worker delegation increments/decrements these values in a `try/finally`. The candidate requires count zero and captures the epoch. Final revalidation requires count zero and the same epoch. This solves the existing workflow's completion race without introducing a DAG or distributed scheduler.

### Immutable completion candidate

After readiness passes, the authority constructs and freezes a minimal candidate containing:

- task identity and authoritative revision;
- lease generation;
- repository/worktree identity and HEAD;
- current workspace digest;
- validation evidence identities and aggregate digest;
- pending-work count/epoch;
- lifecycle state;
- a deterministic candidate digest over those fields.

The candidate does not duplicate full task state or source contents.

### Advisor evidence and binding

The Advisor receives the existing strict semantic contract and sanitized evidence backed by the candidate:

- objective and completion criteria;
- workspace identity/digest;
- bounded changed paths/write set;
- fresh validation command/result summaries;
- candidate digest.

A valid `approve` result is bound in memory to the candidate digest, Advisor invocation identity, selected route, and a digest of the sanitized verdict. `changes_requested`, `unable`, malformed output, and provider failure return typed refusal and never reach the durable completion write.

The accepted Advisor contract, 800-token budget, high thinking, route selection, and no-hidden-retry behavior remain unchanged.

### Lease and TOCTOU boundary

One fenced lease is acquired before readiness and held across candidate review. No new retry or fallback is added. Before the final write, the authority:

1. verifies/heartbeats the same lease token and generation;
2. reloads the authoritative state and requires the exact candidate revision/lifecycle;
3. recaptures the workspace and requires identical repository, worktree, HEAD, and workspace digest;
4. requires the same fresh validation identities/digest;
5. requires pending count zero and the same work epoch;
6. requires the approval binding to match the candidate.

Lease expiry/loss, revision change, workspace mutation, evidence replacement, lifecycle change, or new governed work fails closed. The Advisor result is not reused automatically.

### Durable completion evidence

The existing unified durable state stores a discriminator-based completion record in the same CAS that writes `status: completed`. It includes only:

- authority version;
- candidate digest;
- resulting authoritative revision;
- workspace digest;
- validation evidence IDs/aggregate digest;
- sanitized Advisor invocation/route/status/verdict digest and bounded summary;
- completion timestamp;
- lease generation.

The state schema remains read-compatible with legacy completion records. New governed completions must use the authority record. No second persistence system is introduced.

### Ordering and idempotence

The final order is:

```text
fenced durable CAS completed
→ controller projects workflow-visible completed
→ completion_ready notification
→ tool success
```

`completion_ready` no longer writes durable state. A durable refusal therefore cannot leave the workflow visibly completed.

A repeat request for an already completed task with authority evidence returns deterministic idempotent success without another Advisor call, evidence append, or revision increment. A conflicting/legacy completed record returns a typed already-completed outcome without rewriting history.

### Recovery interaction

`suspended`, `resuming`, `blocked`, and `cancelled` fail readiness. `completed` follows idempotence only. `CompletionAuthority` consumes lifecycle state and never creates recovery decisions, suspension policies, or another `RecoveryCoordinator`.

## Error handling

Every refusal is an `ExecutionResult` failure or typed idempotent outcome. No string parsing controls behavior. Errors are sanitized and bounded. The authority always attempts lease release in `finally`; a successful durable CAS remains authoritative even if cleanup later reports a lease-release problem.

## Static ownership gates

Architecture checks will narrowly assert:

- exactly one production `CompletionAuthority` construction;
- no direct durable-completed write in `wayforge_complete`, Advisor, recovery, account adapters, or projection;
- the sole task-completion CAS is inside the authority;
- no second durable store or pi-accounts dependency/protocol is introduced;
- the sole `RecoveryCoordinator` invariant remains unchanged.

## Test design

Tests are written and observed RED before production changes. Required gates:

1. missing validation evidence;
2. stale validation evidence;
3. workspace changed after validation;
4. suspended lifecycle;
5. resuming lifecycle;
6. pending governed work;
7. Advisor `changes_requested`/`unable`;
8. malformed Advisor result;
9. stale lease generation;
10. lease lost between readiness and write;
11. state/workspace mutation after approval;
12. valid fenced completion;
13. idempotent repeat.

Integration tests additionally prove Advisor is not called on deterministic readiness failure, durable completion precedes workflow-visible completion, and concurrent revision/lease mutation fails closed.

After deterministic validation, one isolated positive real governed dogfood must reach authoritative completion, and one controlled stale-workspace scenario must refuse before Advisor invocation. Sanitized evidence only is retained.

## Rejected alternatives

1. **Persisted two-step `advise → complete`:** preserves old interaction but adds candidate/approval intermediate states and a wider TOCTOU/recovery surface.
2. **Support both one-step and two-step authority:** increases state-machine and idempotence complexity without an acceptance requirement.
3. **Harden event projection only:** retains multiple completion owners and permits workflow-visible completion before durable authority.
