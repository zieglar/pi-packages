import { describe, expect, it } from "vitest";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import { HealthProjector } from "../src/recovery/health-projector.js";
import { routeId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";

const route: ExecutionRoute = {
  routeId: routeId("r1"), provider: "provider-a", modelId: "model-a", accountRef: "acct-a",
  tier: "fast", thinking: "low", budgetLimit: 100,
  capabilities: { worker: true, advisor: false, tools: true, reasoning: false },
};

describe("HealthProjector", () => {
  it("keeps ambiguous rate limits route-local and bounded", () => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health, { maxAmbiguousRouteCooldownMs: 5_000 });
    projector.record(route, {
      kind: "rate_limit", scope: "provider", confidence: "ambiguous", code: "http_429",
      message: "busy", retryAfterMs: 60_000,
    });
    expect(health.getRoute("r1")?.cooldownUntilMs).toBe(6_000);
    expect(health.getProvider("provider-a")).toBeUndefined();
    expect(health.getAccount("acct-a")).toBeUndefined();
  });

  it("records exact account facts without poisoning provider or model", () => {
    const health = new HealthRegistry(() => 100);
    const projector = new HealthProjector(health);
    projector.record(route, {
      kind: "authentication", scope: "account", confidence: "certain", code: "http_401", message: "unauthorized",
    });
    expect(health.getAccount("acct-a")?.status).toBe("unavailable");
    expect(health.getProvider("provider-a")).toBeUndefined();
    expect(health.getModel("model-a")).toBeUndefined();
  });

  it("does not convert context or cancellation failures into cooldown state", () => {
    const health = new HealthRegistry(() => 100);
    const projector = new HealthProjector(health);
    projector.record(route, {
      kind: "context_overflow", scope: "model", confidence: "certain", code: "context", message: "too long",
    });
    projector.record(route, {
      kind: "cancellation", scope: "invocation", confidence: "certain", code: "aborted", message: "cancelled",
    });
    expect(health.snapshot()).toEqual([]);
  });
});
