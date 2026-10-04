import { describe, expect, it, vi } from "vitest";
import { WorkflowController, type WorkerDelegationPort } from "../src/workflow/workflow-controller.js";
import { WorkflowEventLog } from "../src/workflow/events.js";
import { WorkflowStateStore, type WorkflowTaskState } from "../src/workflow/workflow-state.js";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import { HealthProjector } from "../src/recovery/health-projector.js";
import { RecoveryCoordinator } from "../src/recovery/recovery-coordinator.js";
import { RuntimeRecoveryExecutor } from "../src/recovery/runtime-recovery-executor.js";
import { MainModelController } from "../src/runtime/main-model-controller.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { PassiveAccountAdapter } from "../src/adapters/passive-account-adapter.js";
import type { ExecutionRoute, WorkerOutcome } from "../src/workflow/contracts.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";
import { success } from "../src/types/result.js";

const mainRoute: ExecutionRoute = {
  routeId: routeId("main-observed"), provider: "p", modelId: "main-model",
  tier: "flagship", thinking: "medium", budgetLimit: 500,
  capabilities: { worker: false, advisor: false, tools: true, reasoning: true },
};

const workerRoute: ExecutionRoute = {
  routeId: routeId("worker-1"), provider: "p", modelId: "worker-model",
  tier: "fast", thinking: "low", budgetLimit: 120,
  capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
};

const advisorRoute: ExecutionRoute = {
  routeId: routeId("advisor-1"), provider: "p", modelId: "advisor-model",
  tier: "balanced", thinking: "high", budgetLimit: 60,
  capabilities: { worker: false, advisor: true, tools: false, reasoning: true },
};

const workerOutcome = (index: number, status: WorkerOutcome["status"] = "completed"): WorkerOutcome => ({
  taskId: taskId("task-w"),
  invocationId: invocationId(`worker-out-${index}`),
  parentInvocationId: invocationId("main-1"),
  selectedRoute: workerRoute,
  ...(status === "completed" ? { observedModel: "p/worker-model" } : {}),
  status,
  ...(status === "completed" ? { text: `worker output ${index}` } : {}),
  ...(status !== "completed"
    ? {
        failure: {
          kind: "provider" as const, scope: "provider" as const, confidence: "ambiguous" as const,
          code: "http_503", message: "upstream unavailable",
        },
      }
    : {}),
  remainingBudget: 100,
});

interface Harness {
  readonly controller: WorkflowController;
  readonly state: WorkflowTaskState;
  readonly executeMany: ReturnType<typeof vi.fn>;
  readonly review: ReturnType<typeof vi.fn>;
  readonly applyModelDecision: ReturnType<typeof vi.fn>;
  readonly mainContext: ReturnType<typeof createInvocation>;
}

function makeHarness(options?: {
  requireAdvisorApproval?: boolean;
  workerOutcomes?: readonly WorkerOutcome[];
}): Harness {
  const log = new WorkflowEventLog(() => 1_000);
  const state = new WorkflowStateStore(log).create({
    taskId: taskId("task-w"),
    objective: "objective",
    completionCriteria: "criteria",
    recoveryBudget: { retriesLeft: 1, fallbacksLeft: 1 },
  });
  const health = new HealthRegistry(() => 1_000);
  const now = () => 1_000;
  const executor = new RuntimeRecoveryExecutor(
    new RecoveryCoordinator(),
    new HealthProjector(health, { now }),
    health,
    log,
    { taskId: taskId("task-w"), now },
  );
  const routes = new PassiveAccountAdapter([workerRoute, advisorRoute], { hasModel: () => true }, health);
  const outcomes = options?.workerOutcomes ?? [workerOutcome(1), workerOutcome(2)];
  const executeMany = vi.fn(async () => outcomes);
  const workers: WorkerDelegationPort = { executeMany };
  const review = vi.fn(async (input: { parent: { invocationId: string } }) =>
    success({
      verdict: { status: "approve" as const, summary: "ok", findings: [] },
      decision: {
        routeId: advisorRoute.routeId, provider: advisorRoute.provider, modelId: advisorRoute.modelId,
        tier: advisorRoute.tier, thinking: advisorRoute.thinking,
        capabilityId: capabilityId("cap-advisor"), budget: { limit: 60 },
      },
      invocationId: invocationId("advisor-out-1"),
      parentInvocationId: input.parent.invocationId as ReturnType<typeof invocationId>,
    }));
  const advisors = { review };
  const applyModelDecision = vi.fn(async () => success({ provider: "p", modelId: "main-model" }));
  const mainModel = { applyModelDecision } as unknown as MainModelController;
  const mainContext = createInvocation({
    invocationId: invocationId("main-1"), taskId: taskId("task-w"), role: "main", maxDepth: 2, budgetLimit: 500,
  });
  const controller = new WorkflowController({
    state,
    routes,
    workers,
    advisors,
    recovery: executor,
    mainModel,
    mainContext,
    observedMainRoute: mainRoute,
    log,
    config: { cwd: "/repo", requireAdvisorApproval: options?.requireAdvisorApproval ?? false },
  });
  return { controller, state, executeMany, review, applyModelDecision, mainContext };
}

