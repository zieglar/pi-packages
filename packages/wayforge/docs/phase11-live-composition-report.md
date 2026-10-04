# ALPHA 1 LIVE COMPOSITION NEEDS REVISION

## Delivery decision

The owner explicitly approved committing and pushing the reviewed composition with this verdict, rather than changing the frozen Advisor budget/policy or bypassing Completion Authority. Real coding and persisted validation were observed; an approving Advisor verdict and completed governed coding workflow were **not** observed.

## Baseline and scope

- Frozen starting HEAD: `b619384488c370897e5b3838a161bc264ac484f9`, branch `main`.
- Repository: private `zieglar/pi-packages`; original `wayforge` repository preserved at `d903cd52fc20b9b63f15a5d7d9c6b4d5ca600276` with clean status.
- No accounts adapter/package, topology/activation integration, new recovery taxonomy, package, public release, upstream PR change, or Advisor/Worker redesign.
- `WorkflowTaskState` and `AuthoritativeTaskState` stay separate; mapping is the narrow one-way `LiveDurableProjection`. The existing RecoveryCoordinator remains the only recovery-policy owner.

## Live composition

| Component | Live path |
| --- | --- |
| Durable store | guard-approved `session_start` -> `createDurableExecution` -> `FilesystemDurableTaskStore`, `<agent>/wayforge/tasks` |
| Recovery discovery | one asynchronous bounded startup scan per extension instance -> `StartupRecoveryScanner` -> `WakeupService` |
| Task identity | scan persisted `alpha0-N` identities; create the authoritative record before admitting the same-ID live workflow; collisions fail closed |
| Checkpoint | governed-task admission captures the Git workspace and adopts existing changed paths as the task write set |
| Suspension | existing RecoveryCoordinator terminal suspension detail -> ordered projection -> authoritative suspended state |
| Resume | fenced lease, checkpoint reload, drift validation before launch, RESUMING/launch-intent persistence, new SDK session, bounded duplicate prevention |
| Workspace | each launcher invocation receives the verified persisted workspace root, not the restarting Pi cwd |
| Lifecycle | completion/cancellation/validation mapped explicitly; graceful shutdown drains queued durable projections |
| Authentication | SDK continuation accepts an explicit isolated agentDir; live success used the already authenticated isolated profile, without copying credentials |

The default nested continuation agentDir remains credential-free unless separately configured. Probe-based strategies have no live health registry in this composition and remain fail-closed. Continuation progress after launch is not projected back into durable state. A durable record admitted immediately before a runtime-construction exception can remain orphaned running; this is a reviewed non-blocking residual risk.

## Tests, review, and live evidence

- The initial eight live-composition tests were observed RED before wiring, then GREEN: service construction, identity, real-coordinator suspension, restart discovery, new-session continuation, lease fencing, conflicting-drift fail-safe, duplicate-launch prevention.
- Cross-process extension acceptance uses the real factory and launcher with a Pi host double and doubled session factory; it is not cited as real SDK proof.
- Independent review found identity contamination and restart-cwd binding blockers. Regression tests were observed RED for both, then GREEN after fail-closed admission and per-launch workspace binding.
- Real dogfood exposed a shutdown projection race. A new barrier test failed with expected cancelled / received running, then passed after asynchronous shutdown drains projections.
- Three independent read-only review rounds concluded **code APPROVE**, separately **full governed dogfood acceptance NOT MET**. The removed dead symbol was the private helper function `projectionFailure`, not the retained public diagnostic method of the same name.
- Final local verification under Node 22.14.0 / pnpm 12.9.1: frozen install, build, typecheck, **44 files / 301 tests**, **11 architecture gates / 49 production files**, workspace check, format/diff check, Alpha 0 and Alpha 1 checks all PASS. Baseline minimums (289 tests, 9 gates, 47 files) did not regress.
- Existing Alpha checks validate their declared artifacts/preconditions; their PASS is not a substitute for live success.

Evidence:

