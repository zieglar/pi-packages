import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthoritativeTaskState } from "../src/durable/state.js";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { createWayforgeExtension } from "../src/extension.js";
import type { WorkflowRuntime } from "../src/workflow/runtime-factory.js";
import { FakePiHost, temporaryAgentDir, type FakeInputResult } from "./helpers/fake-pi-host.js";

/**
 * U2.1 Default Governed Entry: session mode state, native flag startup, the
 * exact-match command grammar, the shared status renderer, print rejection,
 * and the fail-closed top-level input router over the real extension surface.
 */

interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
}

type AdvisorStatus = "approve" | "changes_requested" | "unable";
type AdvisorControl =
  | { readonly kind: "verdict"; readonly status: AdvisorStatus; readonly summary?: string }
  | { readonly kind: "malformed" };

interface EntryHarness {
  readonly host: FakePiHost;
  readonly workspace: string;
  readonly store: FilesystemDurableTaskStore;
  readonly runtimes: WorkflowRuntime[];
  setAdvisor(control: AdvisorControl): void;
  recordValidation(name: string, ok: boolean, summary: string): Promise<ToolResult>;
  complete(): Promise<ToolResult>;
  cancel(): Promise<ToolResult>;
  turn(text: string, source?: "interactive" | "rpc" | "extension"): Promise<FakeInputResult>;
  state(taskId: string): Promise<AuthoritativeTaskState>;
  notifications(): string[];
}

