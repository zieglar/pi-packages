# Wayforge Design Constitution

**Status: frozen governance baseline — HANDOFF 38164.** This document is
normative for architectural decisions. [CONTRIBUTING.md](CONTRIBUTING.md)
provides the review gates and current operating protocol. The
[derivation proposal](docs/design-constitution-proposal.md) is historical,
non-normative evidence, not a competing source of rules.

This freeze adopts governance; it does not change runtime behavior or reopen
existing contracts. Source, tests, and frozen contracts remain authoritative
for what the implementation currently guarantees. A conflict with this document
must be reported and resolved explicitly, not hidden by either source.

## Identity and purpose

Wayforge is a **durable, policy-driven execution orchestration layer for Pi**.
**Pi-first, agent-portable:** Pi is the supported host today; host-neutral
policy and durable authority must not acquire unnecessary host dependencies.
Agent-portable is a direction, not a claim of current multi-host support.

Wayforge exists to make software workflows governed: execution roles and
policy are explicit, failures cannot silently become successful completion,
and completion requires validated, workspace-bound evidence and authority.
Native Pi Main remains native. Wayforge owns orchestration decisions and
workflow authority, not every capability that a workflow consumes.

Evidence: [README](README.md), the
[durable execution design](docs/plans/2026-10-04-wayforge-phase-1b2-durable-resume-design.md),
[composition](src/workflow/runtime-factory.ts), and
[Completion Authority](src/completion/completion-authority.ts).

## Four levels of governance

| Level | Meaning | Example |
| --- | --- | --- |
| **PRINCIPLE** | Durable rule for ownership and architectural direction; changes require an explicit documented decision. | One authoritative owner per capability. |
| **CONTRACT** | Concrete semantic guarantee relied on by consumers; a frozen contract requires deliberate reopening. | One-shot authoritative completion Advisor review. |
| **CURRENT IMPLEMENTATION** | Replaceable mechanism satisfying principles and contracts; not constitutional merely because it exists. | Startup interruption reconciliation uses leases, generation checks, and revision CAS. |
| **OPERATIONAL PROTOCOL** | Rules necessary to use the current implementation safely; may evolve with verified capabilities. | Exclusive governed workspace use during U1. |

Experimental mechanisms are an adoption status, not a fifth level of authority:
state the experiment's owner, isolation, evidence target, and exit criteria.
Experiments have no implied exemption from contracts or privacy rules.

## Explicit non-goals

Within this baseline Wayforge is not:

- a provider transport implementation or replacement for Pi's model runtime;
- a credential store or account credential manager;
- a generic agent framework or host replacing native Pi Main;
- automatically an arbitrary DAG scheduler, distributed scheduler, or
  event-sourcing platform;
- the owner of a capability merely because a workflow needs it.

These are scope boundaries, not eternal technology bans. Expansion requires
observed evidence, ownership proof, and an explicit decision; frozen contracts
must be reopened separately where affected. Existing diagnostic events are
not an event-sourcing authority. Read-only operational inspection is in scope;
"not a UI" must not be used to prohibit useful inspection surfaces.

Evidence: [adapter contracts](src/adapters/contracts.ts),
[architecture gates](scripts/check-architecture.mjs),
[durable resume non-goals](docs/plans/2026-10-04-wayforge-phase-1b2-durable-resume-design.md),
and [completion design](docs/plans/2026-10-05-durable-completion-authority-design.md).
Historical phase-specific exclusions in older documents are not statements
that subsequently implemented durable functionality does not exist.

## One authoritative owner per capability

**PRINCIPLE:** identify the owner before adding a mechanism. Do not create a
parallel authority for convenience. Consume the owner's supported seam where
it satisfies the required semantics. If no adequate owner/seam exists, prove
that Wayforge owns the missing responsibility before implementing it.

Distinguish ownership of a **decision**, **capability**, **resource**, and
**consumption**. Needing account switching does not confer credential ownership;
observing a failure does not confer authority over provider account state.

### Current ownership map

This is an evidence-backed map of current responsibilities, not a perpetual
assignment of every implementation class.

