# Wayforge Phase 1A Kernel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and verify the smallest Phase 1A Wayforge kernel while preserving its ownership boundaries and leaving production Pi untouched.

**Architecture:** Use one TypeScript ESM package with pure domain policies and planners, narrow side-effect ports, one Pi 1.x compatibility module, and an inert extension factory. Develop test-first with Vitest and enforce architecture rules with executable source scans.

**Tech Stack:** Node.js 22+, npm, TypeScript 5.x, Vitest 4.x, TypeBox 1.x, project-local `@earendil-works/pi-coding-agent@1.0.2`.

---

### Task 1: Bootstrap repository and isolated Pi 1.x profile

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `scripts/pi1-dev.sh`
- Create: `src/index.ts`

**Step 1: Define the package and scripts**

Add scripts for `test`, `test:watch`, `typecheck`, `build`, `check:architecture`, `verify`, and `pi:version`. Pin Pi 1.0.2 and Vitest; use npm lockfile version 3.

**Step 2: Create an isolated launcher**

`scripts/pi1-dev.sh` must resolve the repository root, set `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` below ignored `.wayforge-dev/`, set `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1`, and execute `node_modules/.bin/pi`. It must not read or write production `~/.pi` configuration.

**Step 3: Install without lifecycle scripts**

Run: `npm install --ignore-scripts`

Expected: lockfile created; local Pi is exactly 1.0.2.

**Step 4: Verify isolated Pi**

Run: `npm run pi:version`

Expected: `1.0.2`.

### Task 2: Implement foundational types, invocation context, capabilities, and policies using TDD

**Files:**
- Create: `src/types/identity.ts`
- Create: `src/types/execution.ts`
- Create: `src/kernel/invocation-context.ts`
- Create: `src/kernel/capability-catalog.ts`
- Create: `src/policy/role-policy.ts`
- Create: `src/policy/model-policy.ts`
- Test: `test/invocation-context.test.ts`
- Test: `test/policy.test.ts`

**Step 1: Write failing invocation tests**

Cover parent/child derivation, monotonic depth, max-depth fail-closed behavior, child budget clamping/rejection, shared consumed budget visibility, and downward cancellation propagation.

Run: `npm test -- test/invocation-context.test.ts`

Expected: FAIL because production modules do not exist.

**Step 2: Implement minimal invocation types and derivation**

Use explicit immutable types and an internal linked `AbortController`. Never store the signal in persist-safe trace metadata.

**Step 3: Run invocation tests**

Expected: PASS.

**Step 4: Write failing policy tests**

Cover separate role/model resolution, static capabilities, model/tier/thinking output, provider/model restrictions, worker/advisor eligibility, nested permission, and capability mismatch.

Run: `npm test -- test/policy.test.ts`

Expected: FAIL for missing policy modules.

**Step 5: Implement minimal catalog and pure policies**

No provider calls, retries, session mutation, or adaptive routing.

**Step 6: Run policy tests and typecheck**

Run: `npm test -- test/invocation-context.test.ts test/policy.test.ts && npm run typecheck`

Expected: PASS.

### Task 3: Implement typed results, trace/redaction, and runtime ownership using TDD

**Files:**
- Create: `src/types/result.ts`
- Create: `src/trace/redaction.ts`
- Create: `src/trace/trace.ts`
- Create: `src/runtime/ports.ts`
- Create: `src/runtime/main-model-controller.ts`
- Create: `src/runtime/nested-invoker.ts`
- Create: `src/runtime/pi-compatibility-adapter.ts`
- Create: `src/extension.ts`
- Test: `test/failure-normalization.test.ts`
- Test: `test/redaction.test.ts`
- Test: `test/main-model-ownership.test.ts`
- Test: `test/nested-runtime.test.ts`

**Step 1: Write failing result and redaction tests**

Cover the complete failure taxonomy, distinct auth/context/cancel outcomes, conservative ambiguous 429 handling, credential/header/cookie/raw-body redaction, and retention of allowlisted diagnostics.

Run: `npm test -- test/failure-normalization.test.ts test/redaction.test.ts`

Expected: FAIL.

**Step 2: Implement typed outcomes and recursive redaction**

Use discriminated unions. Normalize unknown errors without persisting raw error objects or bodies.

**Step 3: Write failing ownership/runtime tests**

Cover non-main model mutation rejection, typed model-change result, nested child derivation and one runtime attempt, cancellation, composed-provider sentinel observation, no retry, and sanitized trace events.

