import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../src/kernel/capability-catalog.js";
import { ModelPolicy, type ModelDecision, type StaticModelRoute } from "../src/policy/model-policy.js";
import { RolePolicy, type RoleRule } from "../src/policy/role-policy.js";
import { HealthProjector } from "../src/recovery/health-projector.js";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import {
  MainRouteEligibility,
  projectEligibleMainAlternatives,
  transportEndpointKey,
} from "../src/recovery/main-route-eligibility.js";
import type { TransportFailureClassification } from "../src/recovery/transport-failure-classifier.js";
import { capabilityId, routeId, taskId } from "../src/types/identity.js";
import type { ExecutionRoute } from "../src/workflow/contracts.js";

const CAP_MAIN = capabilityId("cap-main");
const MAIN_RULE: RoleRule = {
  role: "main",
  capabilityId: CAP_MAIN,
  allowNested: true,
  needsStreaming: true,
  needsReasoning: true,
  needsTools: true,
  budgetLimit: 1_000,
};
const MAIN_REQUIREMENT = (() => {
  const resolved = new RolePolicy([MAIN_RULE]).resolve({ role: "main", taskId: taskId("tr2") });
  if (!resolved.ok) throw new Error("expected Main requirement");
  return resolved.requirement;
})();

function staticRoute(id: string, provider: string, modelId: string): StaticModelRoute {
  return {
    routeId: routeId(id),
    provider,
    modelId,
    tier: "balanced",
    thinking: "high",
    capabilityId: CAP_MAIN,
    budgetLimit: 1_000,
  };
}

function executionRoute(id: string, provider: string, modelId: string): ExecutionRoute {
  return {
    routeId: routeId(id),
    provider,
    modelId,
    tier: "balanced",
    thinking: "high",
    budgetLimit: 1_000,
    capabilities: { worker: false, advisor: false, tools: true, reasoning: true },
  };
}

function classification(
  kind: TransportFailureClassification["classification"],
  input: Partial<TransportFailureClassification> = {},
): TransportFailureClassification {
  return {
    classification: kind,
    confidence: "certain",
    evidence: "structured",
    code: `test_${kind}`,
    ...input,
  };
}

function decisions(routes: readonly StaticModelRoute[]): readonly ModelDecision[] {
  const result = new ModelPolicy(routes).candidates(MAIN_REQUIREMENT, CapabilityCatalog);
  if (!result.ok) throw new Error(`expected candidates, got ${result.failure.kind}`);
  return result.candidates;
}

const EXPECTED = {
  provider: "provider-a",
  modelId: "model-a",
  invocationId: "task:main#1",
} as const;

