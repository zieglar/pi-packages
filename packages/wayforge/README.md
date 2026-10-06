# Wayforge

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
  └─ RuntimeRecoveryExecutor ─ executes coordinator decisions, bounded

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
| `npm run check:architecture` | Static ownership-boundary gates (9) |
| `npm run check:alpha0` | Assisted-dogfood preconditions gate |
| `npm run verify` | Architecture gates, tests, typecheck, build |
| `npm run verify:alpha0` | Full verify plus the Alpha 0 gate |
| `npm run pi:version` | Print the installed project-local Pi version |
| `scripts/pi1-dev.sh [args]` | Launch isolated project-local Pi |

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

**Advisor diagnostics** — `advisors_unavailable` / `no_advisor_route` mean no
eligible route for the advisor role; `advisor_not_triggered` means the request
did not satisfy the trigger policy (e.g. a `beforeDone: true` call before
completion is attempted); `invalid_advisor_verdict` means the model's response
did not parse against the strict verdict schema — resend with clearer
instructions. `completion_gate_failed` means a latest validation is failing or
no approving advisor verdict exists yet.

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

`npm run verify` runs the architecture checker (9 gates: single `setModel(`
callsite in the adapter; no `pi-ai` transport imports; Pi API imports confined
to the adapter, extension entry, and tool surface; no forbidden
lifecycle/fallback members in adapters or recovery; single `RecoveryCoordinator`,
`HealthRegistry`, and `HealthProjector` construction sites in the runtime
factory; live-Pi components constructed only in the extension entry; and
pi-subagents imports confined to the public `pi-subagents/delegation`
contract), the full test suite, typecheck, and build.

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

No autonomous restart or resume after host or Pi exits, no ambient account-plugin
adaptation (active `pi-multi-account`/`pi-shift-router`/`pi-advisor-flow`
sessions fail the ownership guard closed), no persistent workflow durability
beyond the in-process stores, no wake timers, leases, drift reconciliation,
databases, scheduling, distributed execution, UI, analytics, adaptive routing,
production migration, or Phase 1B.2 behavior. Production Pi configuration,
plugins, and `~/.pi` are untouched by this repository.
