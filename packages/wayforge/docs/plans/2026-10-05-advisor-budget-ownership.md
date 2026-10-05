# Phase 1B.3A Advisor Budget Ownership Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Protect the one strict authoritative completion review from ordinary advice and unrelated shared-ledger consumption without changing Completion Authority semantics.

**Architecture:** Owner-approved design: governed `wayforge_advise` is unavailable and consumes no provider budget. The single existing Advisor adapter executes completion-purpose requests only through CompletionAuthority's candidate-bound callback. A bounded, once-claimed review allowance is isolated from Main/Worker consumption while maintaining parent cancellation. Readiness refusals do not claim the allowance; dispatch attempts do, including provider/invalid/negative outcomes. No automatic retry or replenishment is allowed.

**Tech Stack:** Existing TypeScript, Vitest, Pi adapter/runtime, invocation contexts, filesystem task store and architecture checker; no dependencies.

## Baseline and audit

HEAD `1a95b2753f4f7688b034c768a9f4679e48b5b79e`, dirty accepted Phase 1B.3 retained. Snapshot `/tmp/wayforge-phase1b3a-baseline.ufoEEJ` contains HEAD/status/stat/full tracked patch and untracked archive. Prior validated totals: 46 files / 334 tests; 15 architecture gates / 52 production files.

Consumer map: `wayforge_advise -> WorkflowController.advise -> reviewAdvisorEvidence -> PiAdvisorAdapter -> NestedInvoker -> provider`; `wayforge_complete -> controller -> CompletionAuthority readiness/candidate -> review callback -> same adapter/invoker -> provider -> revalidation/fenced CAS`. `NestedInvoker` derives a child with an 800-token logical ledger ceiling against Main's shared consumed ledger; `child.spend(input+output)` and Worker `parent.spend` affect every sibling's remaining. Manual negative review also records blockers in workflow state. No other production Advisor review callsites found.

Alternatives rejected: separate advisory allowance adds provider cost and accounting complexity; prompting suppression is unreliable; higher budget/parser loosening/retries violate the mission. The chosen unavailable manual path means prior positive/negative manual provider results cannot exist within governed tasks; regressions must prove attempted manual reviews cannot invoke or contaminate authority, including injected approve/negative responses that must never be consumed by manual calls.

## Task 1 — RED public-path gates before production edits

Create `packages/wayforge/test/advisor-budget-ownership.test.ts`, reusing or minimally extracting the real-extension/disposable-Git harness in `test/durable-completion-authority.test.ts` and FakePiHost. Write the entire regression set first:

1. manual advice refused with typed non-consuming failure, followed by validation/complete succeeds with exactly one authoritative provider call;
2. repeated manual/beforeDone attempts (including concurrency) make zero provider calls and do not starve completion;
3. authority logical allowance stays 800 with high reasoning, consumes at most one attempt, second request after unable/changes_requested/invalid/provider failure does not dispatch again;
4. manual attempted approve/negative verdict cannot authorize or poison completion (use fake responses, assert not consumed);
5. Main/Worker shared-ledger spend cannot consume the isolated completion allowance; cancellation is still linked;
6. existing readiness refusals dispatch zero calls and do not spend reservation;
7. concurrent valid completion attempts dispatch at most once; completed repeat remains idempotent;
8. candidate/workspace/revision/lease races still fail closed and parsed approval is bound to the actual candidate.

Run `mise x node@22.14.0 pnpm@12.9.1 -- pnpm --filter wayforge test -- advisor-budget-ownership.test.ts` and retain exact expected semantic RED failures. No production changes until RED is recorded.

## Task 2 — Minimal owner/capability hardening

Likely files: `src/workflow/workflow-controller.ts`, `src/workflow/runtime-factory.ts`, `src/runtime/extension-tools.ts`, `src/adapters/pi-advisor-adapter.ts`, and a narrow existing-context capability helper only if needed. Preserve authority `src/completion/*` transaction except minimal purpose integration.

- Governed manual advice returns a stable typed refusal before route lookup, evidence building, verdict recording or invocation. Update misleading tool description, not as enforcement.
- Isolate completion allowance from the shared task ledger; retain depth/task identity and downward parent cancellation. Do not silently reset an allowance per call or create unbounded independent contexts.
- Reserve/claim at actual candidate-ready review dispatch, atomically before awaits, once per governed task. Failed outcomes retain spent claim. No public parameter can impersonate completion-purpose capability.
- Emit sanitized purpose/count/usage metadata sufficient for live audit without changing strict verdict JSON/parser/model route/800-logical-allowance/high-reasoning policy. Provider usage may exceed the logical allowance because input is included in Wayforge accounting and Pi/provider-specific reasoning transformation may prepare an aggregate output ceiling greater than that allowance; report observed usage without claiming or increasing a final-output ceiling.
- Preserve existing manual API compatibility only outside the governed lifecycle if clearly necessary; no second Advisor stack.

Run focused ownership and all existing Phase 1B.3 tests GREEN, typecheck/build.

## Task 3 — Narrow architecture/security gates

Files: `scripts/check-architecture.mjs`, `test/architecture-gates.test.ts`, ownership tests. Add RED fixture assertions for bypasses of manual non-consuming boundary, authoritative review ownership/capability, and direct completion publication outside authority/controller. Prefer concrete current callsite constraints; do not introduce speculative broad lint.

Keep sole RecoveryCoordinator and all accounts exclusions. Prove rejected manual requests have zero provider cost, repeated failed complete bounded, and no secrets/raw responses/reasoning persist. Run gates GREEN and report truthful exact counts.

## Task 4 — Independent review and full validation

Read-only fresh review of Advisor ownership, starvation, impersonation, concurrent double-review, candidate/lease/TOCTOU, provider cost amplification and scope. Parent verifies findings; no more than 3 rounds. Full command:

`mise x node@22.14.0 pnpm@12.9.1 -- bash -c 'set -euo pipefail; pnpm install --frozen-lockfile; pnpm build; pnpm typecheck; pnpm test; pnpm check; pnpm check:workspace; pnpm format:check; pnpm --filter wayforge check:alpha0; pnpm --filter wayforge check:alpha1; git diff --check'`

## Task 5 — One fresh bounded live governed dogfood (parent-owned)

Use fresh disposable Git workspace, fresh task and isolated durable store, existing isolated authentication only. Record production configuration fingerprints without printing/copying credentials. Supply immutable pure-function tests. Main may call advice; runtime must reject it without consuming reservation. Do real coding, independently run tests, record validation/current digest, then one authority request. Capture sanitized diff/artifact hashes, candidate/revision/digest/evidence IDs, invocation purpose/count/token usage, lease generation, before/after revision, durable completed, and visible completion ordering. No retry of unsuccessful authoritative verdict; no contaminated-session reuse. Do not claim COMPLETE unless real strict approve and ordered fenced completion occur.

## Task 6 — Evidence/report/delivery

Write `docs/evidence/phase1b3-completion-authority-dogfood.json` and `docs/phase1b3-completion-authority-report.md`. Classify all changed paths (UNRELATED=0); report original Wayforge preservation, production Pi credentials/config preservation, no accounts protocols integration. Clean owned raw logs/temp repos/tasks after sanitized evidence exists. Re-run full checks. Parent alone commits/pushes normally and verifies hosted CI at exact delivered HEAD; no amend/rebase/force-push. If live fails, report NEEDS REVISION and do not represent deterministic tests as live completion. Final report ends with the exact mandatory verdict.