describe("ModelPolicy ordered Main candidates", () => {
  it("preserves immutable declaration order rather than lexical route order", () => {
    const policy = new ModelPolicy([
      staticRoute("route-z", "provider-a", "model-a"),
      staticRoute("route-a", "provider-a", "model-b"),
      staticRoute("route-m", "provider-b", "model-c"),
    ]);

    const first = policy.candidates(MAIN_REQUIREMENT, CapabilityCatalog);
    const second = policy.candidates(MAIN_REQUIREMENT, CapabilityCatalog);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("expected candidates");
    expect(first.candidates.map((candidate) => candidate.routeId)).toEqual([
      "route-z",
      "route-a",
      "route-m",
    ]);
  });

  it("preserves relative order while filtering policy-incompatible routes", () => {
    const catalog = {
      has: () => true,
      get: () => ({
        id: CAP_MAIN,
        tools: true,
        streaming: true,
        reasoning: true,
        allowNestedInvocation: true,
        workerEligible: false,
        advisorEligible: false,
        allowedProviders: ["provider-a", "provider-c"],
      }),
      all: () => [],
    };
    const result = new ModelPolicy([
      staticRoute("z", "provider-a", "model-a"),
      staticRoute("a", "provider-b", "model-b"),
      staticRoute("m", "provider-c", "model-c"),
    ]).candidates(MAIN_REQUIREMENT, catalog);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected candidates");
    expect(result.candidates.map((candidate) => candidate.routeId)).toEqual(["z", "m"]);
  });

  it("returns an empty ordered set when no route matches the requirement", () => {
    const result = new ModelPolicy([]).candidates(MAIN_REQUIREMENT, CapabilityCatalog);
    expect(result).toEqual({ ok: true, candidates: [] });
  });

  it("keeps resolve first-match semantics over the shared candidate filter", () => {
    const policy = new ModelPolicy([
      staticRoute("z", "provider-a", "model-a"),
      staticRoute("a", "provider-a", "model-b"),
    ]);
    const result = policy.resolve(MAIN_REQUIREMENT, CapabilityCatalog);
    expect(result.ok && result.decision.routeId).toBe("z");
  });

  it("rejects duplicate route IDs at configuration construction", () => {
    expect(() => new ModelPolicy([
      staticRoute("duplicate", "provider-a", "model-a"),
      staticRoute("duplicate", "provider-b", "model-b"),
    ])).toThrow(/duplicate route id/i);
  });

  it("rejects duplicate provider/model endpoints in Main candidates", () => {
    const result = new ModelPolicy([
      staticRoute("one", "provider-a", "model-a"),
      staticRoute("two", "provider-a", "model-a"),
    ]).candidates(MAIN_REQUIREMENT, CapabilityCatalog);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected duplicate endpoint rejection");
    expect(result.failure.kind).toBe("duplicate_endpoint");
  });

  it("treats provider aliases as opaque endpoint components", () => {
    const result = new ModelPolicy([
      staticRoute("one", "openai-codex", "model-a"),
      staticRoute("two", "openai-codex-account-2", "model-a"),
    ]).candidates(MAIN_REQUIREMENT, CapabilityCatalog);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected opaque aliases");
    expect(result.candidates).toHaveLength(2);
  });
});

