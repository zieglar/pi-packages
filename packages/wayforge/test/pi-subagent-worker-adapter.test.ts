import { describe, expect, it } from "vitest";
import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
} from "pi-subagents/delegation";
import { PiSubagentWorkerAdapter } from "../src/adapters/pi-subagent-worker-adapter.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { invocationId, routeId, taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";

class Bus {
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const handler of this.handlers.get(channel) ?? []) handler(data);
  }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set<(data: unknown) => void>();
    set.add(handler); this.handlers.set(channel, set);
    return () => set.delete(handler);
  }
  count(channel: string): number { return this.handlers.get(channel)?.size ?? 0; }
}

const route: ExecutionRoute = {
  routeId: routeId("worker-route"), provider: "provider", modelId: "worker-model",
  tier: "fast", thinking: "low", budgetLimit: 100,
  capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
};

function parent() {
  return createInvocation({ invocationId: invocationId("main"), taskId: taskId("task"), role: "main", maxDepth: 2, budgetLimit: 200 });
}

function request(adapter: PiSubagentWorkerAdapter, signal?: AbortSignal) {
  return adapter.execute({
    parent: parent(), invocationId: invocationId("worker-1"), route, prompt: "do work", cwd: "/repo",
    timeoutMs: 500, toolBudgetHard: 5, context: "fresh", result: { kind: "text" }, ...(signal ? { signal } : {}),
  });
}

describe("PiSubagentWorkerAdapter", () => {
  it("launches a fully resolved request and verifies terminal model evidence", async () => {
    const bus = new Bus();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
      const launched = raw as SubagentDelegationRequest;
      expect(launched).toMatchObject({
        agent: "worker", context: "fresh", cwd: "/repo", model: "provider/worker-model",
        thinking: "low", timeoutMs: 500, toolBudget: { hard: 5 }, result: { kind: "text" },
      });
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId,
        status: "completed", model: "provider/worker-model", result: { kind: "text", text: "done" },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 2, durationMs: 20 },
      } satisfies SubagentDelegationResponse);
    });
    const adapter = new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 2 });
    const outcome = await request(adapter);
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("done");
    expect(outcome.remainingBudget).toBe(85);
    expect(bus.count(SUBAGENT_DELEGATION_RESPONSE_EVENT)).toBe(0);
  });


  it("accepts a thinking-level suffix on the same base route and records the observed model", async () => {
    const bus = new Bus();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
      const launched = raw as SubagentDelegationRequest;
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId,
        status: "completed", model: "provider/worker-model:high", result: { kind: "text", text: "done" },
      } satisfies SubagentDelegationResponse);
    });
    const outcome = await request(new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 1 }));
    expect(outcome.status).toBe("completed");
    expect(outcome.text).toBe("done");
    expect(outcome.observedModel).toBe("provider/worker-model:high");
  });

  it("fails closed when completed evidence carries no model", async () => {
    const bus = new Bus();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
      const launched = raw as SubagentDelegationRequest;
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId,
        status: "completed", result: { kind: "text", text: "untrusted" },
      } satisfies SubagentDelegationResponse);
    });
    const outcome = await request(new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 1 }));
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe("worker_model_mismatch");
    expect(outcome.failure?.message).toContain("observed none");
  });
  it("fails closed on selected-model mismatch", async () => {
    const bus = new Bus();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
      const launched = raw as SubagentDelegationRequest;
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId,
        status: "completed", model: "provider/other", result: { kind: "text", text: "untrusted" },
      } satisfies SubagentDelegationResponse);
    });
    const outcome = await request(new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 1 }));
    expect(outcome.status).toBe("failed");
    expect(outcome.failure?.code).toBe("worker_model_mismatch");
    expect(outcome.text).toBeUndefined();
  });

  it("propagates cancellation with the exact correlation tuple", async () => {
    const bus = new Bus();
    const controller = new AbortController();
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, () => controller.abort());
    bus.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (raw) => {
      const cancel = raw as { requestId: string; ownerRunId: string; nodeId: string };
      bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { ...cancel, status: "cancelled" } satisfies SubagentDelegationResponse);
    });
    const outcome = await request(new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 1 }), controller.signal);
    expect(outcome.status).toBe("cancelled");
    const launched = bus.emitted.find((entry) => entry.channel === SUBAGENT_DELEGATION_REQUEST_EVENT)?.data as SubagentDelegationRequest;
    const cancelled = bus.emitted.find((entry) => entry.channel === SUBAGENT_DELEGATION_CANCEL_EVENT)?.data;
    expect(cancelled).toEqual({ requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId });
  });

  it("bounds parallel executions without coupling failures", async () => {
    const bus = new Bus();
    let active = 0; let peak = 0;
    bus.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (raw) => {
      const launched = raw as SubagentDelegationRequest; active += 1; peak = Math.max(peak, active);
      setTimeout(() => {
        active -= 1;
        bus.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
          requestId: launched.requestId, ownerRunId: launched.ownerRunId, nodeId: launched.nodeId,
          status: launched.nodeId.endsWith("2") ? "failed" : "completed", model: "provider/worker-model",
          ...(launched.nodeId.endsWith("2") ? { error: "failed" } : { result: { kind: "text", text: "ok" } }),
        } satisfies SubagentDelegationResponse);
      }, 5);
    });
    const adapter = new PiSubagentWorkerAdapter(bus, { ownerRunId: "wayforge", maxConcurrency: 2 });
    const inputs = [1, 2, 3].map((index) => ({
      parent: parent(), invocationId: invocationId(`worker-${index}`), route, prompt: "x", cwd: "/repo",
      timeoutMs: 100, toolBudgetHard: 2, context: "fresh" as const, result: { kind: "text" as const },
    }));
    const outcomes = await adapter.executeMany(inputs);
    expect(peak).toBe(2);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["completed", "failed", "completed"]);
  });
});
