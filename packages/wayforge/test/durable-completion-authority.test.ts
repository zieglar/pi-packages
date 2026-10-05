import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
} from "pi-subagents/delegation";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { serializeTaskState, type AuthoritativeTaskState } from "../src/durable/state.js";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { captureWorkspaceCheckpoint } from "../src/durable/workspace-checkpoint.js";
import { createWayforgeExtension } from "../src/extension.js";
import { InvocationContext } from "../src/kernel/invocation-context.js";
import type { WorkflowRuntime } from "../src/workflow/runtime-factory.js";
import { FakePiHost, temporaryAgentDir } from "./helpers/fake-pi-host.js";

interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

interface AdvisorCall {
  readonly prompt: string;
}

type AdvisorStatus = "approve" | "changes_requested" | "unable";
type AdvisorControl =
  | { readonly kind: "verdict"; readonly status: AdvisorStatus; readonly summary?: string; readonly usage?: { readonly input: number; readonly output: number }; readonly afterReview?: () => Promise<void> }
  | { readonly kind: "malformed"; readonly usage?: { readonly input: number; readonly output: number }; readonly afterReview?: () => Promise<void> };

interface Clock {
  now: number;
}

interface CompletionHarness {
  readonly host: FakePiHost;
  readonly workspace: string;
  readonly store: FilesystemDurableTaskStore;
  readonly runtime: WorkflowRuntime;
  readonly advisorCalls: readonly AdvisorCall[];
  readonly clock: Clock;
  setAdvisor(control: AdvisorControl): void;
  recordValidation(name: string, ok: boolean, summary: string): Promise<ToolResult>;
  complete(): Promise<ToolResult>;
  state(): Promise<AuthoritativeTaskState>;
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
  const workspace = temporaryRoot("wayforge-completion-ws-");
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
  return callable("completion-test", params, new AbortController().signal, () => {}, {});
}

async function loadRequired(store: FilesystemDurableTaskStore): Promise<AuthoritativeTaskState> {
  const loaded = await store.load("alpha0-1" as never);
  if (!loaded.ok || loaded.value === null) throw new Error("durable task state missing");
  return loaded.value;
}