describe("TR1 classification to route-local health", () => {
  it.each([
    "transient_throttle",
    "transient_provider",
    "transient_connection",
  ] as const)("opens a default route-local cooldown for %s", (kind) => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health);
    const route = executionRoute("route-a", "provider-a", "model-a");

    expect(projector.projectTransport({ route, classification: classification(kind), attribution: EXPECTED }))
      .toBe("cooldown_opened");
    expect(health.getRoute("route-a")?.cooldownUntilMs).toBe(31_000);
    expect(health.getProvider("provider-a")).toBeUndefined();
    expect(health.getModel("model-a")).toBeUndefined();
  });

  it.each([
    "authentication",
    "economic_quota",
    "context_overflow",
    "cancelled",
    "tool_failure",
    "incomplete_result",
    "unknown",
  ] as const)("does not mutate route health for %s", (kind) => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health);
    const route = executionRoute("route-a", "provider-a", "model-a");

    expect(projector.projectTransport({ route, classification: classification(kind), attribution: EXPECTED }))
      .toBe("none");
    expect(health.snapshot()).toEqual([]);
  });

  it("does not mutate health from an ambiguous transient classification", () => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health);
    expect(projector.projectTransport({
      route: executionRoute("route-a", "provider-a", "model-a"),
      classification: classification("transient_provider", { confidence: "ambiguous", evidence: "ambiguous" }),
      attribution: EXPECTED,
    })).toBe("none");
    expect(health.snapshot()).toEqual([]);
  });

  it("uses a shorter qualified retry hint and caps hostile excessive hints", () => {
    const route = executionRoute("route-a", "provider-a", "model-a");
    const shortHealth = new HealthRegistry(() => 1_000);
    const cappedHealth = new HealthRegistry(() => 1_000);

    new HealthProjector(shortHealth).projectTransport({
      route,
      classification: classification("transient_throttle", { retryAfterMs: 5_000 }),
      attribution: EXPECTED,
    });
    new HealthProjector(cappedHealth).projectTransport({
      route,
      classification: classification("transient_provider", { retryAfterMs: 90_000 }),
      attribution: EXPECTED,
    });

    expect(shortHealth.getRoute("route-a")?.cooldownUntilMs).toBe(6_000);
    expect(cappedHealth.getRoute("route-a")?.cooldownUntilMs).toBe(31_000);
  });

  it.each([-1, 0, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses the bounded default for invalid retry hint %s",
    (retryAfterMs) => {
      const health = new HealthRegistry(() => 1_000);
      new HealthProjector(health).projectTransport({
        route: executionRoute("route-a", "provider-a", "model-a"),
        classification: classification("transient_connection", { retryAfterMs }),
        attribution: EXPECTED,
      });
      expect(health.getRoute("route-a")?.cooldownUntilMs).toBe(31_000);
    },
  );

  it("requires exact attribution before opening cooldown", () => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health);
    const route = executionRoute("route-a", "provider-a", "model-a");

    expect(projector.projectTransport({
      route,
      classification: classification("transient_provider"),
      attribution: { ...EXPECTED, modelId: "model-b" },
    })).toBe("none");
    expect(health.snapshot()).toEqual([]);
  });

  it("expires exclusion without fabricating success or deleting the cooldown fact", () => {
    let now = 1_000;
    const health = new HealthRegistry(() => now);
    const route = executionRoute("route-a", "provider-a", "model-a");
    new HealthProjector(health).projectTransport({
      route,
      classification: classification("transient_throttle", { retryAfterMs: 5_000 }),
      attribution: EXPECTED,
    });

    now = 6_000;
    expect(health.isAvailable("route-a")).toBe(true);
    expect(health.getRoute("route-a")?.status).toBe("cooldown");
  });

  it.each(["stop", "toolUse"] as const)("clears only a matching proven %s success", (stopReason) => {
    const health = new HealthRegistry(() => 1_000);
    const projector = new HealthProjector(health);
    const route = executionRoute("route-a", "provider-a", "model-a");
    projector.projectTransport({
      route,
      classification: classification("transient_provider"),
      attribution: EXPECTED,
    });

    expect(projector.projectTransport({
      route,
      classification: classification("successful_result", { code: stopReason === "stop" ? "stop" : "tool_use" }),
      attribution: EXPECTED,
      terminal: { ...EXPECTED, stopReason },
    })).toBe("route_cleared");
    expect(health.getRoute("route-a")).toBeUndefined();
  });

  it("does not clear for length, wrong route, or unattributed success", () => {
    const route = executionRoute("route-a", "provider-a", "model-a");
    const cases = [
      {
        classification: classification("incomplete_result", { code: "length" }),
        terminal: { ...EXPECTED, stopReason: "length" },
      },
      {
        classification: classification("successful_result", { code: "stop" }),
        terminal: { ...EXPECTED, provider: "provider-b", stopReason: "stop" },
      },
      {
        classification: classification("successful_result", { code: "stop" }),
        terminal: { ...EXPECTED, invocationId: "task:main#other", stopReason: "stop" },
      },
      {
        classification: classification("successful_result", { code: "stop" }),
      },
    ] as const;

    for (const candidate of cases) {
      const health = new HealthRegistry(() => 1_000);
      const projector = new HealthProjector(health);
      projector.projectTransport({ route, classification: classification("transient_provider"), attribution: EXPECTED });
      expect(projector.projectTransport({ route, attribution: EXPECTED, ...candidate })).toBe("none");
      expect(health.isAvailable("route-a")).toBe(false);
    }
  });
});

