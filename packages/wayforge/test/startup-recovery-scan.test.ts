import { describe, expect, it, vi } from "vitest";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import type { ContinuationLauncher } from "../src/durable/contracts.js";
import { StartupRecoveryScanner } from "../src/recovery/startup-recovery-scan.js";
import { WakeupService } from "../src/recovery/wakeup-service.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";
import { invocationId, taskId } from "../src/types/identity.js";
import { success } from "../src/types/result.js";

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

describe("StartupRecoveryScanner", () => {
  it("starts only due suspended tasks and remains idempotent across repeated scans", async () => {
    const now = 1_000;
    const store = new InMemoryTaskStore({ now: () => now });
    const launch = vi.fn<ContinuationLauncher["launch"]>(async () => success({ invocationId: invocationId("restart-invocation") }));
    const wakeup = new WakeupService({
      store,
      launcher: { launch },
      now: () => now,
      leaseTtlMs: 10_000,
      maxContinuationLaunches: 1,
      maxRecoveryAttempts: 2,
      captureWorkspace: async (state) => state.workspace!,
      evaluateAvailability: () => ({ available: true, reason: "health_available" }),
    });
    const scanner = new StartupRecoveryScanner(store, wakeup, () => now);
    await store.create(suspended("task-due"));
    await store.create(suspended("task-future", 2_000));
    await store.create(populatedTaskState({ taskId: "task-running", revision: 0, leaseGeneration: 0, status: "running", suspension: null }));
    await store.create(populatedTaskState({ taskId: "task-completed", revision: 0, leaseGeneration: 0, status: "completed", suspension: null }));

    expect(await scanner.scan()).toMatchObject({ ok: true, value: { discovered: 1, processed: 1 } });
    expect(await scanner.scan()).toMatchObject({ ok: true, value: { discovered: 0, processed: 0 } });
    expect(launch).toHaveBeenCalledTimes(1);
    const due = await store.load(taskId("task-due"));
    expect(due.ok && due.value?.status).toBe("running");
  });
});