| Capability | Current owner/boundary | Evidence and qualification |
| --- | --- | --- |
| Workflow sequencing and execution policy | Wayforge | [Controller](src/workflow/workflow-controller.ts), [role policy](src/policy/role-policy.ts), [model policy](src/policy/model-policy.ts). |
| Main route candidate ordering | Wayforge ModelPolicy | [`ModelPolicy.candidates`](src/policy/model-policy.ts) preserves immutable declaration order, filters by policy/capability/role, rejects duplicate route IDs and duplicate Main `provider + modelId` endpoints, and has no health or execution authority. |
| Durable workflow state | Wayforge | [Schema](src/durable/state.ts), [store contract](src/durable/contracts.ts). |
| Completion authority and validation recording | Wayforge Completion Authority | [Authority](src/completion/completion-authority.ts). Operator/Main runs checks; recording is not independent execution of those checks. |
| Recovery policy | Wayforge's pure RecoveryCoordinator | [Planner](src/recovery/recovery-coordinator.ts). Decisions are not transitions. |
| Recovery execution | Explicit Wayforge execution/transition owners | [Executor](src/recovery/runtime-recovery-executor.ts), [WakeupService](src/recovery/wakeup-service.ts). Live worker failure handling calls `plan`; autonomous executor `run` is not wired there. |
| Health/cooldown and route eligibility | Wayforge runtime-private health boundary | [Registry](src/recovery/health-registry.ts), [TR1 health projection](src/recovery/health-projector.ts), and [ordered Main eligibility](src/recovery/main-route-eligibility.ts). One workflow runtime owns one registry; expiry restores eligibility but does not prove success. Historical evidence is not health authority. |
| Transport failure classification | Wayforge passive classifier | [Classifier](src/recovery/transport-failure-classifier.ts). Classification is not route fallback, cooldown mutation, continuation, budget, account activation, Worker replay, or Advisor retry authority. |
| Provider transport and model runtime | Pi runtime | [Compatibility boundary](src/runtime/pi-compatibility-adapter.ts), [nested invoker](src/runtime/nested-invoker.ts). |
| Account inventory, credential storage, activation semantics | Pi Accounts when integrated; Pi auth otherwise | [Protocol client](src/adapters/pi-accounts-adapter.ts). Wayforge consumes the seam; this adapter is not live account-recovery wiring. |
| Worker execution and child-session lifecycle | pi-subagents, consumed through a Wayforge adapter | [Public delegation boundary](src/adapters/pi-subagent-worker-adapter.ts). No independent child lifecycle mechanism is implied. |
| Advisor semantic judgment | Advisor via Pi runtime | [Strict verdict adapter](src/adapters/pi-advisor-adapter.ts); Wayforge owns evidence/verdict contracts and completion admission, not the model's judgment. |
| UI/operational inspection | Wayforge projection, Pi presentation | [Inspection](src/durable/inspection.ts), [tool surface](src/runtime/extension-tools.ts). Historical inspection is read-only. |
| Repository edits and Git actions | Authorized task actor/operator under workspace protocol | [Workspace capture](src/durable/workspace-checkpoint.ts) is inspection-only; it does not repair or overwrite files. |

The Pi Accounts client's disclaimer about selection/recovery policy applies to
that **adapter**, not to all of Wayforge. Routing/recovery decisions remain
Wayforge concerns where explicitly owned. Credential execution remains outside.

## Authority before convenience

**PRINCIPLE:** when authority is proven, act. When authority is ambiguous, do
not guess: reject, block, suspend, or require explicit recovery according to
the owning contract. Fail-closed is a concrete transition policy, not an excuse
to invent a second owner or claim that every failure has the same outcome.

| Existing mechanism | Authority boundary |
| --- | --- |
| [Completion](src/completion/completion-authority.ts) | Readiness, workspace/candidate binding, Advisor approval, post-review revalidation, fenced durable CAS before visible completion. |
| [Lease/generation/revision](src/durable/filesystem-task-store.ts) | A stale holder or revision cannot silently overwrite another owner's state. |
| [Drift validation](src/durable/drift-validator.ts) | Conflicting workspace drift blocks continuation rather than overwriting external work. |
| [Continuation ambiguity](src/recovery/wakeup-service.ts) | Ambiguous launch intent is blocked; never blindly replay an external side effect. |
| [Durable reads](src/durable/state.ts) | Corrupt, incompatible, or forbidden state is rejected, not reconstructed by guessing. |
| [Admission](src/extension.ts) | Governed execution requires durable authority; diagnostics may remain available when admission fails. |
| [Worker failure binding](src/workflow/workflow-controller.ts) | Unresolved outcomes must bind durably before acceptance; binding failure refuses, unresolved items block readiness. |
| [Startup reconciliation](src/recovery/startup-recovery-scan.ts) | Prior running state is reconciled under existing authority; no PID/age-based liveness inference. Current-process ownership and lease contention are respected. |

