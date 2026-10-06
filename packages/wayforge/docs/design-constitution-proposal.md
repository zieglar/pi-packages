# Wayforge Design Constitution — Proposal

Status: proposal for operator review. Every claim below is labeled
**EXISTING PRINCIPLE** (demonstrated by production composition, frozen
contracts, gates, tests, or accepted git history) or **PROPOSED GOVERNANCE
RULE** (a new rule proposed for future issues/PRs). Nothing labeled PROPOSED
is historical architecture.

## Purpose

This document derives a candidate Design Constitution for Wayforge from
repository evidence: production source, frozen contracts, the 19 static
architecture gates, the durable-state schema, recovery and adapter
boundaries, dogfood records, and accepted git history.

It is **not** the frozen Constitution itself (it becomes one only through an
explicit operator decision), not an incident report, and not a restatement
of preferences (where evidence is absent, the text says so or records an
open question).

## Wayforge identity

Wayforge is a deterministic agent-orchestration kernel and Pi extension that
owns **governed multi-role software workflows under explicit authority** for
Pi (`packages/wayforge/README.md`). A native Pi Main session stays native;
Wayforge wraps it with:

- role-scoped execution policy (Main / Worker / Advisor) resolved from pure
  policies (`packages/wayforge/src/policy/role-policy.ts`,
  `packages/wayforge/src/policy/model-policy.ts`);
- versioned, authoritative durable task state with fenced leases
  (`packages/wayforge/src/durable/state.ts`,
  `packages/wayforge/src/durable/filesystem-task-store.ts`);
- a single Completion Authority that alone may persist validation evidence
  and transition a task to `completed`
  (`packages/wayforge/src/completion/completion-authority.ts`);
- centralized, typed failure recovery planning
  (`packages/wayforge/src/recovery/recovery-coordinator.ts`) and bounded
  execution (`packages/wayforge/src/recovery/runtime-recovery-executor.ts`);
- one Pi compatibility boundary and narrow adapters for everything external
  (`packages/wayforge/src/runtime/pi-compatibility-adapter.ts`,
  `packages/wayforge/src/adapters/contracts.ts`).

The problem it owns: making multi-role agent work **completable only with
authority** — durable evidence, an approving Advisor verdict, a fenced
lease, and a verified workspace — and **recoverable without hidden retries
or duplicate side effects** across restarts (`packages/wayforge/docs/alpha-1-durable-resume.md`).

## Explicit non-goals

Each non-goal is verified against evidence before inclusion.

- **Not a provider transport.** Gate 2 forbids direct
  `@earendil-works/pi-ai` imports; nested model calls go through
  `ExtensionContext.modelRegistry.streamSimple()`
  (`packages/wayforge/scripts/check-architecture.mjs`, `packages/wayforge/README.md`).
- **Not a credential store.** The durable schema structurally rejects
  secret-shaped values (`containsSensitiveValue` in
  `packages/wayforge/src/durable/state.ts`); credentials are never persisted
  (`packages/wayforge/docs/alpha-1-durable-resume.md`).
- **Not a general DAG scheduler or distributed executor.** The completion
  design solves the completion race "without introducing a DAG or
  distributed scheduler" and says "Do not add DAG semantics"
  (`packages/wayforge/docs/plans/2026-10-05-durable-completion-authority-design.md`,
  `packages/wayforge/docs/plans/2026-10-05-durable-completion-authority.md`);
  the README out-of-scope list adds databases, scheduling, and distributed
  execution (`packages/wayforge/README.md`).
- **Not middleware and not a host.** "Native Pi Main stays native. Wayforge
  is an extension, not a host" (`packages/wayforge/docs/alpha-0-assisted-dogfood.md`);
  the controller is sequencing-only (`packages/wayforge/README.md`, lines 40
  and 157; implemented by `packages/wayforge/src/workflow/workflow-controller.ts`).
- **Not an event-sourced system.** The durable-resume design rejects event
  sourcing, external daemons, distributed leases, and databases
  (`packages/wayforge/docs/plans/2026-10-04-wayforge-phase-1b2-durable-resume-design.md`).
- **Not a UI.** The README out-of-scope list excludes UI and analytics;
  inspection is a read-only projection (`packages/wayforge/src/durable/inspection.ts`).