async function replaceState(
  store: FilesystemDurableTaskStore,
  change: (state: AuthoritativeTaskState) => Partial<AuthoritativeTaskState>,
): Promise<void> {
  const state = await loadRequired(store);
  const updated = await store.update(state.revision, {
    ...state,
    ...change(state),
    revision: state.revision + 1,
    updatedAtMs: state.updatedAtMs + 1,
  });
  if (!updated.ok) throw new Error(`failed to seed durable state: ${updated.failure.code}`);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(): Promise<CompletionHarness> {
  const workspace = createWorkspace();
  const storeRoot = join(temporaryAgentDir(), "wayforge", "tasks");
  roots.push(storeRoot.split(`${join("wayforge", "tasks")}`)[0]!);
  const clock: Clock = { now: T0 };
  const host = new FakePiHost(workspace);
  const advisorCalls: AdvisorCall[] = [];
  let advisor: AdvisorControl = { kind: "verdict", status: "approve" };
  host.setStreamSimpleHandler(async (prompt) => {
    advisorCalls.push({ prompt });
    await advisor.afterReview?.();
    const text = advisor.kind === "malformed"
      ? "not-json"
      : JSON.stringify({ status: advisor.status, summary: advisor.summary ?? `advisor ${advisor.status}`, findings: [] });
    return { content: [{ type: "text", text }], usage: advisor.usage ?? { input: 10, output: 5 } };
  });
  let runtimeResolve: (runtime: WorkflowRuntime) => void = () => {};
  const runtimePromise = new Promise<WorkflowRuntime>((resolve) => {
    runtimeResolve = resolve;
  });
  createWayforgeExtension({
    durable: { storeRoot, now: () => clock.now, leaseTtlMs: 1_000 },
    observeRuntime: (value) => {
      if (value !== undefined) runtimeResolve(value);
    },
  })(host as unknown as Parameters<import("@earendil-works/pi-coding-agent").ExtensionFactory>[0]);
  await host.emitLifecycle("session_start");
  await host.runCommand("wayforge", "prove durable completion authority");
  const runtime = await runtimePromise;
  const store = new FilesystemDurableTaskStore(storeRoot, { now: () => clock.now });
  await waitFor(async () => (await store.load(runtime.controller.taskId)).ok, "task was not created");
  return {
    host,
    workspace,
    store,
    runtime,
    advisorCalls,
    clock,
    setAdvisor(control) {
      advisor = control;
    },
    recordValidation: (name, ok, summary) =>
      execute(host.tool("wayforge_record_validation"), { name, ok, summary }),
    complete: () => execute(host.tool("wayforge_complete")),
    state: () => loadRequired(store),
  };
}

async function expectRefused(
  harness: CompletionHarness,
  expectedCode: string,
  advisorCalls = 0,
  expectedDurableStatus: AuthoritativeTaskState["status"] = "running",
): Promise<void> {
  const result = await harness.complete();
  expect(failureCode(result)).toBe(expectedCode);
  expect(harness.advisorCalls).toHaveLength(advisorCalls);
  expect(harness.runtime.controller.status().status).toBe("running");
  expect((await harness.state()).status).toBe(expectedDurableStatus);
}

beforeAll(() => execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" }));
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("durable completion authority public path", () => {
  it("returns validation_required without Advisor when no durable validation exists", async () => {
    const harness = await createHarness();
    await expectRefused(harness, "validation_required");
  });

  it("returns validation_stale without Advisor for validation bound to another workspace digest", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    writeFileSync(join(harness.workspace, "owned.txt"), "new workspace\n", "utf8");
    const state = await harness.state();
    if (state.workspace === null) throw new Error("workspace missing");
    const captured = await captureWorkspaceCheckpoint({
      workspaceRoot: harness.workspace,
      taskWriteSet: state.workspace.taskWriteSet,
      capturedAtMs: T0,
    });
    if (!captured.ok) throw new Error(captured.failure.code);
    await replaceState(harness.store, () => ({ workspace: captured.value }));
    await expectRefused(harness, "validation_stale");
  });

  it("completes after real task work when validation binds the current workspace", async () => {
    const harness = await createHarness();
    writeFileSync(join(harness.workspace, "owned.txt"), "task work\n", "utf8");
    const validated = await harness.recordValidation("pnpm test", true, "passed");
    expect(parse(validated).ok).toBe(true);
    const bound = await harness.state();
    if (bound.workspace === null) throw new Error("workspace missing");
    const completed = await harness.complete();
    expect(failureCode(completed)).toBeUndefined();
    expect(parse(completed).ok).toBe(true);
    expect(harness.advisorCalls).toHaveLength(1);
    const finished = await harness.state();
    expect(finished.status).toBe("completed");
    const captured = await captureWorkspaceCheckpoint({
      workspaceRoot: harness.workspace,
      taskWriteSet: bound.workspace.taskWriteSet,
      capturedAtMs: T0,
    });
    if (!captured.ok) throw new Error(captured.failure.code);
    expect(bound.workspace.workingStateDigest).toBe(captured.value.workingStateDigest);
    expect(finished.completionEvidence).toMatchObject({
      authority: "completion_authority_v1",
      workspaceDigest: captured.value.workingStateDigest,
    });
  });

  it("returns workspace_changed without Advisor after validate then workspace mutation", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    await waitFor(async () => (await harness.state()).evidence.length > 0, "validation was not persisted");
    writeFileSync(join(harness.workspace, "owned.txt"), "mutated after validation\n", "utf8");
    await expectRefused(harness, "workspace_changed");
  });

  it("returns task_suspended without Advisor for a suspended durable task", async () => {
    const harness = await createHarness();
    await replaceState(harness.store, () => ({ status: "suspended" }));
    await expectRefused(harness, "task_suspended", 0, "suspended");
  });

  it("returns task_resuming without Advisor for a resuming durable task", async () => {
    const harness = await createHarness();
    await replaceState(harness.store, () => ({ status: "resuming" }));
    await expectRefused(harness, "task_resuming", 0, "resuming");
  });

  it("returns pending_work without Advisor while a governed Worker is in flight", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    let request: Record<string, unknown> | undefined;
    const remove = harness.host.events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (value) => {
      request = value as Record<string, unknown>;
    });
    const delegated = execute(harness.host.tool("wayforge_delegate_workers"), { prompts: ["inspect"] });
    await waitFor(async () => request !== undefined, "worker request was not emitted");
    await expectRefused(harness, "pending_work");
    harness.host.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
      ...request,
      status: "completed",
      model: "test-provider/test-model:low",
      result: { kind: "text", text: "done" },
      usage: { input: 1, output: 1, toolCalls: 0, durationMs: 1 },
    });
    await delegated;
    expect(harness.runtime.state.governedWorkSnapshot().pendingGovernedWorkCount).toBe(0);
    remove();
  });

  it.each(["changes_requested", "unable"] as const)(
    "returns distinct advisor_%s refusal and leaves both states running",
    async (status) => {
      const harness = await createHarness();
      await harness.recordValidation("pnpm test", true, "passed");
      harness.setAdvisor({ kind: "verdict", status });
      await expectRefused(harness, `advisor_${status}`, 1);
    },
  );

  it("returns advisor_invalid for malformed strict Advisor output", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    harness.setAdvisor({ kind: "malformed" });
    await expectRefused(harness, "advisor_invalid", 1);
  });

  it("refuses commit when the lease generation becomes stale", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    harness.setAdvisor({
      kind: "verdict",
      status: "approve",
      afterReview: async () => {
        await replaceState(harness.store, (state) => ({ leaseGeneration: state.leaseGeneration + 1 }));
      },
    });
    await expectRefused(harness, "lease_conflict", 1);
  });

  it("returns lease_conflict when lease ownership is lost after Advisor", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    harness.setAdvisor({
      kind: "verdict",
      status: "approve",
      afterReview: async () => {
        harness.clock.now += 2_000;
        const acquired = await harness.store.acquireLease(harness.runtime.controller.taskId, 1_000);
        expect(acquired.ok).toBe(true);
      },
    });
    await expectRefused(harness, "lease_conflict", 1);
  });

  it.each(["revision", "workspace"] as const)(
    "refuses when %s changes after Advisor and leaves durable state incomplete",
    async (mode) => {
      const harness = await createHarness();
      await harness.recordValidation("pnpm test", true, "passed");
      harness.setAdvisor({
        kind: "verdict",
        status: "approve",
        afterReview: async () => {
          if (mode === "revision") {
            await replaceState(harness.store, () => ({ currentPhase: "changed-after-review" }));
          } else {
            writeFileSync(join(harness.workspace, "owned.txt"), "changed during review\n", "utf8");
          }
        },
      });
      await expectRefused(harness, mode === "revision" ? "state_conflict" : "workspace_changed", 1);
    },
  );

  it("commits durable authority evidence before workflow-visible completed", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    const order: string[] = [];
    const originalUpdate = FilesystemDurableTaskStore.prototype.update;
    vi.spyOn(FilesystemDurableTaskStore.prototype, "update").mockImplementation(async function (this: FilesystemDurableTaskStore, ...args) {
      const next = args[1];
      if (next.status === "completed") order.push("durable");
      return originalUpdate.apply(this, args);
    });
    const originalSetStatus = harness.runtime.state.setStatus.bind(harness.runtime.state);
    vi.spyOn(harness.runtime.state, "setStatus").mockImplementation((status) => {
      if (status === "completed") order.push("workflow");
      originalSetStatus(status);
    });
    const completed = await harness.complete();
    expect(parse(completed).ok).toBe(true);
    const state = await harness.state();
    expect(state.status).toBe("completed");
    expect(state.completionEvidence).toMatchObject({ authority: "completion_authority_v1" });
    expect(harness.runtime.controller.status().status).toBe("completed");
    expect(order).toEqual(["durable", "workflow"]);
  });

  it("refuses completion with typed cancellation after cancel even when the durable cancellation projection fails", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    const originalUpdate = FilesystemDurableTaskStore.prototype.update;
    vi.spyOn(FilesystemDurableTaskStore.prototype, "update").mockImplementation(async function (this: FilesystemDurableTaskStore, ...args) {
      const next = args[1];
      if (next.status === "cancelled") {
        return {
          ok: false as const,
          failure: {
            kind: "validation" as const,
            scope: "task" as const,
            confidence: "certain" as const,
            code: "projection_write_failed",
            message: "injected durable cancellation projection failure",
          },
        };
      }
      return originalUpdate.apply(this, args);
    });
    const cancelled = await execute(harness.host.tool("wayforge_cancel"));
    expect(parse(cancelled)).toMatchObject({ ok: true, cancelled: true });
    const result = await harness.complete();
    expect(failureCode(result)).toBe("workflow_cancelled");
    expect(parse(result).failure).toMatchObject({ kind: "cancellation", code: "workflow_cancelled" });
    expect(harness.advisorCalls).toHaveLength(0);
    expect(harness.runtime.controller.status().status).toBe("cancelled");
    expect((await harness.state()).status).toBe("running");
  });

  it("is idempotent on repeat with no second Advisor, evidence write, or revision increment", async () => {
    const harness = await createHarness();
    await harness.recordValidation("pnpm test", true, "passed");
    const first = await harness.complete();
    expect(parse(first).ok).toBe(true);
    const committed = await harness.state();
    expect(harness.advisorCalls).toHaveLength(1);
    const second = await harness.complete();
    expect(parse(second)).toMatchObject({ ok: true });
    const repeated = await harness.state();
    expect(harness.advisorCalls).toHaveLength(1);
    expect(repeated.revision).toBe(committed.revision);
    expect(repeated.completionEvidence).toEqual(committed.completionEvidence);
    expect(repeated.status).toBe("completed");
    expect(harness.runtime.controller.status().status).toBe("completed");
  });

  it("redacts inline validation and Advisor credentials in persisted durable evidence", async () => {
    const harness = await createHarness();
    const cookieSecret = "cookie-persistence-secret";
    const githubSecret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const basicSecret = "c3ludGhldGljOnBlcnNpc3RlbmNl";
    const awsSecret = "AKIAABCDEFGHIJKLMNOP";
    const validation = await harness.recordValidation(
      "node test",
      true,
      `tests passed Cookie: session=${cookieSecret}\ncredential=${githubSecret}`,
    );
    expect(parse(validation).ok).toBe(true);
    const afterValidation = serializeTaskState(await harness.state());
    expect(afterValidation).toContain("[redacted]");
    expect(afterValidation).not.toContain(cookieSecret);
    expect(afterValidation).not.toContain(githubSecret);

    harness.setAdvisor({
      kind: "verdict",
      status: "approve",
      summary: `approved Authorization: Basic ${basicSecret}; aws=${awsSecret}`,
    });
    expect(parse(await harness.complete()).ok).toBe(true);
    const completed = serializeTaskState(await harness.state());
    expect(completed).toContain("[redacted]");
    expect(completed).not.toContain(basicSecret);
    expect(completed).not.toContain(awsSecret);
  });


  describe("Phase 1B.3A authoritative Advisor budget ownership", () => {
    it.each(["approve", "changes_requested", "unable"] as const)(
      "manual %s attempts cannot authorize, poison or starve completion",
      async (status) => {
        const harness = await createHarness();
        harness.setAdvisor({ kind: "verdict", status });
        const advice = await execute(harness.host.tool("wayforge_advise"), { manual: true, beforeDone: true });
        expect(failureCode(advice)).toBe("advisor_reserved_for_completion");
        expect(harness.advisorCalls).toHaveLength(0);
        expect(harness.runtime.controller.status().advisorVerdicts).toHaveLength(0);
        expect(harness.runtime.controller.status().unresolved).toHaveLength(0);
        expect((await harness.state()).status).toBe("running");
        harness.setAdvisor({ kind: "verdict", status: "approve" });
        await harness.recordValidation("node test", true, "passed");
        expect(parse(await harness.complete())).toMatchObject({ ok: true });
        expect(harness.advisorCalls).toHaveLength(1);
        expect((await harness.state()).status).toBe("completed");
      },
    );

    it("repeated concurrent manual/beforeDone attempts consume zero calls", async () => {
      const harness = await createHarness();
      const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        execute(harness.host.tool("wayforge_advise"), index % 2 ? { beforeDone: true } : { manual: true }),
      ));
      expect(attempts.map(failureCode)).toEqual(Array(12).fill("advisor_reserved_for_completion"));
      expect(harness.advisorCalls).toHaveLength(0);
      await harness.recordValidation("node test", true, "passed");
      expect(parse(await harness.complete()).ok).toBe(true);
      expect(harness.advisorCalls).toHaveLength(1);
    });

    it.each(["changes_requested", "unable", "malformed", "provider_failure"] as const)(
      "a %s authoritative attempt is not retried or replenished",
      async (status) => {
        const harness = await createHarness();
        if (status === "provider_failure") {
          harness.host.setStreamSimpleHandler(async () => { throw new Error("synthetic provider failure"); });
        } else {
          harness.setAdvisor(status === "malformed" ? { kind: "malformed" } : { kind: "verdict", status });
        }
        await harness.recordValidation("node test", true, "passed");
        expect(parse(await harness.complete()).ok).toBe(false);
        harness.setAdvisor({ kind: "verdict", status: "approve" });
        const second = await harness.complete();
        expect(failureCode(second)).toBe("completion_review_spent");
        expect((await harness.state()).status).toBe("running");
        expect(harness.advisorCalls.length).toBeLessThanOrEqual(1);
      },
    );

    it("readiness refusal does not claim the one authoritative opportunity", async () => {
      const harness = await createHarness();
      await expectRefused(harness, "validation_required");
      await harness.recordValidation("node test", true, "passed");
      expect(parse(await harness.complete()).ok).toBe(true);
      expect(harness.advisorCalls).toHaveLength(1);
    });

    it("shared Main/Worker consumption cannot starve the completion allowance", async () => {
      const harness = await createHarness();
      const controller = harness.runtime.controller as unknown as {
        options: { mainContext: { spend(amount: number): void } };
      };
      controller.options.mainContext.spend(96_000);
      await harness.recordValidation("node test", true, "passed");
      expect(parse(await harness.complete()).ok).toBe(true);
      expect(harness.advisorCalls).toHaveLength(1);
    });

    it("accounts authoritative overdraw after generation without invalidating approval or dispatching again", async () => {
      const harness = await createHarness();
      const spendSnapshots: Array<{ amount: number; before: { limit: number; consumed: number; remaining: number }; after: { limit: number; consumed: number; remaining: number } }> = [];
      const originalSpend = InvocationContext.prototype.spend;
      vi.spyOn(InvocationContext.prototype, "spend").mockImplementation(function (this: InvocationContext, amount: number) {
        const before = this.budget;
        originalSpend.call(this, amount);
        if (this.role === "advisor" && this.traceMetadata.purpose === "authoritative_completion") {
          spendSnapshots.push({ amount, before, after: this.budget });
        }
      });
      harness.setAdvisor({
        kind: "verdict",
        status: "approve",
        summary: "overdraw remains contract-valid",
        usage: { input: 350, output: 700 },
        afterReview: async () => {
          expect(spendSnapshots).toEqual([]);
        },
      });
      await harness.recordValidation("node test", true, "passed");

      const completed = await harness.complete();

      expect(parse(completed)).toMatchObject({ ok: true });
      expect(spendSnapshots).toEqual([{
        amount: 1_050,
        before: { limit: 800, consumed: 0, remaining: 800 },
        after: { limit: 800, consumed: 1_050, remaining: 0 },
      }]);
      expect(harness.runtime.controller.status().advisorVerdicts.at(-1)).toMatchObject({
        status: "approve",
        summary: "overdraw remains contract-valid",
      });
      const completionEvidence = (await harness.state()).completionEvidence;
      expect(completionEvidence).toMatchObject({ authority: "completion_authority_v1" });
      if (completionEvidence == null || !("advisor" in completionEvidence)) {
        throw new Error("authoritative completion evidence missing Advisor binding");
      }
      expect(completionEvidence.advisor).toMatchObject({
        status: "approve",
        summary: "overdraw remains contract-valid",
      });
      expect(harness.advisorCalls).toHaveLength(1);

      expect(parse(await harness.complete())).toMatchObject({ ok: true });
      expect(harness.advisorCalls).toHaveLength(1);
    });

    it("concurrent valid requests issue only one authoritative review", async () => {
      const harness = await createHarness();
      await harness.recordValidation("node test", true, "passed");
      const outcomes = await Promise.all([harness.complete(), harness.complete()]);
      expect(outcomes.filter((result) => parse(result).ok === true).length).toBeGreaterThanOrEqual(1);
      expect(harness.advisorCalls).toHaveLength(1);
      expect((await harness.state()).status).toBe("completed");
    });
  });
});