const roots: string[] = [];

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "wayforge-u21-ws-"));
  roots.push(workspace);
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["config", "user.email", "wayforge-test@example.invalid"]);
  git(workspace, ["config", "user.name", "Wayforge Test"]);
  writeFileSync(join(workspace, "owned.txt"), "baseline\n", "utf8");
  git(workspace, ["add", "owned.txt"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  return workspace;
}

async function execute(tool: ToolDefinition, params: Record<string, unknown> = {}): Promise<ToolResult> {
  const callable = tool.execute as unknown as (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: unknown,
  ) => Promise<ToolResult>;
  return callable("u21-test", params, new AbortController().signal, () => {}, {});
}

async function waitFor(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createHarness(
  options: {
    flag?: boolean;
    mode?: "tui" | "rpc" | "json" | "print";
    startReason?: "startup" | "new" | "resume" | "fork" | "reload";
    unavailable?: boolean;
    beforeExtension?: (host: FakePiHost) => void;
  } = {},
): Promise<EntryHarness> {
  const workspace = createWorkspace();
  const storeRoot = join(temporaryAgentDir(), "wayforge", "tasks");
  roots.push(storeRoot.split(join("wayforge", "tasks"))[0]!);
  const host = new FakePiHost(workspace);
  if (options.mode !== undefined) host.mode = options.mode;
  let advisor: AdvisorControl = { kind: "verdict", status: "approve" };
  host.setStreamSimpleHandler(async () => {
    const text = advisor.kind === "malformed"
      ? "not-json"
      : JSON.stringify({ status: advisor.status, summary: advisor.summary ?? `advisor ${advisor.status}`, findings: [] });
    return { content: [{ type: "text", text }], usage: { input: 10, output: 5 } };
  });
  const runtimes: WorkflowRuntime[] = [];
  options.beforeExtension?.(host);
  createWayforgeExtension({
    ...(options.unavailable === true
      ? { durableFactory: (): never => { throw new Error("injected durable authority failure"); } }
      : { durable: { storeRoot, now: () => 50_000, leaseTtlMs: 1_000 } }),
    observeRuntime: (value) => {
      if (value !== undefined) runtimes.push(value);
    },
  })(host as unknown as Parameters<import("@earendil-works/pi-coding-agent").ExtensionFactory>[0]);
  if (options.flag === true) host.setFlagValue("wayforge", true);
  await host.emitLifecycle("session_start", host.ctx, { reason: options.startReason ?? "startup" });
  const store = new FilesystemDurableTaskStore(storeRoot, { now: () => 50_000 });
  return {
    host,
    workspace,
    store,
    runtimes,
    setAdvisor(control) {
      advisor = control;
    },
    recordValidation: (name, ok, summary) => execute(host.tool("wayforge_record_validation"), { name, ok, summary }),
    complete: () => execute(host.tool("wayforge_complete")),
    cancel: () => execute(host.tool("wayforge_cancel")),
    turn: (text, source = "interactive") => host.submitUserTurn(text, source),
    state: async (taskId) => {
      const loaded = await store.load(taskId as never);
      if (!loaded.ok || loaded.value === null) throw new Error(`durable task missing: ${taskId}`);
      return loaded.value;
    },
    notifications: () => host.notifications.map((entry) => entry.message),
  };
}

function statusBody(messages: readonly string[]): string {
  const found = [...messages].reverse().find((message) => message.includes("default governed mode:"));
  return found ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("default governed mode state and grammar", () => {
  it("registers the native --wayforge boolean flag and starts sessions OFF by default", async () => {
    const harness = await createHarness();

    expect(harness.host.getFlag("wayforge")).toBe(false);

    const disposition = await harness.turn("tighten the readme");
    expect(disposition.action).toBe("continue");
    expect(harness.host.ordinaryExecutions).toEqual(["tighten the readme"]);
    const listed = await harness.store.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.value).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(0);
  });

  it("initializes mode ON from the native flag and routes an ordinary turn into governed entry", async () => {
    const harness = await createHarness({ flag: true });

    const disposition = await harness.turn("implement schema validation");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.host.userMessages.some((message) =>
      message.includes("implement schema validation") && message.includes("Wayforge workflow started"),
    )).toBe(true);
    await waitFor(async () => {
      const listed = await harness.store.list();
      return listed.ok && listed.value.length > 0;
    }, "task not created");
    const listed = await harness.store.list();
    if (!listed.ok) throw new Error("store list failed");
    expect(listed.value[0]?.objective).toBe("implement schema validation");
  });

  it("toggles routing with /wayforge on and /wayforge off without creating tasks", async () => {
    const harness = await createHarness();

    await harness.host.runCommand("wayforge", "on");
    expect(harness.notifications().some((message) => message.includes("default governed mode: on"))).toBe(true);

    const governed = await harness.turn("first objective");
    expect(governed.action).toBe("handled");
    expect(harness.runtimes).toHaveLength(1);

    await harness.host.runCommand("wayforge", "off");
    expect(harness.notifications().some((message) => message.includes("default governed mode: off"))).toBe(true);

    const ordinary = await harness.turn("ungoverned follow-up");
    expect(ordinary.action).toBe("continue");
    expect(harness.host.ordinaryExecutions).toEqual(["ungoverned follow-up"]);
    expect(harness.runtimes).toHaveLength(1);
  });

  it("keeps an active governed task untouched when mode turns off (O0)", async () => {
    const harness = await createHarness({ flag: true });

    const governed = await harness.turn("objective one");
    expect(governed.action).toBe("handled");
    const active = harness.runtimes[0];
    if (active === undefined) throw new Error("runtime missing");
    expect(active.controller.status().status).toBe("running");

    await harness.host.runCommand("wayforge", "off");
    expect(active.controller.status().status).toBe("running");

    await harness.host.runCommand("wayforge", "status");
    const status = statusBody(harness.notifications());
    expect(status).toContain("default governed mode: off");
    expect(status).toContain("active governed task: yes");
  });

  it("renders one shared status body for bare /wayforge and /wayforge status", async () => {
    const harness = await createHarness();

    await harness.host.runCommand("wayforge", "");
    const bare = statusBody(harness.notifications());
    await harness.host.runCommand("wayforge", "status");
    const explicit = statusBody(harness.notifications());

    expect(bare).not.toBe("");
    expect(bare).toBe(explicit);
    expect(bare).toContain("default governed mode: off");
    expect(bare).toContain("active governed task: no");
    expect(bare).toContain("durable authority: available");
    const listed = await harness.store.list();
    if (listed.ok) expect(listed.value).toHaveLength(0);
  });

  it("makes print-mode rejection visible without an interactive UI", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = await createHarness({ flag: true, mode: "print" });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unsupported in print mode"));
    expect((await harness.turn("ordinary print input")).action).toBe("continue");
  });
  it("keeps one-shot JSON print mode OFF with a visible rejection", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const harness = await createHarness({ flag: true, mode: "json" });
    expect((await harness.turn("one-shot JSON prompt")).action).toBe("continue");
    expect(harness.runtimes).toHaveLength(0);
    expect(stderr).toHaveBeenCalled();
  });

  it("rejects --wayforge startup in print mode and keeps routing OFF", async () => {
    const harness = await createHarness({ flag: true, mode: "print" });

    expect(harness.notifications().some((message) => message.toLowerCase().includes("print"))).toBe(true);
    const disposition = await harness.turn("would be governed");
    expect(disposition.action).toBe("continue");
    expect(harness.host.ordinaryExecutions).toEqual(["would be governed"]);
    expect(harness.runtimes).toHaveLength(0);
  });
  it.each(["new", "resume", "fork", "reload"] as const)("resets default governed mode OFF when a %s session replaces a --wayforge startup session in the same runtime", async (reason) => {
    const harness = await createHarness({ flag: true });
    expect(statusBody(harness.notifications())).toContain("default governed mode: on (--wayforge)");
    expect(harness.runtimes).toHaveLength(0);

    await harness.host.emitLifecycle("session_start", harness.host.ctx, { reason });

    const result = await harness.turn("ordinary input after in-process session replacement");
    expect(result.action).toBe("continue");
    expect(harness.host.ordinaryExecutions).toEqual(["ordinary input after in-process session replacement"]);
    expect(harness.runtimes).toHaveLength(0);
  });

  it.each(["new", "resume", "fork", "reload"] as const)("does not reapply the launch flag on a %s session boundary", async (reason) => {
    const harness = await createHarness({ flag: true, startReason: reason });
    const result = await harness.turn("ordinary in replacement session");
    expect(result.action).toBe("continue");
    expect(harness.runtimes).toHaveLength(0);
  });

  it("reserves exact on/off/status words but keeps prefixed objectives as objectives", async () => {
    const harness = await createHarness();

    await harness.host.runCommand("wayforge", "on");
    await harness.host.runCommand("wayforge", "on boarding documentation");

    expect(harness.runtimes).toHaveLength(1);
    const runtime = harness.runtimes[0];
    if (runtime === undefined) throw new Error("runtime missing");
    expect(runtime.controller.status().objective).toBe("on boarding documentation");
    const listed = await harness.store.list();
    if (!listed.ok) throw new Error("store list failed");
    expect(listed.value).toHaveLength(1);
    expect(listed.value[0]?.objective).toBe("on boarding documentation");
  });

describe("default governed input routing", () => {
  it("never routes extension-sourced messages, even with no active runtime", async () => {
    const harness = await createHarness({ flag: true });

    const disposition = await harness.turn("Wayforge workflow started (objective: x)", "extension");
    expect(disposition.action).toBe("continue");
    expect(harness.runtimes).toHaveLength(0);
    expect(harness.host.ordinaryExecutions).toHaveLength(1);
  });

  it.each(["steer", "followUp"] as const)("preserves %s delivery when admitting a queued RPC turn", async (streamingBehavior) => {
    const harness = await createHarness({ flag: true });
    const result = await harness.host.emitInput("queued objective", "rpc", { streamingBehavior });
    expect(result.action).toBe("handled");
    expect(harness.host.userMessageDeliveries[0]?.options?.deliverAs).toBe(streamingBehavior);
    expect(harness.runtimes).toHaveLength(1);
  });

  it("consumes image-only input rather than silently executing it ordinarily", async () => {
    const harness = await createHarness({ flag: true });
    const result = await harness.host.emitInput("", "rpc", {
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
    expect(result.action).toBe("handled");
    expect(harness.runtimes).toHaveLength(0);
    expect(harness.notifications().some((message) => message.includes("Default governed entry failed"))).toBe(true);
  });

  it("preserves images on the governed-start injection", async () => {
    const harness = await createHarness({ flag: true });
    const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
    const result = await harness.host.emitInput("implement pictured objective", "rpc", { images: [image] });
    expect(result.action).toBe("handled");
    expect(harness.host.userMessageDeliveries[0]?.content).toContainEqual(image);
  });

  it("admits at most one task for concurrent entry attempts", async () => {
    const harness = await createHarness({ flag: true });
    const results = await Promise.all([harness.turn("first racing objective"), harness.turn("second racing objective")]);
    expect(results.every((result) => result.action === "handled")).toBe(true);
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.host.userMessages).toHaveLength(1);
    const listed = await harness.store.list();
    if (!listed.ok) throw new Error("store unavailable");
    expect(listed.value).toHaveLength(1);
  });

  it("injects its governed-start message exactly once without recursive task entry", async () => {
    const harness = await createHarness({ flag: true });

    const governed = await harness.turn("first objective");
    expect(governed.action).toBe("handled");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.host.userMessages).toHaveLength(1);
  });

  it("passes ordinary turns through while a non-terminal runtime is active", async () => {
    const harness = await createHarness({ flag: true });

    await harness.turn("objective one");
    expect(harness.runtimes).toHaveLength(1);

    const followUp = await harness.turn("keep working on the same task");
    expect(followUp.action).toBe("continue");
    expect(harness.runtimes).toHaveLength(1);
    expect(harness.host.ordinaryExecutions).toEqual(["keep working on the same task"]);
  });

  it.each(["/unknown command", "/skill:test", "/new"])("leaves structural slash input %s to Pi", async (text) => {
    const harness = await createHarness({ flag: true });
    const result = await harness.turn(text, "rpc");
    expect(result.action).toBe("continue");
    expect(harness.runtimes).toHaveLength(0);
  });

  it("routes RPC-sourced operator turns with identical semantics", async () => {
    const harness = await createHarness({ flag: true });

    const disposition = await harness.turn("rpc-sourced objective", "rpc");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(1);
  });
});

describe("fail-closed governed entry", () => {
  it("allows /wayforge on while durable authority is unavailable, then fails the next turn closed (policy A)", async () => {
    const harness = await createHarness({ unavailable: true });

    await harness.host.runCommand("wayforge", "on");
    expect(harness.notifications().some((message) => message.includes("default governed mode: on"))).toBe(true);

    await harness.host.runCommand("wayforge", "status");
    const status = statusBody(harness.notifications());
    expect(status).toContain("default governed mode: on");
    expect(status).toContain("durable authority: unavailable");

    const disposition = await harness.turn("would be governed");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(0);
    expect(harness.notifications().some((message) => message.includes("Default governed entry failed"))).toBe(true);
  });

  it("consumes the turn visibly when the ownership guard failed closed", async () => {
    const harness = await createHarness({
      flag: true,
      beforeExtension: (host) => {
        host.registerCommand("wayforge", {
          description: "rogue duplicate",
          handler: async () => {},
          sourceInfo: { source: "competing-package", path: "/tmp/rogue-extension.js" },
        });
      },
    });

    const disposition = await harness.turn("would be governed");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(0);
    expect(harness.notifications().some((message) => message.includes("Default governed entry failed"))).toBe(true);
  });

  it("consumes the turn visibly when governed entry itself throws (no model selected)", async () => {
    const harness = await createHarness({ flag: true });
    harness.host.modelShape = undefined;

    const disposition = await harness.turn("would be governed");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.runtimes).toHaveLength(0);
    expect(harness.notifications().some((message) => message.includes("Default governed entry failed"))).toBe(true);
  });

  it("consumes the turn visibly on an unexpected internal failure after admission committed (truthful partial state)", async () => {
    const harness = await createHarness({ flag: true });
    vi.spyOn(harness.host, "sendUserMessage").mockImplementationOnce(() => {
      throw new Error("injected injection failure");
    });

    const disposition = await harness.turn("objective with late failure");
    expect(disposition.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.notifications().some((message) => message.includes("Default governed entry failed"))).toBe(true);
    // Durable admission legitimately committed before the injected failure.
    expect(harness.runtimes).toHaveLength(1);
  });
  it("keeps launch routing fail-closed even if startup failure notification throws", async () => {
    const harness = await createHarness({
      flag: true, unavailable: true,
      beforeExtension: (host) => {
        vi.spyOn(host.ctx.ui, "notify").mockImplementationOnce(() => {
          throw new Error("startup notification failure");
        });
      },
    });
    const result = await harness.turn("must remain governed", "rpc");
    expect(result.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
  });

  it("still consumes input when the failure notifier throws", async () => {
    const harness = await createHarness({ flag: true });
    harness.host.modelShape = undefined;
    vi.spyOn(harness.host.ctx.ui, "notify").mockImplementation(() => {
      throw new Error("injected notifier failure");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const result = await harness.turn("must not execute ordinarily", "rpc");
    expect(result.action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.host.inputErrors).toHaveLength(0);
    expect(stderr).toHaveBeenCalled();
  });

  it("consumes input even when both notification and stderr reporting throw", async () => {
    const harness = await createHarness({ flag: true });
    harness.host.modelShape = undefined;
    vi.spyOn(harness.host.ctx.ui, "notify").mockImplementation(() => { throw new Error("notify unavailable"); });
    vi.spyOn(process.stderr, "write").mockImplementation(() => { throw new Error("stderr unavailable"); });
    expect((await harness.turn("must never fall through", "rpc")).action).toBe("handled");
    expect(harness.host.ordinaryExecutions).toHaveLength(0);
    expect(harness.host.inputErrors).toHaveLength(0);
  });

  it("does not query historical evidence to route an active runtime", async () => {
    const harness = await createHarness({ flag: true });
    await harness.turn("active objective");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const load = vi.spyOn(FilesystemDurableTaskStore.prototype, "load").mockImplementation(async () => {
      throw new Error("historical inspection unavailable");
    });

    const result = await harness.turn("continue active work");
    expect(result.action).toBe("continue");
    expect(harness.runtimes).toHaveLength(1);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("lifecycle routing", () => {
  it("creates a new governed task after the active task completes", async () => {
    const harness = await createHarness({ flag: true });

    await harness.turn("first objective");
    await harness.recordValidation("pnpm test", true, "passed");
    await harness.complete();
    const first = harness.runtimes[0];
    if (first === undefined) throw new Error("first runtime missing");
    await waitFor(() => Promise.resolve(first.controller.status().status === "completed"), "task A not completed");

    const second = await harness.turn("second objective");
    expect(second.action).toBe("handled");
    expect(harness.runtimes).toHaveLength(2);
    const listed = await harness.store.list();
    if (!listed.ok) throw new Error("store list failed");
    expect(listed.value.map((task) => task.taskId).sort()).toEqual(["alpha0-1", "alpha0-2"]);
    expect(await harness.state("alpha0-1")).toMatchObject({ status: "completed" });
    expect(await harness.state("alpha0-2")).toMatchObject({ status: "running", objective: "second objective" });
  });

  it("creates a new governed task after cancellation", async () => {
    const harness = await createHarness({ flag: true });

    await harness.turn("first objective");
    await harness.cancel();
    const first = harness.runtimes[0];
    if (first === undefined) throw new Error("first runtime missing");
    await waitFor(() => Promise.resolve(first.controller.status().status === "cancelled"), "task A not cancelled");

    const second = await harness.turn("replacement objective");
    expect(second.action).toBe("handled");
    expect(harness.runtimes).toHaveLength(2);
  });

  it("admits a new task after a live blocked runtime", async () => {
    const harness = await createHarness({ flag: true });
    await harness.turn("first objective");
    harness.runtimes[0]!.state.setStatus("blocked");
    expect((await harness.turn("new objective")).action).toBe("handled");
    expect(harness.runtimes).toHaveLength(2);
  });

  it.each(["unable", "malformed"] as const)("does not release an active runtime after %s review", async (kind) => {
    const harness = await createHarness({ flag: true });
    await harness.turn("first objective");
    await harness.recordValidation("check", true, "passed");
    harness.setAdvisor(kind === "malformed" ? { kind: "malformed" } : { kind: "verdict", status: "unable" });
    await harness.complete();
    expect((await harness.turn("keep investigating")).action).toBe("continue");
    expect(harness.runtimes).toHaveLength(1);
  });

  it("lets explicit /wayforge <objective> start again after a terminal runtime", async () => {
    const harness = await createHarness({ flag: true });

    await harness.turn("first objective");
    await harness.cancel();

    await harness.host.runCommand("wayforge", "explicit objective two");
    expect(harness.runtimes).toHaveLength(2);
    expect(harness.notifications().some((message) => message.includes("already active"))).toBe(false);
  });

  it("routes corrected work into a NEW task after changes_requested", async () => {
    const harness = await createHarness({ flag: true });

    await harness.turn("first objective");
    const first = harness.runtimes[0];
    if (first === undefined) throw new Error("first runtime missing");
    await harness.recordValidation("pnpm test", true, "passed");
    harness.setAdvisor({ kind: "verdict", status: "changes_requested", summary: "tighten the guide" });
    await harness.complete();
    await waitFor(async () => {
      const state = await harness.state(first.controller.taskId);
      return "negativeReview" in state && state.negativeReview !== null;
    }, "negative review not recorded");

    await harness.host.runCommand("wayforge", "status");
    expect(statusBody(harness.notifications())).toContain("active governed task: no");
    const corrected = await harness.turn("corrected objective");
    expect(corrected.action).toBe("handled");
    expect(harness.runtimes).toHaveLength(2);
    const second = harness.runtimes[1];
    if (second === undefined) throw new Error("second runtime missing");
    expect(second.controller.taskId).not.toBe(first.controller.taskId);
    expect(await harness.state(second.controller.taskId)).toMatchObject({ status: "running", objective: "corrected objective" });
    const firstState = await harness.state(first.controller.taskId);
    expect("negativeReview" in firstState ? firstState.negativeReview : undefined).toMatchObject({
      outcome: "changes_requested",
      summary: "tighten the guide",
    });
  });
});

describe("status privacy", () => {
  it("exposes no absolute workspace paths in the status body", async () => {
    const harness = await createHarness({ flag: true });
    await harness.turn("objective one");
    await harness.host.runCommand("wayforge", "status");
    const body = statusBody(harness.notifications());
    expect(body).not.toContain(harness.workspace);
    expect(body).not.toContain(tmpdir());
  });
});
});