**PRINCIPLE:** a governed workspace is an authority boundary. A candidate must
account for its changes and their ownership; unrelated external edits cannot
silently become governed evidence. The exclusive-workspace U1 protocol in
[CONTRIBUTING](CONTRIBUTING.md#current-u1-operational-protocol) is today's
operational enforcement, not proof of automatic fencing or a permanent lock design.

**CURRENT IMPLEMENTATION:** startup reconciliation precedes due suspension
processing and uses existing lease/generation/CAS mechanisms. This is not a
constitutional requirement for permanent global machine locks or a new scheduler.

## Frozen contracts

**CONTRACT — Completion Authority (Phase 1B.3):** preserve deterministic
readiness, validation freshness, candidate binding, completion fencing/CAS,
idempotent authoritative completion, and publication ordering. Semantic Advisor
approval cannot replace those checks; passing checks cannot replace judgment.

The controller synchronously claims `completionReviewClaimed` before route
lookup/provider awaits and **never resets** it. The authoritative review is
one-shot in the current runtime-task lifecycle, not a durable restart allowance.
`advisor_changes_requested` is terminal for that task's completion review:
a corrected workspace must enter a **new governed task/candidate lifecycle**.
It is not retryable; `completion_review_spent` must not be bypassed. Invalid,
unable, or provider-failed reviews do not replenish the claim either.

A settled `changes_requested` verdict is additionally preserved as exactly one
**non-authorizing durable historical fact** (`negativeReview`, durable schema
generation 3): outcome, candidate digest, record time, and a bounded sanitized
summary. It binds the reviewed completion candidate — later workspace drift
does not erase the judgment — is written at most once by the Completion
Authority inside the completion path under lease and revision fencing, and
never authorizes, blocks, or spends anything by itself. It carries **no
review-allowance semantics**: absence is unknown (legacy generation or never
settled), never proof that no review happened, and inspection guidance stays
"correct the work and start a new governed task" — never an allowance
exhaustion claim. Durable review-allowance enforcement across restarts remains
out of scope (decision E0/A0).

Preserve Contract A's bounded logical allowance (800, capped by the parent),
high reasoning, reserved review capacity, and post-generation overdraw semantics:
overdraw does not invalidate an otherwise valid verdict. Governed manual advice
cannot consume the authoritative review opportunity.

Evidence: [controller](src/workflow/workflow-controller.ts),
[authority tests](test/durable-completion-authority.test.ts),
[budget ownership plan](docs/plans/2026-10-05-advisor-budget-ownership.md).

**CONTRACT — Pi Accounts protocol boundary (Phase 1B.4A):** untrusted callback
validation is fail-closed, first terminal settlement wins, and `account: null`
restores Pi built-in auth; it never means select a default account. Credentials
and transport internals do not cross this boundary. Evidence:
[adapter](src/adapters/pi-accounts-adapter.ts),
[tests](test/pi-accounts-adapter.test.ts), and
[gates](scripts/check-architecture.mjs).

Freezing governance does not reopen either contract or wire account recovery.

**CONTRACT — Main Transport Recovery (TR0/TR1/TR2):** the only authorized recovery class is an owned governed **Main** request after Pi-native retry/recovery has declined continuation at the supported `agent_before_settle` boundary. TR1 classification is passive: it distinguishes attributable transient throttle/provider/connection failures, authentication, economic quota, context overflow, cancellation, tool failure, incomplete results, success, and unknown without switching models, consuming budgets, requesting continuation, activating accounts, replaying Workers, or retrying the one-shot Advisor.

Worker transport-looking failures never authorize automatic relaunch because child work may have side effects. Ordinary Pi remains unaffected: no owned governed Main invocation means no Wayforge cooldown, failure-driven model switch, or continuation injection. Runtime route health remains workflow-runtime-private and is not durable history; historical classification evidence is descriptive and non-authorizing. Evidence: [classifier](src/recovery/transport-failure-classifier.ts), [adapter outcome interpretation](src/runtime/pi-compatibility-adapter.ts), [classification tests](test/transport-failure-classifier.test.ts), [resolved-result regression](test/nested-runtime.test.ts), and [Pi 1.0.2 contract tests](test/pi102-advisor-contract.test.ts).

TR2 maps only attributable `transient_throttle`, `transient_provider`, and `transient_connection` classifications to a route-local cooldown bounded at 30 seconds. A matching attributed terminal `stop`/`toolUse` result may clear that exact route; authentication, economic quota, context overflow, cancellation, tool failure, incomplete results, and unknown do not mutate transport health. `ModelPolicy` owns deterministic declaration order; episode-local `provider + modelId` visits and current-endpoint exclusion remain separate inputs. A single-route configuration honestly yields no alternative, and account identity is outside transport eligibility. TR2 reports ordered eligibility only: it does not switch models, reserve fallback budget, request continuation, activate accounts, or execute recovery. Evidence: [eligibility projection](src/recovery/main-route-eligibility.ts), [health projection](src/recovery/health-projector.ts), [tests](test/main-route-eligibility.test.ts), and [architecture gate](scripts/check-architecture.mjs).

## Durable-state boundary

**PRINCIPLE: runtime-useful != durable-safe.** Persist only bounded,
sanitized workflow authority/evidence justified by the owning schema:

- task identity/status/revision/lease generation, safe objective and criteria;
- policy versions and safe checkpoint/work/recovery state;
- workspace identity/digests/write-set metadata, not file contents;
- workspace-bound validation evidence and authoritative completion evidence;
- one settled non-authorizing negative-review fact (`changes_requested` only),
  candidate-bound and mutually exclusive with completion evidence;
- bounded sanitized failure summaries and approved safe route representations.

Do not persist credentials, tokens, cookies, authorization headers, unsafe raw
account identifiers, live SessionManager objects, callbacks, AbortSignals,
executable capabilities, raw provider request/response bodies, full prompts or
transcripts, hidden reasoning, or unsanitized errors merely for convenience.
A safe objective is not permission to persist a full prompting transcript.

**CURRENT IMPLEMENTATION:** the [schema](src/durable/state.ts) is an exact
allowlist with bounds, forbidden-field/prototype defenses and sensitive-value
rejection. It allows workspace roots and optional sanitized `accountKey`
provenance internally; that is not permission to expose them. Secret detection
is a guard, not a proof that arbitrary text is safe. Producers must minimize and
sanitize; schema presence alone does not justify a new privacy exposure.

The negative-review fact follows the same boundary: only `changes_requested`
outcomes are recorded (approval lives in completion evidence; abstention,
invalid output, provider failure, and cancellation are not negative judgment),
the summary is bounded (1,000 characters) and stripped of secret material,
absolute paths, and control characters before persistence, the record is
write-once and mutually exclusive with `completionEvidence` at the codec level,
and it survives cancellation and startup reconciliation as historical fact.
Sole writer ownership is enforced by architecture gate 20 in
[check-architecture.mjs](scripts/check-architecture.mjs); legacy generation-2
records remain readable and upgrade lazily only through an otherwise valid
authoritative write.

The [historical inspection projection](src/durable/inspection.ts) separately
omits workspace paths, account identifiers (including `accountKey`), originating
failure payloads and digest internals; it exposes bounded status and authority
metadata, not mutation/recovery capabilities. A `running` record is not proof
of liveness. Diagnostic events and runtime observations are not substitutes
for authoritative task state. See also [continuation packages](src/recovery/continuation.ts)
and [redaction](src/trace/redaction.ts).

## Residency and non-amplification (DH-0)

**CONTRACT — HANDOFF 58241:** durability is not a residency requirement.
Wayforge-owned working state must be bounded independently of cold history and
historical payload bytes; Wayforge must not amplify Pi-owned history through
cumulative projections or unnecessary copies. The normative
[DH-0 contract](docs/dh0-residency-contract.md) defines ownership, active/cold
boundaries, the source-backed projection inventory, acceptance predicates and
DH-1/DH-2 roadmap. Known runtime gaps are explicitly deferred, not claimed fixed.

The existing authoritative durable schema and frozen completion, accounts and
transport contracts remain valid and unopened. DH is independent of TR3 and
1B.4B. This freeze changes no runtime behavior and grants no Pi residency control.

## Roles and separations of authority

**PRINCIPLE: role != model.** Main, Worker, and Advisor are semantic roles;
provider/model choices are routing policy/current implementation. Do not bind
a role constitutionally to a vendor or model. Preserve role capabilities and
model-evidence checks when changing routing.

Keep these boundaries explicit:

- **Recovery policy != recovery execution:** a plan does not grant execution
  authority or prove that a retry happened.
- **Transport classification != recovery execution:** a typed provider/model outcome does not
  by itself switch routes, mutate health, consume budget, request continuation, replay
  Worker work, or replenish Advisor review.
- **Runtime health != historical evidence:** cooldown/visited state is task-runtime-private;
  persisted facts describe settled outcomes and cannot authorize later eligibility or replay.
- **Route selection != credential ownership:** choosing eligibility does not
  authorize credential storage, activation internals, or provider-account mutation.
- **Completion readiness != Advisor semantic judgment:** independent inputs to
  the single completion authority, neither a replacement for the other.
- **Durable evidence != runtime observation:** an event/claim/diagnostic becomes
  authoritative only through the owning validation and persistence contract.

Evidence: [policy](src/policy/model-policy.ts),
[recovery](src/recovery/runtime-recovery-executor.ts),
[readiness](src/completion/completion-readiness.ts),
[Advisor](src/adapters/pi-advisor-adapter.ts), and
[diagnostic sink](src/runtime/workflow-disk-sink.ts).

## Integration: upstream-first, not upstream-blind

**PRINCIPLE:** prefer an upstream-supported capability to local duplication,
but upstream existence is neither necessary for every feature nor sufficient
for adoption. Use this sequence:

1. Identify the current owner of the decision, capability, and resource.
2. If another component owns the capability, inspect its **supported seam**.
3. Verify authority, lifecycle, privacy, and failure semantics against the
   observed requirement. If adequate, consume it; do not add a parallel authority.
4. If inadequate, record the concrete missing requirement and evidence. Prefer
   a narrow upstream dependency/request when it belongs to that owner.
5. If no adequate owner/seam exists, prove Wayforge owns the missing responsibility
   before adding only the smallest justified mechanism. Otherwise remain out of scope.

A supported startup extension boundary, for example, is not automatically proof
of a fail-closed **pre-invocation admission** guarantee. Verify ordering and failure
propagation rather than assuming equivalence. This rule is dependency-neutral.

Account recovery/shared health remains a later review: identify what Wayforge
may decide or observe versus what the account integration owns. No cross-session
health-sharing authority, account registry, activation policy, or child-admission
implementation is created by this freeze.

## Evidence-driven evolution

**PRINCIPLE:** choose the smallest mechanism satisfying an observed requirement;
do not generalize from one integration need. Generic middleware, DAGs, event
sourcing, distributed scheduling, account registries, parallel authorities, and
new persistent state machines require evidence, not anticipation.

Historical rejection of DAG semantics for completion or event sourcing for
resume is contextual evidence, not permanent prohibition. Review future
requirements deliberately; do not infer an accepted STOP decision from missing
history or session recollection.

Deterministic tests establish correctness boundaries. Controlled dogfood
establishes operational usefulness. **Neither substitutes for the other.**
A failed real workflow is evidence to preserve, not a pass to manufacture by
manual durable edits or an unauthorized alternate path. Observed workflow
failures outrank speculative convenience architecture.

Evidence: [Alpha 0](docs/alpha-0-assisted-dogfood.md),
[Alpha 1](docs/alpha-1-durable-resume.md),
[U1 operational record](CONTRIBUTING.md#known-friction-and-u1-evidence).

## Deliberate contract reopening

A frozen contract may be reopened with explicit evidence: contradiction,
real workflow impossibility, safety/authority defect, upstream incompatibility
that cannot be adapted safely, or repeated operational evidence that the
contract is wrong. Easier implementation, a different dependency API, or
one-off inconvenience is not enough.

A reopening proposal must identify the old guarantee, affected consumers,
evidence, proposed replacement semantics, privacy/durable/recovery consequences,
migration where needed, and deterministic plus operational acceptance criteria.
Record explicit approval before implementation, update affected tests/gates/docs,
and name the new freeze boundary. Until approved, the existing contract remains
in force. Principles may likewise evolve by documented decision; current
implementations and U1 protocols may evolve without falsely changing contracts.
