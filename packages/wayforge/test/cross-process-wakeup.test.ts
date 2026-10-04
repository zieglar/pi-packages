import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./helpers/ensure-built.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

const roots: string[] = [];
const childScript = fileURLToPath(new URL("./fixtures/wakeup-child.mjs", import.meta.url));

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "wayforge-wakeup-process-"));
  roots.push(directory);
  return join(directory, "tasks");
}

function waitFor(child: ChildProcess, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const message = (value: unknown): void => {
      if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== type) return;
      cleanup();
      resolve(value);
    };
    const exited = (code: number | null): void => {
      cleanup();
      reject(new Error(`wakeup child exited before ${type}: ${String(code)}`));
    };
    const cleanup = (): void => {
      child.off("message", message);
      child.off("exit", exited);
    };
    child.on("message", message);
    child.on("exit", exited);
  });
}

function child(taskRoot: string, marker: string): ChildProcess {
  return fork(childScript, [taskRoot, "task-process-resume", "1000", marker], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

beforeAll(() => ensureBuilt());
afterEach(() => roots.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

describe("cross-process WakeupService", () => {
  it(
    "permits exactly one continuation launch owner across repeated contention rounds",
    // Ten rounds fork twenty child processes; the default 5s wall-clock
    // budget assumed the old unconditional build hooks staggered file start.
    // With deduplicated builds (helpers/ensure-built) and ambient desktop
    // load ~12x cores, isolated runtime is ~3.3s and the default budget is
    // exceeded without any defect; the ownership assertion is unchanged.
    { timeout: 20_000 },
    async () => {
    for (let round = 0; round < 10; round += 1) {
      const taskRoot = root();
      const marker = join(taskRoot, `launch-${round}.jsonl`);
      const store = new FilesystemDurableTaskStore(taskRoot, { now: () => 1_000 });
      const initial = populatedTaskState({
        taskId: "task-process-resume",
        revision: 0,
        leaseGeneration: 0,
        status: "suspended",
        continuation: null,
        suspension: {
          ...populatedTaskState().suspension!,
          nextCheckAtMs: 1_000,
          resumeNotBeforeMs: 1_000,
          checkCount: 0,
          maxChecks: 2,
        },
      });
      expect((await store.create(initial)).ok).toBe(true);

      const first = child(taskRoot, marker);
      const second = child(taskRoot, marker);
      await Promise.all([waitFor(first, "ready"), waitFor(second, "ready")]);
      const one = waitFor(first, "result");
      const two = waitFor(second, "result");
      first.send("go");
      second.send("go");
      await Promise.all([one, two]);

      expect(existsSync(marker)).toBe(true);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    }
    },
  );
});
