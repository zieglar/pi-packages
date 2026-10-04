import { describe, expect, it } from "vitest";
import { PassiveAccountAdapter } from "../src/adapters/passive-account-adapter.js";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import { routeId, taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";

const routes: readonly ExecutionRoute[] = [
  {
    routeId: routeId("advisor"), provider: "p", modelId: "advisor-model", accountRef: "acct-b",
    tier: "balanced", thinking: "high", budgetLimit: 50,
    capabilities: { worker: false, advisor: true, tools: false, reasoning: true },
  },
  {
    routeId: routeId("worker"), provider: "p", modelId: "worker-model", accountRef: "acct-a",
    tier: "fast", thinking: "low", budgetLimit: 100,
    capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
  },
];

describe("PassiveAccountAdapter", () => {
  it("returns available role-compatible routes in deterministic order", async () => {
    const health = new HealthRegistry(() => 100);
    const adapter = new PassiveAccountAdapter(routes, { hasModel: (_provider, model) => model !== "missing" }, health);
    const worker = await adapter.listExecutionRoutes({ taskId: taskId("t"), role: "worker" });
    expect(worker.ok && worker.value.map((route) => route.routeId)).toEqual(["worker"]);
    const sanitized = await adapter.listEligibleRoutes({ taskId: taskId("t"), role: "worker" });
    expect(sanitized.ok && sanitized.value[0]).toMatchObject({ routeId: "worker", accountId: "acct-a", status: "available" });
  });

  it("excludes unavailable models and centrally cooled routes", async () => {
    const health = new HealthRegistry(() => 100);
    health.recordRoute("worker", { status: "cooldown", cooldownMs: 100 });
    const adapter = new PassiveAccountAdapter(routes, { hasModel: () => true }, health);
    const result = await adapter.listExecutionRoutes({ taskId: taskId("t"), role: "worker" });
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("exposes no mutation, retry, or continuation authority", () => {
    const adapter = new PassiveAccountAdapter(routes, { hasModel: () => true }, new HealthRegistry());
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(adapter)).sort()).toEqual([
      "constructor", "listEligibleRoutes", "listExecutionRoutes", "reportRouteOutcome",
    ]);
  });
});
