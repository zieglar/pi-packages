import { describe, expect, it, vi } from "vitest";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import { HealthProjector } from "../src/recovery/health-projector.js";
import { RecoveryCoordinator } from "../src/recovery/recovery-coordinator.js";
import { RuntimeRecoveryExecutor } from "../src/recovery/runtime-recovery-executor.js";
import { WorkflowEventLog } from "../src/workflow/events.js";
import { invocationId, routeId, taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";
import type { Failure } from "../src/types/result.js";
import { failure, success } from "../src/types/result.js";

const route = (id: string, provider = "p", model = `m-${id}`): ExecutionRoute => ({
  routeId: routeId(id), provider, modelId: model, accountRef: `acct-${id}`,
  tier: "fast", thinking: "low", budgetLimit: 100,
  capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
});

const fail = (kind: Failure["kind"], extra: Partial<Failure> = {}): Failure => ({
  kind, scope: "invocation", confidence: "certain", code: kind, message: kind, ...extra,
});

function makeExecutor(now = () => 1_000) {
  const health = new HealthRegistry(now);
  const projector = new HealthProjector(health);
  const log = new WorkflowEventLog(now);
  const coordinator = new RecoveryCoordinator();
  const executor = new RuntimeRecoveryExecutor(coordinator, projector, health, log, {
    taskId: taskId("task-r"),
  });
  return { executor, health, log, coordinator, projector };
}

const budget = { retriesLeft: 1, fallbacksLeft: 2 };

describe("RuntimeRecoveryExecutor single step", () => {
  it("retries the same route once, consuming retry budget deterministically", () => {
    const { executor } = makeExecutor();
    const step = executor.plan({
      currentRoute: route("a"),
      alternatives: [route("b")],
      budget,
      failure: fail("network", { scope: "provider", confidence: "ambiguous", retryAfterMs: 50 }),
      failedInvocationId: invocationId("inv-1"),
    });
    expect(step.terminal).toBeUndefined();
    expect(step.next?.route.routeId).toBe("a");
    expect(step.next?.invocationId).toBe("inv-1#r1");
    expect(step.next?.parentInvocationId).toBe("inv-1");
    expect(step.budgetAfter).toEqual({ retriesLeft: 0, fallbacksLeft: 2 });
    expect(step.counters).toEqual({ retries: 1, fallbacks: 0, rotations: 0 });
  });

  it("rotates account with a new linked invocation and consumes fallback budget", () => {
    const { executor } = makeExecutor();
    const step = executor.plan({
      currentRoute: route("a", "p", "shared-model"),
      alternatives: [route("b", "p", "shared-model"), route("c", "q")],
      budget,
      failure: fail("authentication", { scope: "account" }),
      failedInvocationId: invocationId("inv-2"),
    });
    expect(step.next?.route.routeId).toBe("b");
    expect(step.next?.invocationId).toBe("inv-2#r1");
    expect(step.next?.parentInvocationId).toBe("inv-2");
    expect(step.budgetAfter).toEqual({ retriesLeft: 1, fallbacksLeft: 1 });
    expect(step.counters).toEqual({ retries: 0, fallbacks: 1, rotations: 1 });
  });

  it("falls back by model then provider within remaining budget", () => {
    const { executor } = makeExecutor();
    const modelStep = executor.plan({
      currentRoute: route("a", "p", "m-a"),
      alternatives: [route("b", "p", "m-b"), route("c", "q", "m-c")],
      budget,
      failure: fail("context_overflow", { scope: "model" }),
      failedInvocationId: invocationId("inv-3"),
    });
    expect(modelStep.next?.route.routeId).toBe("b");
    const providerStep = executor.plan({
      currentRoute: route("a", "p", "m-a"),
      alternatives: [route("b", "p", "m-b"), route("c", "q", "m-c")],
      budget: { retriesLeft: 0, fallbacksLeft: 1 },
      failure: fail("provider", { scope: "provider" }),
      failedInvocationId: invocationId("inv-4"),
    });
    expect(providerStep.next?.route.routeId).toBe("c");
  });

  it("stops on cancellation without consuming budget or writing health", () => {
    const { executor, health } = makeExecutor();
    const step = executor.plan({
      currentRoute: route("a"),
      alternatives: [route("b")],
      budget,
      failure: fail("cancellation"),
      failedInvocationId: invocationId("inv-5"),
    });
    expect(step.terminal).toEqual({ action: "stop", reason: expect.any(String) });
    expect(step.budgetAfter).toEqual(budget);
    expect(health.snapshot()).toEqual([]);
  });

  it("blocks when the recovery budget is exhausted and suspends on reset-bearing limits", () => {
    const { executor } = makeExecutor();
    const blocked = executor.plan({
      currentRoute: route("a"),
      alternatives: [route("b")],
      budget: { retriesLeft: 0, fallbacksLeft: 0 },
      failure: fail("provider", { scope: "provider" }),
      failedInvocationId: invocationId("inv-6"),
    });
    expect(blocked.terminal?.action).toBe("block");
    const suspended = executor.plan({
      currentRoute: route("a"),
      alternatives: [],
      budget: { retriesLeft: 0, fallbacksLeft: 1 },
      failure: fail("usage_limit", { scope: "account", resetAtMs: 5_000 }),
      failedInvocationId: invocationId("inv-7"),
    });
    expect(suspended.terminal?.action).toBe("suspend");
    expect(suspended.terminal?.resumeAtMs).toBe(5_000);
  });

  it("projects only through the injected HealthProjector and plans only via RecoveryCoordinator", () => {
    const now = () => 1_000;
    const health = new HealthRegistry(now);
    const projector = new HealthProjector(health);
    const log = new WorkflowEventLog(now);
    const plan = vi.fn(() => ({ action: "block" as const, reason: "unit" }));
    const coordinator = { plan } as unknown as RecoveryCoordinator;
    const record = vi.spyOn(projector, "record");
    const executor = new RuntimeRecoveryExecutor(coordinator, projector, health, log, { taskId: taskId("t") });
    executor.plan({
      currentRoute: route("a"),
      alternatives: [],
      budget: { retriesLeft: 0, fallbacksLeft: 0 },
      failure: fail("rate_limit", { scope: "provider", confidence: "ambiguous", retryAfterMs: 999_999 }),
      failedInvocationId: invocationId("inv-8"),
    });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(health.getRoute("a")?.cooldownUntilMs).toBe(31_000);
  });
});

describe("RuntimeRecoveryExecutor bounded run", () => {
  it("applies at most the authorized attempts and stops at the step limit", async () => {
    const { executor } = makeExecutor();
    const attempts: string[] = [];
    const outcome = await executor.run({
      initialRoute: route("a", "p", "m-a"),
      alternatives: [route("b", "p", "m-b"), route("c", "q", "m-c")],
      budget: { retriesLeft: 2, fallbacksLeft: 3 },
      initialInvocationId: invocationId("inv-run"),
      maxSteps: 6,
      attempt: async (route, invocationId) => {
        attempts.push(`${route.routeId}:${invocationId}`);
        if (attempts.length < 4) {
          return failure(fail("provider", { scope: "provider" }));
        }
        return success({ summary: "done" });
      },
    });
    expect(outcome.ok).toBe(true);
    expect(attempts).toEqual(["a:inv-run", "c:inv-run#r1", "b:inv-run#r2", "c:inv-run#r3"]);
  });

  it("never loops forever: exhausted budget terminates the run as blocked", async () => {
    const { executor } = makeExecutor();
    let count = 0;
    const outcome = await executor.run({
      initialRoute: route("a"),
      alternatives: [],
      budget: { retriesLeft: 1, fallbacksLeft: 0 },
      initialInvocationId: invocationId("inv-run2"),
      maxSteps: 10,
      attempt: async () => {
        count += 1;
        return failure(fail("network", { scope: "provider", retryAfterMs: 1 }));
      },
    });
    expect(count).toBe(2);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe("recovery_blocked");
  });

  it("stops immediately on cancellation failures", async () => {
    const { executor } = makeExecutor();
    let count = 0;
    const outcome = await executor.run({
      initialRoute: route("a"),
      alternatives: [route("b")],
      budget,
      initialInvocationId: invocationId("inv-run3"),
      maxSteps: 10,
      attempt: async () => {
        count += 1;
        return failure(fail("cancellation"));
      },
    });
    expect(count).toBe(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe("recovery_stopped");
  });

  it("emits decision, application, and budget events with parent linkage", () => {
    const now = () => 1_000;
    const health = new HealthRegistry(now);
    const log = new WorkflowEventLog(now);
    const executor = new RuntimeRecoveryExecutor(
      new RecoveryCoordinator(),
      new HealthProjector(health),
      health,
      log,
      { taskId: taskId("task-ev") },
    );
    executor.plan({
      currentRoute: route("a"),
      alternatives: [route("b")],
      budget,
      failure: fail("network", { scope: "provider", retryAfterMs: 10 }),
      failedInvocationId: invocationId("inv-ev"),
    });
    const kinds = log.snapshot().map((event) => event.kind);
    expect(kinds).toContain("recovery_decided");
    expect(kinds).toContain("recovery_applied");
    expect(kinds).toContain("budget_changed");
    const decided = log.snapshot().find((event) => event.kind === "recovery_decided");
    expect(JSON.stringify(decided)).not.toMatch(/acct-/);
  });
});
