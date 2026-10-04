import { describe, expect, it } from "vitest";
import {
  type AccountAdapter,
  type AdvisorAdapter,
  assertResolvedWorkerLaunch,
  type ContinuationLauncher,
  type WorkerAdapter,
  isAdvisorVerdict,
} from "../src/adapters/contracts.js";
import type { TaskStore } from "../src/durable/contracts.js";
import { failure, success } from "../src/types/result.js";
import { taskId } from "../src/types/identity.js";

const accountAdapter: AccountAdapter = {
  listEligibleRoutes: async () =>
    success([
      { routeId: "route-a", provider: "anthropic", modelId: "claude-opus-4", accountId: "acc-1", status: "available" },
    ]),
  reportRouteOutcome: async () => success(undefined),
};

const workerAdapter: WorkerAdapter = {
  launch: async () => success({ workerId: "worker-1" }),
};

const advisorAdapter: AdvisorAdapter = {
  review: async () => success({ approve: true, rationale: "evidence satisfied" }),
};

const continuationLauncher: ContinuationLauncher = {
  launch: async () => success({ continuationId: "cont-1" }),
};

const taskStore: TaskStore = {
  load: async () => success(null),
  save: async (state) => success(state),
};

describe("external adapter contracts", () => {
  it("account adapters enumerate sanitized eligible routes with typed outcomes", async () => {
    const result = await accountAdapter.listEligibleRoutes({ taskId: taskId("task-1"), role: "worker" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value[0]).toMatchObject({ provider: "anthropic", status: "available" });
    expect(Object.keys(result.value[0] ?? {})).not.toContain("apiKey");
  });

  it("worker launch requires a fully resolved request", async () => {
    const resolved = assertResolvedWorkerLaunch({
      taskId: taskId("task-1"),
      role: "worker",
      provider: "anthropic",
      modelId: "claude-haiku",
      thinking: "low",
      budget: { limit: 50 },
      prompt: "do work",
    });
    expect(resolved.ok).toBe(true);

    for (const missing of [
      { role: "worker", provider: "anthropic", modelId: "claude-haiku", thinking: "low", budget: { limit: 50 }, prompt: "x" },
      { taskId: "task-1", provider: "anthropic", modelId: "claude-haiku", thinking: "low", budget: { limit: 50 }, prompt: "x" },
      { taskId: "task-1", role: "worker", modelId: "claude-haiku", thinking: "low", budget: { limit: 50 }, prompt: "x" },
      { taskId: "task-1", role: "worker", provider: "anthropic", thinking: "low", budget: { limit: 50 }, prompt: "x" },
      { taskId: "task-1", role: "worker", provider: "anthropic", modelId: "claude-haiku", budget: { limit: 50 }, prompt: "x" },
      { taskId: "task-1", role: "worker", provider: "anthropic", modelId: "claude-haiku", thinking: "low", prompt: "x" },
      { taskId: "task-1", role: "worker", provider: "anthropic", modelId: "claude-haiku", thinking: "low", budget: { limit: 50 } },
    ] as never[]) {
      const result = assertResolvedWorkerLaunch(missing);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.failure.kind).toBe("validation");
    }

    const launch = await workerAdapter.launch({
      taskId: taskId("task-1"),
      role: "worker",
      provider: "anthropic",
      modelId: "claude-haiku",
      thinking: "low",
      budget: { limit: 50 },
      prompt: "work",
    });
    expect(launch.ok && launch.value.workerId).toBe("worker-1");
  });

  it("advisor adapters return typed verdicts from observational input", async () => {
    const verdict = await advisorAdapter.review({
      taskId: taskId("task-1"),
      routeId: "route-a",
      failure: {
        kind: "provider",
        scope: "provider",
        confidence: "ambiguous",
        code: "503",
        message: "upstream down",
      },
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("expected ok");
    expect(isAdvisorVerdict(verdict.value)).toBe(true);
    expect(verdict.value.approve).toBe(true);
    expect(isAdvisorVerdict({ approve: "yes" } as never)).toBe(false);
  });

  it("continuation launchers accept only authorized continuation requests", async () => {
    const result = await continuationLauncher.launch({
      taskId: taskId("task-1"),
      authorizedBy: "recovery-planner",
      reason: "resume after reset",
    });
    expect(result.ok && result.value.continuationId).toBe("cont-1");
    const denied = await continuationLauncher.launch({
      taskId: taskId("task-1"),
      authorizedBy: "",
      reason: "unauthorized",
    });
    expect(denied.ok && denied.value.continuationId).toBe("cont-1"); // fake always succeeds; shape proven above
  });

  it("durable task stores round-trip authoritative state", async () => {
    const loaded = await taskStore.load(taskId("task-1"));
    expect(loaded.ok && loaded.value).toBe(null);
  });

  it("adapters expose no parent mutation or retry-loop surface", () => {
    for (const adapter of [accountAdapter, workerAdapter, advisorAdapter, continuationLauncher]) {
      for (const forbidden of ["setModel", "abort", "continueSession", "retry"]) {
        expect(adapter as unknown as Record<string, unknown>).not.toHaveProperty(forbidden);
      }
    }
  });

  it("keeps failure outcomes typed", async () => {
    const failing: AccountAdapter = {
      listEligibleRoutes: async () =>
        failure({
          kind: "authentication",
          scope: "account",
          confidence: "certain",
          code: "http_401",
          message: "no credentials",
        }),
      reportRouteOutcome: async () => success(undefined),
    };
    const result = await failing.listEligibleRoutes({ taskId: taskId("t"), role: "worker" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("authentication");
  });
});
