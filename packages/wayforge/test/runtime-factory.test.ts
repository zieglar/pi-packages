import { describe, expect, it } from "vitest";
import type { CompletionAuthorityPort } from "../src/completion/completion-authority.js";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
} from "pi-subagents/delegation";
import { createWorkflowRuntime } from "../src/workflow/runtime-factory.js";
import type { MainModelController } from "../src/runtime/main-model-controller.js";
import type { NestedModelRequest, NestedModelOutput } from "../src/runtime/ports.js";
import { invocationId, routeId, taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";
import { success } from "../src/types/result.js";

class Bus {
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  constructor(private readonly respond: (request: SubagentDelegationRequest) => void) {}
  emit(channel: string, data: unknown): void {
    if (channel !== SUBAGENT_DELEGATION_REQUEST_EVENT) return;
    this.respond(data as SubagentDelegationRequest);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  dispatch(channel: string, data: unknown): void {
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
}

const workerRoute: ExecutionRoute = {
  routeId: routeId("rt-worker"), provider: "sentinel", modelId: "worker-model",
  tier: "fast", thinking: "low", budgetLimit: 120,
  capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
};

const advisorRoute: ExecutionRoute = {
  routeId: routeId("rt-advisor"), provider: "sentinel", modelId: "advisor-model",
  tier: "balanced", thinking: "high", budgetLimit: 60,
  capabilities: { worker: false, advisor: true, tools: false, reasoning: true },
};

const mainRoute: ExecutionRoute = {
  routeId: routeId("rt-main"), provider: "sentinel", modelId: "main-model",
  tier: "flagship", thinking: "medium", budgetLimit: 800,
  capabilities: { worker: false, advisor: false, tools: true, reasoning: true },
};

describe("createWorkflowRuntime", () => {
  it("composes one wired runtime: delegate -> advise -> validate -> complete", async () => {
    const bus = new Bus((request) => {
      queueMicrotask(() => {
        bus.dispatch(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          model: "sentinel/worker-model",
          result: { kind: "text", text: "worker done" },
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 },
        });
      });
    });
    const advisorCalls: NestedModelRequest[] = [];
    const nestedRuntime = {
      stream: async (request: NestedModelRequest): Promise<{ ok: true; value: NestedModelOutput }> => {
        advisorCalls.push(request);
        return {
          ok: true,
          value: {
            text: JSON.stringify({ status: "approve", summary: "ready", findings: [] }),
            usage: { inputTokens: 4, outputTokens: 4 },
          },
        };
      },
    };
    const mainModel = {} as MainModelController;
    const runtime = createWorkflowRuntime({
      ownerRunId: "wayforge-alpha0",
      delegation: bus,
      modelAvailability: { hasModel: () => true },
      routes: [workerRoute, advisorRoute, mainRoute],
      observedMainRoute: mainRoute,
      task: {
        taskId: taskId("task-factory"),
        objective: "isolate a small improvement",
        completionCriteria: "validation passes and advisor approves",
      },
      mainModel,
      nestedRuntime,
      completionAuthority: {
        recordValidation: async () => success({ evidenceId: "validation:test", workspaceDigest: "digest" }),
        requestCompletion: async (request) => {
          const reviewed = await request.review({
            objective: "small improvement", completionCriteria: "validation passes",
            implementationSummary: "implemented", changedPaths: ["owned.txt"], diffSummary: "one change",
            validations: [{ name: "npm test", ok: true, summary: "passed" }],
            workerFindings: [], unresolved: [], workspaceDigest: "digest", extra: {},
          });
          return reviewed.ok
            ? success({ summary: "completed", committedRevision: 1, idempotent: false })
            : reviewed;
        },
      } satisfies CompletionAuthorityPort,
      config: { cwd: "/repo", requireAdvisorApproval: true, now: () => 1_000 },
    });

    expect(runtime.advisorAdapter).toBeDefined();
    expect(runtime.controller.beginMainTurn()).toEqual({ ok: true, value: undefined });

    const delegated = await runtime.controller.delegateWorkers({ prompts: ["do a small bounded task"] });
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) throw new Error("expected delegation");
    expect(delegated.value.outcomes[0]?.status).toBe("completed");

    const advised = await runtime.controller.advise({ beforeDone: true });
    expect(advised.ok).toBe(false);
    if (!advised.ok) expect(advised.failure.code).toBe("advisor_reserved_for_completion");
    expect(advisorCalls).toHaveLength(0);
    await runtime.controller.recordValidation({ name: "npm test", ok: true, summary: "all green" });
    expect((await runtime.controller.complete()).ok).toBe(true);
    expect(advisorCalls).toHaveLength(1);
    expect(advisorCalls[0]?.modelId).toBe("advisor-model");
    expect(advisorCalls[0]?.thinking).toBe("high");
    expect(advisorCalls[0]?.budgetLimit).toBe(advisorRoute.budgetLimit);

    const events = runtime.log.snapshot();
    expect(events.map((event) => event.kind)).toContain("worker_launched");
    expect(events.map((event) => event.kind)).toContain("advisor_verdict");
    expect(events.map((event) => event.kind)).toContain("completion_ready");
  });

  it("exposes the single health boundary the router consults", async () => {
    const bus = new Bus((request) => {
      queueMicrotask(() => {
        bus.dispatch(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: request.requestId,
          ownerRunId: request.ownerRunId,
          nodeId: request.nodeId,
          status: "completed",
          model: "sentinel/worker-model",
          result: { kind: "text", text: "ok" },
        });
      });
    });
    const runtime = createWorkflowRuntime({
      ownerRunId: "wayforge-alpha0",
      delegation: bus,
      modelAvailability: { hasModel: () => true },
      routes: [workerRoute, advisorRoute, mainRoute],
      observedMainRoute: mainRoute,
      task: { taskId: taskId("task-health"), objective: "o", completionCriteria: "c" },
      mainModel: {} as MainModelController,
      config: { now: () => 1_000 },
    });
    runtime.controller.beginMainTurn();
    const before = await runtime.controller.delegateWorkers({ prompts: ["x"] });
    expect(before.ok).toBe(true);
    runtime.health.recordRoute("rt-worker", { status: "cooldown", cooldownMs: 60_000, updatedAtMs: 1_000 });
    const after = await runtime.controller.delegateWorkers({ prompts: ["x"] });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.failure.code).toBe("no_worker_route");
  });
});
