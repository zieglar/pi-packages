# Wayforge Phase 1B.1 Runtime Workflow Design

**Status:** Approved 2026-10-04

## Goal

Phase 1B.1 turns the frozen Phase 1A kernel at `98c640ec3a4c5ac3ecb83458254984fcf3601dc7` into an assisted, in-process workflow for native Pi Main execution, bounded Worker delegation, Advisor review, centralized recovery, passive routing, structured observability, and one isolated self-dogfood run. It does not add restart-safe continuation or any Phase 1B.2 autonomous behavior.

## Architectural choice

Wayforge is a Pi extension around the native Main `AgentSession`; it does not create a replacement session host. The extension registers narrow commands/tools and observes Main lifecycle events. `WorkflowController` sequences existing owners but does not become another policy, model, recovery, or health owner.

```text
Pi Main AgentSession
        |
        v
Wayforge extension
  |- WorkflowController (sequencing only)
  |- MainModelController -> PiCompatibilityAdapter -> ExtensionAPI.setModel
  |- PiSubagentWorkerAdapter -> pi-subagents/delegation
  |- PiAdvisorAdapter -> NestedInvoker -> ModelRegistry.streamSimple
  |- RuntimeRecoveryExecutor -> RecoveryCoordinator
  |- PassiveAccountAdapter -> configured/registry routes
  `- HealthRegistry
