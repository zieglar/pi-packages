# Wayforge Phase 1A Kernel Design

## Goal

Establish the smallest deterministic Wayforge kernel that owns invocation, policy, model selection, nested Pi runtime use, recovery planning, health, durable-state contracts, integration boundaries, and safe trace data without implementing Phase 1B workflow behavior.

## Package shape

Wayforge is one TypeScript ESM package targeting Node 22+ and Pi 1.x. It contains an inert Pi extension entry point, domain modules under `src/`, Vitest tests, and an isolated development launcher that invokes a project-local Pi 1.x binary with project-local ignored configuration and session directories.

No monorepo or production Pi installation changes are needed.

## Architecture

```text
inert extension entry
  └─ PiCompatibilityAdapter
      ├─ MainModelController ── only production caller of pi.setModel()
      └─ PiNestedRuntime ────── ctx.modelRegistry.streamSimple()

InvocationContext
  ├─ RolePolicy ──> ExecutionRequirement
  └─ ModelPolicy ─> ModelDecision
                         │
        main ────────────┴─> MainModelController
        nested ─────────────> NestedInvoker ─> PiNestedRuntime

typed failure ─> RecoveryCoordinator (pure) ─> RecoveryDecision
route health ──> HealthRegistry (single cooldown boundary)
durable/adapters ─> interfaces only
```

## Ownership boundaries

- `MainModelController` is the sole Wayforge component authorized to request a parent session model change.
- The concrete Pi compatibility adapter contains the sole production `setModel(` callsite.
- `RecoveryCoordinator` is the sole retry/fallback planner and remains pure.
- `HealthRegistry` is the single owner of sanitized route cooldown and availability state.
- `NestedInvoker` performs one invocation attempt through a Pi runtime port and never retries.
- Account, worker, advisor, and continuation adapters receive narrow Wayforge types and cannot access parent session mutation APIs.

## Invocation and capability model

`InvocationContext` has branded invocation/task identifiers, role, parent ID, depth and maximum depth, immutable remaining/shared budget, linked cancellation, a policy reference, and persist-safe trace metadata.

Child derivation increments depth, fails closed beyond the maximum, cannot increase budget, and links cancellation from parent to child. A child may receive a smaller explicit budget but never a larger one.

A static `CapabilityCatalog` describes tools, streaming, reasoning, provider/model restrictions, nested invocation permission, worker eligibility, and advisor eligibility. Role and model policies consume capabilities but do not call providers.

## Policy

`RolePolicy` resolves a role and task metadata into an `ExecutionRequirement`. `ModelPolicy` resolves that requirement against static configured routes and capability facts into a `ModelDecision` containing model, provider, tier, thinking level, and budget. Role and model remain separate types.

For a main invocation, `MainModelController` validates the role before applying an already-resolved decision. For nested work, `NestedInvoker` derives the child context, resolves requirements, and calls a single runtime boundary.

## Pi compatibility

The development dependency is pinned to `@earendil-works/pi-coding-agent@1.0.2`. A `PiCompatibilityAdapter` is the only module aware of Pi extension APIs:

- parent mutation delegates to `ExtensionAPI.setModel()`;
- nested model calls delegate to `ExtensionContext.modelRegistry.streamSimple()`;
- model lookup delegates to the same parent model registry.

No low-level `pi-ai/compat` stream function is imported. A sentinel provider/runtime test observes the composed model-registry path.

The extension entry point is intentionally inert: it captures/wires supported ports but registers no workflow command, retries, continuation, worker, or advisor behavior.

## Typed outcomes and recovery

`ExecutionResult<T>` is a success/failure discriminated union. Failures carry kind, scope, confidence, sanitized code/message, optional retry/reset times, and safe metadata.

Normalization is conservative. Authentication, cancellation, context overflow, rate limiting, usage exhaustion, provider/network, validation, reasoning, tool, and capability failures remain distinct. An unqualified HTTP 429 is `rate_limit` with ambiguous confidence, never automatically `usage_limit`.

`RecoveryCoordinator` receives the current route, alternatives, remaining retry/fallback budget, sanitized health, and constraints. Its deterministic precedence is:

1. cancellation stops;
2. exhausted budget blocks/stops;
3. exact temporary current-route failures can retry within bounds;
4. scoped account failures may rotate account;
5. model-scoped failures may fallback model;
6. provider-scoped failures may fallback provider;
7. reset-bearing limits may suspend;
8. otherwise block or stop.

Infrastructure failures never request Advisor semantics.

## Health

`HealthRegistry` exposes sanitized route/account/provider/model health and centralized cooldown ownership. The Phase 1A implementation is in-memory and deterministic. Credentials and raw provider responses never enter health records.

## Durable-lite contracts

`DurableTaskState` is a versioned authoritative schema containing task ID, revision, status, objective, completion criteria, policy versions, checkpoint, recovery counters, suspension metadata, completion evidence, and timestamps.

Ephemeral session state is a separate non-serializable type for abort signals, runtime objects, streams, and handles. Serialization is deterministic and validates schema version and forbidden secret-bearing keys. The schema excludes credentials, API keys, cookies, authorization headers, raw provider responses, hidden reasoning, transcripts, raw reconstruction prompts, runtime/model objects, live streams, and worker handles.

Interfaces cover task storage, checkpoint persistence, leases, suspension, continuation, drift validation, and completion evidence only; no wake/resume engine is implemented.

## External adapters

- `AccountAdapter` enumerates sanitized eligible routes and reports typed outcomes.
- `WorkerAdapter` accepts a fully resolved launch request with role, provider/model, thinking, and budget.
- `AdvisorAdapter` accepts observational input and returns a typed verdict.
- `ContinuationLauncher` accepts an authorized continuation request.

These interfaces expose no parent `setModel`, parent abort, session continuation mutation, or hidden retry loop.

## Trace and redaction

Trace events are structured discriminated records for invocation, policy decisions, route selection, recovery decisions, suspension, and nesting. Trace metadata is allowlisted and redacted before emission.

Recursive redaction removes credential fields, API keys, bearer tokens, cookies, authorization headers, raw provider bodies, and unnecessary account identifiers while preserving safe diagnostic fields.

## Verification

Vitest covers invocation derivation, depth/budget/cancellation, policy/capability resolution, main-role guards, nested runtime sentinels, error normalization, recovery decisions, health cooldown ownership, durable round-trip/version/security boundaries, adapter contract shape, and trace redaction.

Static architecture gates scan production source to prove:

- one `setModel(` callsite exists and is located only in the Pi compatibility adapter;
- no direct low-level compatibility transport import exists;
- no adapter or recovery component independently owns continuation or fallback loops.

## Scope

Phase 1A implements contracts, pure policies, a minimal Pi runtime bridge, and tests only. It does not implement real account rotation, worker/advisor plugins, autonomous continuation, wake timers, startup scanning, leases, drift reconciliation, completion authority, databases, scheduling, distributed execution, UI, analytics, adaptive routing, production migration, or Phase 1B workflow behavior.