- **Not an account plugin adapter.** Competing account/routing/advisor
  extensions fail the ownership guard closed (`packages/wayforge/src/runtime/ownership-guard.ts`).

## Ownership map

Owners: **Wayforge**, **Pi core**, **pi-subagents**, **Pi Accounts** (component boundary), **the Operator**.

| Capability | Owner | Evidence |
| --- | --- | --- |
| Workflow orchestration (sequencing) | Wayforge | `packages/wayforge/src/workflow/workflow-controller.ts`; "sequencing only" per `packages/wayforge/README.md` |
| Execution policy (role/model) | Wayforge | `packages/wayforge/src/policy/role-policy.ts`, `packages/wayforge/src/policy/model-policy.ts` |
| Durable workflow state | Wayforge | `packages/wayforge/src/durable/state.ts`, `packages/wayforge/src/durable/filesystem-task-store.ts` |
| Completion authority | Wayforge | `packages/wayforge/src/completion/completion-authority.ts`; gates 12–14 in `packages/wayforge/scripts/check-architecture.mjs` |
| Recovery policy (planning) | Wayforge | `packages/wayforge/src/recovery/recovery-coordinator.ts` (pure; gate 5) |
| Recovery execution | Wayforge | `packages/wayforge/src/recovery/runtime-recovery-executor.ts` (bounded; plans returned to Main, `packages/wayforge/src/workflow/workflow-controller.ts`) |
| Provider transport | Pi core | Gate 2 (no `pi-ai` imports); `packages/wayforge/src/runtime/pi-compatibility-adapter.ts` sole `setModel(` (gate 1) |
| Model runtime | Pi core | `modelRegistry.streamSimple()` via `packages/wayforge/src/runtime/nested-invoker.ts` (exactly one attempt) |
| Credentials | Pi Accounts / provider auth | Secret rejection in `packages/wayforge/src/durable/state.ts`; gate 11 |
| Account storage | Pi Accounts (boundary) | `packages/wayforge/src/adapters/pi-accounts-adapter.ts` ("owns neither account selection nor recovery policy") |
| Account activation | Pi Accounts (boundary) | EventBus `accounts:activation:v1` confined by gate 15 |
| Worker execution | pi-subagents | `packages/wayforge/src/adapters/pi-subagent-worker-adapter.ts`; gate 9 (public `pi-subagents/delegation` contract only) |
| Child-session lifecycle | pi-subagents | Gate 4: no `abort`/`continueSession`/retry authority in adapters |
| Validation recording | Wayforge | `CompletionAuthority.recordValidation` in `packages/wayforge/src/completion/completion-authority.ts` |
| Advisor semantics (verdict) | Advisor model via Pi runtime; verdict schema owned by Wayforge | Strict verdict parsing in `packages/wayforge/src/adapters/pi-advisor-adapter.ts`; gate 17 |
| Health/cooldown | Wayforge | `packages/wayforge/src/recovery/health-registry.ts` (gate 6: single construction) |
| UI / operational inspection | Wayforge (read-only projection); git actions: the Operator | `packages/wayforge/src/durable/inspection.ts`; inspection-only workspace capture (`packages/wayforge/src/durable/workspace-checkpoint.ts`) |

## Core design principles

### One-owner principle (EXISTING PRINCIPLE)

One authoritative owner per capability; consume an existing owner or seam
instead of introducing a parallel mechanism. Demonstrated by:

- **Pi Accounts owns credentials and activation.** Wayforge consumes a
  versioned EventBus protocol and deliberately owns neither selection nor
  recovery policy (`packages/wayforge/src/adapters/pi-accounts-adapter.ts`);
  gate 11 forbids any pi-accounts dependency elsewhere.
- **pi-subagents owns child-session lifecycle.** Wayforge consumes only the
  public `pi-subagents/delegation` event contract (gate 9;
  `packages/wayforge/src/adapters/pi-subagent-worker-adapter.ts`).
- **Recovery planning vs execution split.** The sole planner is pure and
  constructed once (gate 5; `packages/wayforge/src/recovery/recovery-coordinator.ts`);
  the bounded executor only carries decisions out
  (`packages/wayforge/src/recovery/runtime-recovery-executor.ts`).