**Step 4: Implement runtime ports and components**

`MainModelController` accepts only a `MainSessionModelPort`. `NestedInvoker` accepts policies and a `NestedModelRuntimePort`. The Pi adapter alone imports Pi types, performs `pi.setModel()`, and calls `ctx.modelRegistry.streamSimple()`.

**Step 5: Add inert extension factory**

The factory may wire ports but must register no workflow behavior.

**Step 6: Run focused tests and typecheck**

Run: `npm test -- test/failure-normalization.test.ts test/redaction.test.ts test/main-model-ownership.test.ts test/nested-runtime.test.ts && npm run typecheck`

Expected: PASS.

### Task 4: Implement recovery and health using TDD

**Files:**
- Create: `src/recovery/recovery-coordinator.ts`
- Create: `src/recovery/health-registry.ts`
- Test: `test/recovery-coordinator.test.ts`
- Test: `test/health-registry.test.ts`

**Step 1: Write failing planner tests**

Cover bounded retry, account rotation, model fallback, provider fallback, suspension, budget exhaustion, cancellation stop, and proof that infrastructure failures never emit advisor semantics.

**Step 2: Implement a deterministic pure planner**

Use explicit precedence and counters. Return decisions only; perform no transition.

**Step 3: Write failing health tests**

Cover sanitized records, centralized cooldown, expiration, and route/account/provider/model lookup.

**Step 4: Implement in-memory registry**

Reject secret-bearing metadata and raw provider bodies.

**Step 5: Run focused tests**

Run: `npm test -- test/recovery-coordinator.test.ts test/health-registry.test.ts`

Expected: PASS.

### Task 5: Implement durable-lite and external adapter contracts using TDD

**Files:**
- Create: `src/durable/state.ts`
- Create: `src/durable/contracts.ts`
- Create: `src/adapters/contracts.ts`
- Test: `test/durable-state.test.ts`
- Test: `test/adapter-contracts.test.ts`

**Step 1: Write failing durable tests**

Cover deterministic schema round-trip, supported/current version, unsupported version rejection, explicit authoritative/ephemeral separation, and forbidden secret/runtime fields.

**Step 2: Implement state schema and serializers**

Keep authoritative state JSON-only. Use exact field allowlists and stable ordering.

**Step 3: Write failing adapter shape tests**

Compile and runtime-shape test account, worker, advisor, and continuation ports. Prove worker launch requires resolved role/model/provider/thinking/budget and advisor output is a typed verdict.

**Step 4: Implement narrow interfaces**

No third-party plugin types and no session-model, abort, continuation-lifecycle, or retry-loop authority.

**Step 5: Run focused tests and typecheck**

Run: `npm test -- test/durable-state.test.ts test/adapter-contracts.test.ts && npm run typecheck`

Expected: PASS.

### Task 6: Add architecture gates, documentation, and final verification

**Files:**
- Create: `scripts/check-architecture.mjs`
- Create: `test/architecture-gates.test.ts`
- Create: `README.md`
- Modify: `src/index.ts`

**Step 1: Write the failing architecture gate test**

The gate must scan production source and assert exactly one `.setModel(` or `setModel(` invocation, located in `src/runtime/pi-compatibility-adapter.ts`; reject low-level compatibility streaming imports; reject forbidden lifecycle/fallback methods in adapter contracts.

**Step 2: Implement the architecture checker**

Emit actionable file/line failures and a sentinel summary.

**Step 3: Document boundaries and isolated development**

README must explain ownership, dependency/control flow, safe Pi launcher, tests, out-of-scope work, and production safety.

**Step 4: Export public contracts**

Export only intended Wayforge domain types and constructors from `src/index.ts`.

**Step 5: Run complete verification**

Run: `npm run verify`

Expected: architecture gate, all tests, typecheck, and build pass with clean output.

Run: `npm audit --omit=dev`

Expected: report captured; any advisory is assessed without making unrequested dependency changes.

Run: `git diff --check`

Expected: PASS.

**Step 6: Review scope and safety**

Confirm no Phase 1B behavior, credentials, production Pi paths, existing plugin paths, unpublished Pi APIs, or direct transport calls were introduced.

**Step 7: Create the requested single commit**

Run: `git add . && git commit -m "Phase 1A: establish Wayforge kernel"`

Expected: one root commit on `phase-1a-kernel`.
