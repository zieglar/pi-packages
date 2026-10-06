import { describe, expect, it } from "vitest";
import type { DurableTaskStore } from "../src/durable/contracts.js";
import { inspectDurableTask, inspectDurableTasks } from "../src/durable/inspection.js";
import { failure, success } from "../src/types/result.js";
import { durableTaskFixture, populatedTaskState } from "./helpers/durable-task-fixture.js";
import { validTaskState } from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";

function storeWith(states: readonly ReturnType<typeof validTaskState>[]): DurableTaskStore {
  return {
    create: async () => { throw new Error("not used"); },
    load: async (taskId) => success(states.find((state) => state.taskId === taskId) ?? null),
    list: async () => success(states),
    update: async () => { throw new Error("not used"); },
    acquireLease: async () => { throw new Error("not used"); },
    heartbeatLease: async () => { throw new Error("not used"); },
    releaseLease: async () => success(undefined),
  };
}

describe("durable inspection", () => {
  it("returns an empty deterministic list", async () => {
    await expect(inspectDurableTasks(storeWith([]))).resolves.toEqual({ ok: true, value: [] });
  });

  it("presents running state without claiming liveness", async () => {
    const state = validTaskState(durableTaskFixture({ taskId: "running", status: "running" }));
    const result = await inspectDurableTask(storeWith([state]), taskId("running"));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        source: "durable",
        taskId: "running",
        status: "running",
        nextAction: "durable state is running; liveness is not established by this inspection",
      }),
    });
  });

  it("presents bounded suspension metadata without raw failure payloads", async () => {
    const state = populatedTaskState({ taskId: "suspended" });
    const result = await inspectDurableTask(storeWith([state]), taskId("suspended"));

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "suspended",
        suspension: {
          reason: "account quota exhausted",
          strategy: "explicit_reset",
          resumeNotBeforeMs: 5_000,
          nextCheckAtMs: 5_000,
        },
      }),
    });
  });

  it("marks only Completion Authority evidence as authoritative", async () => {
    const state = validTaskState(durableTaskFixture({
      taskId: "completed",
      status: "completed",
      revision: 3,
      leaseGeneration: 2,
      completionEvidence: {
        authority: "completion_authority_v1",
        candidateDigest: "candidate",
        authoritativeRevision: 3,
        workspaceDigest: "workspace",
        validationEvidenceIds: ["validation:test"],
        validationEvidenceDigest: "validation-digest",
        advisor: {
          invocationId: "advisor-1",
          routeId: "advisor-route",
          status: "approve",
          verdictDigest: "verdict",
          summary: "approved",
        },
        completedAtMs: 2_000,
        leaseGeneration: 2,
        summary: "authoritative completion",
      },
    }));

    const result = await inspectDurableTask(storeWith([state]), taskId("completed"));
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        status: "completed",
        completion: { authoritative: true, completedAtMs: 2_000 },
        nextAction: "no action required",
      }),
    });
  });

  it.each([
    ["blocked", "inspect the failure and start a new task after correction"],
    ["cancelled", "start a new task if desired"],
  ] as const)("presents %s as a safe terminal state", async (status, nextAction) => {
    const state = validTaskState(durableTaskFixture({ taskId: status, status }));
    const result = await inspectDurableTask(storeWith([state]), taskId(status));
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ status, nextAction }) });
  });

  it("orders summaries by newest update, then creation, then task id", async () => {
    const states = [
      validTaskState(durableTaskFixture({ taskId: "a", updatedAtMs: 10, createdAtMs: 1 })),
      validTaskState(durableTaskFixture({ taskId: "c", updatedAtMs: 20, createdAtMs: 1 })),
      validTaskState(durableTaskFixture({ taskId: "b", updatedAtMs: 20, createdAtMs: 1 })),
    ];

    const result = await inspectDurableTasks(storeWith(states));
    expect(result).toEqual({ ok: true, value: expect.arrayContaining([
      expect.objectContaining({ taskId: "b" }),
      expect.objectContaining({ taskId: "c" }),
      expect.objectContaining({ taskId: "a" }),
    ]) });
    if (result.ok) expect(result.value.map((entry) => entry.taskId)).toEqual(["b", "c", "a"]);
  });

  it("reports corrupt-store failures without leaking contents", async () => {
    const store: DurableTaskStore = {
      ...storeWith([]),
      list: async () => failure({
        kind: "capability",
        scope: "task",
        confidence: "certain",
        code: "durable_state_corrupt",
        message: "raw payload Bearer secret-token-1234567890",
      }),
    };

    const result = await inspectDurableTasks(store);
    expect(result).toEqual({
      ok: false,
      failure: expect.objectContaining({ code: "durable_inspection_unavailable" }),
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("never serializes workspace paths, provider data, or hidden durable fields", async () => {
    const state = populatedTaskState({ taskId: "private" });
    const result = await inspectDurableTask(storeWith([state]), taskId("private"));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("workspaceRoot");
    expect(serialized).not.toContain("/tmp/wayforge-fixture");
    expect(serialized).not.toContain("account-key-hash");
    expect(serialized).not.toContain("originatingFailure");
  });
});
