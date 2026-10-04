import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  durableTaskDirectoryName,
  durableTaskStoreRoot,
  FilesystemDurableTaskStore,
} from "../src/durable/filesystem-task-store.js";
import { DURABLE_TASK_STATE_VERSION, serializeTaskState } from "../src/durable/state.js";
import { taskId } from "../src/types/identity.js";
import { FIXTURE_SECRET, populatedTaskState } from "./helpers/durable-task-fixture.js";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "wayforge-durable-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function taskPaths(root: string, rawTaskId: string): { directory: string; state: string; backup: string } {
  const directory = join(root, durableTaskDirectoryName(rawTaskId));
  return {
    directory,
    state: join(directory, "state.json"),
    backup: join(directory, "state.prev.json"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FilesystemDurableTaskStore", () => {
  it("round-trips deterministic authoritative bytes", async () => {
    const root = join(temporaryRoot(), "wayforge", "tasks");
    const store = new FilesystemDurableTaskStore(root);
    const state = populatedTaskState({ taskId: "task-roundtrip", revision: 0 });

    expect(await store.create(state)).toEqual({ ok: true, value: state });
    expect(await store.load(taskId("task-roundtrip"))).toEqual({ ok: true, value: state });
    expect(readFileSync(taskPaths(root, "task-roundtrip").state, "utf8")).toBe(
      `${serializeTaskState(state)}\n`,
    );
  });

  it("creates, loads, and lists tasks in deterministic task-id order", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    await store.create(populatedTaskState({ taskId: "task-z", revision: 0 }));
    await store.create(populatedTaskState({ taskId: "task-a", revision: 0 }));

    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("expected list success");
    expect(listed.value.map((state) => state.taskId)).toEqual(["task-a", "task-z"]);
  });

  it("enforces expected revisions and keeps one bounded backup", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    const initial = populatedTaskState({ taskId: "task-update", revision: 0, objective: "zero" });
    await store.create(initial);

    const stale = await store.update(9, populatedTaskState({ taskId: "task-update", revision: 1 }));
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.failure.code).toBe("stale_task_revision");

    const first = populatedTaskState({ taskId: "task-update", revision: 1, objective: "one" });
    expect((await store.update(0, first)).ok).toBe(true);
    expect(JSON.parse(readFileSync(taskPaths(root, "task-update").backup, "utf8")).revision).toBe(0);

    const second = populatedTaskState({ taskId: "task-update", revision: 2, objective: "two" });
    expect((await store.update(1, second)).ok).toBe(true);
    expect(JSON.parse(readFileSync(taskPaths(root, "task-update").backup, "utf8")).revision).toBe(1);
    expect(readdirSync(taskPaths(root, "task-update").directory).sort()).toEqual([
      "state.json",
      "state.prev.json",
    ]);
  });

  it("commits with atomic replacement and removes temporary files", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    await store.create(populatedTaskState({ taskId: "task-atomic", revision: 0 }));
    await store.update(0, populatedTaskState({ taskId: "task-atomic", revision: 1 }));
    expect(readdirSync(taskPaths(root, "task-atomic").directory).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("fails closed on malformed JSON and never promotes a backup", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    await store.create(populatedTaskState({ taskId: "task-corrupt", revision: 0 }));
    await store.update(0, populatedTaskState({ taskId: "task-corrupt", revision: 1 }));
    writeFileSync(taskPaths(root, "task-corrupt").state, "{ partial", "utf8");

    const loaded = await store.load(taskId("task-corrupt"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.failure.code).toBe("durable_state_corrupt");
    expect(JSON.parse(readFileSync(taskPaths(root, "task-corrupt").backup, "utf8")).revision).toBe(0);
  });

  it("rejects unsupported schema versions explicitly", async () => {
    const root = join(temporaryRoot(), "tasks");
    const paths = taskPaths(root, "task-version");
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.state, JSON.stringify({ schemaVersion: DURABLE_TASK_STATE_VERSION + 1 }), "utf8");
    const store = new FilesystemDurableTaskStore(root);

    const loaded = await store.load(taskId("task-version"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.failure.code).toBe("unsupported_version");
  });

  it("uses restrictive directory and state-file permissions", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    await store.create(populatedTaskState({ taskId: "task-mode", revision: 0 }));
    const paths = taskPaths(root, "task-mode");
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    expect(statSync(paths.state).mode & 0o777).toBe(0o600);
  });

  it("encodes task IDs beneath the canonical root without collisions or traversal", async () => {
    const parent = temporaryRoot();
    const root = join(parent, "tasks");
    const store = new FilesystemDurableTaskStore(root);
    const dangerous = "../escape/attempt";
    const encoded = durableTaskDirectoryName(dangerous);
    expect(encoded).toMatch(/^task-[A-Za-z0-9_-]+$/);
    expect(resolve(root, encoded).startsWith(`${resolve(root)}/`)).toBe(true);

    expect((await store.create(populatedTaskState({ taskId: dangerous, revision: 0 }))).ok).toBe(true);
    expect(readdirSync(parent)).toEqual(["tasks"]);
    expect(readdirSync(root)).toEqual([encoded]);
  });

  it("rejects a symlinked task directory instead of escaping the root", async () => {
    const parent = temporaryRoot();
    const root = join(parent, "tasks");
    const outside = join(parent, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, durableTaskDirectoryName("task-link")), "dir");
    const store = new FilesystemDurableTaskStore(root);

    const created = await store.create(populatedTaskState({ taskId: "task-link", revision: 0 }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.code).toBe("durable_store_unsafe_path");
    expect(readdirSync(outside)).toEqual([]);
  });
  it("rejects a symlinked store root without chmodding its target", async () => {
    const parent = temporaryRoot();
    const outside = join(parent, "outside-root");
    const linkedRoot = join(parent, "linked-root");
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    symlinkSync(outside, linkedRoot, "dir");
    const beforeMode = statSync(outside).mode & 0o777;
    const store = new FilesystemDurableTaskStore(linkedRoot);

    const listed = await store.list();
    expect(listed.ok).toBe(false);
    if (!listed.ok) expect(listed.failure.code).toBe("durable_store_unsafe_path");
    expect(statSync(outside).mode & 0o777).toBe(beforeMode);
  });

  it("rejects a symlinked state file instead of reading outside the task directory", async () => {
    const parent = temporaryRoot();
    const root = join(parent, "tasks");
    const paths = taskPaths(root, "task-state-link");
    const externalState = join(parent, "external-state.json");
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(
      externalState,
      `${serializeTaskState(populatedTaskState({ taskId: "task-state-link", revision: 0 }))}\n`,
      "utf8",
    );
    symlinkSync(externalState, paths.state);
    const store = new FilesystemDurableTaskStore(root);

    const loaded = await store.load(taskId("task-state-link"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.failure.code).toBe("durable_store_unsafe_path");
  });

  it("treats an orphaned task directory as corrupt authoritative state", async () => {
    const root = join(temporaryRoot(), "tasks");
    const paths = taskPaths(root, "task-orphan");
    mkdirSync(paths.directory, { recursive: true });
    const store = new FilesystemDurableTaskStore(root);

    const created = await store.create(populatedTaskState({ taskId: "task-orphan", revision: 0 }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.code).toBe("durable_state_corrupt");
  });


  it("surfaces filesystem failures and leaves no committed task", async () => {
    const parent = temporaryRoot();
    const blocker = join(parent, "not-a-directory");
    writeFileSync(blocker, "blocker", "utf8");
    const store = new FilesystemDurableTaskStore(join(blocker, "tasks"));

    const created = await store.create(populatedTaskState({ taskId: "task-io", revision: 0 }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.failure.code).toBe("durable_store_io");
  });

  it("never persists secret-shaped values", async () => {
    const root = join(temporaryRoot(), "tasks");
    const store = new FilesystemDurableTaskStore(root);
    const leaky = {
      ...populatedTaskState({ taskId: "task-secret", revision: 0 }),
      objective: `use ${FIXTURE_SECRET}`,
    } as never;

    const created = await store.create(leaky);
    expect(created.ok).toBe(false);
    expect(JSON.stringify(created)).not.toContain(FIXTURE_SECRET);
    expect(readdirSync(root)).toEqual([]);
  });

  it("places durable tasks under the diagnostic wayforge root without sharing authority", () => {
    const agentDirectory = temporaryRoot();
    expect(durableTaskStoreRoot(agentDirectory)).toBe(join(agentDirectory, "wayforge", "tasks"));
    expect(lstatSync(agentDirectory).isDirectory()).toBe(true);
  });
});
