# Phase 1.1A — Governed Workflow Acceptance Closure

## Executive verdict

The missing Phase 1.1 live acceptance chain was observed using the frozen implementation: real coding, independent validation, real contract-valid Advisor approval, existing completion-gate acceptance, and the existing successful terminal path. No production code, routing policy, budget, parser, or Completion Authority was changed. Phase 1.1 implementation and live acceptance can be classified **COMPLETE / FREEZE**, subject to the exact evidence-commit CI verification recorded in the delivery response.

## Frozen baseline

- Canonical repository: `/Users/zieglar/Code/pi-packages`.
- Starting HEAD: `14c879b8f28853e814654ca59f03775aedfe16e8`; branch `main`; starting worktree clean.
- Remote: `git@github.com:zieglar/pi-packages.git`, private, default branch `main`.
- Baseline hosted CI: [37221586602](https://github.com/zieglar/pi-packages/actions/runs/37221586602), SUCCESS at the exact starting HEAD.
- Final HEAD is the evidence-only commit containing this report; its SHA, clean-worktree result, remote equality, and exact-head CI URL are recorded after commit in the delivery response. This report does not preclaim an uncreated CI run.

## Previous failure classification

Primary classification: **UNKNOWN**. The retained Phase 1.1 evidence records real Kimi coding, `invalid_advisor_verdict`, two later `budget_exhausted` results, and a correctly refused completion. It does **not** retain the actual Advisor route, request, raw output, or token usage. The frozen adapter emits `invalid_advisor_verdict` when strict parsing fails, but those historical records cannot distinguish model malformed output from a transport/adapter, contract, or parser issue. The current observed route is not retroactive proof of that earlier invocation. No historical root cause is invented.

## Advisor contract audit

- Request: `PiAdvisorAdapter.review` receives parent context, invocation ID, sanitized `AdvisorEvidence`, and budget limit. It asks for only JSON with exactly `status`, `summary`, and `findings`; finding keys are `code`, `severity`, `summary`, and optional `path`.
- Response: status `approve|changes_requested|unable`; string summary; at most 20 findings; severity `blocker|warning|note`. An approval is status `approve`.
- Parser: private `parseVerdict` in `src/adapters/pi-advisor-adapter.ts`; direct `JSON.parse` plus strict object/key/type/enum checks. Markdown fences, non-JSON prose, arrays, extra keys, missing/wrong-type fields, unknown statuses/severities, invalid findings, and over 20 findings are rejected. Strings are bounded after parsing.
- Schema enforcement: prompt plus local strict parser; no provider structured-output schema is supplied. `PiCompatibilityAdapter` extracts visible text only.
- Retry: `NestedInvoker` makes exactly one runtime call per invocation, with no automatic retry. Main can explicitly ask again through the existing trigger/tool, subject to the unchanged budget. Model runtime usage is spent before verdict parsing, so even an invalid or non-approving response consumes budget. `AdvisorTriggerPolicy` authorizes manual/before-done review and defined repeated-failure triggers; it is not a retry loop.
- Budget: live observed Advisor route limit **800**, thinking **high**; main context limit **96,000**. Child contexts share cumulative consumption and cannot increase limits; the effective limit is the minimum of route/rule/remaining child budget. The compatibility adapter does not pass this budget as an output-token cap; recorded input plus output usage is charged afterward.
- Provider/model route: live roles derive from the native observed Main model. Both new runs used `kimi-coding/kimi-for-coding`; Advisor composition has one static observed Advisor route. No Advisor fallback occurs in this path, and the generic recovery budget does not create a hidden Advisor retry/fallback.
- Completion integration: `WorkflowController.complete` requires passing latest validations and latest Advisor status `approve`; the live extension sets `requireAdvisorApproval:true`. Success sets workflow status `completed` and emits `completion_ready`. The existing durable projection persists completion; no new completion transition was added.

## Dogfood task

Two fresh disposable Git repositories outside the canonical repository were used. Implement the pure `countOccurrences(haystack, needle)` function, with five predefined immutable Node tests: normal counts; overlapping counts; no matches/empty haystack; literal, case-sensitive boundary matching; empty-needle/non-string exceptions. Acceptance was declared before coding: all five tests pass and only the source file changes. The tests and package manifest were not altered.

The first objective also contained staging instructions. The second kept the same function contract and separated process instructions from the task objective. Independent host evidence was recorded before its first Advisor invocation using the existing validation tool. This was evidence preparation, not a change to Advisor policy or a fabricated verdict.

## Environment isolation and provider preflight

Project-local ignored `.wayforge-dev/agent` supplied existing isolated OAuth authentication. Temporary session directories and disposable workspaces were outside the repository. Production credentials were not copied. Explicit CLI extension paths loaded an unchanged production Wayforge factory through a temporary default-export shim plus a temporary observer; ambient extensions, skills, templates, and context files were disabled.

`pi auth check --provider kimi-coding --no-refresh --json` reported ready without printing credentials. Before each workflow, native Main returned `READY`, and the real `ModelRegistry.streamSimple` mechanism at Advisor thinking level high returned `READY` with stopReason `stop`. No quota-exhausted OpenAI route was chosen. The observer forwarded the original request/stream unchanged and retained only sanitized request, visible text, outcome, and usage; it never supplied model output. An initial harness-only extension-export error occurred before any model call or workflow admission and was resolved with the temporary shim, using the same RPC protocol.

## Governed execution trace and Advisor evidence

1. `alpha0-1`: real coding and independent five-test validation passed. Advisor invocation `advisor-1` returned valid **unable**, correctly parsed. It cited unverifiable change scope because the frozen controller's direct-Main evidence had empty `changedPaths` and unavailable workspace digest. Recorded usage **410 input + 664 output = 1,074**. Main then recorded Git scope validation and explicitly requested review again; the shared 800-budget limit returned `budget_exhausted` **before a second model call**. No completion tool was called. Graceful shutdown cancelled the still-running task. This is a legitimate non-approving outcome (**POLICY_REJECTION**), followed by budget exhaustion, not malformed output or a parser defect.
2. `alpha0-2`: real coding modified only `src/count-occurrences.mjs`; host independently ran `npm test`, five passed, zero failed; Git scope and immutable-test SHA256 were verified. Main recorded `independentHostAcceptance` before review. Advisor invocation `advisor-1` returned valid **approve**, no findings, usage **421 input + 280 output = 701**, within the unchanged charged limit. The existing parser/tool returned that approving verdict. Main called `wayforge_complete`, which returned `ok:true`, `completed with 2 passing validation(s)`. `completion_ready` was emitted; workflow and durable state became **completed**, durable revision **3**. Host reran the five tests afterward and again during evidence capture: all passed.

Both raw visible semantic Advisor outputs, exact sanitized requests, parsed verdicts, all Advisor tool outcomes (including the no-call budget failure), workspace identities, starting/final digests, source diffs, and event sequences are retained in the evidence JSON. No reasoning blocks or credentials are retained there. Recovery budget remained 1 retry / 2 fallbacks; no override was used.

## Completion evidence

The existing completion gate **accepted alpha0-2**. This is supported by the real RPC tool result, parsed approving verdict, `completion_ready` event, workflow `completed` snapshot, and persisted durable `completed` state with completion evidence. It is not inferred merely from passing tests or model prose. Successful final workspace digest: `c26eac6fddb282e2467a9a88d4edba897cccf295d63d11447a7decb5d13b818f`, captured with the existing checkpoint algorithm. No task state was patched.

## Production diff

**Production code changes: 0.** Only this report and `docs/evidence/phase11a-governed-acceptance.json` are delivered. No tests, source, scripts, dependencies, locks, accounts integration, recovery taxonomy, or authority semantics are changed.

## Tests and validation

Fresh frozen-baseline and post-capture regression validation both passed: frozen install (baseline), build, typecheck, test, package checks, workspace check, format/diff hygiene, Alpha 0 and Alpha 1. Exact final totals: **44 test files / 301 tests**, **11 architecture gates / 49 production files**, **Alpha 0 PASS / Alpha 1 PASS**. Both dogfood repositories passed five fixed tests under independent host execution. The parent inspected the terminal regression result and exact totals before committing. Intentional rogue-fixture architecture diagnostics are negative-test evidence, not production violations.

## Evidence artifacts, commit, and hosted CI

- `docs/evidence/phase11a-governed-acceptance.json` — sanitized positive/negative live evidence and complete contract-boundary trace.
- `docs/phase11a-governed-acceptance-report.md` — this Phase 1.1 addendum; historical Phase 1.1 evidence is preserved unchanged.
- Preferred evidence-only commit: `Phase 1.1A: prove governed workflow acceptance`; normal push, no amend/rebase/force push.
- The final response identifies the actual commit and independently verified hosted CI SUCCESS at that exact HEAD. Neither a launch nor baseline CI substitutes for that gate.

## Security/hygiene and preservation

Production Pi configuration fingerprints were recorded and rechecked unchanged at cleanup; no production Pi command/configuration/credential/extension changes were made. The isolated user's auth/settings were retained without publishing their contents. After sanitized evidence retention, owned disposable workspaces, temporary observer/shim/driver, raw logs, temporary native sessions, and owned task observability/state were deleted. Final canonical worktree cleanliness and remote equality are verified after commit. The temporary ignored preservation-fingerprint record is removed after the final post-CI comparison.

Original repository `/Users/zieglar/Code/wayforge` remains at `d903cd52fc20b9b63f15a5d7d9c6b4d5ca600276`, unchanged and clean. Upstream PR #1438 was observed read-only; no PR action or mutation was performed. `PiAccountsAdapter`, `@narumitw/pi-accounts`, `accounts:topology:v1`, and `accounts:activation:v1` remain absent from production/dependency surfaces.

## Remaining Phase 1.1 limitations

Unchanged: default nested continuation agentDir is credential-free until configured; probe strategies without live HealthRegistry fail closed; continuation progress is not projected back into durable state; runtime-construction exceptions can leave an admitted orphaned running record. The frozen Advisor evidence for direct Main still lacks tracked changed paths/workspace digest; truthful independent validation via the existing tool was sufficient for this bounded successful review. No fresh-evidence/digest authority rules or Phase 1B.3 changes were introduced.

## Recommended next action

Freeze Phase 1.1 after exact evidence-commit CI and hygiene verification. Do not automatically begin another phase. This closes an evidence gap, not a new feature or a guarantee that all future model/provider attempts will approve.
