import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt } from "./helpers/ensure-built.js";
import { serializeTaskState, type AuthoritativeTaskState } from "../src/durable/state.js";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { captureWorkspaceCheckpoint } from "../src/durable/workspace-checkpoint.js";
import { createWayforgeExtension } from "../src/extension.js";
import type { WorkflowRuntime } from "../src/workflow/runtime-factory.js";
import { FakePiHost, temporaryAgentDir } from "./helpers/fake-pi-host.js";
import { scheduleSuspension } from "../src/recovery/suspension.js";
import type { Failure } from "../src/types/result.js";

interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

interface AdvisorMessage {
  readonly blocks: readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[];
  readonly stopReason?: string;
  readonly text: string;
  readonly usage: { readonly input: number; readonly output: number };
}

type AdvisorScript = "approve" | "not-json" | "throw";

interface EmissionHarness {
  readonly host: FakePiHost;
  readonly workspace: string;
  readonly store: FilesystemDurableTaskStore;
  readonly runtime: WorkflowRuntime;
  readonly agentDir: string;
  readonly advisorCalls: readonly string[];
  readonly sdkRequests: readonly { readonly maxTokens: number | undefined; readonly reasoning: string | undefined }[];
  setAdvisor(script: AdvisorScript, message?: Partial<AdvisorMessage>): void;
  advise(manual: boolean): Promise<ToolResult>;
  recordValidation(name: string): Promise<ToolResult>;
  complete(): Promise<ToolResult>;
  state(): Promise<AuthoritativeTaskState>;
  diagnosticLines(): Record<string, unknown>[];
  eventsPath(): string;
}

const roots: string[] = [];
const T0 = 50_000;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
}

