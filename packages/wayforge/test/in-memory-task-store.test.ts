import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import { validTaskState } from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";

const task = taskId("task-store");
const state = validTaskState({
  taskId: task,
  revision: 0,
  status: "running",
  objective: "alpha",
  completionCriteria: "verified",
  policyVersions: { role: "1", model: "1" },
  checkpoint: { revision: 0, summary: "start" },
  recoveryCounters: { retries: 0, fallbacks: 0, rotations: 0 },
  suspension: null,
  completionEvidence: null,
  createdAtMs: 1,
  updatedAtMs: 1,
});

describe("InMemoryTaskStore", () => {
  it("implements clone-on-read/write TaskStore semantics", async () => {
    const store = new InMemoryTaskStore();
    expect(await store.load(task)).toEqual({ ok: true, value: null });
    const saved = await store.save(state);
    expect(saved).toEqual({ ok: true, value: state });
    const first = await store.load(task);
    expect(first.ok && first.value).toEqual(state);
    if (first.ok && first.value) (first.value as { objective: string }).objective = "mutated";
    const second = await store.load(task);
    expect(second.ok && second.value?.objective).toBe("alpha");
  });

  it("rejects stale revisions", async () => {
    const store = new InMemoryTaskStore();
    await store.save(state);
    const stale = await store.save(state);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure.code).toBe("stale_task_revision");
  });
});
