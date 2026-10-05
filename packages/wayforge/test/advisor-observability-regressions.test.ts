import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiAdvisorAdapter, parseVerdict } from "../src/adapters/pi-advisor-adapter.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import type { NestedInvoker } from "../src/runtime/nested-invoker.js";
import type { NestedModelOutput } from "../src/runtime/ports.js";
import { scheduleSuspension } from "../src/recovery/suspension.js";
import { normalizeError, type Failure } from "../src/types/result.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";
import { buildAdvisorDiagnosticRecord, readAdvisorFailureDiagnostic } from "../src/trace/advisor-diagnostics.js";

const verdict = { status: "approve", summary: "ready", findings: [] };
const approval = JSON.stringify(verdict);
const request = { provider: "sentinel", modelId: "local", thinking: "high" as const, prompt: "synthetic", budgetLimit: 800 };
const evidence = {
  objective: "review", completionCriteria: "pass", implementationSummary: "done",
  changedPaths: [], diffSummary: "", validations: [], workerFindings: [], unresolved: [],
  workspaceDigest: "digest", extra: {},
};

function runtime(message: unknown) {
  const ctx = { modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => message }) } };
  return new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext);
}

async function review(output: NestedModelOutput) {
  const parent = createInvocation({ invocationId: invocationId("main"), taskId: taskId("task"), role: "main", maxDepth: 2, budgetLimit: 800 });
  const child = parent.deriveChild({ invocationId: invocationId("advisor"), role: "advisor", budgetLimit: 800 });
  if (!child.ok) throw new Error("expected child");
  const invoker = { invoke: async () => ({ ok: true as const, value: {
    child: child.context, output, trace: [],
    decision: { routeId: routeId("advisor"), provider: "sentinel", modelId: "local", tier: "balanced" as const,
      thinking: "high" as const, capabilityId: capabilityId("advisor"), budget: { limit: 800 } },
  } }) };
  return new PiAdvisorAdapter(invoker as unknown as NestedInvoker).review({ parent, invocationId: invocationId("advisor"), budgetLimit: 800, evidence });
}

function message(content: unknown[]) {
  return { content, usage: { input: 1, output: 1 }, stopReason: "stop" };
}

