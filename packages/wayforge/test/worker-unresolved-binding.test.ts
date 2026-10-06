import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationRequest,
} from "pi-subagents/delegation";
import { CompletionAuthority } from "../src/completion/completion-authority.js";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { serializeTaskState, type AuthoritativeTaskState } from "../src/durable/state.js";
import { LiveDurableProjection } from "../src/runtime/durable-task-projection.js";
import type { MainModelController } from "../src/runtime/main-model-controller.js";
import { taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";
import { createWorkflowRuntime, type WorkflowRuntime } from "../src/workflow/runtime-factory.js";

/**
 * Phase B1: an unresolved worker failure must become authoritative durable
 * state, must block completion readiness before the Advisor review is spent,
 * and must fail closed when the durable binding cannot be established.
 */

let workspace: string | undefined;
let storeRoot: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "wayforge-b1-ws-"));
  execFileSync("git", ["init", "--quiet"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.invalid", "commit", "--quiet", "--allow-empty", "-m", "base"], { cwd: workspace });
  storeRoot = mkdtempSync(join(tmpdir(), "wayforge-b1-store-"));
});

afterEach(() => {
  for (const dir of [workspace, storeRoot]) {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

class Bus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  constructor(private readonly respond: (request: SubagentDelegationRequest, bus: Bus) => void) {}
  emit(channel: string, data: unknown): void {
    if (channel === SUBAGENT_DELEGATION_REQUEST_EVENT) {
      const request = data as SubagentDelegationRequest;
      queueMicrotask(() => this.respond(request, this));
    }
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

function completionResponse(request: SubagentDelegationRequest, bus: Bus): void {
  bus.dispatch(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: "completed",
    model: "p/m",
    result: { kind: "text", text: "done" },
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 },
  });
}

function failedResponse(request: SubagentDelegationRequest, bus: Bus): void {
  bus.dispatch(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
    requestId: request.requestId,
    ownerRunId: request.ownerRunId,
    nodeId: request.nodeId,
    status: "failed",
    model: "p/m",
    error: "provider exploded sk-testsecret1234567890abcdef",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 },
  });
}

const routes: readonly ExecutionRoute[] = [
  {
    routeId: "main-route" as never,
    provider: "p",
    modelId: "m",
    tier: "flagship",
    thinking: "medium",
    capabilities: { worker: false, advisor: false, tools: true, reasoning: true },
    budgetLimit: 96_000,
  },
  {
    routeId: "worker-route" as never,
    provider: "p",
    modelId: "m",
    tier: "flagship",
    thinking: "low",
    capabilities: { worker: true, advisor: false, tools: true, reasoning: true },
    budgetLimit: 32_000,
  },
  {
    routeId: "advisor-route" as never,
    provider: "p",
    modelId: "m",
    tier: "flagship",
    thinking: "high",
    capabilities: { worker: false, advisor: true, tools: false, reasoning: true },
    budgetLimit: 800,
  },
];

interface Harness {
  readonly runtime: WorkflowRuntime;
  readonly store: FilesystemDurableTaskStore;
  readonly projection: LiveDurableProjection;
  readonly advisorCalls: { count: () => number };
}

function makeHarness(options: { failWorker?: boolean; governed?: boolean; createTask?: boolean } = {}): Harness {
  const store = new FilesystemDurableTaskStore(storeRoot!, { now: () => 50_000 });
  const projection = new LiveDurableProjection(store, { now: () => 50_000 });
  const bus = new Bus(options.failWorker === true ? failedResponse : completionResponse);
  let advisorCalls = 0;
  const authority = options.governed === true
    ? new CompletionAuthority({
        store,
        workspaceRoot: workspace!,
        taskId: taskId("alpha0-1"),
        leaseTtlMs: 1_000,
        now: () => 50_000,
      })
    : undefined;
  const runtime = createWorkflowRuntime({
    ownerRunId: "wayforge-b1",
    delegation: bus,
    modelAvailability: { hasModel: () => true },
    routes,
    observedMainRoute: routes[0]!,
    task: { taskId: taskId("alpha0-1"), objective: "bind worker failures durably", completionCriteria: "tests pass" },
    mainModel: {} as MainModelController,
    nestedRuntime: {
      stream: async () => {
        advisorCalls += 1;
        return { ok: true, value: { text: JSON.stringify({ status: "approve", summary: "ok", findings: [] }), usage: { inputTokens: 1, outputTokens: 1 } } };
      },
    },
    durableUnresolved: projection,
    ...(authority !== undefined ? { completionAuthority: authority } : {}),
    config: { cwd: workspace!, now: () => 50_000 },
  });
  return { runtime, store, projection, advisorCalls: { count: () => advisorCalls } };
}

