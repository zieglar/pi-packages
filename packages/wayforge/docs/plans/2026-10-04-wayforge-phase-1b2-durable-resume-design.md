# Wayforge Phase 1B.2 Durable Execution & Autonomous Resume Design

## Status

Approved for implementation on top of frozen Phase 1B.1 commit `442ae7675895b3e42089803853fc72e341e62c35`.

Wayforge remains Pi-first and agent-portable. Pi is the only supported host in this phase. Host-neutral state, persistence, lease, scheduling, drift, and evidence logic must not import Pi APIs. Pi coupling is limited to extension lifecycle and continuation session launch.

## Goals

Phase 1B.2 makes a task-level checkpoint survive process exit and autonomously resume when a Wayforge/Pi process is available and the persisted blocking condition is due and eligible.

Resume is a new Pi invocation. It does not revive an old stream, replay a full conversation, or reconstruct hidden reasoning.

## Non-goals

No external daemon, OS service, distributed lease, database, event sourcing, destructive Git reconciliation, transparent same-invocation retry, multi-host abstraction, completion-authority expansion, or production Pi migration is introduced.

## Current-state audit

Phase 1A defines a versioned, exact-allowlist `AuthoritativeTaskState`, but the only implementation is an in-memory map. The runtime does not project `WorkflowTaskState` into that schema. Phase 1B.1 `WorkflowDiskSink` is explicitly write-only observability: it swallows failures, does not fsync, and is never read.

Therefore:

- `WorkflowDiskSink` remains diagnostic and cannot be recovery authority.
- The durable schema must evolve to represent suspension, resumption, drift, continuation provenance, and bounded history.
- The task store contract must support enumeration and revision-checked updates.
- Lease renewal, expiry, reclamation, and fencing must be added.
- Runtime transitions must project into one authoritative durable task record.

## Chosen architecture

### Storage layout

Use one task directory beneath the existing Wayforge root:

```text
<PI_CODING_AGENT_DIR>/wayforge/
  tasks/
    <safe-task-id>/
      state.json
      state.backup.json
      lease.claim/
        lease.json
  <task-id>.events.jsonl       # existing diagnostic sink
  <task-id>.status.json        # existing diagnostic sink
```

`state.json` is the only authoritative task state. The lease is coordination metadata owned by the same `FilesystemDurableTaskStore`; it is not a second task-state authority. Existing event/status files remain best-effort diagnostics.

Task IDs are converted to bounded safe directory keys. Every resolved path is checked to remain under the canonical store root.

### DurableTaskState v2

The exact-allowlist schema contains:

- schema version;
- task ID and revision;
- lease generation;
- status: `running`, `suspended`, `resuming`, `blocked`, `completed`, or `cancelled`;
- objective and completion criteria;
- policy versions;
- current phase;
- structured checkpoint summary;
- completed work, remaining work, unresolved items;
- bounded sanitized Worker/Advisor findings;
- `WorkspaceCheckpoint`;
- recovery counters, resume checks, and continuation launches;
- bounded sanitized recent attempts;
- last typed failure;
- typed suspension or null;
- validation/completion evidence references;
- current invocation and continuation provenance;
- prepared continuation state where applicable;
- created and updated timestamps.

The schema never permits credentials, raw provider bodies, transcripts, prompts retained solely to reconstruct model state, hidden reasoning, runtime objects, streams, controllers, clients, handles, timers, or sensitive environment data.

### Structured checkpoint

A checkpoint is concise state reconstruction, not a transcript. It includes:

- summary;
- completed work;
- remaining work;
- unresolved items;
- bounded semantic findings;
- workspace checkpoint;
- relevant evidence references.

Every collection has an explicit size/count bound before persistence.

## DurableTaskStore

`FilesystemDurableTaskStore` is the single authoritative implementation. Its public operations include:

- create;
- load;
- list/scan;
- revision-checked update;
- lease acquire;
- heartbeat;
- release;
- stale reclaim.

`InMemoryTaskStore` implements the same state semantics for unit tests but is never production authority.

### Atomic state update

Within the task directory:

1. validate the full state against the exact schema;
2. verify expected revision and active lease generation where required;
3. deterministically serialize;
4. create a random temporary file atomically with mode `0600`;
5. write and fsync the temporary file;
6. retain at most one previous valid snapshot as a bounded backup;
7. rename the temporary file over `state.json`;
8. fsync the task directory where supported.

Unsupported directory fsync errors are handled narrowly and documented; state validation and ordinary write failures are never swallowed.

### Corruption behavior

Malformed, truncated, unsupported-version, or schema-invalid authoritative state returns a typed `durable_state_corrupt`/`unsupported_version` blocked result. Startup scan reports the task as blocked and never launches it. Backup files are diagnostic only and are not silently promoted. Human action is required.

## Lease design

A lease prevents two local processes from resuming the same task. It is not a distributed lock.

Lease metadata contains:

- task ID;
- random owner token;
- owner instance ID;
- generation;
- acquired, heartbeat, and expiry timestamps;
- optional diagnostic PID.

Acquisition uses an atomic claim-directory operation. A valid unexpired claim rejects competitors. Stale reclaim atomically renames the old claim aside before competing for a new claim. Successful claim increments the authoritative task lease generation. All subsequent authoritative transitions validate both owner token and generation.

Heartbeat and release require exact token and generation matches. PID never establishes ownership.

## Suspension and classification

Persisted suspension reasons are:

- `rate_limit`;
- `usage_limit`;
- `provider_outage`.

Suspension records include sanitized scope and scope key, observation time, resume-not-before, next-check time, strategy, check count, maximum checks, and the originating typed failure.

Classification priority is:

1. explicit provider reset timestamp;
2. explicit Retry-After;
3. known quota-window metadata;
4. reliable structured provider metadata;
5. conservative rate-limit treatment.

An unqualified HTTP 429 remains ambiguous `rate_limit`; it may receive a short route cooldown but never a long-lived account usage cooldown.

The sole `RecoveryCoordinator` remains the policy owner. It may return a structured suspend decision. Durable components only persist and execute that decision.

## WakeupService and startup scan

`WakeupService` is host-neutral and deterministic. It receives the task store, resume-condition evaluator, drift validator, evidence freshness logic, continuation launcher port, clock, and bounded backoff policy.

On startup it scans once. While the process remains alive it schedules one bounded timer for the nearest due task; there is no busy loop. `nextCheckAt` is authoritative on disk.

For each due suspended task:

1. claim lease;
2. validate lease generation;
3. enforce resume-check and continuation-launch budgets;
4. evaluate the persisted resume condition without an unnecessary LLM call;
5. if unavailable, increment checks and persist bounded backoff;
6. if eligible, persist `resuming` before further side effects;
7. capture and classify current workspace;
8. invalidate stale evidence;
9. block on conflicting drift;
10. reserve and launch one new continuation;
11. persist provenance and resulting progress state;
12. release the lease if still owned.

Infrastructure recovery never invokes Advisor.

If no Pi/Wayforge process is alive, no work can execute. The next host startup performs the scan automatically. No launchd/systemd/cloud integration is added.

## WorkspaceCheckpoint

The checkpoint stores no file contents. It contains:

- canonical workspace root;
- repository identity hash;
- worktree identity hash;
- HEAD;
- deterministic working-state digest;
- bounded task write-set paths and fingerprints;
- capture timestamp.

The digest is SHA-256 over canonical, sorted records containing:

- HEAD;
- `git status --porcelain=v1 -z --untracked-files=all` status/path entries;
- relevant index mode/blob/stage entries;
- worktree file type and content hash, symlink target hash, or missing marker.

Git is invoked with argument arrays and no shell. Paths are canonicalized and verified beneath the workspace root.

## Drift classification

- `NO_DRIFT`: HEAD and full working-state digest match.
- `MINOR_DRIFT`: HEAD matches and only paths outside the task write-set changed.
- `RECONCILABLE_DRIFT`: repository/worktree identity remains valid and task-owned fingerprints match, but HEAD or non-owned workspace state changed. Continuation may proceed only after revalidation.
- `CONFLICTING_DRIFT`: repository/worktree identity changed, a task-owned fingerprint differs, or safe classification is impossible.

No class triggers reset, stash, rebase, overwrite, or discard. Conflicting drift persists `blocked` with actionable diagnostics.

## Evidence freshness

Every validation/completion evidence reference is tied to a workspace digest. A digest mismatch marks it stale and emits `evidence_invalidated`. Stale evidence may be passed to the continuation as stale context but cannot authorize completion.

Phase 1B.2 does not introduce the Phase 1B.3 completion-authority state machine.

## Continuation boundary

`PiContinuationLauncher` is the only new Pi-specific component. It uses the public Pi SDK:

- `createAgentSession`;
- `SessionManager.inMemory()`;
- a model resolved from Pi's registered model runtime;
- the isolated agent directory and task workspace;
- `AgentSession.prompt`.

The new session does not restore the old session transcript. Its concise structured continuation package is reconstructed solely from durable state and current workspace facts:

- objective and criteria;
- phase;
- completed, remaining, and unresolved work;
- bounded Worker/Advisor findings;
- current workspace and evidence state;
- suspension and recovery context;
- policy constraints.

The durable record links the new invocation/session to the previous invocation via `continuationOf`. No `setModel` call or direct `pi-ai` transport is introduced.

## Crash windows

- **After checkpoint, before suspended:** the state remains running with a checkpoint. Startup does not guess; it blocks an orphaned running task unless a complete suspension transition exists.
- **After lease acquisition:** expiry and generation allow stale reclaim.
- **After `resuming`, before reservation:** the valid lease holder may repeat deterministic revalidation; after expiry a new generation may do so.
- **After continuation reservation, before launch boundary:** the reservation is idempotent and may proceed under a valid generation.
- **After `launching`, before launch receipt:** Pi offers no transactional exactly-once launch. Restart blocks with `continuation_outcome_ambiguous` instead of silently duplicating.
- **After successful continuation, before lease release:** persisted launched/running provenance prevents relaunch; stale lease later expires and can be released/reclaimed without a second continuation.

This fail-closed ambiguity is explicit and preferable to duplicate autonomous work.

## Observability

Sanitized events include checkpoint written, suspension created, resume scheduled/check, lease acquired/rejected/reclaimed, drift classification, evidence invalidation, continuation reserved/launched/linked, resume failed, and task blocked.

Events remain diagnostic. Authoritative decisions and transitions are in `state.json`.

## Static ownership gates

Extend architecture checks to preserve:

- one parent `setModel` writer;
- one `RecoveryCoordinator` construction;
- one `HealthRegistry` construction;
- one production `FilesystemDurableTaskStore` construction;
- one Pi continuation launcher boundary;
- Pi imports only at existing boundaries plus the continuation launcher;
- no Advisor dependency from durable wakeup/recovery infrastructure;
- no direct low-level transport or private pi-subagents import.

## Test strategy

Use TDD for schema/store, lease, suspension, wakeup/startup, drift/evidence, continuation, and runtime wiring. Add child-process integration fixtures for real process exit/restart and competing claims. Add isolated positive and conflicting-drift dogfood evidence without spending provider quota for synthetic suspension.

Only after all inherited and new gates pass is the single final commit created:

`Phase 1B.2: add durable execution and autonomous resume`
