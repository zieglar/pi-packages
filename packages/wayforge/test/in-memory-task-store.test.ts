import { describe, expect, it } from "vitest";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import { serializeTaskState } from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";
import { durableTaskFixture, populatedTaskState } from "./helpers/durable-task-fixture.js";

function makeClock(start = 10_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("InMemoryTaskStore", () => {
  it("creates, loads, and enumerates with clone semantics", async () => {
    const store = new InMemoryTaskStore();
    const alpha = populatedTaskState({ taskId: "task-alpha", revision: 0, objective: "alpha" });
    const beta = populatedTaskState({ taskId: "task-beta", revision: 0, objective: "beta" });

    expect(await store.load(taskId("task-alpha"))).toEqual({ ok: true, value: null });

    const created = await store.create(alpha);
    expect(created.ok).toBe(true);
    expect(created).toEqual({ ok: true, value: alpha });
    expect(await store.create(beta)).toEqual({ ok: true, value: beta });

    const duplicate = await store.create(alpha);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.failure.code).toBe("task_already_exists");

    const loaded = await store.load(taskId("task-alpha"));
    expect(loaded.ok && loaded.value).toEqual(alpha);
    if (loaded.ok && loaded.value) {
      (loaded.value as { objective: string }).objective = "mutated";
    }
    const reloaded = await store.load(taskId("task-alpha"));
    expect(reloaded.ok && reloaded.value?.objective).toBe("alpha");

    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("expected ok");
    expect(listed.value.map((state) => state.taskId)).toEqual(["task-alpha", "task-beta"]);
    if (listed.value[0]) (listed.value[0] as { objective: string }).objective = "mutated";
    const relisted = await store.list();
    expect(relisted.ok && relisted.value[0]?.objective).toBe("alpha");
  });

  it("requires revision zero on create", async () => {
    const store = new InMemoryTaskStore();
    const result = await store.create(populatedTaskState({ taskId: "task-nonzero", revision: 3 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("invalid_initial_revision");
  });

  it("enforces expected-revision on update", async () => {
    const store = new InMemoryTaskStore();
    const initial = populatedTaskState({ taskId: "task-alpha", revision: 0 });
    await store.create(initial);

    const missing = await store.update(0, populatedTaskState({ taskId: "task-gone", revision: 1 }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure.code).toBe("task_not_found");

    const wrongExpected = await store.update(7, populatedTaskState({ taskId: "task-alpha", revision: 1 }));
    expect(wrongExpected.ok).toBe(false);
    if (!wrongExpected.ok) expect(wrongExpected.failure.code).toBe("stale_task_revision");

    const nonMonotonic = await store.update(0, populatedTaskState({ taskId: "task-alpha", revision: 0 }));
    expect(nonMonotonic.ok).toBe(false);
    if (!nonMonotonic.ok) expect(nonMonotonic.failure.code).toBe("stale_task_revision");

    const skippedRevision = await store.update(
      0,
      populatedTaskState({ taskId: "task-alpha", revision: 2 }),
    );
    expect(skippedRevision.ok).toBe(false);
    if (!skippedRevision.ok) expect(skippedRevision.failure.code).toBe("stale_task_revision");

    const updated = await store.update(0, populatedTaskState({ taskId: "task-alpha", revision: 1, objective: "next" }));
    expect(updated.ok).toBe(true);
    expect(updated.ok && updated.value.objective).toBe("next");
  });

  it("only stores schema-valid, serializable state", async () => {
    const store = new InMemoryTaskStore();
    const leaky = {
      ...durableTaskFixture({ taskId: "task-leak" }),
      apiKey: "sk-shouldneverpersist",
    } as never;
    const created = await store.create(leaky);
    expect(created.ok).toBe(false);
    const loaded = await store.load(taskId("task-leak"));
    expect(loaded.ok && loaded.value).toBeNull();
  });

  it("persists exactly the deterministic serialized bytes", async () => {
    const store = new InMemoryTaskStore();
    const state = populatedTaskState({ taskId: "task-bytes", revision: 0 });
    await store.create(state);
    const loaded = await store.load(taskId("task-bytes"));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || !loaded.value) throw new Error("expected state");
    expect(serializeTaskState(loaded.value)).toBe(serializeTaskState(state));
  });

  it("acquires, heartbeats, and releases a fenced lease", async () => {
    const clock = makeClock();
    const store = new InMemoryTaskStore({ now: clock.now });
    const state = populatedTaskState({ taskId: "task-lease", revision: 0, leaseGeneration: 0 });
    await store.create(state);

    const lease = await store.acquireLease(taskId("task-lease"), 1_000);
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("expected ok");
    expect(lease.value.leaseGeneration).toBe(1);
    expect(lease.value.ownerToken.length).toBeGreaterThan(0);

    const afterClaim = await store.load(taskId("task-lease"));
    expect(afterClaim.ok && afterClaim.value?.leaseGeneration).toBe(1);

    const contended = await store.acquireLease(taskId("task-lease"), 1_000);
    expect(contended.ok).toBe(false);
    if (!contended.ok) expect(contended.failure.code).toBe("lease_contended");

    const heartbeat = await store.heartbeatLease(lease.value, 5_000);
    expect(heartbeat.ok).toBe(true);
    if (heartbeat.ok) expect(heartbeat.value.expiresAtMs).toBe(15_000);

    const wrongToken = await store.heartbeatLease({ ...lease.value, ownerToken: "forged" }, 5_000);
    expect(wrongToken.ok).toBe(false);
    if (!wrongToken.ok) expect(wrongToken.failure.code).toBe("lease_token_mismatch");

    const released = await store.releaseLease(lease.value);
    expect(released.ok).toBe(true);

    const releasedAgain = await store.releaseLease(lease.value);
    expect(releasedAgain.ok).toBe(false);

    const reacquired = await store.acquireLease(taskId("task-lease"), 1_000);
    expect(reacquired.ok).toBe(true);
    if (reacquired.ok) expect(reacquired.value.leaseGeneration).toBe(2);
  });

  it("reclaims an expired lease and fences stale holders", async () => {
    const clock = makeClock();
    const store = new InMemoryTaskStore({ now: clock.now });
    await store.create(populatedTaskState({ taskId: "task-expiry", revision: 0, leaseGeneration: 0 }));

    const first = await store.acquireLease(taskId("task-expiry"), 1_000);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected ok");

    clock.advance(2_000);
    const staleHeartbeat = await store.heartbeatLease(first.value, 1_000);
    expect(staleHeartbeat.ok).toBe(false);
    if (!staleHeartbeat.ok) expect(staleHeartbeat.failure.code).toBe("lease_expired");

    const reclaimed = await store.acquireLease(taskId("task-expiry"), 1_000);
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error("expected ok");
    expect(reclaimed.value.leaseGeneration).toBe(2);

    const staleRelease = await store.releaseLease(first.value);
    expect(staleRelease.ok).toBe(false);

    const currentRelease = await store.releaseLease(reclaimed.value);
    expect(currentRelease.ok).toBe(true);
  });

  it("refuses leases for unknown tasks", async () => {
    const store = new InMemoryTaskStore();
    const result = await store.acquireLease(taskId("task-missing"), 1_000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("task_not_found");
  });
});
