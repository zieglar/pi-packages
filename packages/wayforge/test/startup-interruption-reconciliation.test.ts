import { describe, expect, it, vi } from "vitest";
import { inspectDurableTask } from "../src/durable/inspection.js";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import type { ContinuationLauncher, DurableTaskStore } from "../src/durable/contracts.js";
import { StartupRecoveryScanner } from "../src/recovery/startup-recovery-scan.js";
import { WakeupService } from "../src/recovery/wakeup-service.js";
import { taskId } from "../src/types/identity.js";
import { success, type ExecutionResult } from "../src/types/result.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

/**
 * Phase B2: a durable `running` task left by a previous governed execution
 * must be reconciled at startup into a safe blocked state — never silently
 * orphaned — using lease/CAS authority, without touching suspended/resuming
 * wakeup semantics, and never classifying a current owner's task.
 */

function suspended(id: string, nextCheckAtMs = 1_000) {
  return populatedTaskState({
    taskId: id,
    revision: 0,
    leaseGeneration: 0,
    status: "suspended",
    continuation: null,
    suspension: {
      ...populatedTaskState().suspension!,
      nextCheckAtMs,
      resumeNotBeforeMs: nextCheckAtMs,
      checkCount: 0,
      maxChecks: 2,
    },
  });
}

function staleRunning(id: string, overrides: Record<string, unknown> = {}) {
  return populatedTaskState({
    taskId: id,
    revision: 0,
    leaseGeneration: 0,
    status: "running",
    suspension: null,
    continuation: null,
    ...overrides,
  });
}

function makeWakeup(store: DurableTaskStore, now = 1_000) {
  const launch = vi.fn<ContinuationLauncher["launch"]>(async () => success({ invocationId: "resume-invocation" as never }));
  const wakeup = new WakeupService({
    store,
    launcher: { launch },
    now: () => now,
    leaseTtlMs: 10_000,
    maxContinuationLaunches: 2,
    maxRecoveryAttempts: 5,
    captureWorkspace: async (state) => state.workspace!,
    evaluateAvailability: () => ({ available: true, reason: "health_available" }),
  });
  return { wakeup, launch };
}