```

One logical task may have at most one active Main invocation. Workers may run concurrently only within an explicit semaphore bound.

## Main path

Normal Pi execution remains native. `/wayforge <objective>` starts an in-process managed task and sends the objective to Main. A small tool surface supports task status, Worker delegation, Advisor review, explicit recovery, and assisted completion.

`before_agent_start` creates or updates the Main `InvocationContext`, enforces the one-active-Main rule, and injects only concise sanitized workflow state. The current Pi model is observed as the initial route. Wayforge does not rewrite it merely to take ownership. Any later parent model transition is applied only through `MainModelController`, whose only production port remains `PiCompatibilityAdapter`.

Workers and Advisors are conditional. The shortest workflow stays `Main -> validate -> complete`.

## Worker integration

`PiSubagentWorkerAdapter` uses the public `pi-subagents/delegation` event contract. It does not import executor internals or scrape tool output. The project pins `pi-subagents` and the isolated launcher explicitly loads that extension beside Wayforge.

Every worker request resolves before launch:

- role and configured agent (`worker`),
- provider/model and thinking level,
- parent/child invocation identity and depth,
- token/tool budget,
- timeout,
- current working directory,
- cancellation signal,
- result mode.

The adapter supports one Worker or bounded parallel Workers. It assigns a unique `(ownerRunId, nodeId, requestId)` tuple, correlates started/update/terminal events, emits the exact cancellation tuple, and disposes listeners. Parallel work uses a fixed concurrency limiter, not a general scheduler.

The terminal result is normalized into a Wayforge `WorkerOutcome`: invocation identity, role, selected and observed route/model, status, safe text/structured result, typed failure, usage, remaining budget, and redacted metadata. A selected-model mismatch fails closed. Worker prose is never interpreted as route, recovery, task-state, or completion authority.

Worker failure returns to `WorkflowController`. It does not automatically abort Main. Cancellation is terminal and never triggers fallback.

## Advisor path

`PiAdvisorAdapter` uses the Phase 1A `NestedInvoker`, so every Advisor model call traverses `ExtensionContext.modelRegistry.streamSimple` and therefore Pi `ModelRuntime`, registered provider composition, authentication, and transport. Advisor cannot receive parent mutation, abort, continuation, or retry capabilities.

Advisor input is a bounded redacted structured snapshot containing objective, completion criteria, implementation summary, changed-file/diff summary, validation results, unresolved failures, Worker findings, and workspace identity/digest. Credentials, raw provider bodies, transcripts, and hidden reasoning are excluded.

The Advisor returns one schema-validated verdict:

- `approve`,
- `changes_requested`,
- `unable`.

Findings are typed and bounded. Advisor prose cannot directly change task state.

Triggers:

1. manual request,
2. repeated bounded `reasoning` failures,
3. repeated bounded `validation` failures,
4. optional before-done review.

Infrastructure, quota, authentication, rate-limit, usage-limit, provider, network, context-overflow, capability, and cancellation failures never auto-trigger Advisor.

## Routes and passive account integration

Phase 1B adds an `ExecutionRoute` containing route id, provider, model, optional sanitized account reference, tier, thinking level, and capability facts. This is additive; it does not widen Phase 1A `ModelDecision`, `RouteRef`, or durable schemas.

`PassiveAccountAdapter` derives eligible routes from trusted Wayforge configuration and current ModelRegistry availability. It reports only sanitized account references and route observations. It never calls `setModel`, continues sessions, retries, or silently switches Main. Alpha 0 does not adapt the active `pi-multi-account` plugin because that plugin owns session/fallback behavior; integrating it would create competing ownership. Account rotation works when more than one explicitly configured sanitized account route exists and is covered with deterministic fakes in tests.

## Recovery runtime

`RuntimeRecoveryExecutor` owns execution of decisions, not decision policy. For each typed failure it:

1. records the failure,
2. asks the sole Phase 1A `RecoveryCoordinator`,
3. emits the decision and remaining budget,
4. consumes the appropriate retry/fallback counter,
5. updates health through the sole `HealthRegistry`,
6. performs at most the authorized next attempt.

Retry/fallback attempts are bounded and observable. Route-changing fallbacks create a new logical continuation invocation and preserve the failed invocation's provenance. There are no adapter-local loops.

Cancellation always stops. Ambiguous HTTP 429 remains `rate_limit` with ambiguous confidence and may affect only the exact route conservatively; it cannot create long-lived account/provider usage cooldown. Context overflow does not poison account or provider health. Exact authentication/usage facts may update the corresponding scoped health record.

## In-process state and observability

`WorkflowState` tracks task identity, objective, criteria, phase/status, current Main invocation, Worker outcomes, Advisor verdicts, recovery counters, recent failures, route history, unresolved items, and structured events.

An `InMemoryTaskStore` implements the Phase 1A `TaskStore` contract for the authoritative summary. Rich runtime details remain in sanitized in-memory state. State is lost when Pi exits; restart durability is explicitly not claimed.

Events are discriminated, monotonically sequenced, redacted records covering task/Main lifecycle, route resolution, Worker launch/result, Advisor trigger/verdict, failure classification, recovery decision/application, budget changes, cancellation, validation, and completion readiness. Each event includes parent/child identities and enough safe facts to explain the decision.

## Extension and ownership guard

The isolated launcher uses `.wayforge-dev` for agent/session state and explicitly loads only project-pinned `pi-subagents` and the Wayforge extension. It never edits global Pi configuration or plugins.

At startup Wayforge inspects canonical tool/command provenance. `pi-subagents` is allowed only as the Worker engine. Active sources matching `pi-shift-router`, `pi-multi-account`, or `pi-advisor-flow` fail closed with a clear ownership diagnostic. Legacy plugins are not uninstalled or modified.

Static gates retain and extend the Phase 1A checks:

- exactly one production `setModel(` callsite in `PiCompatibilityAdapter`,
- no direct `@earendil-works/pi-ai` transport import,
- Pi extension APIs only in approved compatibility/extension modules,
- one RecoveryCoordinator runtime construction path,
- one HealthRegistry runtime construction boundary,
- no lifecycle/fallback authority in Worker/Advisor/Account adapters.

## Phase 1A contract changes

No existing Phase 1A interface, failure taxonomy, model decision, route reference, durable schema, or ownership component needs to change. Phase 1B.1 introduces additive runtime types, adapters, stores, orchestration, and extension wiring. Existing tests remain regression gates.

If implementation proves this assumption false, work stops until the insufficiency, necessity, invariant preservation, and regression proof are documented.

## Test strategy

All production behavior follows test-first red/green/refactor cycles.

- Unit tests: workflow state, Main exclusivity, trigger policy, route selection, recovery accounting, health confidence, failure classification, event redaction.
- Worker integration: real public pi-subagents delegation event contract with deterministic event owner; explicit model match, timeout, cancellation, partial parallel failure, concurrency, depth, and budget.
- Advisor integration: real `ModelRuntime` with deterministic composed provider sentinel proving `NestedInvoker -> ModelRegistry -> provider composition`; structured verdict and redacted input.
- Extension integration: actual extension factory registration, native Main pass-through, ownership guard, command/tool contracts, cancellation.
- Architecture gates: all Phase 1A gates plus recovery/health/legacy-owner ownership.
- Launcher: clean isolated profile, pinned extensions, no production paths.

## Alpha 0 assisted dogfood

After clean install and all automated gates pass, the operator performs an isolated `/login` under `.wayforge-dev`; no credentials are committed or copied from production. Wayforge then performs one small reversible repository improvement with clear criteria, at least one Worker, before-done Advisor review, validation, and saved redacted evidence.

Evidence distinguishes automated, manually inspected, and inferred claims. Any discovered defect is fixed under tests and relevant gates rerun. Phase 1B.2 is not started.
