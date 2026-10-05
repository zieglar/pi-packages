# Durable Completion Authority Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Establish one lease-fenced durable completion owner that rejects stale or insufficient completion before Advisor invocation and publishes workflow completion only after an authoritative durable CAS.

**Architecture:** A pure readiness evaluator and one `CompletionAuthority` operate over the existing `DurableTaskStore`, workspace checkpoint, strict `PiAdvisorAdapter`, and bounded workflow pending-work snapshot. `wayforge_complete` is the single request entry; it acquires one lease, constructs an immutable candidate, obtains candidate-bound semantic approval, revalidates all deterministic inputs, atomically persists completion evidence plus `completed`, then projects workflow-visible completion.

**Tech Stack:** TypeScript 5.9, Vitest 4, TypeBox durable schemas, existing Git workspace checkpointing, existing `DurableTaskStore` revision CAS/fenced leases, Pi 1.0.2 extension APIs.

---

## Operating constraints

- Start implementation from design commit `d71c607` on `main` with a clean worktree.
- Use Node `22.14.0` and pnpm `12.9.1` through `mise`.
- Do not change the Advisor JSON contract, 800-token budget, high thinking, routing, or retry behavior.
- Do not add recovery policy, another `RecoveryCoordinator`, accounts integration, dependencies, packages, or release changes.
- Write no production implementation until the complete 13-gate live/public-path suite has been run and its expected missing-authority failures recorded.
- Use one final implementation commit, plus at most one evidence-only commit if live evidence must follow it.

## Task 1: Add the complete 13-gate RED acceptance suite

**Files:**
- Create: `packages/wayforge/test/durable-completion-authority.test.ts`
- Modify only if reusable test control is required: `packages/wayforge/test/helpers/fake-pi-host.ts`

**Step 1: Build a public-path harness**

Use the real `createWayforgeExtension`, `FakePiHost`, a disposable Git workspace, `FilesystemDurableTaskStore`, and controlled `modelRegistry.streamSimple`. Drive the registered tools instead of importing the future authority.

The harness must expose:

```ts
interface CompletionHarness {
  readonly host: FakePiHost;
  readonly workspace: string;
  readonly store: FilesystemDurableTaskStore;
  readonly runtime: WorkflowRuntime;
  readonly advisorCalls: readonly AdvisorCall[];
  recordValidation(name: string, ok: boolean, summary: string): Promise<ToolResult>;
  complete(): Promise<ToolResult>;
  state(): Promise<AuthoritativeTaskState>;
}
```

`complete()` calls the actual registered `wayforge_complete` tool. Advisor controls may return strict approve/changes_requested/unable JSON, malformed text, or execute a bounded callback after review to simulate state/workspace/lease races.

**Step 2: Add all required gate tests before production edits**

Add one clearly named test for each behavior:

1. returns typed `validation_required` and does not call Advisor when no durable validation exists;
2. returns typed `validation_stale` and does not call Advisor for evidence bound to another digest;
3. validate → mutate workspace → complete returns `workspace_changed`, no Advisor call, durable state remains running;
4. suspended task returns `task_suspended`, no Advisor call;
5. resuming task returns `task_resuming`, no Advisor call;
6. an in-flight governed worker returns `pending_work`, no Advisor call;
7. strict `changes_requested` and `unable` return distinct typed refusals and do not complete;
8. malformed Advisor output returns `advisor_invalid` and does not complete;
9. a stale lease generation cannot commit;
10. lease ownership lost after Advisor but before CAS returns `lease_conflict`;
11. durable revision or workspace mutation after Advisor returns `state_conflict`/`workspace_changed` and does not complete;
12. fresh evidence + no pending work + approve writes durable completion evidence before workflow status becomes completed;
13. repeat completion returns deterministic idempotent success with no second Advisor call, evidence duplication, or revision increment.

Each assertion checks both workflow-visible state and durable state. Record the order of the final durable update and workflow event in Gate 12.

**Step 3: Run the RED suite**

Run:

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- durable-completion-authority.test.ts
```

Expected: the suite fails because the current public path has generic/split completion authority, no integrated pre-Advisor readiness, no digest binding, no completion lease, and wrong publication ordering. Some legacy fail-closed checks may already reject; their tests must still fail on the missing typed/ordering/authority semantics rather than being weakened.

Save the bounded failure list in the working notes; do not modify production yet.

## Task 2: Add typed durable validation and completion evidence schemas

**Files:**
- Modify: `packages/wayforge/src/durable/state.ts`
- Modify: `packages/wayforge/src/durable/evidence-freshness.ts`
- Modify: `packages/wayforge/test/task-state.test.ts`
- Modify: `packages/wayforge/test/evidence-freshness.test.ts`
- Modify fixture if needed: `packages/wayforge/test/helpers/durable-task-fixture.ts`

**Step 1: Add focused schema tests**

Test that a validation evidence reference may carry only bounded typed fields:

```ts
validation: {
  name: string;
  ok: boolean;
}
validAtWorkspaceDigest: string;
```

Test that old unbound command evidence remains readable but cannot be selected as fresh validation. Test the new discriminator-based completion record and rejection/redaction of extra secret-like/raw fields.

**Step 2: Run focused tests RED**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- task-state.test.ts evidence-freshness.test.ts
```

