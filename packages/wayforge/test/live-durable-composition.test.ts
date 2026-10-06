import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { captureWorkspaceCheckpoint } from "../src/durable/workspace-checkpoint.js";
import type { TaskLease } from "../src/durable/contracts.js";
import { PiContinuationLauncher } from "../src/runtime/pi-continuation-launcher.js";
import { createWayforgeExtension } from "../src/extension.js";
import type { WorkflowRuntime } from "../src/workflow/runtime-factory.js";
import { invocationId, routeId, taskId } from "../src/types/identity.js";
import { FakePiHost, temporaryAgentDir } from "./helpers/fake-pi-host.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

/**
 * Phase 1.1 live-composition tests. These drive the REAL extension factory
 * (`createWayforgeExtension`) against a minimal Pi host double, so the
 * durable wiring under test is exactly what a live Pi session executes:
 * durable services at session start, authoritative task creation on
 * `/wayforge`, suspension persistence from a real RecoveryCoordinator
 * decision, startup-scan discovery, new-session continuation, lease fencing,
 * fail-safe drift handling, and at-most-once continuation launches.
 */

const roots: string[] = [];
const T0 = 10_000;
const RESET_AT = T0 + 1_000;

function track(path: string): string {
  roots.push(path);
  return path;
}

function temporaryRoot(prefix: string): string {
  return track(mkdtempSync(join(tmpdir(), prefix)));
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
}

