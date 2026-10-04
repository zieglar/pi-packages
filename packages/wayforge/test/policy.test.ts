import { describe, expect, it } from "vitest";
import { CapabilityCatalog } from "../src/kernel/capability-catalog.js";
import { RolePolicy, type RoleRule } from "../src/policy/role-policy.js";
import {
  ModelPolicy,
  type StaticModelRoute,
} from "../src/policy/model-policy.js";
import { capabilityId, routeId, taskId } from "../src/types/identity.js";

const CAP_MAIN = capabilityId("cap-main");
const CAP_NESTED = capabilityId("cap-nested");
const CAP_ADVISOR = capabilityId("cap-advisor");
const CAP_STREAM_ONLY = capabilityId("cap-stream-only");

const rules: readonly RoleRule[] = [
  {
    role: "main",
    capabilityId: CAP_MAIN,
    allowNested: true,
    needsStreaming: true,
    needsReasoning: true,
    needsTools: true,
    budgetLimit: 1000,
  },
  {
    role: "worker",
    capabilityId: CAP_NESTED,
    allowNested: false,
    needsStreaming: true,
    needsReasoning: false,
    needsTools: true,
    budgetLimit: 200,
  },
  {
    role: "advisor",
    capabilityId: CAP_ADVISOR,
    allowNested: false,
    needsStreaming: true,
    needsReasoning: true,
    needsTools: false,
    budgetLimit: 50,
  },
];

const routes: readonly StaticModelRoute[] = [
  {
    routeId: routeId("route-flagship"),
    provider: "anthropic",
    modelId: "claude-opus-4",
    tier: "flagship",
    thinking: "high",
    capabilityId: CAP_MAIN,
    budgetLimit: 1000,
  },
  {
    routeId: routeId("route-fast"),
    provider: "anthropic",
    modelId: "claude-haiku",
    tier: "fast",
    thinking: "minimal",
    capabilityId: CAP_NESTED,
    budgetLimit: 200,
  },
  {
    routeId: routeId("route-advisor"),
    provider: "openai",
    modelId: "gpt-5",
    tier: "balanced",
    thinking: "medium",
    capabilityId: CAP_ADVISOR,
    budgetLimit: 50,
  },
];

const rolePolicy = new RolePolicy(rules);
const modelPolicy = new ModelPolicy(routes);

describe("static capability catalog", () => {
  it("describes tools, streaming, reasoning, nesting, and role eligibility", () => {
    const cap = CapabilityCatalog.get(CAP_MAIN);
    expect(cap).toMatchObject({
      id: CAP_MAIN,
      streaming: true,
      reasoning: true,
      tools: true,
      allowNestedInvocation: true,
      workerEligible: false,
      advisorEligible: false,
    });
  });

  it("exposes restricted providers and models", () => {
    const cap = CapabilityCatalog.get(CAP_STREAM_ONLY);
    expect(cap?.allowedProviders).toEqual(["anthropic"]);
    expect(cap?.allowedModels).toEqual(["claude-haiku"]);
    expect(cap?.allowNestedInvocation).toBe(false);
  });

  it("knows which capabilities are worker or advisor eligible", () => {
    expect(CapabilityCatalog.get(CAP_NESTED)?.workerEligible).toBe(true);
    expect(CapabilityCatalog.get(CAP_ADVISOR)?.advisorEligible).toBe(true);
    expect(CapabilityCatalog.get(CAP_MAIN)?.workerEligible).toBe(false);
    expect(CapabilityCatalog.get(CAP_MAIN)?.advisorEligible).toBe(false);
  });

  it("reports unknown capabilities without guessing", () => {
    expect(CapabilityCatalog.has(capabilityId("cap-unknown"))).toBe(false);
    expect(CapabilityCatalog.get(capabilityId("cap-unknown"))).toBeUndefined();
  });

  it("is a static, frozen catalog", () => {
    expect(Object.isFrozen(CapabilityCatalog.all())).toBe(true);
  });
});

