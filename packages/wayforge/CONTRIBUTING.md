# Contributing to Wayforge

**Normative review gates — HANDOFF 38164.** Read the
[Design Constitution](DESIGN.md) first. These are human review gates, not GitHub
automation. Tests being green does not authorize violating ownership boundaries.
The U1 operating protocol and friction below are explicitly current, evolvable
operations, not timeless constitutional implementation requirements.

## Feature issue gate

For a feature or architecture expansion, answer proportionately:

1. Why does this belong in Wayforge?
2. Who owns the capability today? Separate decision, capability, resource, and consumption.
3. Does an existing supported mechanism satisfy the requirement?
4. What concrete observed requirement is missing? Link reproducible evidence.
5. Would this introduce a second authority? Identify how overlap is avoided.
6. Does it change a frozen contract? If so, request explicit reopening first.
7. Does it change durable state/schema or require migration?
8. Does it change privacy exposure, including inspection/logging?
9. Does it change recovery semantics, restart, ambiguity, or side-effect handling?
10. What is the smallest mechanism satisfying the requirement?

### Bug/defect path

Do not require ten speculative architecture answers for an obvious defect.
Identify the **existing documented contract violated**, reproduction, expected
versus actual behavior, affected owner, and a regression check. A correction
that preserves the contract is a defect fix; a proposed different contract is
not. If the reproduction exposes a frozen contract itself as wrong, use the
[explicit reopening process](DESIGN.md#deliberate-contract-reopening).

## PR review gate

Declare each impact as **none**, **preserved**, or **changed**, with evidence
where material; an unsupported "none" is not sufficient:

| Impact | Reviewer asks |
| --- | --- |
| Ownership | Who owns the new decision/capability/resource? Is an existing seam adequate? |
| Authority | Any parallel source of truth, bypass, fencing change, or new mutation privilege? |
| Frozen contract | Which guarantee changes? Where is reopening approval? |
| Durable state/schema | New fields, bounds, versions, migrations, corruption/restart behavior? |
| Privacy | What can be persisted or displayed? What is structurally omitted/sanitized? |
| Recovery | Planning versus execution, retry/launch ambiguity, interruption and restart? |
| Provider/model | Any role/model binding, transport coupling, or credential ownership expansion? |
| Workspace | Which files/write set are owned? Any external coordination, destructive Git action, or drift behavior? |
| Validation | Exact commands/results; tests exercise changed contracts, not just unrelated hygiene. |
| Dogfood | When operational semantics change, what controlled real-workflow evidence exists? If absent, do not claim operational acceptance. |

Documentation-only changes require local link/path checks and appropriate
architecture/workspace checks. Before freezing governance, verify the complete
current tree: tests, typecheck, build, architecture and workspace gates. A green
suite alone cannot certify new runtime use or justify architecture expansion.

Use the commands in [README](README.md#commands). From `packages/wayforge`,
run `npm test`, `npm run typecheck`, `npm run build`,
`npm run check:architecture`, `npm run check:alpha0`, and
`npm run check:alpha1`; from repository root run
`node tooling/check-workspace.mjs`. Alpha 1 currently requires the package cwd.
Do not alter runtime to conceal unrelated validation failure: stop and report.

## Decision vocabulary

| Decision | Action |
| --- | --- |
| **IN SCOPE** | Ownership and evidence established; evaluate the smallest implementation. |
| **OUT OF SCOPE** | Wayforge does not own the responsibility; redirect rather than absorb it. |
| **USE EXISTING MECHANISM** | An adequate supported owner/seam exists; consume it without duplication. |
| **UPSTREAM DEPENDENCY** | Missing semantics belong to an upstream owner; record the exact gap and required acceptance. |
| **EVIDENCE REQUIRED** | Scope or mechanism is not justified; obtain a reproduction/measurement before expansion. |
| **CONTRACT CHANGE REQUIRED** | The proposal changes a frozen guarantee; reopen explicitly before implementation. |
| **EXPERIMENTAL** | A bounded, isolated hypothesis with owner, evidence target, and exit criteria; not production acceptance. |

These are decision outcomes, not mandatory bureaucracy or stages every issue
must traverse. An outcome can name a prerequisite without hiding the final scope decision.

## Current U1 operational protocol

**CURRENT U1 OPERATIONAL PROTOCOL**, not a promise of U2 daily-driver support:

- Use the isolated [development profile](README.md#isolated-pi-development).
  Provision authentication inside it; do not copy credentials into evidence.
- Retain session lifetime through interactive/TUI use or an RPC session with
  explicit lifecycle control. RPC was exercised in accepted U1 dogfood;
  TUI is the supported persistent interactive path.
- **One-shot print mode (`pi -p`) is not currently a supported governed entrypoint.**
  This is a lifecycle limitation today, not a permanent architectural prohibition.
- Treat the governed workspace as an authority boundary. Do not concurrently
  mutate its tracked files as an operator/external actor unless the workflow
  explicitly owns and accounts for that coordination. Do not silently revert
  another actor's changes to "clean" a candidate. Stop and report unexpected
  overlap. This protocol does not claim automatic workspace fencing or require
  global machine-level locking; future fencing needs separate evidence/review.
- Enter through `/wayforge <objective>`, perform the scoped work, run relevant
  checks, and record actual results through `wayforge_record_validation`.
  After any workspace edits, rerun affected checks and record fresh evidence
  before completion; do not manufacture passing records.
- Request completion through `wayforge_complete`. Authoritative Advisor review
  occurs there, not through repeated manual `wayforge_advise` attempts.
- Treat authoritative `advisor_changes_requested` as terminal for **that task's
  completion review**. Do not reinterpret it as retryable or try to reset the
  claim. End/cancel the old task through supported lifecycle handling, apply
  required corrections with explicit ownership, and admit the corrected
  workspace through a **new governed task/candidate lifecycle**. Revalidate
  within that lifecycle. `completion_review_spent` is not an escape hatch.
- Keep the process alive with sufficient budget until the workflow settles.
  An interrupted `running` task may be reconciled to `blocked` on startup;
  inspection does not assert liveness. This is not transparent cross-session
  continuation of the same governed Main lifecycle.
- Never manually edit durable state to recover or complete a workflow.
- Use `wayforge_tasks` and `wayforge_task_status {taskId}` for sanitized,
  read-only history. Successful acceptance requires `completed` and
  `completion.authoritative: true`, not merely an approving runtime message.
- Completion does not imply a Git commit. Follow the authorized repository Git
  workflow; do not amend/rewrite/push history without explicit authorization.

## Governance case checks

These are documentation-level applications, not new integration implementations.

### A — pi-subagents admission

**Decision: inspect the supported seam first; USE EXISTING MECHANISM only if
it proves the required semantics. Otherwise UPSTREAM DEPENDENCY / EVIDENCE REQUIRED.**

A required-child-extension startup boundary is a candidate seam, not proof
that it provides fail-closed admission before invocation. Verify once-per-child
ordering, failure propagation, no provider call before acceptance, and lifecycle
coverage against the needed authority. Do not add a parallel preflight callback
merely for convenience. If the missing child-lifecycle guarantee belongs to
pi-subagents, request it upstream instead of absorbing lifecycle ownership.

Produced by: one-owner rule and the integration sequence in [DESIGN](DESIGN.md).
Current dependency is pinned at 0.70.0 ([manifest](package.json)); newer seam
availability and the prior #2707 discussion are not an implemented contract in
this repository. This freeze does not choose a dependency upgrade or settle 1B.4B.

### B — account credentials

**Decision: OUT OF SCOPE for persistence in Wayforge.** Recovery's need to choose
an account does not transfer credential-resource ownership. Consume a supported
activation/auth seam without persisting secrets. Produced by: the durable-state
boundary, route-selection/credential separation, and one-owner rule.

### C — shared account health

**Decision: EVIDENCE REQUIRED; ownership questions explicit, implementation deferred.**
Wayforge already owns execution health/route eligibility decisions locally.
A usage-limit observation may justify sanitized route-health evidence without
credential ownership, but does not prove authority to share it across sessions
or mutate provider account state. Identify provenance/confidence, scope/key
privacy, persistence owner, freshness/expiry, fencing, concurrent-writer behavior,
and who decides eligibility versus who stores/activates accounts. Which authority
may Sessions B/C rely on? What does the account integration alone own?

Produced by: decision/capability/resource/consumption distinction, durable-safe
rules, and integration qualification. This is a future review agenda, not approval
of a shared account registry or a new recovery state machine.

### D — arbitrary workflow DAGs

**Decision: EVIDENCE REQUIRED, not IN SCOPE merely because a future task might benefit.**
Provide an observed requirement, explain why existing sequencing is insufficient,
prove ownership, then compare the smallest mechanism. Historical completion
non-goals reject speculative DAG expansion for that problem, not all future DAGs.
Produced by: minimal mechanism, evidence before expansion, and deliberate evolution.

## Known friction and U1 evidence

This section is a non-normative operational record, not constitutional incident law.
Source: accepted U1 handoff **67231**, proposal commit
`b1b5b41664745c6984a06938d792a0cee6b938f3`, and operator-reported isolated runs.
Full isolated sessions/events are ignored local artifacts, not portable evidence
for arbitrary machines. Do not read/copy their auth or raw transcripts into issues.

Accepted final task **alpha0-10** reported Advisor `approve`; historical inspection
proved `status = completed`, `completion.authoritative = true`, `revision = 7`,
`unresolvedCount = 0`, and `nextAction = "no action required"`. This record preserves
that accepted result; documentation freeze does not claim a new provider run.

| Finding | Classification and current disposition |
| --- | --- |
| Print-mode process lifetime does not retain extension-triggered execution | **UX friction:** unsupported for governed U1; use persistent TUI/RPC. Not a permanent ban. |
| `turn_end could not resolve the persisted assistant entry ID` on aborted teardown | **Bug (observed, root cause unconfirmed):** candidate Pi boundary defect; requires independent reproduction/triage, not a claimed Wayforge fix. |
| RPC `follow_up` queued after settle without restarting work in the acceptance driver | **UX friction / harness behavior:** use explicit idle-aware lifecycle/prompt control; queue semantics need reproduction, not assumed universal behavior. |
| Negative authoritative Advisor findings unavailable through historical status projection | **UX friction:** history proves authority/status but does not yet expose these findings; do not infer them from status alone. |
| No automatic workspace fencing; concurrent operator edits contaminated a candidate | **UX friction:** enforce exclusive-workspace U1 protocol. Advisor correctly rejected scope creep; no fencing capability is claimed. |
| Alpha 1 gate resolves package-relative paths against cwd | **U2 limitation:** run it from `packages/wayforge`; portability improvement deferred. |
| No transparent cross-session governed Main resume | **Expected limitation:** retain process lifetime or start a new governed lifecycle; existing suspension/continuation machinery is not general Main-session resume. |
| One-shot review misunderstood as retryable after changes_requested | **UX friction:** protocol now states the frozen consequence clearly; the contract itself worked as designed. |

External OAuth expiry/revocation and insufficient driver time budgets are
environment/operator limitations, not proof of a runtime authority defect.
Workspace-bound `validation_stale` and lease-contention refusals are expected
fail-closed behavior; preserve their contracts rather than suppressing them.
