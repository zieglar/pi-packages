# Durable Completion Authority — Phase 1B.3 + 1B.3A status

## Acceptance boundary

**Not accepted as COMPLETE.** Phase 1B.3A deterministic hardening is green; its independent review is blocked by the session's enforced orchestration cap. The required one fresh live authority-approval dogfood has deliberately not been started before that review. No strict real approval, authority completion evidence, provider token usage, or visible completion ordering is claimed for 1B.3A. Previous contaminated runs are not substituted for the required fresh run.

## Baseline preservation

- Starting and current HEAD: `1a95b2753f4f7688b034c768a9f4679e48b5b79e`, branch `main`.
- Starting worktree: accepted uncommitted Phase 1B.3 changes, not a clean checkout. Snapshot `/tmp/wayforge-phase1b3a-baseline.ufoEEJ` retains HEAD/status/stat/full tracked diff plus archived untracked files.
- Tracked baseline patch SHA-256: `434673350098a5051c8a54b829957ffda24e0247960bc12266fc5ffea4c5b414`.
- Archived untracked baseline SHA-256: `b97487bc7f89e6dd07daae79eb7bde92ab048ac52b06ae295590e980663d89d5`.
- All three new Phase 1B.3 completion production modules match the archived baseline byte-for-byte. Existing readiness/candidate/digest/lease/revision/CAS/publication/idempotence tests remain green. No frozen history rewritten.
- Original `/Users/zieglar/Code/wayforge`: HEAD `d903cd52fc20b9b63f15a5d7d9c6b4d5ca600276`, clean, freshly checked.

## Consumer map and root cause

Manual: `wayforge_advise -> WorkflowController.advise -> reviewAdvisorEvidence -> PiAdvisorAdapter.review -> NestedInvoker.invoke -> provider`.

Authoritative: `wayforge_complete -> controller -> CompletionAuthority readiness/candidate -> controller review callback -> same PiAdvisorAdapter/NestedInvoker -> provider -> candidate revalidation -> fenced durable CAS -> visible completion`.

Originally both consumers derived Advisor children from Main's shared ledger. The child had an 800-token logical ledger ceiling but subtracted the whole tree's consumption; manual advice and Worker consumption therefore starved later completion. Manual negative verdicts also recorded unresolved blockers. Prompt suppression failed in prior live experiments.

## Approved design and implementation

- Governed advice returns typed `advisor_reserved_for_completion` before route/provider invocation or verdict mutation. Every ordinary manual/beforeDone attempt is non-consuming. Standalone non-governed advice retains its existing behavior and has no durable completion authority.
- Only the candidate-ready authority callback calls `reviewCompletionEvidence`. A synchronous one-shot claim precedes async lookup/dispatch and is never replenished after negative, malformed or provider-failed review.
- `InvocationContext.reserveCompletionBudget` retains identity, nesting constraints and downward cancellation, with a separate bounded ledger capped at `min(800, parent.limit)`. It is used only by the one-shot completion callback; architecture checks enforce this concrete callsite boundary.
- The same Adapter/parser/model route/high thinking remain. No retry, larger budget, second Advisor stack, accounts integration or recovery redesign.
- Purpose is sanitized in `advisor_triggered`; parsed successful outcome usage is emitted as numeric `budget_changed` metadata. No prompt, hidden reasoning, transcript or raw provider payload is added to persisted completion evidence.
- Synchronous cancellation after review is refused before returning approval to the authority.
- Reservation is runtime-task-scoped. It is not a new durable recovery/restart policy; no such policy is claimed.

Rejected alternatives: prompt-only suppression is disproven; separate ordinary advisory allowance adds provider cost and accounting complexity; increasing budget/parser relaxation violates the mission.

## RED → GREEN

All new public-path semantic regressions were added before production hardening. First run: **9 failed / 336 passed**, covering manual approve/negative attempts, repeated concurrent advice, replenishment after negative/invalid/provider failure, and unrelated ledger starvation. Existing readiness/concurrency cases already passed; those assertions were retained.

Three new architecture fixtures were separately observed RED before checker edits: unauthorized reservation, unauthorized completion-review callback, and missing manual non-consuming guard.

Fresh full validation: **46 test files / 348 tests PASS**, **18 architecture gates / 52 production files PASS**. Frozen install, build, typecheck, repository check, workspace check, format/diff check, Alpha 0 and Alpha 1 PASS. Logs: `/tmp/phase1b3a-red.log`, `/tmp/phase1b3a-architecture-red.log`, `/tmp/phase1b3a-full.log` (local deterministic outputs, not live-provider evidence).

Manual review attempts dispatch zero provider calls; ready completion dispatches one. Negative/malformed/provider-failed attempts retain the claim and reject a second completion review as `completion_review_spent`. Concurrency and completed-repeat tests remain bounded; original candidate/TOCTOU/lease gates remain green. Old governed-manual test assumptions were updated to expect refusal; composition mocks now request their approval through the authority callback rather than an old manual verdict.

## Independent review blocker

The authorized writer/reviewer workflow was rejected before launch with `orchestration cap reached (max 3 rounds, 2 escalations)`. No child run was created. The parent took over implementation under the router's cap rule; no external CLI fallback was used. The three previous Phase 1B.3 reviews do **not** count as review of the new Phase 1B.3A code. A new authorized review context or operator-provided independent read-only review is required before live acceptance.

## Diff classification (all paths relative to packages/wayforge)

**UNRELATED = 0.** Retained Phase 1B.3: `src/completion/*`, `src/durable/{state,evidence-freshness}.ts`, `src/extension.ts`, `src/runtime/durable-task-projection.ts`, `src/workflow/{runtime-factory,workflow-state}.ts` = COMPLETION_AUTHORITY/LIVE_WIRING; corresponding existing tests and host fixture = ACCEPTANCE/REGRESSION_FIXTURE.

1B.3A: `src/kernel/invocation-context.ts`, `src/workflow/workflow-controller.ts` = BUDGET_OWNERSHIP; `src/adapters/pi-advisor-adapter.ts` = SANITIZED_USAGE; `src/runtime/extension-tools.ts` = TOOL_SEMANTICS; `scripts/check-architecture.mjs`, `test/architecture-gates.test.ts` = ARCHITECTURE_GUARD; `test/{durable-completion-authority,runtime-factory,workflow-controller}.test.ts` = ACCEPTANCE/REGRESSION_FIXTURE; `docs/plans/2026-10-05-advisor-budget-ownership.md` and this report = APPROVED_PLAN/STATUS_REPORT.

## Security, hygiene and delivery

No credential contents read/copied for 1B.3A, no provider requests run, no production Pi/config/auth writes made. Full post-delivery production fingerprints are pending; untouched is not presented as a freshly verified fingerprint match. Existing isolated profile is ignored/untracked. No accounts topology/activation strings or PiAccountsAdapter found in production source; package/lock/account adapter/recovery changes absent. PR #1438 not modified.

Commits/push/hosted CI: **not performed**; final HEAD unchanged and worktree deliberately dirty with the retained implementation plus hardening/report. No acceptance commit is justified before independent review and live evidence. Remaining: review, one fresh bounded dogfood, sanitized complete evidence, full revalidation, classification/security/fingerprint audit, normal commit/push and exact-head hosted CI.

# DURABLE COMPLETION AUTHORITY NEEDS REVISION
