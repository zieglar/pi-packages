# Wayforge

Deterministic agent-orchestration kernel. This repository currently contains
the **Phase 1A kernel**: invocation and capability contracts, pure role/model
policies, typed failures and recovery planning, health cooldown ownership,
versioned durable-state contracts, narrow external-adapter contracts, and one
Pi 1.x compatibility boundary — with no Phase 1B workflow behavior.

## Ownership boundaries

- `MainModelController` is the **sole** Wayforge component authorized to
  request a parent-session model change, and only for the `main` role.
- The concrete Pi compatibility adapter (`src/runtime/pi-compatibility-adapter.ts`)
  contains the **only production `setModel(` callsite** and is the only module
  (with the inert extension entry) that imports Pi extension APIs.
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
inert extension entry (src/extension.ts)
  └─ PiCompatibilityAdapter ── pi.setModel / modelRegistry.streamSimple
      ├─ MainModelController ── validates role, applies resolved decision
      └─ NestedInvoker ──────── derives child, resolves policy, one attempt

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
| `npm run check:architecture` | Static ownership-boundary gates |
| `npm run verify` | Architecture gates, tests, typecheck, build |
| `npm run pi:version` | Print the installed project-local Pi version |
| `scripts/pi1-dev.sh [args]` | Launch isolated project-local Pi |

## Verification

`npm run verify` runs the architecture checker (4 gates: single `setModel(`
callsite in the adapter; no `pi-ai` transport imports; Pi API imports confined
to the adapter and extension entry; no forbidden lifecycle/fallback members in
adapters or recovery), the full test suite, typecheck, and build.

Tests cover invocation derivation (depth/budget/cancellation), capability and
policy resolution, failure normalization (including conservative ambiguous
429 handling), recursive trace redaction, main-role model ownership, nested
runtime single-attempt behavior, recovery precedence, health cooldown
ownership, durable-state round-trips with version/allowlist enforcement,
adapter contract shapes, and the architecture gates themselves.

## Out of scope (Phase 1A)

No real account rotation, worker/advisor plugins, autonomous continuation,
wake timers, startup scanning, leases, drift reconciliation, completion
authority, databases, scheduling, distributed execution, UI, analytics,
adaptive routing, production migration, or any Phase 1B workflow behavior.
Production Pi configuration, plugins, and `~/.pi` are untouched by this
repository.