describe("startup interruption reconciliation (B2)", () => {
  it("B2.1 reconciles a previous-process running task into blocked with an interruption reason", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    const seeded = staleRunning("task-orphan");
    await store.create(seeded);

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);
    if (scanned.ok) expect(scanned.value.reconciled).toBe(1);

    const loaded = await store.load(taskId("task-orphan"));
    if (!loaded.ok || loaded.value === null) throw new Error("task missing after reconciliation");
    const stored = loaded.value;
    expect(stored).toMatchObject({
      status: "blocked",
      lastFailure: { code: "interrupted_execution" },
    });
    // Evidence, objective, and workspace checkpoint survive reconciliation.
    expect(stored.objective).toBe(seeded.objective);
    expect(stored.evidence.map((entry) => entry.evidenceId)).toEqual(seeded.evidence.map((entry) => entry.evidenceId));
    expect(stored.workspace).toEqual(seeded.workspace);
    expect(stored.revision).toBeGreaterThan(seeded.revision);
    expect(stored.completionEvidence).toBeNull();
  });

  it("B2.2 exposes the reconciled state through the Phase A inspection surface", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(staleRunning("task-orphan"));

    await scanner.scan();
    const inspected = await inspectDurableTask(store, taskId("task-orphan"));
    expect(inspected).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "blocked",
        nextAction: "inspect the failure and start a new task after correction",
        lastFailure: { kind: "capability", code: "interrupted_execution" },
      }),
    });
  });

  it("B2.3 leaves completed, cancelled, and blocked tasks unchanged", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    for (const status of ["completed", "cancelled", "blocked"] as const) {
      await store.create(populatedTaskState({ taskId: `task-${status}`, revision: 0, leaseGeneration: 0, status, suspension: null, continuation: null }));
    }

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);
    for (const status of ["completed", "cancelled", "blocked"] as const) {
      const loaded = await store.load(taskId(`task-${status}`));
      if (!loaded.ok || loaded.value === null) throw new Error(`task missing: ${status}`);
      expect(loaded.value.status).toBe(status);
      expect(loaded.value.lastFailure?.code ?? "").not.toBe("interrupted_execution");
    }
  });

  it("B2.4 preserves suspended wakeup semantics alongside running reconciliation", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup, launch } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(suspended("task-due"));
    await store.create(staleRunning("task-orphan"));

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);
    if (scanned.ok) {
      expect(scanned.value.discovered).toBe(1);
      expect(scanned.value.processed).toBe(1);
      expect(scanned.value.reconciled).toBe(1);
    }
    expect(launch).toHaveBeenCalledTimes(1);

    const resumed = await store.load(taskId("task-due"));
    expect(resumed.ok && resumed.value?.status).toBe("running");
    const orphan = await store.load(taskId("task-orphan"));
    expect(orphan.ok && orphan.value?.status).toBe("blocked");
  });

  it("B2.5 keeps the ambiguous launching fail-closed behavior", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup, launch } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(populatedTaskState({
      taskId: "task-launching",
      revision: 0,
      leaseGeneration: 0,
      status: "resuming",
      suspension: suspended("x").suspension,
      continuation: { continuationId: "cont-1", phase: "launching", preparedAtMs: 900 },
    }));

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);
    expect(launch).toHaveBeenCalledTimes(0);
    const stored = await store.load(taskId("task-launching"));
    expect(stored.ok && stored.value).toMatchObject({
      status: "blocked",
      lastFailure: { code: "continuation_outcome_ambiguous" },
    });
  });

  it("B2.6 loses safely on a CAS conflict and never corrupts state", async () => {
    const base = new InMemoryTaskStore({ now: () => 1_000 });
    let failNextUpdate = true;
    const store: DurableTaskStore = Object.assign(
      Object.create(Object.getPrototypeOf(base)),
      base,
      { update: async (expectedRevision: number, next: Parameters<DurableTaskStore["update"]>[1], lease?: Parameters<DurableTaskStore["update"]>[2]) => {
        if (failNextUpdate) {
          failNextUpdate = false;
          return {
            ok: false,
            failure: { kind: "capability", scope: "task", confidence: "certain", code: "stale_task_revision", message: "conflict" },
          } satisfies ExecutionResult<never>;
        }
        return base.update(expectedRevision, next, lease);
      } },
    );
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(staleRunning("task-contended"));

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);
    const stored = await store.load(taskId("task-contended"));
    if (!stored.ok || stored.value === null) throw new Error("task-contended missing");
    expect(stored.value.status).toBe("running");
    expect(stored.value.lastFailure?.code ?? "").not.toBe("interrupted_execution");
  });

  it("B2.7 never reconciles a task owned by the current process", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(staleRunning("task-live"));
    await store.create(staleRunning("task-orphan"));

    const scanned = await scanner.scan({
      isOwnedTask: (id) => id === "task-live",
    });
    expect(scanned.ok).toBe(true);
    const live = await store.load(taskId("task-live"));
    if (!live.ok || live.value === null) throw new Error("task-live missing");
    expect(live.value.status).toBe("running");
    const orphan = await store.load(taskId("task-orphan"));
    if (!orphan.ok || orphan.value === null) throw new Error("task-orphan missing");
    expect(orphan.value.status).toBe("blocked");
  });

  it("B2.8 preserves a settled negative review across interruption reconciliation", async () => {
    const store = new InMemoryTaskStore({ now: () => 1_000 });
    const { wakeup } = makeWakeup(store);
    const scanner = new StartupRecoveryScanner(store, wakeup, () => 1_000);
    await store.create(staleRunning("task-reviewed", {
      negativeReview: {
        outcome: "changes_requested",
        candidateDigest: "candidate-c1",
        recordedAtMs: 500,
        summary: "correct the validation gap",
      },
    }));

    const scanned = await scanner.scan();
    expect(scanned.ok).toBe(true);

    const loaded = await store.load(taskId("task-reviewed"));
    if (!loaded.ok || loaded.value === null) throw new Error("task missing after reconciliation");
    const stored = loaded.value;
    expect(stored.status).toBe("blocked");
    expect("negativeReview" in stored ? stored.negativeReview : undefined).toMatchObject({
      outcome: "changes_requested",
      candidateDigest: "candidate-c1",
      summary: "correct the validation gap",
    });
    const detail = await inspectDurableTask(store, taskId("task-reviewed"));
    expect(detail).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "blocked",
        nextAction: "correct the work and start a new governed task",
        negativeReview: {
          outcome: "changes_requested",
          recordedAtMs: 500,
          summary: "correct the validation gap",
        },
      }),
    });
  });
});