Expected: schema does not yet accept typed validation or authority completion evidence.

**Step 3: Implement the compatible schema extension**

Keep `DURABLE_TASK_STATE_VERSION` read compatibility. Extend evidence references with an optional exact object `validation: { name, ok }`. Add a discriminated authority completion-evidence object while retaining the old `{summary, at}` object as a legacy read-only union member.

The new completion record contains bounded values only:

```ts
{
  authority: "completion_authority_v1";
  candidateDigest: string;
  authoritativeRevision: number;
  workspaceDigest: string;
  validationEvidenceIds: string[];
  validationEvidenceDigest: string;
  advisor: {
    invocationId: string;
    routeId: string;
    status: "approve";
    verdictDigest: string;
    summary: string;
  };
  completedAtMs: number;
  leaseGeneration: number;
  summary: string;
}
```

Do not persist provider payloads, prompts, transcripts, reasoning, auth data, or file contents.

**Step 4: Implement typed freshness selection**

Add a helper that returns latest validation evidence by validation name and partitions it by current digest without parsing summaries.

**Step 5: Run focused tests GREEN**

Run the same command. Expected: PASS.

## Task 3: Implement pure readiness and candidate construction

**Files:**
- Create: `packages/wayforge/src/completion/contracts.ts`
- Create: `packages/wayforge/src/completion/completion-readiness.ts`
- Create: `packages/wayforge/test/completion-readiness.test.ts`

**Step 1: Add unit tests for exact typed reasons**

Use real `AuthoritativeTaskState` fixtures and current workspace checkpoints. Cover missing/stale/failing validation; suspended/resuming/blocked/cancelled/completed lifecycle; unresolved suspension/items; pending count; and ready state.

Expected API:

```ts
export type CompletionReadiness =
  | { readonly ready: true; readonly validationEvidence: readonly EvidenceReference[] }
  | { readonly ready: false; readonly reason: CompletionRefusalReason };

export function evaluateCompletionReadiness(input: {
  readonly state: AuthoritativeTaskState;
  readonly workspace: WorkspaceCheckpoint;
  readonly pending: GovernedWorkSnapshot;
}): CompletionReadiness;
```

**Step 2: Run RED**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- completion-readiness.test.ts
```

Expected: module/API absent.

**Step 3: Implement minimal readiness**

Use explicit discriminated reasons; do not inspect human summaries. Treat legacy completion as `already_completed`. Require exact repository/worktree identity and digest match where applicable.

**Step 4: Add deterministic candidate builder**

In `contracts.ts`, define immutable candidate and Advisor binding types. Build `candidateDigest` from deterministic canonical JSON of only the approved fields, using SHA-256. Freeze returned structures.

**Step 5: Run GREEN**

Run focused tests and the evidence tests. Expected: PASS.

## Task 4: Track pending governed work and bind validation at record time

**Files:**
- Modify: `packages/wayforge/src/workflow/workflow-state.ts`
- Modify: `packages/wayforge/src/workflow/workflow-controller.ts`
- Modify: `packages/wayforge/src/runtime/extension-tools.ts`
- Modify: `packages/wayforge/src/runtime/durable-task-projection.ts`
- Modify: `packages/wayforge/test/workflow-controller.test.ts` or nearest existing controller test
- Modify: `packages/wayforge/test/live-durable-composition.test.ts`

**Step 1: Add pending-work lifecycle tests**

Assert begin/end increments a monotonic epoch, concurrent count is accurate, and `finally` clears pending work on worker failure/cancellation.

**Step 2: Implement minimal pending state**

Add snapshot fields:

```ts
pendingGovernedWorkCount: number;
governedWorkEpoch: number;
```

Wrap `delegateWorkers()` ownership with begin/end in `try/finally`. Do not add DAG semantics.

**Step 3: Add validation persistence tests**

Assert the tool captures the workspace after the real validation result, writes typed evidence with the current digest, and updates in-memory validation only after durable persistence succeeds.

**Step 4: Route validation recording through the completion domain**

Make `WorkflowController.recordValidation()` and the tool async. Introduce the narrow recording method on the future authority dependency. Remove durable validation writes from `LiveDurableProjection` so unbound duplicate evidence cannot be created. Keep the validation event for observability only.

**Step 5: Run focused tests GREEN**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- workflow-controller.test.ts live-durable-composition.test.ts durable-completion-authority.test.ts
```