function createWorkspace(): string {
  const workspace = temporaryRoot("wayforge-live-ws-");
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["config", "user.email", "wayforge-test@example.invalid"]);
  git(workspace, ["config", "user.name", "Wayforge Test"]);
  writeFileSync(join(workspace, "owned.txt"), "baseline\n", "utf8");
  git(workspace, ["add", "owned.txt"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  return workspace;
}

interface Clock {
  now: number;
}

interface RecordingSessionFactory {
  readonly prompts: string[];
  readonly sessionIds: string[];
  create(): { sessionId: string; prompt(text: string): Promise<void> };
}

function recordingSessionFactory(): RecordingSessionFactory {
  const prompts: string[] = [];
  const sessionIds: string[] = [];
  return {
    prompts,
    sessionIds,
    create() {
      const sessionId = `fresh-continuation-session-${sessionIds.length + 1}`;
      sessionIds.push(sessionId);
      return {
        sessionId,
        prompt: async (text: string) => {
          prompts.push(text);
        },
      };
    },
  };
}

function launcherWith(factory: RecordingSessionFactory): PiContinuationLauncher {
  return new PiContinuationLauncher({
    factory: {
      create: async () => factory.create(),
    },
  });
}

interface LiveHarness {
  readonly storeRoot: string;
  readonly clock: Clock;
  readonly factory: RecordingSessionFactory;
  host(workspace: string): { host: FakePiHost; runtime: Promise<WorkflowRuntime> };
}

function liveHarness(): LiveHarness {
  const storeRoot = join(temporaryAgentDir(), "wayforge", "tasks");
  const clock: Clock = { now: T0 };
  const factory = recordingSessionFactory();
  return {
    storeRoot,
    clock,
    factory,
    host(workspace: string) {
      const host = new FakePiHost(workspace);
      let resolveRuntime: (runtime: WorkflowRuntime) => void = () => {};
      const runtime = new Promise<WorkflowRuntime>((resolve) => {
        resolveRuntime = resolve;
      });
      createWayforgeExtension({
        durable: {
          storeRoot,
          now: () => clock.now,
          launcher: launcherWith(factory),
        },
        observeRuntime: (runtimeValue) => {
          if (runtimeValue !== undefined) resolveRuntime(runtimeValue);
        },
      })(host as unknown as Parameters<import("@earendil-works/pi-coding-agent").ExtensionFactory>[0]);
      return { host, runtime };
    },
  };
}

async function startGovernedTask(harness: LiveHarness, objective: string): Promise<WorkflowRuntime> {
  const { host, runtime } = harness.host(createWorkspace());
  await host.emitLifecycle("session_start");
  await host.runCommand("wayforge", objective);
  return runtime;
}

/** Real RecoveryCoordinator suspend decision through the live runtime executor. */
async function suspendThroughRecovery(runtime: WorkflowRuntime, storeRoot: string): Promise<void> {
  const decision = runtime.recovery.plan({
    currentRoute: {
      routeId: routeId("observed-worker"),
      provider: "test-provider",
      modelId: "test-model",
      tier: "flagship",
      thinking: "low",
      capabilities: { worker: true, advisor: false, tools: true, reasoning: true },
      budgetLimit: 32_000,
    },
    alternatives: [],
    budget: { retriesLeft: 0, fallbacksLeft: 0 },
    failure: {
      kind: "usage_limit",
      scope: "account",
      confidence: "certain",
      code: "quota_exhausted",
      message: "usage window exhausted",
      resetAtMs: RESET_AT,
    },
    failedInvocationId: invocationId("live-suspend-inv"),
  });
  expect(decision.terminal?.action).toBe("suspend");
  await pollStore(storeRoot, (state) => state.status === "suspended");
}

async function storeAt(storeRoot: string, now: () => number = () => T0): Promise<FilesystemDurableTaskStore> {
  return new FilesystemDurableTaskStore(storeRoot, { now });
}

async function pollStore(
  storeRoot: string,
  predicate: (state: { status: string; continuation: { phase: string } | null }) => boolean,
  now: () => number = () => T0,
): Promise<void> {
  const store = await storeAt(storeRoot, now);
  const deadline = Date.now() + 4_000;
  for (;;) {
    const listed = await store.list();
    if (!listed.ok) throw new Error(listed.failure.code);
    if (listed.value.length > 0 && predicate(listed.value[0]!)) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for durable state transition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeAll(() => execFileSync("npm", ["run", "build"], { cwd: process.cwd(), stdio: "pipe" }));
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

describe("live durable composition", () => {
  it("persists cancellation before session_shutdown returns", async () => {
    const harness = liveHarness();
    const live = harness.host(createWorkspace());
    await live.host.emitLifecycle("session_start");
    await live.host.runCommand("wayforge", "durable shutdown barrier");
    const runtime = await live.runtime;
    await live.host.emitLifecycle("session_shutdown");
    const store = await storeAt(harness.storeRoot);
    const loaded = await store.load(runtime.controller.taskId);
    expect(loaded.ok && loaded.value?.status).toBe("cancelled");
  });

  it("reconciles the prior running task and allocates a distinct durable task after restart", async () => {
    const harness = liveHarness();
    const workspace = createWorkspace();
    const first = harness.host(workspace);
    await first.host.emitLifecycle("session_start");
    await first.host.runCommand("wayforge", "original governed task");
    const firstRuntime = await first.runtime;
    const store = await storeAt(harness.storeRoot);
    const original = await store.load(firstRuntime.controller.taskId);

    const second = harness.host(workspace);
    await second.host.emitLifecycle("session_start");
    await second.host.runCommand("wayforge", "new task after restart");
    const secondRuntime = await second.runtime;
    expect(secondRuntime.controller.taskId).not.toBe(firstRuntime.controller.taskId);
    await second.host.emitLifecycle("session_shutdown");
    await pollStore(harness.storeRoot, (state) => state.status === "blocked");
    // Phase B2: the prior execution's running task is reconciled at the new
    // session's startup scan — blocked with an interruption reason, never
    // silently orphaned — while the new task stays distinct.
    const reconciled = await store.load(firstRuntime.controller.taskId);
    if (!reconciled.ok || reconciled.value === null) throw new Error("prior task missing");
    expect(reconciled.value.status).toBe("blocked");
    expect(reconciled.value.lastFailure?.code).toBe("interrupted_execution");
    expect(reconciled.value?.objective).toBe(original.ok ? original.value?.objective : undefined);
    const listed = await store.list();
    expect(listed.ok && listed.value.length).toBe(2);
  });

  it("constructs durable services that process a pre-existing due suspension at session start", async () => {
    const harness = liveHarness();
    const workspace = createWorkspace();
    const checkpoint = await captureWorkspaceCheckpoint({
      workspaceRoot: workspace,
      taskWriteSet: ["owned.txt"],
      capturedAtMs: T0,
    });
    expect(checkpoint.ok).toBe(true);
    const store = await storeAt(harness.storeRoot);
    const seeded = populatedTaskState({
      taskId: "task-seeded",
      status: "suspended",
      workspace: checkpoint.ok ? checkpoint.value : null,
      continuation: null,
      leaseGeneration: 0,
      revision: 0,
      suspension: {
        ...populatedTaskState().suspension!,
        strategy: "explicit_reset",
        resumeNotBeforeMs: T0,
        nextCheckAtMs: T0,
        checkCount: 0,
        maxChecks: 2,
      },
    });
    const created = await store.create(seeded);
    expect(created.ok).toBe(true);

    const { host } = harness.host(workspace);
    await host.emitLifecycle("session_start");
    await pollStore(harness.storeRoot, (state) => state.status === "running");
    expect(harness.factory.sessionIds).toHaveLength(1);
  });

  it("gives a governed live task an authoritative durable identity", async () => {
    const harness = liveHarness();
    await startGovernedTask(harness, "compose the durable live path");
    const store = await storeAt(harness.storeRoot);
    const loaded = await store.load(taskId("alpha0-1"));
    expect(loaded.ok && loaded.value).toMatchObject({
      taskId: "alpha0-1",
      status: "running",
      objective: "compose the durable live path",
      revision: 0,
      leaseGeneration: 0,
    });
    const state = loaded.ok ? loaded.value : undefined;
    expect(state?.completionCriteria.length).toBeGreaterThan(0);
    expect(state?.workspace).not.toBeNull();
    expect(state?.workspace?.changedPaths.map((entry) => entry.path)).toEqual([]);
  });

  it("persists authoritative suspension from a real RecoveryCoordinator decision", async () => {
    const harness = liveHarness();
    const runtime = await startGovernedTask(harness, "suspend through the live path");
    await suspendThroughRecovery(runtime, harness.storeRoot);

    const store = await storeAt(harness.storeRoot);
    const loaded = await store.load(taskId("alpha0-1"));
    const state = loaded.ok ? loaded.value : undefined;
    expect(state?.status).toBe("suspended");
    expect(state?.suspension).toMatchObject({
      kind: "usage_limit",
      strategy: "explicit_reset",
      resumeNotBeforeMs: RESET_AT,
      decidedBy: "recovery_coordinator",
    });
    expect(state?.lastFailure).toMatchObject({ code: "quota_exhausted" });
    expect(state?.revision).toBeGreaterThan(0);
  });

  it("discovers a live-created suspended task through a fresh composition's startup scan", async () => {
    const harness = liveHarness();
    const runtime = await startGovernedTask(harness, "restart discovery through live composition");
    await suspendThroughRecovery(runtime, harness.storeRoot);

    harness.clock.now = RESET_AT + 1;
    const workspace = process.cwd(); // replacement below; scan uses the persisted workspace
    const second = harness.host(workspace);
    await second.host.emitLifecycle("session_start");
    await pollStore(harness.storeRoot, (state) => state.status === "running", () => harness.clock.now);
    const store = await storeAt(harness.storeRoot, () => harness.clock.now);
    const loaded = await store.load(taskId("alpha0-1"));
    expect(loaded.ok && loaded.value?.continuation).toMatchObject({
      continuationId: "alpha0-1:resume-1",
      phase: "launched",
    });
    expect(loaded.ok && loaded.value?.invocationProvenance).toMatchObject({
      invocationId: "alpha0-1:resume-1",
      role: "continuation",
    });
  });

  it("continues in a new session without reusing the suspended invocation", async () => {
    const harness = liveHarness();
    const runtime = await startGovernedTask(harness, "new session continuation");
    await suspendThroughRecovery(runtime, harness.storeRoot);

    harness.clock.now = RESET_AT + 1;
    const { host } = harness.host(createWorkspace());
    await host.emitLifecycle("session_start");
    await pollStore(harness.storeRoot, (state) => state.status === "running", () => harness.clock.now);

    expect(harness.factory.sessionIds).toHaveLength(1);
    const sessionId = harness.factory.sessionIds[0]!;
    expect(sessionId).not.toContain("alpha0");
    expect(harness.factory.prompts[0]).toContain("Wayforge continuation package");
    expect(harness.factory.prompts[0]).toContain("new invocation");
    expect(harness.factory.prompts[0]).toContain("new session continuation");
    const store = await storeAt(harness.storeRoot, () => harness.clock.now);
    const loaded = await store.load(taskId("alpha0-1"));
    expect(loaded.ok && loaded.value?.invocationProvenance?.invocationId).not.toBe("live-suspend-inv");
  });

  it("keeps lease fencing effective: stale generations cannot update or complete a newer task", async () => {
    const harness = liveHarness();
    const runtime = await startGovernedTask(harness, "fencing through live wiring");
    await suspendThroughRecovery(runtime, harness.storeRoot);

    const store = await storeAt(harness.storeRoot, () => harness.clock.now);
    const lease = await store.acquireLease(taskId("alpha0-1"), 60_000);
    expect(lease.ok).toBe(true);
    const loaded = await store.load(taskId("alpha0-1"));
    const state = loaded.ok && loaded.value !== null ? loaded.value : undefined;
    if (state === undefined) throw new Error("state missing");
    expect(state).toBeDefined();
    expect(lease.ok && lease.value.leaseGeneration).toBeGreaterThan(0);

    const staleLease: TaskLease = {
      taskId: taskId("alpha0-1"),
      ownerToken: "dead-owner-token",
      leaseGeneration: (lease.ok ? lease.value.leaseGeneration : 1) - 1,
      acquiredAtMs: T0,
      expiresAtMs: harness.clock.now + 60_000,
    };
    const staleUpdate = await store.update(state.revision, { ...state, currentPhase: "hijacked" }, staleLease);
    expect(staleUpdate.ok).toBe(false);
    if (!staleUpdate.ok) expect(staleUpdate.failure.code).toBe("lease_token_mismatch");
    const staleHeartbeat = await store.heartbeatLease(staleLease, 60_000);
    expect(staleHeartbeat.ok).toBe(false);
    const release = await store.releaseLease(lease.ok ? lease.value : staleLease);
    expect(release.ok).toBe(true);
  });

  it("fails safe on conflicting workspace drift without touching user work", async () => {
    const harness = liveHarness();
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "owned.txt"), "task-owned change\n", "utf8");

    const { host, runtime } = harness.host(workspace);
    await host.emitLifecycle("session_start");
    await host.runCommand("wayforge", "drift fail-safe through live composition");
    await suspendThroughRecovery(await runtime, harness.storeRoot);

    const externalBytes = "external change must survive\n";
    writeFileSync(join(workspace, "owned.txt"), externalBytes, "utf8");
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();

    harness.clock.now = RESET_AT + 1;
    const second = harness.host(workspace);
    await second.host.emitLifecycle("session_start");
    await pollStore(harness.storeRoot, (state) => state.status === "blocked", () => harness.clock.now);

    expect(readFileSync(join(workspace, "owned.txt"), "utf8")).toBe(externalBytes);
    expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(workspace, ["status", "--porcelain"]).trim()).toBe("M owned.txt");
    expect(existsSync(join(workspace, ".git", "refs", "stash"))).toBe(false);
    expect(harness.factory.sessionIds).toHaveLength(0);
    const store = await storeAt(harness.storeRoot, () => harness.clock.now);
    const loaded = await store.load(taskId("alpha0-1"));
    expect(loaded.ok && loaded.value?.lastFailure).toMatchObject({ code: "workspace_drift_conflict" });
    expect(loaded.ok && loaded.value?.continuation).toBeNull();
  });

  it("does not duplicate continuation launches across repeated scans or persisted launch intents", async () => {
    const harness = liveHarness();
    const runtime = await startGovernedTask(harness, "at most one continuation");
    await suspendThroughRecovery(runtime, harness.storeRoot);

    harness.clock.now = RESET_AT + 1;
    const first = harness.host(createWorkspace());
    await first.host.emitLifecycle("session_start");
    await pollStore(harness.storeRoot, (state) => state.status === "running", () => harness.clock.now);
    expect(harness.factory.sessionIds).toHaveLength(1);

    // A repeated startup scan must not launch again for a running task.
    const second = harness.host(createWorkspace());
    await second.host.emitLifecycle("session_start");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(harness.factory.sessionIds).toHaveLength(1);

    // A persisted post-side-effect launch intent must fail closed, not relaunch.
    const store = await storeAt(harness.storeRoot, () => harness.clock.now);
    const loaded = await store.load(taskId("alpha0-1"));
    const state = loaded.ok && loaded.value !== null ? loaded.value : undefined;
    if (state === undefined) throw new Error("state missing");
    const persisted = await store.update(
      state.revision,
      {
        ...state,
        revision: state.revision + 1,
        status: "resuming",
        continuation: {
          continuationId: "alpha0-1:resume-9",
          phase: "launching",
          preparedAtMs: harness.clock.now,
        },
      },
    );
    expect(persisted.ok).toBe(true);
    const third = harness.host(createWorkspace());
    await third.host.emitLifecycle("session_start");
    await pollStore(
      harness.storeRoot,
      (candidate) => candidate.status === "blocked" || candidate.status === "running",
      () => harness.clock.now,
    );
    expect(harness.factory.sessionIds).toHaveLength(1);
  });
});
