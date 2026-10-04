import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { ensureBuilt } from "./helpers/ensure-built.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  durableTaskDirectoryName,
  FilesystemDurableTaskStore,
} from "../src/durable/filesystem-task-store.js";
import { InMemoryTaskStore } from "../src/durable/in-memory-task-store.js";
import { taskId } from "../src/types/identity.js";
import type { ExecutionResult } from "../src/types/result.js";
import type { TaskLease } from "../src/durable/contracts.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

const temporaryDirectories: string[] = [];
const childScript = fileURLToPath(new URL("./fixtures/durable-store-child.mjs", import.meta.url));

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "wayforge-lease-"));
  temporaryDirectories.push(directory);
  return join(directory, "tasks");
}

function makeClock(start = 10_000): { now: () => number; advance: (milliseconds: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

async function createTask(store: FilesystemDurableTaskStore, rawTaskId: string): Promise<void> {
  const created = await store.create(
    populatedTaskState({ taskId: rawTaskId, revision: 0, leaseGeneration: 0 }),
  );
  if (!created.ok) throw new Error(`task setup failed: ${created.failure.code}`);
}

function waitForMessage<T>(child: ChildProcess, type: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== type) return;
      cleanup();
      resolve((message as { result?: T }).result as T);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`lease claimant exited before ${type}: ${String(code)}`));
    };
    const cleanup = (): void => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function claimant(root: string, rawTaskId: string, now: number, ttl: number): ChildProcess {
  return fork(childScript, [root, rawTaskId, String(now), String(ttl)], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

beforeAll(() => {
  ensureBuilt();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.each([
  ["memory", (clock: () => number) => new InMemoryTaskStore({ now: clock })],
  ["filesystem", (clock: () => number, root: string) => new FilesystemDurableTaskStore(root, { now: clock })],
] as const)("%s fenced lease", (_kind, makeStore) => {
  it("acquires, heartbeats, and releases with owner metadata", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = makeStore(clock.now, root);
    await store.create(
      populatedTaskState({ taskId: "task-lease", revision: 0, leaseGeneration: 0 }),
    );

    const acquired = await store.acquireLease(taskId("task-lease"), 1_000);
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error("expected lease");
    expect(acquired.value).toMatchObject({
      taskId: "task-lease",
      leaseGeneration: 1,
      acquiredAtMs: 10_000,
      expiresAtMs: 11_000,
    });
    expect(acquired.value.ownerToken).toMatch(/^[a-f0-9]{32}$/);

    clock.advance(100);
    const heartbeat = await store.heartbeatLease(acquired.value, 2_000);
    expect(heartbeat.ok).toBe(true);
    if (!heartbeat.ok) throw new Error("expected heartbeat");
    expect(heartbeat.value.expiresAtMs).toBe(12_100);
    expect((await store.releaseLease(heartbeat.value)).ok).toBe(true);
  });

  it("rejects a competing claimant and forged owner token", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = makeStore(clock.now, root);
    await store.create(
      populatedTaskState({ taskId: "task-contention", revision: 0, leaseGeneration: 0 }),
    );
    const lease = await store.acquireLease(taskId("task-contention"), 1_000);
    if (!lease.ok) throw new Error("expected lease");

    const contended = await store.acquireLease(taskId("task-contention"), 1_000);
    expect(contended.ok).toBe(false);
    if (!contended.ok) expect(contended.failure.code).toBe("lease_contended");
    const forged = await store.heartbeatLease({ ...lease.value, ownerToken: "0".repeat(32) }, 1_000);
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged.failure.code).toBe("lease_token_mismatch");
  });

  it("reclaims an expired lease with a higher generation and fences the stale holder", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = makeStore(clock.now, root);
    await store.create(
      populatedTaskState({ taskId: "task-reclaim", revision: 0, leaseGeneration: 0 }),
    );
    const first = await store.acquireLease(taskId("task-reclaim"), 100);
    if (!first.ok) throw new Error("expected lease");
    clock.advance(101);

    const second = await store.acquireLease(taskId("task-reclaim"), 100);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected reclaimed lease");
    expect(second.value.leaseGeneration).toBe(2);
    const staleHeartbeat = await store.heartbeatLease(first.value, 100);
    expect(staleHeartbeat.ok).toBe(false);
    const staleRelease = await store.releaseLease(first.value);
    expect(staleRelease.ok).toBe(false);
  });

  it("allows the current owner to release after expiry when no reclaim occurred", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = makeStore(clock.now, root);
    await store.create(
      populatedTaskState({ taskId: "task-expired-release", revision: 0, leaseGeneration: 0 }),
    );
    const lease = await store.acquireLease(taskId("task-expired-release"), 100);
    if (!lease.ok) throw new Error("expected lease");
    clock.advance(101);
    expect((await store.releaseLease(lease.value)).ok).toBe(true);
  });

  it("requires a positive bounded TTL", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = makeStore(clock.now, root);
    await store.create(
      populatedTaskState({ taskId: "task-ttl", revision: 0, leaseGeneration: 0 }),
    );
    const invalid = await store.acquireLease(taskId("task-ttl"), 0);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.failure.code).toBe("invalid_lease_ttl");
  });
});

describe("filesystem lease persistence and process contention", () => {
  it("persists the claim and fences protected updates by generation", async () => {
    const clock = makeClock();
    const root = temporaryRoot();
    const store = new FilesystemDurableTaskStore(root, { now: clock.now });
    await createTask(store, "task-fence");
    const first = await store.acquireLease(taskId("task-fence"), 100);
    if (!first.ok) throw new Error("expected first lease");
    const claimDirectory = join(root, durableTaskDirectoryName("task-fence"), "lease.claim");
    expect(existsSync(claimDirectory)).toBe(true);

    clock.advance(101);
    const second = await store.acquireLease(taskId("task-fence"), 100);
    if (!second.ok) throw new Error("expected second lease");
    const next = populatedTaskState({ taskId: "task-fence", revision: 1, leaseGeneration: 2 });
    const staleUpdate = await store.update(0, next, first.value);
    expect(staleUpdate.ok).toBe(false);
    if (!staleUpdate.ok) expect(staleUpdate.failure.code).toBe("lease_token_mismatch");
    expect((await store.update(0, next, second.value)).ok).toBe(true);
  });

  it("lets exactly one of two synchronized processes acquire and reclaims after process death", async () => {
    const root = temporaryRoot();
    const setup = new FilesystemDurableTaskStore(root, { now: () => 1_000 });
    await createTask(setup, "task-process");

    const first = claimant(root, "task-process", 1_000, 100);
    const second = claimant(root, "task-process", 1_000, 100);
    await Promise.all([waitForMessage(first, "ready"), waitForMessage(second, "ready")]);
    const firstResult = waitForMessage<ExecutionResult<TaskLease>>(first, "result");
    const secondResult = waitForMessage<ExecutionResult<TaskLease>>(second, "result");
    first.send("go");
    second.send("go");
    const results = await Promise.all([firstResult, secondResult]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.failure.code === "lease_contended")).toHaveLength(1);

    const third = claimant(root, "task-process", 1_101, 100);
    await waitForMessage(third, "ready");
    const thirdResult = waitForMessage<ExecutionResult<TaskLease>>(third, "result");
    third.send("go");
    const reclaimed = await thirdResult;
    expect(reclaimed.ok).toBe(true);
    if (reclaimed.ok) expect(reclaimed.value.leaseGeneration).toBe(2);
  });
});
