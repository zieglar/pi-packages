import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { describe, expect, it, vi } from "vitest";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import { PiAdvisorAdapter } from "../src/adapters/pi-advisor-adapter.js";
import type { NestedInvoker } from "../src/runtime/nested-invoker.js";
import type { NestedModelOutput } from "../src/runtime/ports.js";
import { buildAdvisorDiagnosticRecord, readAdvisorFailureDiagnostic } from "../src/trace/advisor-diagnostics.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";
import type { Failure } from "../src/types/result.js";

const request = { provider: "anthropic", modelId: "claude-sonnet-4-20250514", thinking: "high" as const, prompt: "synthetic prompt must never persist", budgetLimit: 800 };
const model: Model<"anthropic-messages"> = {
  id: request.modelId, name: "offline Pi 1.0.2 audit", api: "anthropic-messages", provider: "anthropic",
  baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 32000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { forceAdaptiveThinking: false },
};

function installedPiHarness() {
  let prepared: Record<string, unknown> | undefined;
  let observerReturn: unknown;
  let payloadUnchanged = false;
  // This injected transport always throws before any real network operation.
  const offlineFetch = vi.fn(async () => { throw new Error("synthetic offline transport failure"); });
  const stream = vi.fn((selected: Model<"anthropic-messages">, context: TranscriptContext, options?: SimpleStreamOptions) => streamSimple(selected, context, {
    ...options, apiKey: "synthetic-not-a-real-credential", maxRetries: 0, fetch: offlineFetch,
    onPayload: async (payload, selectedModel) => {
      const before = JSON.stringify(payload);
      prepared = payload as Record<string, unknown>;
      observerReturn = await options?.onPayload?.(payload, selectedModel);
      payloadUnchanged = before === JSON.stringify(payload);
      return undefined;
    },
  }));
  const ctx = { modelRegistry: { find: () => model, streamSimple: stream } };
  return {
    adapter: new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext),
    stream, offlineFetch, payload: () => prepared, observerReturn: () => observerReturn,
    payloadUnchanged: () => payloadUnchanged,
  };
}

async function diagnosticForInvalid(output: NestedModelOutput) {
  const parent = createInvocation({ invocationId: invocationId("main"), taskId: taskId("task"), role: "main", maxDepth: 2, budgetLimit: 800 });
  const child = parent.deriveChild({ invocationId: invocationId("advisor"), role: "advisor", budgetLimit: 800 });
  if (!child.ok) throw new Error("expected child");
  const invoker = { invoke: async () => ({ ok: true as const, value: { child: child.context, output, trace: [],
    decision: { routeId: routeId("advisor"), provider: request.provider, modelId: request.modelId, tier: "balanced" as const,
      thinking: "high" as const, capabilityId: capabilityId("advisor"), budget: { limit: 800 } },
  } }) };
  const reviewed = await new PiAdvisorAdapter(invoker as unknown as NestedInvoker).review({ parent, invocationId: invocationId("advisor"), budgetLimit: 800,
    evidence: { objective: "audit", completionCriteria: "pass", implementationSummary: "done", changedPaths: [], diffSummary: "", validations: [], workerFindings: [], unresolved: [], workspaceDigest: "b".repeat(64), extra: {} } });
  if (reviewed.ok) throw new Error("expected invalid JSON");
  expect(reviewed.failure.code).toBe("invalid_advisor_verdict");
  return buildAdvisorDiagnosticRecord({ invocationId: "advisor", candidateDigest: "a".repeat(64), candidateRevision: 1,
    workspaceDigest: "b".repeat(64), ...readAdvisorFailureDiagnostic(reviewed.failure), parseValid: false });
}

function diagnosticForTransportFailure(failure: Failure) {
  return buildAdvisorDiagnosticRecord({ invocationId: "advisor", candidateDigest: "a".repeat(64), candidateRevision: 1,
    workspaceDigest: "b".repeat(64), ...readAdvisorFailureDiagnostic(failure), parseValid: false });
}