Expected: pending and validation portions pass; final completion cases may remain RED until Task 5.

## Task 5: Implement the sole CompletionAuthority

**Files:**
- Create: `packages/wayforge/src/completion/completion-authority.ts`
- Modify: `packages/wayforge/src/workflow/workflow-controller.ts`
- Modify: `packages/wayforge/src/workflow/runtime-factory.ts`
- Modify: `packages/wayforge/src/runtime/durable-composition.ts` only for narrow dependency exposure if needed
- Modify: `packages/wayforge/src/extension.ts`
- Modify: `packages/wayforge/src/runtime/extension-tools.ts`
- Modify: `packages/wayforge/src/runtime/durable-task-projection.ts`
- Modify: `packages/wayforge/test/durable-completion-authority.test.ts`
- Modify: `packages/wayforge/test/runtime-factory.test.ts`

**Step 1: Define narrow ports**

The authority receives existing primitives, not Pi APIs:

```ts
interface CompletionAuthorityOptions {
  store: DurableTaskStore;
  workspaceRoot: string;
  taskId: TaskId;
  leaseTtlMs: number;
  now: () => number;
  captureWorkspace: typeof captureWorkspaceCheckpoint;
}

interface CompletionRequest {
  pending: () => GovernedWorkSnapshot;
  review: (evidence: AdvisorEvidence) => Promise<ExecutionResult<AdvisorReviewOutcome>>;
}
```

It exposes `recordValidation(...)` and `requestCompletion(...)`. There is no second task store or recovery owner.

**Step 2: Implement validation recording**

Capture workspace, acquire a bounded lease, load state, replace latest typed validation by stable evidence ID, increment revision once through fenced CAS, and release in `finally`. Surface typed durable failures.

**Step 3: Implement requestCompletion up to Advisor**

- Load and return idempotent result for authority-completed state without another lease/Advisor.
- Acquire one lease using the existing configured TTL.
- Reload state, capture current workspace, evaluate readiness.
- On NOT_READY, release and return typed refusal without Advisor.
- Build/freeze the candidate and sanitized candidate-backed Advisor evidence.
- Invoke the supplied strict Advisor callback once.
- Map `changes_requested`, `unable`, malformed (`invalid_advisor_verdict`), and provider failures to typed refusals.

Do not retry or fall back.

**Step 4: Implement post-Advisor revalidation and fenced CAS**

- Verify/heartbeat the same lease token/generation.
- Reload and require exact candidate revision/status/evidence set.
- Recapture workspace and compare repository/worktree/HEAD/digest.
- Recheck pending count zero and identical epoch.
- Verify approval binding to candidate.
- Build sanitized completion evidence.
- Call `store.update(candidate.taskRevision, nextState, activeLease)` exactly once with `revision + 1`, evidence and `status: completed` together.

Any conflict returns typed failure and leaves workflow running.

**Step 5: Wire the controller and tool**

Make `complete()` async. It asks the authority to perform the transaction. Only after durable success:

```ts
state.setStatus("completed");
log.emit("completion_ready", committedIdentity);
```

The tool awaits it. Manual `advise()` remains non-authoritative. Remove the projection's `completion_ready → durable completed` branch.

If durable authority is unavailable, governed completion fails closed with a typed capability refusal; do not retain a legacy completion writer.

**Step 6: Run all 13 gates GREEN**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- durable-completion-authority.test.ts completion-readiness.test.ts runtime-factory.test.ts live-durable-composition.test.ts
```

Expected: all pass; Gate 12 proves durable-before-workflow ordering, Gate 13 proves no duplicate write/Advisor call.

## Task 6: Add narrow architecture and security gates

**Files:**
- Modify: `packages/wayforge/scripts/check-architecture.mjs`
- Modify: `packages/wayforge/test/architecture-gates.test.ts`
- Add security assertions to: `packages/wayforge/test/durable-completion-authority.test.ts` or `packages/wayforge/test/task-state.test.ts`

**Step 1: Add architecture fixture tests RED**

Prove the checker rejects:

- a second `new CompletionAuthority` production site;
- direct task `status: "completed"` in projection/tool/Advisor/recovery/account code;
- completion CAS outside the authority;
- pi-accounts dependency/protocol strings;
- a second durable store owner.

Retain exact existing RecoveryCoordinator/HealthRegistry checks.

**Step 2: Implement narrow checks**

Scan production sources only. Avoid broad text rules that flag schema literals, continuation statuses, or test fixtures.

**Step 3: Add persisted-data security assertions**

Serialize the new completion evidence with synthetic secret-like fields in rejected extras and prove no token, authorization, cookie, API key, refresh token, raw response, reasoning, or transcript survives.

**Step 4: Run GREEN**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge check:architecture
mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- architecture-gates.test.ts task-state.test.ts durable-completion-authority.test.ts
```

