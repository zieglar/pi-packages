import { describe, expect, it, vi } from "vitest";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import type { ContinuationLauncher } from "../src/durable/contracts.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";
import { invocationId, taskId } from "../src/types/identity.js";
import { success } from "../src/types/result.js";
import { WakeupService } from "../src/recovery/wakeup-service.js";

const workspace = populatedTaskState().workspace!;

function suspended(overrides: Partial<ReturnType<typeof populatedTaskState>> = {}) {
  const base = populatedTaskState({
    taskId: "task-wakeup",
    revision: 0,
    checkpoint: { revision: 0, summary: "checkpoint", completedWork: [], remainingWork: ["resume"] },
    leaseGeneration: 0,
    continuation: null,
    status: "suspended",
    suspension: {
      ...populatedTaskState().suspension!,
      observedAtMs: 1_000,
      resumeNotBeforeMs: 1_000,
      nextCheckAtMs: 1_000,
      checkCount: 0,
      maxChecks: 2,
    },
    updatedAtMs: 1_000,
  });
  return { ...base, ...overrides };
}

function harness(
  available: boolean,
  options: { readonly now?: number; readonly capture?: typeof workspace; readonly maxRecoveryAttempts?: number } = {},
) {
  const now = options.now ?? 1_000;
  const store = new InMemoryTaskStore({ now: () => now });
  const launch = vi.fn<ContinuationLauncher["launch"]>(async () => success({ invocationId: invocationId("new-invocation"), sessionId: "new-session" }));
  const launcher: ContinuationLauncher = { launch };
  const service = new WakeupService({
    store,
    launcher,
    now: () => now,
    leaseTtlMs: 10_000,
    maxContinuationLaunches: 2,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? 2,
    captureWorkspace: async () => options.capture ?? workspace,
    evaluateAvailability: () => ({ available, reason: available ? "health_available" : "health_unavailable" }),
  });
  return { store, launch, service };
}

describe("WakeupService", () => {
  it("ignores future and terminal durable tasks without leasing or launching", async () => {
    const { store, launch, service } = harness(true);
    await store.create(suspended({ suspension: { ...suspended().suspension!, nextCheckAtMs: 2_000 } }));
    await store.create(suspended({ taskId: "task-completed", status: "completed", suspension: null }));

    const scanned = await service.scanDueTasks();
    expect(scanned.ok && scanned.value).toEqual({ scanned: 2, due: 0, processed: 0 });
    expect(launch).not.toHaveBeenCalled();
  });


  it("permits sequential revision-checked writes under one live fenced lease", async () => {
    const { store } = harness(true);
    await store.create(suspended());
    const lease = await store.acquireLease(taskId("task-wakeup"), 10_000);
    if (!lease.ok) throw new Error(lease.failure.code);
    const first = await store.load(taskId("task-wakeup"));
    if (!first.ok || first.value === null) throw new Error("missing task");
    const written = await store.update(first.value.revision, { ...first.value, revision: first.value.revision + 1, status: "resuming" }, lease.value);
    if (!written.ok) throw new Error(written.failure.code);
    const second = await store.update(written.value.revision, { ...written.value, revision: written.value.revision + 1, currentPhase: "revalidated" }, lease.value);
    expect(second.ok).toBe(true);
  });
  it("persists a bounded reschedule when due availability remains unavailable", async () => {
    const { store, launch, service } = harness(false);
    await store.create(suspended());

    const result = await service.scanDueTasks();
    expect(result.ok).toBe(true);
    expect(launch).not.toHaveBeenCalled();
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({
      status: "suspended",
      recoveryCounters: { resumeChecks: 1 },
      suspension: { checkCount: 1, nextCheckAtMs: 31_000 },
    });
  });

  it("blocks rather than loops once persisted resume checks are exhausted", async () => {
    const { store, launch, service } = harness(false);
    await store.create(suspended({ suspension: { ...suspended().suspension!, checkCount: 1, maxChecks: 2 } }));

    await service.scanDueTasks();
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({
      status: "blocked",
      lastFailure: { code: "resume_check_budget_exhausted" },
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("blocks before launch when the persisted recovery-attempt budget is exhausted", async () => {
    const { store, launch, service } = harness(true, { maxRecoveryAttempts: 1 });
    await store.create(suspended({
      recoveryCounters: { ...suspended().recoveryCounters, recoveryAttempts: 1 },
    }));

    await service.scanDueTasks();
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({
      status: "blocked",
      lastFailure: { code: "recovery_attempt_budget_exhausted" },
    });
    expect(launch).not.toHaveBeenCalled();
  });


  it("launches exactly one new continuation for a due, available, drift-safe task", async () => {
    const { store, launch, service } = harness(true);
    await store.create(suspended());

    const result = await service.scanDueTasks();
    expect(result.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
    const [packageData, continuationId] = launch.mock.calls[0] ?? [];
    expect(continuationId).toBe("task-wakeup:resume-1");
    expect(packageData).toMatchObject({ taskId: "task-wakeup", continuationId, continuationOf: "inv-1" });
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({
      status: "running",
      continuation: { continuationId, phase: "launched", continuationOf: "inv-1" },
      invocationProvenance: { invocationId: "new-invocation" },
      recoveryCounters: { continuationLaunches: 1, recoveryAttempts: 1 },
      suspension: null,
    });
  });

  it("blocks conflicting drift before launching and preserves the external workspace", async () => {
    const conflicting = { ...workspace, changedPaths: [{ path: workspace.taskWriteSet[0]!, status: "modified" as const, worktreeDigest: "different" }], workingStateDigest: "different" };
    const { store, launch, service } = harness(true, { capture: conflicting });
    await store.create(suspended());

    await service.scanDueTasks();
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({ status: "blocked", lastFailure: { code: "workspace_drift_conflict" } });
    expect(launch).not.toHaveBeenCalled();
    expect(conflicting.changedPaths[0]?.worktreeDigest).toBe("different");
  });

  it("restarts a pre-launch resuming snapshot without duplicating an external launch", async () => {
    const { store, launch, service } = harness(true);
    await store.create(suspended({ status: "resuming", continuation: null }));

    await service.scanDueTasks();
    expect(launch).toHaveBeenCalledTimes(1);
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({
      status: "running",
      continuation: { continuationId: "task-wakeup:resume-1", phase: "launched" },
    });
  });


  it("fails closed after a crash-marked launching intent rather than duplicating work", async () => {
    const { store, launch, service } = harness(true);
    await store.create(suspended({
      status: "resuming",
      suspension: null,
      continuation: { continuationId: "task-wakeup:resume-1", continuationOf: "inv-1", preparedAtMs: 1_000, phase: "launching" },
    }));

    await service.scanDueTasks();
    const updated = await store.load(taskId("task-wakeup"));
    expect(updated.ok && updated.value).toMatchObject({ status: "blocked", lastFailure: { code: "continuation_outcome_ambiguous" } });
    expect(launch).not.toHaveBeenCalled();
  });
});