describe("WorkflowController", () => {
  it("starts one active Main invocation on the observed native route", () => {
    const { controller, state } = makeHarness();
    expect(controller.beginMainTurn()).toEqual({ ok: true, value: undefined });
    expect(state.snapshot().activeMainInvocationId).toBe("main-1");
    expect(state.snapshot().routeHistory[0]).toBe("main-observed");
    const second = new WorkflowController({
      state,
      routes: {} as PassiveAccountAdapter,
      recovery: {} as RuntimeRecoveryExecutor,
      mainModel: {} as MainModelController,
      mainContext: createInvocation({
        invocationId: invocationId("main-2"), taskId: taskId("task-w"), role: "main", maxDepth: 2, budgetLimit: 10,
      }),
      observedMainRoute: mainRoute,
      log: new WorkflowEventLog(() => 1_000),
      config: { cwd: "/repo", requireAdvisorApproval: false },
    });
    const duplicate = second.beginMainTurn();
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.failure.code).toBe("main_already_active");
  });

  it("completes the shortest path without Workers or Advisors", () => {
    const { controller } = makeHarness();
    controller.beginMainTurn();
    expect(controller.complete().ok).toBe(false);
    controller.recordValidation({ name: "npm test", ok: true, summary: "4 passed" });
    const done = controller.complete();
    expect(done.ok).toBe(true);
    expect(controller.status().status).toBe("completed");
  });

  it("gates completion on failed validations and missing advisor approval", async () => {
    const { controller } = makeHarness({ requireAdvisorApproval: true });
    controller.beginMainTurn();
    controller.recordValidation({ name: "npm test", ok: false, summary: "1 failed" });
    expect(controller.complete().ok).toBe(false);
    const unapproved = await controller.advise({ beforeDone: true });
    expect(unapproved.ok).toBe(true);
    expect(controller.complete().ok).toBe(false);
    controller.recordValidation({ name: "npm test", ok: true, summary: "4 passed" });
    expect(controller.complete().ok).toBe(true);
  });

  it("delegates bounded Workers and records outcomes without aborting Main", async () => {
    const { controller, state, executeMany } = makeHarness();
    controller.beginMainTurn();
    const delegated = await controller.delegateWorkers({ prompts: ["a", "b"] });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error("expected delegation");
    expect(delegated.value.outcomes).toHaveLength(2);
    expect(executeMany).toHaveBeenCalledTimes(1);
    const inputs = executeMany.mock.calls[0]?.[0] as {
      prompt: string; route: ExecutionRoute; parent: { invocationId: string } }[];
    expect(inputs?.map((input) => input.prompt)).toEqual(["a", "b"]);
    expect(inputs?.[0]?.route.routeId).toBe("worker-1");
    expect(inputs?.[0]?.parent.invocationId).toBe("main-1");
    expect(state.snapshot().children).toHaveLength(2);
    expect(state.snapshot().activeMainInvocationId).toBe("main-1");
  });

  it("returns Worker provider failures to Main with a bounded suspension and no auto-retry", async () => {
    const { controller, state } = makeHarness({
      workerOutcomes: [workerOutcome(1, "failed")],
    });
    controller.beginMainTurn();
    const failed = await controller.delegateWorkers({ prompts: ["x"] });
    expect(failed.ok).toBe(true);
    if (!failed.ok) throw new Error("expected delegation report");
    expect(failed.value.outcomes[0]?.status).toBe("failed");
    expect(failed.value.recovery?.decision.action).toBe("suspend");
    expect(failed.value.recovery?.terminal?.suspension).toMatchObject({
      kind: "provider_outage",
      strategy: "availability_probe",
      nextCheckAtMs: 31_000,
    });
    expect(executeRetryCount(failed.value.outcomes)).toBe(1);
    expect(state.snapshot().activeMainInvocationId).toBe("main-1");
    expect(state.snapshot().unresolved.length).toBe(1);
    expect(state.snapshot().recoveryBudget.fallbacksLeft).toBe(1);
  });

  it("propagates cancellation and fails closed afterwards", async () => {
    const { controller, mainContext } = makeHarness();
    controller.beginMainTurn();
    controller.cancel();
    expect(mainContext.signal.aborted).toBe(true);
    expect(controller.status().status).toBe("cancelled");
    const delegated = await controller.delegateWorkers({ prompts: ["a"] });
    expect(delegated.ok).toBe(false);
    if (!delegated.ok) expect(delegated.failure.kind).toBe("cancellation");
    expect(controller.complete().ok).toBe(false);
  });

  it("routes parent model changes only through the injected MainModelController", async () => {
    const { controller, applyModelDecision } = makeHarness();
    const decision = {
      routeId: routeId("main-next"), provider: "p", modelId: "main-model-2", tier: "flagship" as const,
      thinking: "high" as const, capabilityId: capabilityId("cap-main"), budget: { limit: 500 },
    };
    const applied = await controller.applyMainModelDecision(decision);
    expect(applied.ok).toBe(true);
    expect(applyModelDecision).toHaveBeenCalledWith({ role: "main", decision });
  });
});

function executeRetryCount(outcomes: readonly WorkerOutcome[]): number {
  return outcomes.length;
}
