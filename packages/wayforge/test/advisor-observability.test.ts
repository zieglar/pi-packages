import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseVerdict,
  parseVerdictWithRejection,
  PiAdvisorAdapter,
} from "../src/adapters/pi-advisor-adapter.js";
import { PiCompatibilityAdapter } from "../src/runtime/pi-compatibility-adapter.js";
import { createInvocation } from "../src/kernel/invocation-context.js";
import type { NestedInvoker } from "../src/runtime/nested-invoker.js";
import { success } from "../src/types/result.js";
import {
  ADVISOR_DIAGNOSTIC_SCHEMA_VERSION,
  advisorDiagnosticRecordIsSafe,
  buildAdvisorDiagnosticRecord,
  buildTextStats,
  classifyContentBlocks,
  classifyStopReason,
} from "../src/trace/advisor-diagnostics.js";
import { capabilityId, invocationId, routeId, taskId } from "../src/types/identity.js";

function parent() {
  return createInvocation({
    invocationId: invocationId("main"),
    taskId: taskId("task"),
    role: "main",
    maxDepth: 2,
    budgetLimit: 100,
  });
}

function fakeInvoker(output: { text: string; stopReason?: string; usage?: { inputTokens: number; outputTokens: number } }) {
  const root = parent();
  const child = root.deriveChild({ invocationId: invocationId("advisor"), role: "advisor", budgetLimit: 25 });
  if (!child.ok) throw new Error("expected child");
  const invoke = vi.fn(async () =>
    success({
      child: child.context,
      decision: {
        routeId: routeId("advisor-route"),
        provider: "sentinel",
        modelId: "advisor-model",
        tier: "balanced" as const,
        thinking: "high" as const,
        capabilityId: capabilityId("advisor-cap"),
        budget: { limit: 25 },
      },
      output: {
        text: output.text,
        usage: output.usage ?? { inputTokens: 4, outputTokens: 5 },
        ...(output.stopReason !== undefined
          ? {
              observed: {
                stopReason: classifyStopReason(output.stopReason),
                blocks: { text: 1, thinking: 0, toolCall: 0, other: 0 },
                text: buildTextStats([output.text]),
              },
            }
          : {}),
      },
      trace: [],
    }),
  );
  return { invoker: { invoke } as unknown as NestedInvoker, invoke };
}

const evidence = {
  objective: "review",
  completionCriteria: "pass",
  implementationSummary: "done",
  changedPaths: ["src/a.ts"],
  diffSummary: "diff",
  validations: [{ name: "test", ok: true, summary: "ok" }],
  workerFindings: [],
  unresolved: [],
  workspaceDigest: "digest",
  extra: {},
};

const CORPUS: readonly string[] = [
  JSON.stringify({ status: "approve", summary: "ready", findings: [] }),
  JSON.stringify({
    status: "changes_requested",
    summary: "needs work",
    findings: [{ code: "bug", severity: "blocker", summary: "broken", path: "src/a.ts" }],
  }),
  JSON.stringify({
    status: "unable",
    summary: "cannot decide",
    findings: Array.from({ length: 20 }, (_v, i) => ({ code: `c${i}`, severity: "note", summary: `s${i}` })),
  }),
  JSON.stringify({
    status: "approve",
    summary: "x".repeat(4_500),
    findings: [{ code: "c".repeat(250), severity: "warning", summary: "s".repeat(2_100), path: "p".repeat(600) }],
  }),
  // not_json
  "not-json",
  "",
  "   ",
  "```json\n{\"status\":\"approve\",\"summary\":\"s\",\"findings\":[]}\n```",
  "{status:approve}",
  // not_object
  "null",
  "42",
  "\"approve\"",
  "[]",
  // forbidden_keys
  JSON.stringify({ status: "approve", summary: "s", findings: [], extra: 1 }),
  JSON.stringify({ status: "approve", summary: "s", findings: [], setModel: "x" }),
  // invalid_status
  JSON.stringify({ status: "ACCEPT", summary: "s", findings: [] }),
  JSON.stringify({ status: 7, summary: "s", findings: [] }),
  JSON.stringify({ summary: "s", findings: [] }),
  // invalid_summary
  JSON.stringify({ status: "approve", summary: 5, findings: [] }),
  JSON.stringify({ status: "approve", findings: [] }),
  // invalid_findings
  JSON.stringify({ status: "approve", summary: "s", findings: "none" }),
  JSON.stringify({ status: "approve", summary: "s", findings: {} }),
  JSON.stringify({
    status: "approve",
    summary: "s",
    findings: Array.from({ length: 21 }, (_v, i) => ({ code: `c${i}`, severity: "note", summary: `s${i}` })),
  }),
  // invalid_finding
  JSON.stringify({ status: "approve", summary: "s", findings: [{ code: "c", severity: "critical", summary: "s" }] }),
  JSON.stringify({ status: "approve", summary: "s", findings: [{ code: "c", summary: "s" }] }),
  JSON.stringify({ status: "approve", summary: "s", findings: [{ code: 1, severity: "note", summary: "s" }] }),
  JSON.stringify({ status: "approve", summary: "s", findings: [{ code: "c", severity: "note", summary: "s", path: 3 }] }),
  JSON.stringify({ status: "approve", summary: "s", findings: [null] }),
];