Expected: new exact gate count reported; all tests pass.

## Task 7: Run deterministic regression and independent review

**Files:**
- Modify based only on verified blocking review findings.

**Step 1: Run focused diagnostics**

Run LSP diagnostics for every changed TypeScript file. Expected: zero errors.

**Step 2: Run the full local suite**

```bash
mise x node@22.14.0 pnpm@12.9.1 -- bash -c '
  set -euo pipefail
  pnpm install --frozen-lockfile
  pnpm build
  pnpm typecheck
  pnpm test
  pnpm check
  pnpm check:workspace
  pnpm format:check
  pnpm --filter wayforge check:alpha0
  pnpm --filter wayforge check:alpha1
  git diff --check
'
```

Expected minimum: 301 tests, 11 gates, 49 production files, Alpha 0/1 PASS. Record exact new totals.

**Step 3: Request independent read-only review**

Use one fresh high-thinking reviewer focused on completion ownership, TOCTOU, lease fencing, digest freshness, Advisor binding, durable-before-visible ordering, idempotence, persisted-data security, and scope. Any false-completion path is blocking.

Use at most three total delegate-review rounds, with later rounds resuming the same reviewer where supported. Parent independently verifies each finding with code/tests before changing anything.

**Step 4: Re-run complete validation after accepted fixes**

No success claim until a fresh full run passes.

## Task 8: Run live positive and negative dogfood

**Files:**
- Create: `packages/wayforge/docs/evidence/phase1b3-completion-authority-dogfood.json`
- Create: `packages/wayforge/docs/phase1b3-completion-authority-report.md`

**Step 1: Prepare isolated environment**

Use the ignored existing isolated Pi profile only after supported auth/model readiness checks. Create fresh disposable Git repositories outside `pi-packages`. Fingerprint production Pi config before the run without reading credential contents.

**Step 2: Positive live governed task**

Use one small deterministic pure-function task with immutable tests. Prove:

```text
real coding
→ independent validation
→ typed validation bound to current digest
→ readiness READY
→ real strict Advisor approve
→ same candidate revalidated
→ fenced durable completed/evidence revision
→ workflow-visible completed afterward
```

Record sanitized provider/model, task/revision, candidate/workspace/validation digests, Advisor semantic outcome and token usage, lease generation, event ordering, final state, and artifact hashes. Do not retain hidden reasoning or raw credentials.

**Step 3: Negative stale-workspace task**

In another disposable repository:

```text
record passing validation
→ mutate workspace
→ wayforge_complete
```

Require typed readiness refusal, durable running state, and zero Advisor model calls. This deterministic boundary should not consume a paid review call.

**Step 4: Clean raw artifacts**

Delete disposable repositories, raw RPC/session logs, temporary shims/scripts, and owned task records after sanitized evidence exists. Retain only ignored user auth/settings.

## Task 9: Final validation, classification, commit, push, and CI

**Files:**
- Update report/evidence only with verified results.

**Step 1: Re-run the full suite after dogfood evidence**

Use the Task 7 full command and record exact totals.

**Step 2: Classify every path**

Assign exactly one required category and require `UNRELATED = 0`. Explicitly report zero account integration, recovery-policy, Advisor budget/routing, package, and release changes.

**Step 3: Verify preservation before staging**

Require canonical branch/HEAD lineage, original Wayforge unchanged/clean, production Pi fingerprints unchanged, PR #1438 observation-only, no ignored credential path tracked, and no secret literal in staged files.

**Step 4: Create the implementation commit**

```bash
git add <classified Phase 1B.3 paths>
git diff --cached --check
git commit -m "Phase 1B.3: establish durable completion authority"
```

Do not amend/rebase/force-push. Use a second commit only if evidence necessarily follows an immutable implementation commit.

**Step 5: Push normally and verify exact-head CI**

```bash
git push origin main
```

Wait for hosted CI through a background watcher. Independently run `gh run view` and verify `headSha` equals final local/remote HEAD and every job succeeds.

**Step 6: Final hygiene**

Require both repositories clean, local/remote exact match, production Pi/config/credentials unchanged, PR #1438 unchanged, and ignored isolated auth untracked.

End the final report with exactly one required verdict based on evidence.