describe("ordered Main route eligibility", () => {
  it("returns no fabricated fallback for a single-route configuration", () => {
    const [routeA] = decisions([staticRoute("a", "provider-a", "model-a")]);
    const eligibility = new MainRouteEligibility(new HealthRegistry(() => 0));

    expect(eligibility.alternatives({
      candidates: [routeA!],
      currentEndpoint: { provider: "provider-a", modelId: "model-a" },
      visitedEndpoints: new Set([transportEndpointKey("provider-a", "model-a")]),
    })).toEqual([]);
  });

  it("fails closed when a health snapshot omits a candidate route", () => {
    const candidates = decisions([staticRoute("b", "provider-a", "model-b")]);
    expect(projectEligibleMainAlternatives({
      candidates,
      currentEndpoint: { provider: "provider-a", modelId: "model-a" },
      visitedEndpoints: new Set(),
      routeAvailability: new Map(),
    })).toEqual([]);
  });

  it("returns the next model for one provider without requiring account identity", () => {
    const candidates = decisions([
      staticRoute("a", "provider-a", "model-a"),
      staticRoute("b", "provider-a", "model-b"),
    ]);
    const eligibility = new MainRouteEligibility(new HealthRegistry(() => 0));

    expect(eligibility.alternatives({
      candidates,
      currentEndpoint: { provider: "provider-a", modelId: "model-a" },
      visitedEndpoints: new Set([transportEndpointKey("provider-a", "model-a")]),
    }).map((candidate) => candidate.routeId)).toEqual(["b"]);
  });

  it("preserves configured order across providers while filtering health and visits", () => {
    const candidates = decisions([
      staticRoute("a", "provider-1", "model-1"),
      staticRoute("b", "provider-1", "model-2"),
      staticRoute("c", "provider-2", "model-3"),
    ]);
    const health = new HealthRegistry(() => 1_000);
    health.recordRoute("b", { status: "cooldown", cooldownMs: 30_000 });
    const eligibility = new MainRouteEligibility(health);

    expect(eligibility.alternatives({
      candidates,
      currentEndpoint: { provider: "provider-1", modelId: "model-1" },
      visitedEndpoints: new Set([transportEndpointKey("provider-1", "model-1")]),
    }).map((candidate) => candidate.routeId)).toEqual(["c"]);
  });

  it("never revisits an endpoint even after its cooldown expires", () => {
    let now = 1_000;
    const candidates = decisions([
      staticRoute("a", "provider-a", "model-a"),
      staticRoute("b", "provider-a", "model-b"),
    ]);
    const health = new HealthRegistry(() => now);
    health.recordRoute("a", { status: "cooldown", cooldownMs: 5_000 });
    const eligibility = new MainRouteEligibility(health);
    const visited = new Set([
      transportEndpointKey("provider-a", "model-a"),
      transportEndpointKey("provider-a", "model-b"),
    ]);

    now = 6_000;
    expect(eligibility.alternatives({
      candidates,
      currentEndpoint: { provider: "provider-a", modelId: "model-b" },
      visitedEndpoints: visited,
    })).toEqual([]);
  });

  it("shares health within one runtime wrapper but not across registry replacement", () => {
    const candidates = decisions([
      staticRoute("a", "provider-a", "model-a"),
      staticRoute("b", "provider-a", "model-b"),
    ]);
    const firstHealth = new HealthRegistry(() => 0);
    firstHealth.recordRoute("b", { status: "cooldown", cooldownMs: 30_000 });
    const input = {
      candidates,
      currentEndpoint: { provider: "provider-a", modelId: "model-a" },
      visitedEndpoints: new Set([transportEndpointKey("provider-a", "model-a")]),
    } as const;

    expect(new MainRouteEligibility(firstHealth).alternatives(input)).toEqual([]);
    expect(new MainRouteEligibility(new HealthRegistry(() => 0)).alternatives(input).map((candidate) => candidate.routeId))
      .toEqual(["b"]);
  });

  it("has no execution-authority dependencies", () => {
    const source = readFileSync(join(process.cwd(), "src", "recovery", "main-route-eligibility.ts"), "utf8");
    expect(source).not.toMatch(/main-model-controller|pi-compatibility-adapter|completion-authority|pi-accounts-adapter|runtime-recovery-executor/);
    expect(source).not.toMatch(/\bsetModel\s*\(/);
    expect(source).not.toMatch(/follow_up|sendUserMessage|continueSession/);
    expect(source).not.toMatch(/fallbacksLeft|retriesLeft/);
  });
});