- The 19 gates are the one-owner principle made executable: single
  construction sites for `RecoveryCoordinator`, `HealthRegistry`,
  `CompletionAuthority`, live-Pi components, and the durable composition
  root (`packages/wayforge/scripts/check-architecture.mjs`).

Governance lesson (PROPOSED direction only): the pi-subagents child-admission
case (upstream issue #2707, a fail-closed child admission hook) shows that an
upstream seam must be verified against Wayforge's authority semantics before
adoption; the analysis is not a tracked artifact and is cited only as a lesson.

### Authority before convenience (EXISTING PRINCIPLE)

Authority proven → act; authority ambiguous → fail closed, block, or
suspend. Concrete mechanisms (the consolidated catalog with per-case
citations is in Authority and fail-closed principles below):

- **Completion fencing**: lease + deterministic readiness + immutable
  candidate digest + Advisor approval + post-review revalidation before the
  CAS commit (`packages/wayforge/src/completion/completion-authority.ts`,
  `packages/wayforge/src/completion/completion-readiness.ts`).
- **Lease/CAS + generation fencing**: revision-conditional updates; stale
  holders fenced (`packages/wayforge/src/durable/contracts.ts`,
  `packages/wayforge/src/durable/filesystem-task-store.ts`).
- **Workspace drift checks**: `CONFLICTING_DRIFT` blocks resume before
  launch intent (`packages/wayforge/src/durable/drift-validator.ts`).
- **Continuation outcome ambiguity**: unacknowledged launches block as
  `continuation_outcome_ambiguous`, never silently replayed
  (`packages/wayforge/src/recovery/wakeup-service.ts`).
- **Corruption fail-closed store reads** (`packages/wayforge/src/durable/state.ts`).
- **Phase B interruption reconciliation**: prior `running` → `blocked`
  (`interrupted_execution`) at startup
  (`packages/wayforge/src/recovery/startup-recovery-scan.ts`).
- **Unresolved-items completion refusal**: worker failures bound durably
  before return; binding failure fails closed
  (`packages/wayforge/src/workflow/workflow-controller.ts`).
- **Ownership guard fail-closed** (`packages/wayforge/src/runtime/ownership-guard.ts`).

### Minimal mechanism (EXISTING PRINCIPLE, with evidence)

Prefer the smallest mechanism satisfying an observed requirement. Documented
rejections of larger designs: event sourcing, databases, distributed leases,
and external daemons for durable resume
(`packages/wayforge/docs/plans/2026-10-04-wayforge-phase-1b2-durable-resume-design.md`);
DAG/distributed-scheduler semantics for the completion race
(`packages/wayforge/docs/plans/2026-10-05-durable-completion-authority-design.md`);
narrower per-concern store interfaces collapsed into one `DurableTaskStore`
with legacy aliases deprecated (`packages/wayforge/src/durable/contracts.ts`).

No rejection evidence was found for "generic middleware", a "generic account
registry", or "parallel authority systems" as such; for those the principle
is **inferred** from the gates and the narrow-adapter contract. Historical
rejection is not permanent prohibition: future evidence may change the
architecture deliberately through a documented decision. Prior-session
records mention explicit STOP decisions; git history shows none, so they are
treated as unverifiable (see Open Questions).

### Role != model (EXISTING PRINCIPLE)

Main/Worker/Advisor are semantic roles with capabilities, not permanently
bound provider/model identities. Routes bind roles to models per delegation:
`ExecutionRoute` carries role capabilities
(`packages/wayforge/src/workflow/contracts.ts`), the worker adapter fails
closed on terminal model-evidence mismatch
(`packages/wayforge/src/adapters/pi-subagent-worker-adapter.ts`), and only
the `main` role may change the parent session model
(`packages/wayforge/src/runtime/main-model-controller.ts`). This documents
current routing behavior; it does not redefine it.

### Policy vs execution (EXISTING PRINCIPLE)

- Recovery planning ≠ recovery execution:
  `packages/wayforge/src/recovery/recovery-coordinator.ts` (pure) vs
  `packages/wayforge/src/recovery/runtime-recovery-executor.ts` (bounded).
- Selection policy ≠ credential ownership:
  `packages/wayforge/src/adapters/passive-account-adapter.ts` (read-only
  route enumeration) vs `packages/wayforge/src/adapters/pi-accounts-adapter.ts`.
- Completion readiness ≠ semantic advisor judgment:
  `packages/wayforge/src/completion/completion-readiness.ts` (deterministic;
  "human summaries never influence policy") vs the strict verdict in
  `packages/wayforge/src/adapters/pi-advisor-adapter.ts`.
- Durable evidence ≠ runtime observation:
  `packages/wayforge/src/durable/state.ts` (authoritative) vs
  `packages/wayforge/src/workflow/events.ts` (redacted log) and the
  never-serialized `EphemeralTaskState`.

## Durable-state principles

Formalized rule: **runtime-useful ≠ durable-safe**.

Durable state holds (schema-enforced, exact allowlist,
`packages/wayforge/src/durable/state.ts`): decisions and typed sanitized
failures, safe evidence references (summaries and digests, never payloads),
workflow status and checkpoints, recovery/suspension state, workspace
identity and path digests (never file contents), continuation phase, and
authority/fencing metadata (revision, lease generation, completion
evidence).

Durable state must never hold: credentials, tokens, cookies, authorization
headers, live session objects, AbortSignals, callbacks, executable
capabilities, raw provider payloads, transcripts, prompts, or hidden
reasoning. Enforcing mechanisms:

- the schema itself: JSON-only, `additionalProperties: false`,
  prototype-polluting keys rejected, `EphemeralTaskState` deliberately
  non-serializable (`packages/wayforge/src/durable/state.ts`);
- storage-layer secret rejection on both serialize and deserialize
  (`containsSensitiveValue` in `packages/wayforge/src/durable/state.ts`);
- the inspection whitelist projection, which structurally omits workspace
  paths, account identifiers, provider payloads, and failure records
  (`packages/wayforge/src/durable/inspection.ts`);
- summary sanitization and redaction for unresolved binding and advisor
  diagnostics (`packages/wayforge/src/workflow/workflow-controller.ts`,
  `packages/wayforge/src/trace/redaction.ts`);
- data-only continuation packages: no SDK session, provider body,
  transcript, prompt history, handle, stream, credential, or CoT
  (`packages/wayforge/src/recovery/continuation.ts`).

## Integration principles

Decision sequence for any new capability:

1. **Does another component already own this capability?** YES → consume its
   supported seam, and verify the seam satisfies Wayforge's authority,
   privacy, lifecycle, and failure semantics. "Upstream exists" is NOT
   automatically sufficient: the pi-subagents ≥0.75.0 admission-seam analysis
   is the standing example — adoption was conditioned on a fail-closed child
   admission hook, not on mere availability (session context, not a tracked
   artifact; the current pin is `pi-subagents@0.70.0`). NO → continue.
2. **Does Wayforge genuinely own it?** Owns → add the narrowest capability
   satisfying the observed requirement. Does not own → do not absorb it for
   convenience; prefer an explicit non-goal over a quiet parallel mechanism.

This sequence is generic. Component-specific arrangements (pi-subagents
delegation, Pi Accounts protocol, Pi core transport) are instances, not
universal architecture.

## Authority and fail-closed principles

Fail-closed catalog, each with its enforcing mechanism:

| Case | Behavior | Evidence |
| --- | --- | --- |
| Admission without durable authority | Task creation is the atomic admission gate; durable failure aborts admission | `packages/wayforge/src/extension.ts` |
| Completion readiness | Deterministic refusal codes (`validation_required`, `task_suspended`, `pending_work`, ...) | `packages/wayforge/src/completion/completion-readiness.ts` |
| Completion fencing / CAS | Lease + candidate digest + post-review revalidation before commit | `packages/wayforge/src/completion/completion-authority.ts` |
| Lease contention | `lease_conflict` / `lease_contended`; expired claims reclaimed at higher generation, stale holders fenced | `packages/wayforge/src/durable/filesystem-task-store.ts` |
| Corruption / version drift | Reads fail closed (`durable_state_corrupt`, `unsupported_version`, `forbidden_fields`) | `packages/wayforge/src/durable/state.ts`, `packages/wayforge/src/durable/filesystem-task-store.ts` |
| Unresolved worker failure binding | Bind durably before return; `unresolved_binding_failed` fails closed; completion refuses `unresolved_items` | `packages/wayforge/src/workflow/workflow-controller.ts` |
| Interruption reconciliation | Prior `running` reconciled to `blocked` (`interrupted_execution`) first at startup | `packages/wayforge/src/recovery/startup-recovery-scan.ts` |
| Ambiguous continuation outcome | Block as `continuation_outcome_ambiguous`; never silently replay | `packages/wayforge/src/recovery/wakeup-service.ts` |
| Competing capability owner | Session disabled, actionable diagnostics, no mutation of other extensions | `packages/wayforge/src/runtime/ownership-guard.ts` |
| Worker model evidence mismatch | Fail closed (`worker_model_mismatch`) | `packages/wayforge/src/adapters/pi-subagent-worker-adapter.ts` |

## Dogfood and evidence principles

EXISTING pattern: deterministic tests establish correctness boundaries;
dogfood runs establish operational usefulness; speculative architecture must
not outrank observed real workflow failures.

- Alpha 0 gate enforces frozen baseline ancestry, isolated paths, pinned
  versions, and sentinel tests (`packages/wayforge/scripts/check-alpha0.mjs`,
  `packages/wayforge/docs/alpha-0-assisted-dogfood.md`,
  `packages/wayforge/docs/evidence/phase-1b1-alpha0-dogfood.json`).
- Alpha 1 proved cross-process restart and drift blocking with disposable
  Git repositories and no provider traffic
  (`packages/wayforge/docs/alpha-1-durable-resume.md`,
  `packages/wayforge/docs/evidence/phase-1b2-alpha1-restart-dogfood.json`,
  `packages/wayforge/test/restart-integration.test.ts`).
- A usability audit of a prior dogfood (session context, "U0"; not itself a
  tracked artifact) motivated the accepted commits `da82936` ("Usability
  Phase A: require durable governed execution") and `facdc65` ("Usability
  Phase B: bind failures and reconcile interruptions") — observed failures
  changed the architecture.
- This U1 run is itself dogfood: this proposal was produced inside a
  governed Wayforge workflow with recorded validations, and it surfaced a
  concrete observation about one-shot completion review (see Open
  Questions).

## Upstream-first principle

**PROPOSED GOVERNANCE RULE.** Before duplicating a capability locally, use
an upstream-supported capability — **conditioned on** the upstream
capability satisfying Wayforge's required authority, privacy, lifecycle, and
failure semantics. Caveat, stated prominently: upstream existence is
necessary but never sufficient; a seam that cannot fail closed, cannot
respect fencing, or leaks privacy boundaries must not be adopted even when
officially supported. When an upstream seam is insufficient, prefer a narrow
local contract and record the gap as an upstream dependency (see the
decision vocabulary).

## Issue/PR decision framework

**PROPOSED GOVERNANCE RULE.** Every issue/PR touching Wayforge architecture
answers these ten review questions as a checklist:

1. Why here — why does this belong in Wayforge at all?
2. Who owns it — which single owner per the Ownership map?
3. Existing mechanism — is there already a mechanism or seam that does this?
4. Second authority — does this introduce a parallel authority for an owned capability? (If yes, stop.)
5. Durable state change — does it alter the authoritative schema? (If yes, versioning and migration evidence required.)
6. Privacy exposure — can it persist or display anything not durable-safe?
7. Recovery semantics — what happens on crash, interruption, and restart?
8. Frozen contract — does it touch a frozen contract? (If yes, reopening evidence required.)
9. Observed evidence — is this motivated by an observed real workflow failure or test boundary, not speculation?
10. Smallest mechanism — is this the smallest sufficient mechanism?

Decision vocabulary (kept minimal; categories that materially improve review
clarity only): **IN SCOPE**, **OUT OF SCOPE**, **USE EXISTING MECHANISM**,
**UPSTREAM DEPENDENCY**, **EVIDENCE REQUIRED**, **CONTRACT CHANGE REQUIRED**,
**EXPERIMENTAL**.

## Frozen versus evolvable

Definitions:

- **Principle** — a durable design rule (this document's EXISTING
  PRINCIPLEs). Evolves only through deliberate, documented decisions.
- **Contract** — a versioned interface other code depends on. Frozen
  contracts require explicit reopening evidence before modification.
- **Current implementation** — replaceable at any time provided contracts,
  gates, and tests still pass.
- **Experimental mechanism** — admitted under EXPERIMENTAL with explicit
  isolation; may not leak into durable state or contracts.

Currently frozen, verified from gates and git history:

- **Completion Authority** — gates 12–14 and 16–19 confine construction,
  completion evidence writes, completion CAS, budget reservation, review
  dispatch, and diagnostic emission; the design was approved against a
  frozen Phase 1B.3 baseline
  (`packages/wayforge/docs/plans/2026-10-05-durable-completion-authority-design.md`; commit `13d57ba`).
- **Phase 1B.4A adapter protocol boundary** — gates 11 and 15 confine
  pi-accounts references and protocol channel strings to
  `packages/wayforge/src/adapters/pi-accounts-adapter.ts` (commits
  `8b969e0`, `409eedf`).
- **Phase 1A kernel baseline** — the Alpha 0 gate requires the frozen
  baseline commit to remain an ancestor of HEAD
  (`packages/wayforge/scripts/check-alpha0.mjs`).

## Open questions

- **U0 usability audit artifact.** The audit that motivated Usability Phase
  A/B is session context, not a tracked repository file; only its outcome
  commits (`da82936`, `facdc65`) are verifiable. Should the audit notes be
  preserved under `packages/wayforge/docs/evidence/`?
- **STOP decisions.** Prior context records STOP decisions from earlier
  sessions; git history contains no matching commits, so they are
  unverifiable and deliberately not asserted as principles here.
- **Runtime recovery executor wiring.** This task's brief described the
  executor as "advisory/unwired". Evidence shows it IS constructed in the
  runtime factory and invoked by the controller, but only to plan one
  bounded step returned to Main — no autonomous retry
  (`packages/wayforge/src/workflow/runtime-factory.ts`,
  `packages/wayforge/src/workflow/workflow-controller.ts`). The source wins
  over the brief; the divergence is recorded here.
- **pi-subagents ≥0.75.0 admission seam.** The seam analysis and upstream
  issue #2707 are session context; the repository pins
  `pi-subagents@0.70.0` and contains no tracked analysis. The governance
  lesson stands; the specifics need a tracked reference before they harden
  into a rule.
- **One-shot authoritative review vs iterative change requests.** The
  frozen Completion Authority grants exactly one authoritative review per
  live runtime: `completionReviewClaimed` is set synchronously and never
  reset (`packages/wayforge/src/workflow/workflow-controller.ts`), and the
  test suite pins that a `changes_requested` (or `unable`, malformed, or
  provider-failure) attempt "is not retried or replenished"
  (`packages/wayforge/test/durable-completion-authority.test.ts`). Is
  one-shot review the deliberate final semantics, or should a bounded
  second review exist for addressed findings?
- **Inferred minimal-mechanism rejections.** Generic middleware, a generic
  account registry, and parallel authority systems are rejected by inference
  from gates and contracts, not by an explicit recorded decision.

## Recommended final document structure

Recommendation: a **two-file** structure, not the VISION.md / DESIGN.md /
CONTRIBUTING.md triplet.

- `DESIGN.md` — the Constitution: identity, non-goals, ownership map, core
  principles, durable-state rules, integration and fail-closed rules,
  frozen-vs-evolvable (this proposal's sections 2–9 and 12).
- `CONTRIBUTING.md` — the review instrument: the ten questions, the decision
  vocabulary, the upstream-first rule (sections 10–11).

Justification from repository conventions: identity and quick-start already
live in `packages/wayforge/README.md`, so a separate VISION.md would
duplicate it; phase narrative lives in dated plans under
`packages/wayforge/docs/plans/` and dogfood evidence under
`packages/wayforge/docs/evidence/`, so a third standing document would
sprawl. This proposal remains as the derivation record; the two extracted
files replace it as living documents.