describe("advisor parser corpus equivalence (original vs instrumented)", () => {
  it("accepts and rejects every corpus entry identically", () => {
    for (const text of CORPUS) {
      const original = parseVerdict(text);
      const instrumented = parseVerdictWithRejection(text);
      expect(
        (original !== undefined) === (instrumented.verdict !== undefined),
        `accept/reject mismatch for ${JSON.stringify(text.slice(0, 60))}`,
      ).toBe(true);
    }
  });

  it("returns deeply identical parsed verdicts for every accepted entry", () => {
    let accepted = 0;
    for (const text of CORPUS) {
      const original = parseVerdict(text);
      const instrumented = parseVerdictWithRejection(text);
      if (original === undefined) {
        expect(instrumented.rejection).toBeTypeOf("string");
        continue;
      }
      accepted += 1;
      expect(instrumented.verdict).toEqual(original);
      expect(instrumented.rejection).toBeUndefined();
    }
    expect(accepted).toBeGreaterThanOrEqual(4);
  });

  it("classifies rejections into the fixed allowlist only", () => {
    const allowed = new Set([
      "not_json",
      "not_object",
      "forbidden_keys",
      "invalid_status",
      "invalid_summary",
      "invalid_findings",
      "invalid_finding",
    ]);
    const seen = new Set<string>();
    for (const text of CORPUS) {
      const instrumented = parseVerdictWithRejection(text);
      if (instrumented.verdict !== undefined) continue;
      const rejection = instrumented.rejection as string;
      expect(allowed.has(rejection), `unexpected category ${rejection}`).toBe(true);
      seen.add(rejection);
    }
    expect(seen).toEqual(allowed);
  });

  it.each([
    ["not-json", "not_json"],
    ["[]", "not_object"],
    [JSON.stringify({ status: "approve", summary: "s", findings: [], extra: 1 }), "forbidden_keys"],
    [JSON.stringify({ status: "nope", summary: "s", findings: [] }), "invalid_status"],
    [JSON.stringify({ status: "approve", summary: 5, findings: [] }), "invalid_summary"],
    [JSON.stringify({ status: "approve", summary: "s", findings: "none" }), "invalid_findings"],
    [JSON.stringify({ status: "approve", summary: "s", findings: [{ code: "c", severity: "note", summary: "s", path: 3 }] }), "invalid_finding"],
  ])("classifies %s deterministically", (text, expected) => {
    expect(parseVerdictWithRejection(text).rejection).toBe(expected);
  });
});