function createWorkspace(): string {
  const workspace = temporaryRoot("wayforge-observability-ws-");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["config", "user.email", "wayforge-test@example.invalid"]);
  git(workspace, ["config", "user.name", "Wayforge Test"]);
  writeFileSync(join(workspace, "owned.txt"), "baseline\n", "utf8");
  git(workspace, ["add", "owned.txt"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  return workspace;
}

function parse(result: ToolResult): Record<string, unknown> {
  const text = result.content[0]?.text;
  if (text === undefined) throw new Error("tool returned no text");
  return JSON.parse(text) as Record<string, unknown>;
}

function failureCode(result: ToolResult): string | undefined {
  const payload = parse(result);
  const failure = payload.failure;
  if (typeof failure === "object" && failure !== null && "code" in failure) {
    return String((failure as { code: unknown }).code);
  }
  return typeof payload.error === "string" ? payload.error : undefined;
}

async function execute(tool: ToolDefinition, params: Record<string, unknown> = {}): Promise<ToolResult> {
  const callable = tool.execute as unknown as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
  return callable("observability-test", params, new AbortController().signal, () => {}, {});
}

async function loadRequired(store: FilesystemDurableTaskStore, taskId: string): Promise<AuthoritativeTaskState> {
  const loaded = await store.load(taskId as never);
  if (!loaded.ok || loaded.value === null) throw new Error("durable task state missing");
  return loaded.value;
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(options: { readonly providerFailure?: Failure; readonly payload?: unknown } = {}): Promise<EmissionHarness> {
  const workspace = createWorkspace();
  const agentDir = temporaryAgentDir();
  roots.push(agentDir);
  const storeRoot = join(agentDir, "wayforge", "tasks");
  const host = new FakePiHost(workspace);
  const advisorCalls: string[] = [];
  const sdkRequests: { maxTokens: number | undefined; reasoning: string | undefined }[] = [];
  const originalStream = host.ctx.modelRegistry.streamSimple;
  host.ctx.modelRegistry.streamSimple = (model, context, sdkOptions?: {
    readonly maxTokens?: number; readonly reasoning?: string; readonly onPayload?: (payload: unknown) => unknown;
  }) => {
    sdkRequests.push({ maxTokens: sdkOptions?.maxTokens, reasoning: sdkOptions?.reasoning });
    if ("payload" in options) {
      const before = JSON.stringify(options.payload);
      expect(sdkOptions?.onPayload?.(options.payload)).toBeUndefined();
      expect(JSON.stringify(options.payload)).toBe(before);
    }
    return originalStream(model, context);
  };
  let script: AdvisorScript = "approve";
  let messageOverride: Partial<AdvisorMessage> = {};
  host.setStreamSimpleHandler(async (prompt) => {
    advisorCalls.push(prompt);
    if (options.providerFailure !== undefined) throw options.providerFailure;
    if (script === "throw") throw new Error("provider stream failed with Bearer sk-syntheticsecret1234");
    const text = script === "not-json" ? "not-json" : JSON.stringify({ status: "approve", summary: "approved", findings: [] });
    const full: AdvisorMessage = {
      blocks: [{ type: "text", text }],
      text,
      usage: { input: 10, output: 5 },
      ...messageOverride,
    };
    return {
      content: full.blocks.map((block) => ({ ...block })),
      usage: full.usage,
      ...(full.stopReason !== undefined ? { stopReason: full.stopReason } : {}),
    };
  });
  let runtimeResolve: (runtime: WorkflowRuntime) => void = () => {};
  const runtimePromise = new Promise<WorkflowRuntime>((resolve) => {
    runtimeResolve = resolve;
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    createWayforgeExtension({
      durable: { storeRoot, now: () => T0, leaseTtlMs: 1_000 },
      observeRuntime: (value) => {
        if (value !== undefined) runtimeResolve(value);
      },
    })(host as unknown as Parameters<import("@earendil-works/pi-coding-agent").ExtensionFactory>[0]);
    await host.emitLifecycle("session_start");
    await host.runCommand("wayforge", "prove authoritative advisor observability");
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
  }
  const runtime = await runtimePromise;
  const store = new FilesystemDurableTaskStore(storeRoot, { now: () => T0 });
  await waitFor(async () => (await store.load(runtime.controller.taskId)).ok, "task was not created");
  const eventsFile = join(agentDir, "wayforge", `${runtime.controller.taskId}.events.jsonl`);
  return {
    host,
    workspace,
    store,
    runtime,
    agentDir,
    advisorCalls,
    sdkRequests,
    setAdvisor(next, message) {
      script = next;
      messageOverride = message ?? {};
    },
    advise: (manual) => execute(host.tool("wayforge_advise"), { manual }),
    recordValidation: (name) =>
      execute(host.tool("wayforge_record_validation"), { name, ok: true, summary: `${name} passed` }),
    complete: () => execute(host.tool("wayforge_complete")),
    state: () => loadRequired(store, runtime.controller.taskId),
    eventsPath: () => eventsFile,
    diagnosticLines() {
      if (!existsSync(eventsFile)) return [];
      return readFileSync(eventsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((event) => event.kind === "advisor_review_diagnostic");
    },
  };
}

beforeAll(() => ensureBuilt());
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const collidingDiagnosticMetadata = {
  diagStream: "resolved", diagReasoning: "low", diagLogicalBudget: 9, diagSdkMaxTokens: 7,
  diagPreparedMaxTokens: 800, diagPreparedMaxTokensField: "max_tokens", diagStopReason: "stop",
  diagBlocks: JSON.stringify({ text: 99, thinking: 99, toolCall: 99, other: 99 }),
  diagTextBlocks: 99, diagTextLength: 9, diagTextEmpty: false, diagCodeFence: true,
  diagParseRejection: "not_json", diagInputTokens: 999, diagOutputTokens: 999,
  diagUnknown: "UNTRUSTED_PRIVATE_SENTINEL",
} as const;

function collidingFailure(metadata: Failure["metadata"] = collidingDiagnosticMetadata): Failure {
  return { kind: "provider", scope: "provider", confidence: "certain", code: "offline",
    message: "synthetic typed failure", metadata: metadata! };
}

const suspensionContext = {
  nowMs: 1000, routeKey: "route", modelKey: "model", providerKey: "provider", maxChecks: 2,
  safeAvailabilityProbe: false, availabilityProbeDelayMs: 100, boundedContinuationDelayMs: 200,
  maxScheduleDelayMs: 10000,
};

describe("authoritative advisor diagnostic event emission", () => {
  it.each([undefined, { max_tokens: 17184, thinking: { type: "enabled", budget_tokens: 16160 } }])(
    "uses only current-invocation facts despite every preserved observation collision (payload %j)", async (payload) => {
      const cause = collidingFailure();
      const originalMetadata = JSON.stringify(cause.metadata);
      const harness = await createHarness({ providerFailure: cause, ...(payload !== undefined ? { payload } : {}) });
      await harness.recordValidation("pnpm test");
      const before = await harness.state();
      const result = await harness.complete();
      expect(failureCode(result)).toBe("offline");
      const returned = parse(result).failure as Failure;
      expect(returned.metadata).toEqual(cause.metadata);
      expect(JSON.stringify(cause.metadata)).toBe(originalMetadata);
      expect(harness.sdkRequests).toEqual([{ maxTokens: 800, reasoning: "high" }]);
      expect(harness.advisorCalls).toHaveLength(1);
      const lines = harness.diagnosticLines();
      expect(lines).toHaveLength(1);
      const detail = lines[0]!.detail as Record<string, unknown>;
      expect(detail.request).toEqual({
        logicalBudget: 800, sdkMaxTokens: 800, reasoning: "high",
        ...(payload !== undefined ? { preparedMaxTokens: 17184, preparedMaxTokensField: "max_tokens" } : {}),
      });
      expect(detail.stream).toBe("rejected");
      expect(detail.stopReason).toBe("unavailable");
      for (const key of ["blocks", "text", "parserRejection", "usage"]) expect(detail[key]).toBeUndefined();
      expect(JSON.stringify(detail)).not.toContain("UNTRUSTED_PRIVATE_SENTINEL");
      expect(await harness.state()).toEqual({ ...before, leaseGeneration: before.leaseGeneration + 1 });
      expect(failureCode(await harness.complete())).toBe("completion_review_spent");
      expect(harness.advisorCalls).toHaveLength(1);
      expect(harness.diagnosticLines()).toHaveLength(1);
    },
  );

  it.each([false, true])("preserves quota semantics with colliding observations at capacity=%s", async (atCapacity) => {
    const cause: Failure = { ...collidingFailure({ ...collidingDiagnosticMetadata,
      quotaWindowReliable: true, quotaWindowResetAtMs: 9000, ...(atCapacity ? { a0: 0, a1: 1 } : {}) }),
      kind: "usage_limit", scope: "account" };
    if (atCapacity) expect(Object.keys(cause.metadata!)).toHaveLength(20);
    const harness = await createHarness({ providerFailure: cause });
    await harness.recordValidation("pnpm test");
    const result = await harness.complete();
    const returned = parse(result).failure as Failure;
    expect(returned.metadata).toEqual(cause.metadata);
    expect(scheduleSuspension(returned, suspensionContext)).toEqual(scheduleSuspension(cause, suspensionContext));
    expect(scheduleSuspension(returned, suspensionContext)?.strategy).toBe("known_quota_window");
    expect(scheduleSuspension(returned, suspensionContext)?.resumeNotBeforeMs).toBe(9000);
    const detail = harness.diagnosticLines()[0]!.detail as Record<string, unknown>;
    expect(detail.request).toEqual({ logicalBudget: 800, sdkMaxTokens: 800, reasoning: "high" });
    expect(detail.usage).toBeUndefined();
    expect(harness.advisorCalls).toHaveLength(1);
  });

  it("drops diagnostics rather than displacing a full semantic metadata projection", async () => {
    const cause: Failure = { ...collidingFailure({
      ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`a${i}`, i])),
      quotaWindowReliable: true, quotaWindowResetAtMs: 9000,
    }), kind: "usage_limit", scope: "account" };
    const harness = await createHarness({ providerFailure: cause });
    await harness.recordValidation("pnpm test");
    const result = await harness.complete();
    const returned = parse(result).failure as Failure;
    expect(returned.metadata).toEqual(cause.metadata);
    expect(scheduleSuspension(returned, suspensionContext)).toEqual(scheduleSuspension(cause, suspensionContext));
    const detail = harness.diagnosticLines()[0]!.detail as Record<string, unknown>;
    expect(detail.request).toEqual({ logicalBudget: "unavailable", sdkMaxTokens: "unavailable", reasoning: "unavailable" });
    expect(detail.stream).toBe("unavailable");
    expect(harness.advisorCalls).toHaveLength(1);
  });

  it("ignores malformed pre-existing diagnostic transport without changing the typed failure", async () => {
    const cause = collidingFailure({ ...collidingDiagnosticMetadata, diagBlocks: "{malformed",
      diagPreparedMaxTokens: "not-a-count", diagPreparedMaxTokensField: "UNKNOWN_PRIVATE",
      diagLogicalBudget: null, diagSdkMaxTokens: false, diagReasoning: "PRIVATE_REASONING" });
    const harness = await createHarness({ providerFailure: cause, payload: { max_tokens: "malformed" } });
    await harness.recordValidation("pnpm test");
    const before = await harness.state();
    const result = await harness.complete();
    expect(failureCode(result)).toBe("offline");
    expect((parse(result).failure as Failure).metadata).toEqual(cause.metadata);
    const detail = harness.diagnosticLines()[0]!.detail as Record<string, unknown>;
    expect(detail.request).toEqual({ logicalBudget: 800, sdkMaxTokens: 800, reasoning: "high" });
    expect(detail.stream).toBe("rejected");
    expect(JSON.stringify(detail)).not.toContain("PRIVATE");
    expect(await harness.state()).toEqual({ ...before, leaseGeneration: before.leaseGeneration + 1 });
    expect(harness.advisorCalls).toHaveLength(1);
  });

  it("emits no diagnostic when readiness refuses before any dispatch", async () => {
    const harness = await createHarness();
    const result = await harness.complete();
    expect(failureCode(result)).toBe("validation_required");
    expect(harness.advisorCalls).toHaveLength(0);
    expect(harness.diagnosticLines()).toHaveLength(0);
  });

  it("emits exactly one persisted diagnostic for an invalid advisor verdict", async () => {
    const harness = await createHarness();
    writeFileSync(join(harness.workspace, "owned.txt"), "task work\n", "utf8");
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    const bound = await harness.state();
    if (bound.workspace === null) throw new Error("workspace missing");
    harness.setAdvisor("not-json");

    const result = await harness.complete();
    expect(failureCode(result)).toBe("advisor_invalid");

    const lines = harness.diagnosticLines();
    expect(lines).toHaveLength(1);
    const detail = (lines[0]!.detail ?? {}) as Record<string, unknown>;
    expect(detail.kind).toBe("advisor_review_diagnostic");
    expect(detail.schemaVersion).toBe(2);
    expect(detail.purpose).toBe("authoritative_completion");
    expect(detail.parseValid).toBe(false);
    expect(detail.parserRejection).toBe("not_json");
    expect(detail.stream).toBe("resolved");
    expect(detail.stopReason).toBe("unavailable");
    expect(detail.usage).toBeUndefined();
    expect(detail.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
    expect(String(detail.candidateDigest)).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.candidateRevision).toBe(bound.revision);
    const captured = await captureWorkspaceCheckpoint({
      workspaceRoot: harness.workspace,
      taskWriteSet: bound.workspace.taskWriteSet,
      capturedAtMs: T0,
    });
    if (!captured.ok) throw new Error(captured.failure.code);
    expect(detail.workspaceDigest).toBe(captured.value.workingStateDigest);
    expect(String(detail.invocationId)).toMatch(/^advisor-/);

    const after = await harness.state();
    expect(after.revision).toBe(bound.revision);
    expect(after.status).toBe("running");
    expect(serializeTaskState(after)).not.toContain("advisor_review_diagnostic");
  });

  it("does not emit a second diagnostic when the spent review refuses to redispatch", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    harness.setAdvisor("not-json");
    expect(failureCode(await harness.complete())).toBe("advisor_invalid");
    expect(failureCode(await harness.complete())).toBe("completion_review_spent");
    expect(harness.advisorCalls).toHaveLength(1);
    expect(harness.diagnosticLines()).toHaveLength(1);
  });

  it("emits one diagnostic with observed blocks for a successful authoritative review", async () => {
    const harness = await createHarness();
    writeFileSync(join(harness.workspace, "owned.txt"), "task work\n", "utf8");
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    const verdictText = JSON.stringify({ status: "approve", summary: "approved", findings: [] });
    harness.setAdvisor("approve", {
      stopReason: "stop",
      blocks: [{ type: "thinking", thinking: "hidden reasoning never persisted" }, { type: "text", text: verdictText }],
    });

    const result = await harness.complete();
    expect(failureCode(result)).toBeUndefined();

    const lines = harness.diagnosticLines();
    expect(lines).toHaveLength(1);
    const detail = (lines[0]!.detail ?? {}) as Record<string, unknown>;
    expect(detail.parseValid).toBe(true);
    expect(detail.usage).toBeUndefined();
    expect(detail.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
    expect(detail.parserRejection).toBeUndefined();
    expect(detail.stream).toBe("resolved");
    expect(detail.stopReason).toBe("stop");
    expect(detail.blocks).toEqual({ text: 1, thinking: 1, toolCall: 0, other: 0 });
    expect(detail.text).toEqual({
      blocks: 1,
      totalLength: verdictText.length,
      empty: false,
      containsCodeFence: false,
    });
    expect(JSON.stringify(detail)).not.toContain("hidden reasoning");
    const finished = await harness.state();
    expect(finished.status).toBe("completed");
    const evidence = finished.completionEvidence;
    if (evidence === null || !("candidateDigest" in evidence)) {
      throw new Error("expected authority completion evidence");
    }
    expect(evidence.candidateDigest).toBe(detail.candidateDigest);
  });

  it("classifies a rejected provider stream without recording provider detail", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    harness.setAdvisor("throw");

    const result = await harness.complete();
    expect(failureCode(result)).not.toBe("advisor_invalid");
    expect(failureCode(result)).toBeDefined();

    const lines = harness.diagnosticLines();
    expect(lines).toHaveLength(1);
    const detail = (lines[0]!.detail ?? {}) as Record<string, unknown>;
    expect(detail.stream).toBe("rejected");
    expect(detail.stopReason).toBe("unavailable");
    expect(detail.usage).toBeUndefined();
    expect(detail.blocks).toBeUndefined();
    expect(detail.text).toBeUndefined();
    expect(detail.parseValid).toBe(false);
    expect(detail.parserRejection).toBeUndefined();
    expect(detail.request).toEqual({ reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 });
    expect(JSON.stringify(detail)).not.toContain("syntheticsecret");
  });

  it("emits nothing for governed manual advice that is refused without dispatch", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    const result = await harness.advise(true);
    expect(failureCode(result)).toBe("advisor_reserved_for_completion");
    expect(harness.advisorCalls).toHaveLength(0);
    expect(harness.diagnosticLines()).toHaveLength(0);
  });

  it("keeps completion behavior identical when diagnostic persistence fails", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    harness.setAdvisor("not-json");
    const eventsPath = harness.eventsPath();
    rmSync(eventsPath);
    mkdirSync(eventsPath);

    const result = await harness.complete();
    expect(failureCode(result)).toBe("advisor_invalid");
    expect(harness.advisorCalls).toHaveLength(1);
    expect((await harness.state()).status).toBe("running");
  });

  it("keeps an approval authoritative when diagnostic disk persistence fails", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    const eventsPath = harness.eventsPath();
    rmSync(eventsPath);
    mkdirSync(eventsPath);
    expect(failureCode(await harness.complete())).toBeUndefined();
    expect(harness.advisorCalls).toHaveLength(1);
    expect((await harness.state()).status).toBe("completed");
  });

  it("persists only allowlist fields with no advisor body, prompt, or secret material", async () => {
    const harness = await createHarness();
    writeFileSync(join(harness.workspace, "owned.txt"), "task work\n", "utf8");
    await harness.recordValidation("pnpm test");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    harness.setAdvisor("not-json");
    expect(failureCode(await harness.complete())).toBe("advisor_invalid");

    const detail = (harness.diagnosticLines()[0]!.detail ?? {}) as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual([
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
      "workspaceDigest",
    ]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("not-json");
    expect(serialized).not.toContain("Review the following sanitized Wayforge evidence");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("[redacted]");
  });
});
