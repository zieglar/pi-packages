# Wayforge

Wayforge is a **durable, policy-driven execution orchestration layer for Pi**.
**Pi-first, agent-portable.** Pi is the current supported host.

## Project governance

The normative [Design Constitution](DESIGN.md) defines identity, ownership,
authority/privacy boundaries, and deliberate contract reopening.
[Contributing](CONTRIBUTING.md) defines issue/PR gates, the
[current U1 operating protocol](CONTRIBUTING.md#current-u1-operational-protocol),
and [known friction](CONTRIBUTING.md#known-friction-and-u1-evidence).
The [Constitution proposal](docs/design-constitution-proposal.md) is historical
and non-normative. Controlled real-project dogfood is accepted; U2 daily-driver
support and account recovery are not implied.

## Historical foundation

Deterministic agent-orchestration kernel. Phase 1A established the kernel:
invocation and capability contracts, pure role/model policies, typed failures and
recovery planning, health cooldown ownership, versioned durable-state contracts,
narrow external-adapter contracts, and one Pi 1.x compatibility boundary.
Phase 1B.1 adds the **runtime workflow** on top of it: an assisted, in-process
Alpha 0 workflow in which native Pi Main runs work, delegates bounded Workers
through the public pi-subagents delegation contract, receives runtime-composed
Advisor review, and recovers through the centralized Phase 1A owners. See
[docs/alpha-0-assisted-dogfood.md](docs/alpha-0-assisted-dogfood.md).

## Ownership boundaries

- `MainModelController` is the **sole** Wayforge component authorized to
  request a parent-session model change, and only for the `main` role.
- The concrete Pi compatibility adapter (`src/runtime/pi-compatibility-adapter.ts`)
  contains the **only production `setModel(` callsite**; Pi extension APIs are
  imported only there, in the extension entry, and in the extension tool surface.
- Nested model calls go through `ExtensionContext.modelRegistry.streamSimple()`;
  no low-level `@earendil-works/pi-ai` transport is imported anywhere.
- `NestedInvoker` performs **exactly one** runtime attempt and never retries.
- `RecoveryCoordinator` is the sole retry/fallback planner and is pure: it
  returns decisions, never transitions.
- `HealthRegistry` is the **single cooldown boundary** for
  route/account/provider/model availability.
- Account, worker, advisor, and continuation adapters receive narrow
  Wayforge types with no parent mutation, abort, continuation, or retry
  authority.

## Dependency and control flow

```text
extension entry (src/extension.ts, session-guarded)
  └─ PiCompatibilityAdapter ── pi.setModel / modelRegistry.streamSimple
      ├─ MainModelController ── validates role, applies resolved decision
      └─ NestedInvoker ──────── derives child, resolves policy, one attempt

workflow runtime factory (single composition root)
  ├─ WorkflowController ───── sequencing only: delegate / advise / validate / complete
  ├─ PiSubagentWorkerAdapter ─ pi-subagents/delegation event contract
  ├─ PiAdvisorAdapter ─────── NestedInvoker + strict verdict schema
  ├─ PassiveAccountAdapter ── read-only eligible routes
  └─ RuntimeRecoveryExecutor ─ owns bounded executor API; live path uses plan only

InvocationContext ── RolePolicy ──> ExecutionRequirement
                                    ModelPolicy ──> ModelDecision
typed Failure ──> RecoveryCoordinator (pure) ──> RecoveryDecision
route health ──> HealthRegistry (single cooldown boundary)
durable state ──> versioned authoritative schema (TypeBox, exact allowlist)
adapters ──> narrow interfaces only
```

## Isolated Pi development

The development dependency is pinned to `@earendil-works/pi-coding-agent@1.0.2`
(exact) and `@sinclair/typebox@0.34.52` (exact). The plan named
"TypeBox 1.x", but no 1.x release exists; the closest available release is
therefore pinned exactly. Both `npm run pi:version` and
`scripts/pi1-dev.sh --version` report the isolated package version `1.0.2`.

The repository-local `.npmrc` sets `min-release-age=0` because the pinned Pi
1.0.2 was published the same day this repository was bootstrapped and the
user's global npm configuration enforces a 7-day minimum. The override is
project-local only; global npm configuration and production `~/.pi` are never
touched.

`scripts/pi1-dev.sh` launches the project-local Pi binary with:

- `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` under the
  git-ignored `.wayforge-dev/` directory,
- `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`,
- no reads or writes of the production `~/.pi` configuration.

## Commands

| Command | Purpose |
| --- | --- |
| `npm test` | Run the full Vitest suite |
| `npm run test:watch` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` over `src` and `test` |
| `npm run build` | Emit `dist/` from `src` |
| `npm run check:architecture` | Static ownership-boundary gates (21) |
| `npm run check:alpha1` | Durable restart / drift evidence gate (package cwd) |
| `npm run check:alpha0` | Assisted-dogfood preconditions gate |
| `npm run verify` | Architecture gates, tests, typecheck, build |
| `npm run verify:alpha0` | Full verify plus the Alpha 0 gate |
| `npm run pi:version` | Print the installed project-local Pi version |
| `scripts/pi1-dev.sh [args]` | Launch isolated project-local Pi |

## Entry and Default Governed Mode (U2.1)

`/wayforge <objective>` remains the explicit governed entry. U2.1 adds a
session-scoped Default Governed Mode over the same entry path — never a second
governance mechanism:

| Surface | Meaning |
| --- | --- |
| `pi` | ordinary Pi; Default Governed Mode is OFF |
| `pi --wayforge` | the session starts with Default Governed Mode ON (native extension flag) |
| `/wayforge on` / `/wayforge off` | toggle session mode; never persisted across sessions |
| `/wayforge` or `/wayforge status` | bounded status: mode, active governed task, durable authority |
| `/wayforge <objective>` | explicit governed task (the words `on`, `off`, and `status` are reserved as exact single-word objectives) |

With mode ON, an eligible top-level operator turn enters the existing
governed-entry path (`startWorkflow` → the existing WorkflowController,
validation, Advisor, and Completion Authority). Routing authority is explicit
session mode plus structured input-source provenance — never prompt-content
classification. Wayforge's own injected messages (source `extension`) bypass
routing, so entry is exactly once and never recursive.

Slash command/skill/template syntax stays Pi-owned. Images and queued steer/follow-up
delivery are preserved. New/resumed/forked sessions and reloads start OFF; the
original launch flag is not replayed into those unrelated extension instances.
Behavioral guarantees:

- **Fail-closed**: if governed entry fails (ownership guard, durable authority
  unavailable, admission or workflow failure, unexpected internal error), the
  original prompt is consumed with a visible typed failure — it never falls
  through to ordinary ungoverned execution.
- **Mode is not task state**: `/wayforge off` (decision O0) only changes
  routing for future turns; an active governed task is untouched.
- **Terminal tasks release entry**: after `completed`/`cancelled`/`blocked`,
  or after this session receives an authoritative `changes_requested`
  completion refusal, the next eligible turn starts a NEW governed task and
  candidate lifecycle. Historical negative-review evidence never authorizes
  routing; the old task's one-shot review is never reset or re-reviewed
  (see [DESIGN.md](DESIGN.md)).
- **Print mode**: `pi --wayforge --print …` is rejected with a visible notice;
  Default Governed Mode stays OFF (one-shot print lifetime cannot host
  governed completion).

## Alpha 0 troubleshooting

**“Wayforge is disabled: the ownership guard failed closed.”** — On session
start the fail-closed guard found a competing owner of reserved capabilities.
Each failure line names the offending tool/command, the competing package
(`pi-multi-account`, `pi-shift-router`, or `pi-advisor-flow`), and its
provenance. A reserved `wayforge_*` tool or `/wayforge` command registered by a
foreign source means a duplicate registration. Wayforge never uninstalls or
mutates other extensions: disable the competing extension, or remove the
duplicate registration, and restart the isolated session
(`scripts/pi1-dev.sh`).

**Worker diagnostics** — `wayforge_delegate_workers` returns an explicit,
bounded failure instead of retrying: `workers_unavailable` / `no_worker_route`
(no eligible role-scoped route for the worker role), `worker_limit_exceeded`
(1–4 workers per call; `worker_limit_exceeded` fires past the configured
`maxWorkers`, default 4), `worker_invalid_request`, `worker_timed_out`,
`worker_token_budget_exceeded`, and `worker_model_mismatch` (terminal Worker
evidence did not match the selected route — fails closed; retry with an
explicit delegation). Other terminal Worker statuses surface as derived
`worker_<status>` codes, e.g. `worker_failed`, `worker_tool_budget_exhausted`,
`worker_structured_output_failed`, `worker_acceptance_failed`,
`worker_cancelled`, and `worker_interrupted`.

**Advisor diagnostics** — In governed tasks `wayforge_advise` returns
`advisor_reserved_for_completion` without a provider call. Record passing
workspace-bound validation and use `wayforge_complete` for the authoritative
review. `advisors_unavailable` / `no_advisor_route` indicate missing capacity;
`invalid_advisor_verdict` indicates strict parsing failed. The authoritative
review is synchronously claimed once and never replenished:
`advisor_changes_requested` is terminal for this task's completion review,
and another attempt returns `completion_review_spent`. Corrected work must
enter a new governed task/candidate lifecycle; do not retry or manually reset
the claim. Standalone non-governed advice retains its separate trigger policy.
See [U1 protocol](CONTRIBUTING.md#current-u1-operational-protocol).

**General** — `wayforge_task_status` shows the sanitized snapshot (status,
children, budget, validations, verdicts) at any point; with a `taskId` it
inspects one historical durable task, and `wayforge_tasks` lists all of them
(newest activity first, read-only). `recovery_blocked` /
`recovery_suspended` mean the deterministic recovery budget is exhausted or a
reset-bearing limit fired; both are terminal for the task by design. If Pi
exits mid-task, the durable record stays `running`; the next session's
startup scan reconciles it to `blocked` (`interrupted_execution`) under a
fenced lease, and unresolved worker failures are bound durably so they
always block completion. There is still no resume: start a new task
deliberately.

## Verification

`npm run verify` runs the architecture checker (19 gates), the full test
suite, typecheck, and build. Gates enforce the single Pi compatibility/model
mutation boundary, narrow adapter imports, single composition owners, durable
completion writes/CAS, accounts protocol confinement, and reserved one-shot
Advisor dispatch/diagnostics. See [the checker](scripts/check-architecture.mjs)
for the executable inventory. When the local pnpm shim is unavailable, run
the equivalent npm commands individually as listed in CONTRIBUTING.md.

Tests cover invocation derivation (depth/budget/cancellation), capability and
policy resolution, failure normalization (including conservative ambiguous
429 handling), recursive trace redaction, main-role model ownership, nested
runtime single-attempt behavior, recovery precedence, health cooldown
ownership, durable-state round-trips with version/allowlist enforcement,
adapter contract shapes, and the architecture gates themselves.

Phase 1B.1 adds coverage for workflow state and event redaction, the in-memory
task store, passive route enumeration, scoped health projection, the public
delegation Worker adapter (model evidence, cancellation tuple, bounded
concurrency, token budget), advisor triggers/evidence/verdict parsing, a real
`ModelRuntime` composition sentinel, the bounded recovery executor, the
sequencing-only controller, the runtime factory, the fail-closed ownership
guard, the extension tool surface, and the Alpha 0 gate.

## Out of scope (Phase 1B.1)

This historical phase list is not the current feature inventory: later
phases added durable state, leases, drift checks, completion authority, and
startup reconciliation. Current boundaries are in [DESIGN.md](DESIGN.md);
supported U1 surfaces and limitations are in [CONTRIBUTING.md](CONTRIBUTING.md).

No autonomous restart or resume after host or Pi exits, no ambient account-plugin
adaptation (active `pi-multi-account`/`pi-shift-router`/`pi-advisor-flow`
sessions fail the ownership guard closed), no persistent workflow durability
beyond the in-process stores, no wake timers, leases, drift reconciliation,
databases, scheduling, distributed execution, UI, analytics, adaptive routing,
production migration, or Phase 1B.2 behavior. Production Pi configuration,
plugins, and `~/.pi` are untouched by this repository.