describe("role policy", () => {
  it("resolves a role into a separate execution requirement", () => {
    const result = rolePolicy.resolve({ role: "worker", taskId: taskId("t-1") });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.requirement).toEqual({
      role: "worker",
      taskId: "t-1",
      capabilityId: CAP_NESTED,
      allowNested: false,
      needsStreaming: true,
      needsReasoning: false,
      needsTools: true,
      budgetLimit: 200,
    });
  });

  it("fails deterministically for an unknown role", () => {
    const result = rolePolicy.resolve({
      role: "subagent" as never,
      taskId: taskId("t-2"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("unknown_role");
  });
});

describe("model policy", () => {
  it("resolves a requirement into a model decision with tier and thinking", () => {
    const req = rolePolicy.resolve({ role: "advisor", taskId: taskId("t-3") });
    if (!req.ok) throw new Error("expected ok");
    const decision = modelPolicy.resolve(req.requirement, CapabilityCatalog);
    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error("expected ok");
    expect(decision.decision).toEqual({
      routeId: "route-advisor",
      provider: "openai",
      modelId: "gpt-5",
      tier: "balanced",
      thinking: "medium",
      capabilityId: CAP_ADVISOR,
      budget: { limit: 50 },
    });
  });

  it("returns the route matching the requirement capability", () => {
    const req = rolePolicy.resolve({ role: "main", taskId: taskId("t-4") });
    if (!req.ok) throw new Error("expected ok");
    const decision = modelPolicy.resolve(req.requirement, CapabilityCatalog);
    expect(decision.ok && decision.decision.routeId).toBe("route-flagship");
    expect(decision.ok && decision.decision.provider).toBe("anthropic");
    expect(decision.ok && decision.decision.modelId).toBe("claude-opus-4");
  });

  it("fails with no_route when no route carries the required capability", () => {
    const req = rolePolicy.resolve({ role: "worker", taskId: taskId("t-5") });
    if (!req.ok) throw new Error("expected ok");
    const policy = new ModelPolicy([
      { ...routes[0]!, capabilityId: CAP_MAIN },
      { ...routes[2]!, capabilityId: CAP_ADVISOR },
    ]);
    const decision = policy.resolve(req.requirement, CapabilityCatalog);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected failure");
    expect(decision.failure.kind).toBe("no_route");
  });

  it("fails with capability_mismatch when the route cannot satisfy the requirement", () => {
    const req = rolePolicy.resolve({ role: "worker", taskId: taskId("t-6") });
    if (!req.ok) throw new Error("expected ok");
    // Route serves the nested capability, but catalog facts say it lacks tools,
    // which the worker requirement needs.
    const notoolsCatalog = {
      has: () => true,
      get: (id: string) =>
        id === CAP_NESTED
          ? {
              id: CAP_NESTED,
              tools: false,
              streaming: true,
              reasoning: false,
              allowNestedInvocation: false,
              workerEligible: true,
              advisorEligible: false,
            }
          : undefined,
      all: () => [],
    };
    const decision = modelPolicy.resolve(req.requirement, notoolsCatalog);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected failure");
    expect(decision.failure.kind).toBe("capability_mismatch");
    if (decision.ok) throw new Error("unreachable");
    if (!("reason" in decision.failure)) throw new Error("unreachable");
    expect(decision.failure.reason).toContain("tools");
  });

  it("enforces provider and model restrictions from the catalog", () => {
    const req = rolePolicy.resolve({ role: "worker", taskId: taskId("t-7") });
    if (!req.ok) throw new Error("expected ok");
    // Route serves the nested capability on a provider/model the capability forbids.
    const decision = new ModelPolicy([
      {
        routeId: routeId("route-wrong-provider"),
        provider: "openai",
        modelId: "gpt-5",
        tier: "fast",
        thinking: "minimal",
        capabilityId: CAP_NESTED,
        budgetLimit: 200,
      },
    ]).resolve(req.requirement, {
      has: () => true,
      get: (id: string) =>
        id === CAP_NESTED
          ? {
              id: CAP_NESTED,
              tools: true,
              streaming: true,
              reasoning: false,
              allowedProviders: ["anthropic"],
              allowedModels: ["claude-haiku"],
              allowNestedInvocation: false,
              workerEligible: true,
              advisorEligible: false,
            }
          : undefined,
      all: () => [],
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("expected failure");
    expect(decision.failure.kind).toBe("capability_mismatch");
    if (decision.failure.kind !== "capability_mismatch") throw new Error("unreachable");
    expect(decision.failure.reason).toContain("openai");
  });

  it("never calls a provider during resolution", () => {
    const req = rolePolicy.resolve({ role: "main", taskId: taskId("t-8") });
    if (!req.ok) throw new Error("expected ok");
    // Resolution must be synchronous and pure: no awaits, no I/O.
    const decision = modelPolicy.resolve(req.requirement, CapabilityCatalog);
    expect(decision.ok).toBe(true);
  });
});
