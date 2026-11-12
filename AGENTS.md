# Project working rules

Read the nearest package instructions, architecture and canonical commands before changing behavior. Keep work within the authorized package and preserve existing dirty files. Isolate release preparation from unrelated development; do not reset, rebase or force-push to manufacture a clean baseline.

## Implementation and evidence

- Prefer the smallest correct change. Validate unknown input at its owning boundary and pass typed values inward. Keep error handling and authority checks close to the operation they protect.
- Test observable behavior at the affected boundary, targeted first. Preserve first failures and distinguish product regressions from fixture/environment failures. Reuse valid fixed-source test and review evidence; do not repeat a full suite or independent review solely because the work reached another stage. Required hosted checks still run.
- Record actual source, dependency/environment and artifact identities. Local tests, installed-package smoke, hosted CI, real Cloud observations and publication prove different things; report each within its demonstrated scope. Missing evidence remains unverified.
- Never expose credentials in output, argv, source or artifacts. Use the existing secure credential reference/consumer path. Do not guess a credential or move production resources into a test without explicit scope.

## Component authority

- CE owns authorized durable message exchange, transport/lifecycle, reception evidence and reconciliation. `CREATED` proves persistence; reception/ACK does not prove business execution, completion or exactly-once effects.
- Workflow policy, Recovery and Completion belong to Wayforge or the external operator/workflow using CE. A CE message, routing group or successful notification does not create business ownership or workflow authority.
- Pi owns SDK tools/hooks, Sessions, runtime and provider transport. Keep its permission and Session/endpoint guards intact. Herdr provides process/terminal orchestration; it does not authorize CE or workflow effects. Magpie routes models; a model route or reviewer role is not business authority or proof of cross-family independence.

## CE qualification and release

Use [CE operations](packages/pi-chat-exchange/docs/operations.md) and the existing [Tunnel qualification contract](packages/pi-chat-exchange/compatibility/README.md). Do not introduce another Gate, review or Handoff merely for a stage transition.

- A is actual bounded Cloud exchange with genuine message/receipt/durable evidence. B is the scoped real-client/local lifecycle observation, including only the Stop/Hook scenarios actually exercised. C is local SDK/policy/test evidence. Loopback or synthetic results cannot be promoted to real Cloud.
- Reuse already valid A/B/C observations for the same candidate/client/environment within their limits. Verify source/runtime, package and dependency identity and provenance before importing them. Keep original evidence and failure history. Do not relabel an old version/runtime or daily deployment as if it were tested against a new candidate.
- The current `runtimeDigest` / `releaseDecision` contract controls qualification. Import reviewed truthful records through the existing compatibility matrix/evidence mechanism. Collect only genuinely missing or affected observations. Changing evidence applicability or digest policy is a release-policy change requiring explicit scope and review; never weaken a predicate to get a pass.
- Preserve normal ordering: exact-head PR checks, normal merge and actual main SHA/tree checks, then the existing OIDC publication workflow. It requires fresh same-run official latest-client offline evidence and matching reviewed qualification. Keep the client job separate from OIDC write authority; no manual-token publication workaround.
- Commit, push, PR, merge, workflow/publication, tag/GitHub Release and production adoption have distinct effects. An explicit instruction may authorize a continuous sequence; do not add redundant permission prompts within that scope. Never infer remote or production authority from a local commit alone.
- Before retrying an unknown external effect, inspect actual branch/PR/main/run/registry/tag state. Do not blindly repeat a push, dispatch, publication or side-effecting test. An existing immutable version must be reconciled by digest/provenance, not republished.
- Claim RELEASED/ACCEPT only after actual registry version/tag/source-workflow provenance, downloaded archive integrity/closure and applicable installed-artifact acceptance pass. Source/version labels and green CI alone do not prove publication. Documentation-only follow-up must not silently retarget an already qualified release candidate or its tag.

## Working directories

- Put temporary task artifacts under `$TMPDIR`; keep durable project documentation in the repository’s existing documentation locations.
- Follow the repository’s existing worktree convention, or use `~/Code/.worktrees/pi-packages/<branch>`; do not create task worktrees under `~/.local/share`.
- Application-owned persistent data may continue to use `~/.local/share`.
- Make cross-endpoint results self-contained; local-only paths are supplementary. Retain durable evidence in existing project locations with stated retention/cleanup conditions; clean temporary artifacts only after checking references.