describe("installed Pi 1.0.2 Advisor token and usage contract", () => {
  it("distinguishes the 800 logical allowance / SDK option from the transformed prepared cap", async () => {
    const harness = installedPiHarness();
    const result = await harness.adapter.stream(request);
    expect(result.ok).toBe(false); // Pi resolves its error-terminal message; TR1 must not treat it as success.
    if (result.ok) throw new Error("expected typed transport failure");
    expect(result.failure.kind).toBe("provider");
    expect(result.failure.code).toBe("transport_stream_error");
    expect(harness.payload()?.max_tokens).toBe(17184);
    expect(harness.payload()?.thinking).toMatchObject({ type: "enabled", budget_tokens: 16160 });
    expect(harness.stream.mock.calls[0]?.[2]).toMatchObject({ reasoning: "high", maxTokens: 800 });
    const diagnostic = diagnosticForTransportFailure(result.failure);
    expect(diagnostic.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800,
      preparedMaxTokens: 17184, preparedMaxTokensField: "max_tokens" });
    expect(diagnostic.stopReason).toBe("error");
    expect(diagnostic.stream).toBe("resolved");
    expect(harness.offlineFetch).toHaveBeenCalledTimes(1);
    expect(harness.observerReturn()).toBeUndefined();
    expect(harness.payloadUnchanged()).toBe(true);
    expect(JSON.stringify(diagnostic)).not.toContain(request.prompt);
    expect(JSON.stringify(diagnostic)).not.toContain("synthetic offline transport failure");
  });

  it("omits provider usage when Pi initializes zeros without receiving provider usage", async () => {
    const harness = installedPiHarness();
    const result = await harness.adapter.stream(request);
    if (result.ok) throw new Error("expected typed transport failure");
    expect(result.failure.kind).toBe("provider");
    expect(result.failure.code).toBe("transport_stream_error");
    const diagnostic = diagnosticForTransportFailure(result.failure);
    expect(diagnostic.usage).toBeUndefined();
    expect(diagnostic.stopReason).toBe("error");
    expect(diagnostic.stream).toBe("resolved");
  });

  it("does not infer provider provenance from nonzero SDK counters", async () => {
    const diagnostic = await diagnosticForInvalid({ text: "not-json", usage: { inputTokens: 9, outputTokens: 8 } });
    expect(diagnostic.usage).toBeUndefined();
  });

  it("does not invent a prepared cap when the runtime never exposes a payload", async () => {
    const ctx = { modelRegistry: { find: () => model, streamSimple: () => ({ result: async () => ({ content: [], stopReason: "stop", usage: { input: 0, output: 0 } }) }) } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    if (!result.ok) throw new Error("expected success");
    const diagnostic = await diagnosticForInvalid(result.value);
    expect(diagnostic.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
  });

  it.each([
    { max_tokens: "Authorization: Bearer synthetic", unknown: "hidden reasoning" },
    { max_tokens: -1 }, { max_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { max_tokens: 800, max_output_tokens: 900 }, { private_cap: 17184 }, null,
  ])("omits malformed, ambiguous, or unknown payload caps %j", async (payload) => {
    const ctx = { modelRegistry: { find: () => model, streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
      expect(options.onPayload?.(payload, model)).toBeUndefined();
      return { result: async () => ({ content: [], stopReason: "stop", usage: { input: 0, output: 0 } }) };
    } } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    if (!result.ok) throw new Error("expected original success");
    const diagnostic = await diagnosticForInvalid(result.value);
    expect(diagnostic.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
    expect(JSON.stringify(diagnostic)).not.toContain("Authorization");
    expect(JSON.stringify(diagnostic)).not.toContain("hidden reasoning");
  });

  it("a malformed or throwing prepared-payload observation cannot reject a runtime success", async () => {
    let observerReturn: unknown = "not-called";
    const ctx = { modelRegistry: { find: () => model, streamSimple: (_model: unknown, _context: unknown, options: SimpleStreamOptions) => {
      const payload = { get max_tokens(): never { throw new Error("synthetic payload observer failure"); } };
      observerReturn = options.onPayload?.(payload, model);
      return { result: async () => ({ content: [{ type: "text", text: "not-json" }], stopReason: "stop", usage: { input: 0, output: 0 } }) };
    } } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    expect(result.ok).toBe(true);
    expect(observerReturn).toBeUndefined();
    if (!result.ok) throw new Error("expected original success");
    const diagnostic = await diagnosticForInvalid(result.value);
    expect(diagnostic.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
  });
});