async function createDurableTask(h: Harness): Promise<void> {
  await h.projection.startDurableTask({
    taskId: taskId("alpha0-1"),
    objective: "bind worker failures durably",
    completionCriteria: "tests pass",
    workspaceRoot: workspace!,
    policyVersions: { role: "main", model: "p/m" },
  });
}

async function loadRequired(h: Harness): Promise<AuthoritativeTaskState> {
  const stored = await h.store.load(taskId("alpha0-1"));
  if (!stored.ok || stored.value === null) throw new Error(`durable task missing: ${stored.ok ? "null" : stored.failure.code}`);
  return stored.value;
}

describe("worker failure durable binding (B1)", () => {
  it("B1.1 a successful worker leaves no durable unresolved state", async () => {
    const h = makeHarness();
    await createDurableTask(h);

    const delegated = await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    expect(delegated.ok).toBe(true);

    expect((await loadRequired(h)).unresolvedItems).toEqual([]);
  });

  it("B1.2 a failed worker becomes authoritative durable unresolved state", async () => {
    const h = makeHarness({ failWorker: true });
    await createDurableTask(h);

    const delegated = await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    expect(delegated.ok).toBe(true);

    const unresolved = (await loadRequired(h)).unresolvedItems;
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved[0]).toMatch(/^worker .* ended failed/);
  });

  it("B1.3 durable unresolved worker state blocks completion readiness before the Advisor review", async () => {
    const h = makeHarness({ failWorker: true, governed: true });
    await createDurableTask(h);

    const delegated = await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    expect(delegated.ok).toBe(true);
    const recorded = await h.runtime.controller.recordValidation({ name: "npm test", ok: true, summary: "passed" });
    expect(recorded.ok).toBe(true);

    const completed = await h.runtime.controller.complete();
    expect(completed.ok).toBe(false);
    if (!completed.ok) expect(completed.failure.code).toBe("unresolved_items");
    expect(h.advisorCalls.count()).toBe(0);
  });

  it("B1.4 a task with bound worker failure cannot reach authoritative completion", async () => {
    const h = makeHarness({ failWorker: true, governed: true });
    await createDurableTask(h);

    await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    await h.runtime.controller.recordValidation({ name: "npm test", ok: true, summary: "passed" });
    const completed = await h.runtime.controller.complete();
    expect(completed.ok).toBe(false);

    const stored = await loadRequired(h);
    expect(stored.status).toBe("running");
    expect(stored.completionEvidence).toBeNull();
  });

  it("B1.5 fails closed when the durable unresolved binding cannot be established", async () => {
    const h = makeHarness({ failWorker: true });
    // No durable task exists: the projection cannot bind unresolved state.

    const delegated = await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    expect(delegated.ok).toBe(false);
    if (!delegated.ok) expect(delegated.failure.code).toBe("unresolved_binding_failed");
  });

  it("B1.6 never persists secret-shaped provider text in durable unresolved state", async () => {
    const h = makeHarness({ failWorker: true });
    await createDurableTask(h);

    const delegated = await h.runtime.controller.delegateWorkers({ prompts: ["small bounded task"] });
    expect(delegated.ok).toBe(true);

    const serialized = serializeTaskState(await loadRequired(h));
    expect(serialized).not.toContain("sk-testsecret");
    expect(serialized).not.toContain("provider exploded");
  });
});