describe("diagnostic classification helpers", () => {
  it("maps only the typed provider stop reasons", () => {
    for (const known of ["stop", "length", "toolUse", "error", "aborted", "deferred", "pending"]) {
      expect(classifyStopReason(known)).toBe(known);
    }
    expect(classifyStopReason("weird_provider_reason")).toBe("other");
    expect(classifyStopReason(undefined)).toBe("unavailable");
    expect(classifyStopReason("unavailable")).toBe("unavailable");
    expect(classifyStopReason("other")).toBe("other");
    expect(classifyStopReason(7)).toBe("other");
    expect(classifyStopReason("Bearer sk-syntheticsecret")).toBe("other");
  });

  it("counts blocks by fixed type and buckets unknown types into other", () => {
    const blocks = [
      { type: "text", text: "a" },
      { type: "thinking", thinking: "b" },
      { type: "toolCall", id: "1", name: "n", arguments: {} },
      { type: "image" },
      { type: "server_event" },
      { type: "text", text: "c" },
    ];
    expect(classifyContentBlocks(blocks)).toEqual({ text: 2, thinking: 1, toolCall: 1, other: 2 });
    expect(classifyContentBlocks([])).toEqual({ text: 0, thinking: 0, toolCall: 0, other: 0 });
    expect(classifyContentBlocks([{ type: 42 }])).toEqual({ text: 0, thinking: 0, toolCall: 0, other: 1 });
  });

  it("derives text statistics including code-fence detection", () => {
    expect(buildTextStats([])).toEqual({ blocks: 0, totalLength: 0, empty: true, containsCodeFence: false });
    expect(buildTextStats(["plain"])).toEqual({ blocks: 1, totalLength: 5, empty: false, containsCodeFence: false });
    expect(buildTextStats(["```json\n{}\n```"])).toEqual({
      blocks: 1,
      totalLength: 14,
      empty: false,
      containsCodeFence: true,
    });
    expect(buildTextStats(["one", "two"])).toEqual({ blocks: 2, totalLength: 6, empty: false, containsCodeFence: false });
  });
});

describe("advisor diagnostic record schema", () => {
  const baseInput = {
    invocationId: "advisor-1",
    candidateDigest: "a".repeat(64),
    candidateRevision: 3,
    workspaceDigest: "b".repeat(64),
    reasoning: "high",
    logicalBudget: 800,
    sdkMaxTokens: 800,
    stream: "resolved" as const,
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 20 },
    blocks: { text: 1, thinking: 0, toolCall: 0, other: 0 },
    text: { blocks: 1, totalLength: 30, empty: false, containsCodeFence: false },
    parseValid: true,
  };

  it("pins the version and the exact allowlist key set", () => {
    const record = buildAdvisorDiagnosticRecord({
      ...baseInput,
      parseValid: false,
      parserRejection: "not_json",
    });
    expect(record.schemaVersion).toBe(ADVISOR_DIAGNOSTIC_SCHEMA_VERSION);
    expect(record.kind).toBe("advisor_review_diagnostic");
    expect(record.purpose).toBe("authoritative_completion");
    expect(Object.keys(record).sort()).toEqual([
      "blocks",
      "candidateDigest",
      "candidateRevision",
      "invocationId",
      "kind",
      "parseValid",
      "parserRejection",
      "purpose",
      "request",
      "schemaVersion",
      "stopReason",
      "stream",
      "text",
      "usage",
      "workspaceDigest",
    ]);
  });

  it("marks unobservable values unavailable without guessing", () => {
    const record = buildAdvisorDiagnosticRecord({
      ...baseInput,
      stopReason: undefined,
      usage: undefined,
      blocks: undefined,
      text: undefined,
      stream: "rejected",
      parseValid: false,
    });
    expect(record.stopReason).toBe("unavailable");
    expect(record.usage).toBeUndefined();
    expect(record.blocks).toBeUndefined();
    expect(record.text).toBeUndefined();
    expect(record.parseValid).toBe(false);
    expect(record.parserRejection).toBeUndefined();
  });

  it("drops non-conforming values instead of echoing them", () => {
    const record = buildAdvisorDiagnosticRecord({
      ...baseInput,
      invocationId: { poison: "x" },
      candidateDigest: 42,
      candidateRevision: "three",
      logicalBudget: -5,
      sdkMaxTokens: -5,
      stream: "maybe",
      stopReason: "Bearer sk-syntheticsecret",
      usage: { inputTokens: "many", outputTokens: 2 },
      parserRejection: "leaky_category",
    });
    expect(record.invocationId).toBe("unavailable");
    expect(record.candidateDigest).toBe("unavailable");
    expect(record.candidateRevision).toBe("unavailable");
    expect(record.request.logicalBudget).toBe("unavailable");
    expect(record.request.sdkMaxTokens).toBe("unavailable");
    expect(record.stream).toBe("unavailable");
    expect(record.stopReason).toBe("unavailable");
    expect(record.usage).toBeUndefined();
    expect(record.parserRejection).toBeUndefined();
  });

  it("never carries secret-shaped content", () => {
    const poisoned = buildAdvisorDiagnosticRecord({
      ...baseInput,
      candidateDigest: "Bearer sk-syntheticsecret1234",
    });
    expect(advisorDiagnosticRecordIsSafe(poisoned)).toBe(false);
    expect(advisorDiagnosticRecordIsSafe(buildAdvisorDiagnosticRecord(baseInput))).toBe(true);
    const serialized = JSON.stringify(buildAdvisorDiagnosticRecord(baseInput));
    expect(serialized).not.toContain("[redacted]");
    expect(JSON.parse(serialized)).toEqual(buildAdvisorDiagnosticRecord(baseInput));
  });
});