1. `evidence/phase11-live-smoke.json`: real Pi loading, task/checkpoint creation, controlled wake discovery, lease/launch intent, fail-closed ambiguous launch; limitations explicitly recorded.
2. `evidence/phase11-real-sdk-restart.json`: real Pi A creates task -> operator-authored suspension -> SIGKILL -> real Pi B starts in different cwd -> unreplaced SDK continuation writes proof only in original workspace -> persisted launched, lease generation 1, one launch. An explicit authenticated isolated agentDir was used; no parent model prompt was submitted during recovery.
3. `evidence/phase11-live-dogfood.json`: initial OpenAI quota failure; subsequent real Kimi RPC coding changes two files and passes independently rerun validation; Advisor `invalid_advisor_verdict`, then `budget_exhausted`; completion refused. No budget change or completion bypass.

All owned disposable workspaces, test sessions, raw diagnostic logs, and temporary scripts were removed after sanitized evidence capture. The generated isolated extension shim was restored; the user's isolated auth/settings were retained and are ignored by Git. No credential contents were printed or copied into evidence.

## Diff classification

All paths below are relative to `packages/wayforge/`. **UNRELATED = 0**.

| File | Classification |
| --- | --- |
| `src/extension.ts` | LIVE_WIRING: durable composition, admission identity, projection, shutdown drain |
| `src/runtime/durable-composition.ts` | LIVE_WIRING: sole durable construction root |
| `src/runtime/durable-task-projection.ts` | LIVE_WIRING: narrow authoritative-state projection |
| `src/runtime/pi-continuation-launcher.ts` | LIVE_WIRING: verified task cwd forwarded to new SDK session |
| `src/recovery/runtime-recovery-executor.ts` | LIVE_WIRING: expose existing terminal suspension payload |
| `src/workflow/runtime-factory.ts` | LIVE_WIRING: shared clock passed to existing executor |
| `scripts/check-architecture.mjs` | ARCHITECTURE_GUARD: durable constructor boundary and accounts exclusion |
| `test/architecture-gates.test.ts` | ARCHITECTURE_GUARD: expected gate count |
| `test/live-durable-composition.test.ts` | ACCEPTANCE: eight required cases plus identity/shutdown regressions |
| `test/live-restart-acceptance.test.ts` | ACCEPTANCE: extension factory across real process boundaries |
| `test/fixtures/live-extension-child.mjs` | ACCEPTANCE_FIXTURE: cross-process host/session doubles |
| `test/helpers/fake-pi-host.ts` | ACCEPTANCE_FIXTURE: bounded Pi host double |
| `test/pi-sdk-continuation-workspace.test.ts` | ACCEPTANCE: SDK boundary receives verified task workspace |
| `test/pi-continuation-launcher.test.ts` | ACCEPTANCE: launcher forwards task cwd |
| `test/extension-runtime.test.ts` | REGRESSION_FIXTURE: real temporary Git cwd and awaited lifecycle |
| `test/helpers/ensure-built.ts` | TEST_INFRA: deduplicate concurrent child-process build hooks |
| `test/alpha0-gate.test.mts` | TEST_INFRA: shared build prerequisite |
| `test/cross-process-wakeup.test.ts` | TEST_INFRA: shared build and evidence-backed contention timeout |
| `test/durable-lease.test.ts` | TEST_INFRA: shared build prerequisite |
| `test/restart-integration.test.ts` | TEST_INFRA: shared build prerequisite |
| `docs/evidence/phase11-live-smoke.json` | SANITIZED_EVIDENCE: bounded live smoke observations |
| `docs/evidence/phase11-real-sdk-restart.json` | SANITIZED_EVIDENCE: successful real SDK restart |
| `docs/evidence/phase11-live-dogfood.json` | SANITIZED_EVIDENCE: positive coding/validation and negative completion outcome |
| `docs/phase11-live-composition-report.md` | ACCEPTANCE_REPORT: scope, classification, limitations, owner decision |

The contention timeout change is limited to the existing ten-round/twenty-child test, retains all ownership assertions, and is backed by observed parallel desktop-load timing after build deduplication; it is not a provider or recovery timeout change.

## Delivery verification boundary

Commit/push and hosted CI are checked by the parent after this report is committed. This document does not claim a hosted CI run that did not yet exist at commit time. Final acceptance requires CI SUCCESS at the exact delivered HEAD and a clean worktree; the final response records those identities. Even green hosted CI cannot change this phase verdict while full governed coding-workflow completion is unproven. Stop after Phase 1.1; no next phase is authorized.
