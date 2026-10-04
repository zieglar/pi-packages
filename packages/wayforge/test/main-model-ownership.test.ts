import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MainModelController } from "../src/runtime/main-model-controller.js";
import type { MainSessionModelPort } from "../src/runtime/ports.js";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import type { ModelDecision } from "../src/policy/model-policy.js";
import { routeId } from "../src/types/identity.js";
import { capabilityId } from "../src/types/identity.js";
import { failure } from "../src/types/result.js";

const decision: ModelDecision = {
  routeId: routeId("route-flagship"),
  provider: "anthropic",
  modelId: "claude-opus-4",
  tier: "flagship",
  thinking: "high",
  capabilityId: capabilityId("cap-main"),
  budget: { limit: 1000 },
};

describe("main model ownership guard", () => {
  it("rejects model mutation for non-main roles without touching the port", async () => {
    const applyModelDecision = vi.fn();
    const port: MainSessionModelPort = { applyModelDecision };
    const controller = new MainModelController(port);
    const workerResult = await controller.applyModelDecision({ role: "worker", decision });
    const advisorResult = await controller.applyModelDecision({ role: "advisor", decision });
    expect(workerResult.ok).toBe(false);
    if (!workerResult.ok) {
      expect(workerResult.failure.kind).toBe("capability");
      expect(workerResult.failure.code).toBe("non_main_role");
    }
    expect(advisorResult.ok).toBe(false);
    expect(applyModelDecision).not.toHaveBeenCalled();
  });

  it("applies an already-resolved decision for the main role exactly once", async () => {
    const applyModelDecision = vi.fn(async () => ({ ok: true as const, value: { provider: "anthropic", modelId: "claude-opus-4" } }));
    const controller = new MainModelController({ applyModelDecision });
    const result = await controller.applyModelDecision({ role: "main", decision });
    expect(result.ok).toBe(true);
    expect(applyModelDecision).toHaveBeenCalledTimes(1);
    expect(applyModelDecision).toHaveBeenCalledWith(decision);
  });

  it("returns the typed failure from the port unchanged", async () => {
    const authFailure = failure({
      kind: "authentication",
      scope: "account",
      confidence: "certain",
      code: "model_auth_not_configured",
      message: "no credentials for provider",
    });
    const controller = new MainModelController({
      applyModelDecision: async () => authFailure,
    });
    const result = await controller.applyModelDecision({ role: "main", decision });
    expect(result).toEqual(authFailure);
  });
});

describe("pi compatibility adapter (sentinel parent-session path)", () => {
  const fakeModel = { id: "claude-opus-4", api: "anthropic" } as never;

  function makePi(opts: { found?: boolean; setModelResult?: boolean } = {}) {
    const pi = {
      setModel: vi.fn(async () => opts.setModelResult ?? true),
    };
    const ctx = {
      modelRegistry: {
        find: vi.fn(() => (opts.found === false ? undefined : fakeModel)),
      },
    };
    return { pi: pi as unknown as ExtensionAPI, ctx: ctx as unknown as ExtensionContext, piSpy: pi.setModel, findSpy: ctx.modelRegistry.find };
  }

  it("delegates parent model mutation through pi.setModel with registry lookup", async () => {
    const { pi, ctx, piSpy, findSpy } = makePi();
    const adapter = new PiCompatibilityAdapter(pi, ctx);
    const result = await adapter.applyModelDecision(decision);
    expect(result.ok).toBe(true);
    expect(findSpy).toHaveBeenCalledWith("anthropic", "claude-opus-4");
    expect(piSpy).toHaveBeenCalledTimes(1);
    expect(piSpy).toHaveBeenCalledWith(fakeModel);
  });

  it("fails with a typed provider failure when the model is unknown", async () => {
    const { pi, ctx, piSpy } = makePi({ found: false });
    const adapter = new PiCompatibilityAdapter(pi, ctx);
    const result = await adapter.applyModelDecision(decision);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("provider");
    expect(result.failure.code).toBe("model_not_found");
    expect(piSpy).not.toHaveBeenCalled();
  });

  it("maps a false setModel result to an authentication failure", async () => {
    const { pi, ctx } = makePi({ setModelResult: false });
    const adapter = new PiCompatibilityAdapter(pi, ctx);
    const result = await adapter.applyModelDecision(decision);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure.kind).toBe("authentication");
  });
});