// Preserve the extraction operation that existed before response diagnostics.
function originalText(content: { type?: unknown; text?: unknown }[]) {
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

describe("diagnostic construction cannot cross authoritative boundaries", () => {
  it("still approves valid JSON followed by a text block with no text", async () => {
    const content = [{ type: "text", text: approval }, { type: "text" }];
    expect(parseVerdict(originalText(content))).toEqual(verdict);
    const streamed = await runtime(message(content)).stream(request);
    expect(streamed.ok).toBe(true);
    if (!streamed.ok) throw new Error("expected original success");
    const reviewed = await review(streamed.value);
    expect(reviewed.ok && reviewed.value.verdict).toEqual(verdict);
  });

  it.each([null, { stopReason: "stop", blocks: null }, { stopReason: "stop", blocks: {}, text: null }])(
    "keeps invalid_advisor_verdict with malformed observation %j", async (observed) => {
      const reviewed = await review({ text: "not-json", usage: { inputTokens: 1, outputTokens: 1 }, observed } as unknown as NestedModelOutput);
      expect(reviewed.ok).toBe(false);
      if (!reviewed.ok) expect(reviewed.failure).toMatchObject({ kind: "validation", scope: "invocation", confidence: "certain", code: "invalid_advisor_verdict" });
    },
  );

  it("omits observations when reading a diagnostic-only terminal property throws", async () => {
    const response = message([{ type: "text", text: approval }]);
    Object.defineProperty(response, "stopReason", { get() { throw new Error("synthetic diagnostic construction failure"); } });
    const streamed = await runtime(response).stream(request);
    expect(streamed.ok).toBe(true);
    if (streamed.ok) {
      expect(streamed.value.observed).toBeUndefined();
      expect((await review(streamed.value)).ok).toBe(true);
    }
  });

  it("keeps invalid typed failure when diagnostic-only observation access throws", async () => {
    const observed = { get blocks(): never { throw new Error("synthetic observation getter failure"); } };
    const reviewed = await review({ text: "not-json", usage: { inputTokens: 1, outputTokens: 1 }, observed } as unknown as NestedModelOutput);
    expect(reviewed.ok).toBe(false);
    if (!reviewed.ok) expect(reviewed.failure.code).toBe("invalid_advisor_verdict");
  });

  it("omits a diagnostic classifier exception without changing extracted approval", async () => {
    let reads = 0;
    const unknownBlock = { get type() { if (++reads > 1) throw new Error("synthetic block classifier failure"); return "unknown"; } };
    const streamed = await runtime(message([{ type: "text", text: approval }, unknownBlock])).stream(request);
    expect(streamed.ok).toBe(true);
    if (streamed.ok) expect((await review(streamed.value)).ok).toBe(true);
  });

  it("keeps unknown block shapes observational and never stores their raw values", async () => {
    const streamed = await runtime(message([{ type: "text", text: approval }, { type: "Authorization: Basic synthetic" }, { type: 42 }, "primitive", 7])).stream(request);
    expect(streamed.ok).toBe(true);
    if (streamed.ok) {
      expect((await review(streamed.value)).ok).toBe(true);
      expect(streamed.value.observed?.blocks).toEqual({ text: 1, thinking: 0, toolCall: 0, other: 4 });
      expect(JSON.stringify(streamed.value.observed)).not.toContain("Authorization");
    }
  });

  it("does not repair a pre-existing extraction failure on a null block", async () => {
    const streamed = await runtime(message([null])).stream(request);
    expect(streamed.ok).toBe(false);
    if (!streamed.ok) expect(streamed.failure.code).toBe("unknown");
  });
});

describe("diagnostic augmentation preserves semantic failure metadata", () => {
  it("preserves quota-window metadata, existing diagnostic keys, and the entire suspension projection", async () => {
    const cause: Failure = { kind: "usage_limit", scope: "account", confidence: "certain", code: "quota", message: "quota exhausted",
      metadata: { quotaWindowReliable: true, quotaWindowResetAtMs: 9000, semanticMarker: "retained", diagStream: "existing_observation" } };
    const ctx = { modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => { throw cause; } }) } };
    const streamed = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    expect(streamed.ok).toBe(false);
    if (streamed.ok) throw new Error("expected failure");
    const before = normalizeError(cause);
    expect(streamed.failure).toMatchObject(before);
    expect(streamed.failure.metadata?.diagStream).toBe("existing_observation");
    const context = { nowMs: 1000, routeKey: "route", modelKey: "model", providerKey: "provider", maxChecks: 2,
      safeAvailabilityProbe: false, availabilityProbeDelayMs: 100, boundedContinuationDelayMs: 200, maxScheduleDelayMs: 10000 };
    const original = scheduleSuspension(before, context);
    const augmented = scheduleSuspension(streamed.failure, context);
    expect(original?.strategy).toBe("known_quota_window");
    expect(augmented?.resumeNotBeforeMs).toBe(9000);
    // Remove only the newly added diagnostic keys, not any pre-existing metadata.
    const added = new Set(Object.keys(streamed.failure.metadata ?? {}).filter((key) => !(key in (before.metadata ?? {}))));
    if (augmented === null) throw new Error("expected suspension");
    const metadata = Object.fromEntries(Object.entries(augmented.originatingFailure.metadata ?? {}).filter(([key]) => !added.has(key)));
    expect({ ...augmented, originatingFailure: { ...augmented.originatingFailure, metadata } }).toEqual(original);
  });

  it("does not displace semantic keys from the existing bounded suspension metadata projection", async () => {
    const metadata = Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`a${index}`, index]));
    const cause: Failure = { kind: "usage_limit", scope: "account", confidence: "certain", code: "quota", message: "quota exhausted",
      metadata: { ...metadata, quotaWindowReliable: true, quotaWindowResetAtMs: 9000 } };
    const ctx = { modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => { throw cause; } }) } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    if (result.ok) throw new Error("expected failure");
    const context = { nowMs: 1000, routeKey: "route", modelKey: "model", providerKey: "provider", maxChecks: 2,
      safeAvailabilityProbe: false, availabilityProbeDelayMs: 100, boundedContinuationDelayMs: 200, maxScheduleDelayMs: 10000 };
    expect(scheduleSuspension(result.failure, context)?.originatingFailure.metadata).toMatchObject(cause.metadata!);
    expect(scheduleSuspension(result.failure, context)).toEqual(scheduleSuspension(normalizeError(cause), context));
  });

  it("does not treat preserved numeric diagnostic keys as provider provenance", () => {
    const cause: Failure = { kind: "provider", scope: "provider", confidence: "certain", code: "offline", message: "synthetic failure",
      metadata: { diagInputTokens: 11, diagOutputTokens: 12 } };
    const record = buildAdvisorDiagnosticRecord({ invocationId: "advisor", candidateDigest: "a".repeat(64),
      candidateRevision: 1, workspaceDigest: "b".repeat(64), ...readAdvisorFailureDiagnostic(cause), parseValid: false });
    expect(record.usage).toBeUndefined();
  });

  it("does not promote pre-existing diagnostic-key collisions into raw reasoning or provider usage", async () => {
    const cause: Failure = { kind: "provider", scope: "provider", confidence: "certain", code: "offline", message: "synthetic failure",
      metadata: { diagReasoning: "hidden reasoning PRIVATE_SENTINEL", diagStream: "rejected", diagInputTokens: 11, diagOutputTokens: 12 } };
    const ctx = { modelRegistry: { find: () => ({}), streamSimple: () => ({ result: async () => { throw cause; } }) } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request);
    if (result.ok) throw new Error("expected failure");
    expect(result.failure).toMatchObject(cause);
    const record = buildAdvisorDiagnosticRecord({ invocationId: "advisor", candidateDigest: "a".repeat(64),
      candidateRevision: 1, workspaceDigest: "b".repeat(64), ...readAdvisorFailureDiagnostic(result.failure), parseValid: false });
    expect(record.request.reasoning).toBe("high"); // Current invocation, not the preserved collision.
    expect(record.usage).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain("PRIVATE_SENTINEL");
  });
});