describe("PiAdvisorAdapter diagnostic surface", () => {
  it("passes the response observation through on success", async () => {
    const fake = fakeInvoker({
      text: JSON.stringify({ status: "approve", summary: "ok", findings: [] }),
      stopReason: "stop",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    const result = await new PiAdvisorAdapter(fake.invoker).review({
      parent: parent(),
      invocationId: invocationId("advisor-9"),
      evidence,
      budgetLimit: 25,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success");
    expect(result.value.observed?.stopReason).toBe("stop");
    expect(result.value.observed?.text.containsCodeFence).toBe(false);
    expect(result.value.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("does not preprocess fenced output: verdict still fails, fence is only observed", async () => {
    const fenced = "```json\n" + JSON.stringify({ status: "approve", summary: "ok", findings: [] }) + "\n```";
    const fake = fakeInvoker({ text: fenced, stopReason: "stop" });
    const result = await new PiAdvisorAdapter(fake.invoker).review({
      parent: parent(),
      invocationId: invocationId("advisor-10"),
      evidence,
      budgetLimit: 25,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("invalid_advisor_verdict");
      expect(result.failure.message).toBe("advisor output did not match the strict verdict schema");
      expect(result.failure.metadata?.diagParseRejection).toBe("not_json");
      expect(result.failure.metadata?.diagCodeFence).toBe(true);
      expect(result.failure.metadata?.diagStream).toBe("resolved");
      const prompt = (fake.invoke.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
      expect(prompt).toContain("Review the following sanitized Wayforge evidence");
      expect(prompt).not.toContain("```");
    }
  });

  it("attaches sanitized diagnostic metadata to the invalid-verdict failure", async () => {
    const fake = fakeInvoker({
      text: JSON.stringify({ status: "approve", summary: "ok", findings: [], extra: 1 }),
      stopReason: "length",
      usage: { inputTokens: 30, outputTokens: 40 },
    });
    const result = await new PiAdvisorAdapter(fake.invoker).review({
      parent: parent(),
      invocationId: invocationId("advisor-11"),
      evidence,
      budgetLimit: 25,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe("validation");
      expect(result.failure.scope).toBe("invocation");
      expect(result.failure.confidence).toBe("certain");
      const metadata = result.failure.metadata ?? {};
      expect(metadata.diagStream).toBe("resolved");
      expect(metadata.diagStopReason).toBe("length");
      expect(metadata.diagReasoning).toBe("high");
      expect(metadata.diagLogicalBudget).toBe(25);
      expect(metadata.diagSdkMaxTokens).toBe("unavailable");
      expect(metadata.diagInputTokens).toBeUndefined();
      expect(metadata.diagOutputTokens).toBeUndefined();
      expect(metadata.diagParseRejection).toBe("forbidden_keys");
      expect(metadata.diagCodeFence).toBe(false);
      expect(JSON.stringify(metadata)).not.toContain("extra");
      expect(JSON.stringify(metadata)).not.toContain("approve");
    }
  });

  it("keeps the request observation on runtime failures it can still see", async () => {
    const root = parent();
    const invoke = vi.fn(async () => ({
      ok: false as const,
      failure: {
        kind: "provider" as const,
        scope: "provider" as const,
        confidence: "certain" as const,
        code: "provider_stream_failed",
        message: "provider stream failed",
        metadata: { diagStream: "rejected", diagReasoning: "high", diagLogicalBudget: 800, diagSdkMaxTokens: 800 },
      },
    }));
    const result = await new PiAdvisorAdapter({ invoke } as unknown as NestedInvoker).review({
      parent: root,
      invocationId: invocationId("advisor-12"),
      evidence,
      budgetLimit: 25,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.metadata?.diagStream).toBe("rejected");
      expect(result.failure.code).toBe("provider_stream_failed");
    }
  });
});

describe("pi compatibility adapter observation", () => {
  const fakeModel = { id: "claude-haiku", api: "anthropic" } as never;

  function makeRegistry(result: unknown) {
    const streamResult = { result: () => Promise.resolve(result) };
    const streamSimple = vi.fn(() => streamResult);
    const ctx = { modelRegistry: { find: vi.fn(() => fakeModel), streamSimple } };
    return { ctx: ctx as unknown as ExtensionContext, streamSimple, pi: {} as ExtensionAPI };
  }

  function request() {
    return {
      provider: "anthropic",
      modelId: "claude-haiku",
      thinking: "high" as const,
      prompt: "say hi",
      budgetLimit: 800,
    };
  }

  it("builds a block, stop-reason, and text observation from the resolved message", async () => {
    const textBlocks = ['{"status":"approve"', ',"summary":"s","findings":[]}'];
    const message = {
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: textBlocks[0] },
        { type: "text", text: textBlocks[1] },
        { type: "toolCall", id: "1", name: "n", arguments: {} },
        { type: "server_event" },
      ],
      usage: { input: 9, output: 8 },
      stopReason: "stop",
    };
    const { ctx, pi } = makeRegistry(message);
    const result = await new PiCompatibilityAdapter(pi, ctx).stream(request());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.observed).toEqual({
      stopReason: "stop",
      request: { sdkMaxTokens: 800 },
      blocks: { text: 2, thinking: 1, toolCall: 1, other: 1 },
      text: {
        blocks: 2,
        totalLength: textBlocks.reduce((sum, text) => sum + text.length, 0),
        empty: false,
        containsCodeFence: false,
      },
    });
  });

  it("maps unknown and missing stop reasons without guessing", async () => {
    const weird = makeRegistry({ content: [{ type: "text", text: "x" }], usage: { input: 1, output: 1 }, stopReason: "provider_specific" });
    const first = await new PiCompatibilityAdapter(weird.pi, weird.ctx).stream(request());
    expect(first.ok && first.value.observed?.stopReason).toBe("other");

    const absent = makeRegistry({ content: [{ type: "text", text: "x" }], usage: { input: 1, output: 1 } });
    const second = await new PiCompatibilityAdapter(absent.pi, absent.ctx).stream(request());
    expect(second.ok && second.value.observed?.stopReason).toBe("unavailable");
  });

  it("records stream rejection with request facts and no provider detail", async () => {
    const streamResult = {
      result: () => Promise.reject(new Error("Authorization: Bearer sk-syntheticsecret1234")),
    };
    const ctx = { modelRegistry: { find: vi.fn(() => fakeModel), streamSimple: vi.fn(() => streamResult) } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.metadata?.diagStream).toBe("rejected");
      expect(result.failure.metadata?.diagReasoning).toBe("high");
      expect(result.failure.metadata?.diagLogicalBudget).toBe(800);
      expect(result.failure.metadata?.diagSdkMaxTokens).toBe(800);
      expect(JSON.stringify(result.failure.metadata)).not.toContain("syntheticsecret");
    }
  });

  it("marks an unattempted stream unavailable on missing model", async () => {
    const ctx = { modelRegistry: { find: vi.fn(() => undefined), streamSimple: vi.fn() } };
    const result = await new PiCompatibilityAdapter({} as ExtensionAPI, ctx as unknown as ExtensionContext).stream(request());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe("model_not_found");
      expect(result.failure.metadata?.diagStream).toBe("unavailable");
      expect(result.failure.metadata?.diagReasoning).toBe("high");
      expect(result.failure.metadata?.diagLogicalBudget).toBe(800);
      expect(result.failure.metadata?.diagSdkMaxTokens).toBe("unavailable");
    }
  });
});
