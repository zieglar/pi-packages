import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./helpers/ensure-built.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { taskId } from "../src/types/identity.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

const roots: string[] = [];
const childScript = fileURLToPath(new URL("./fixtures/restart-child.mjs", import.meta.url));

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wayforge-restart-"));
  roots.push(root);
  return join(root, "tasks");
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
      reject(new Error(`restart child exited before ${type}: ${String(code)}`));
    };
    const cleanup = (): void => {
      child.off("message", message);
      child.off("exit", exited);
    };
    child.on("message", message);
    child.on("exit", exited);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exit ${String(code)}`))));
}

function child(mode: "suspend" | "resume", root: string, marker: string): ChildProcess {
  return fork(childScript, [mode, root, "1000", marker], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "wayforge-negative-drift-"));
  roots.push(workspace);
  git(workspace, ["init", "--quiet"]);
  git(workspace, ["config", "user.email", "wayforge-test@example.invalid"]);
  git(workspace, ["config", "user.name", "Wayforge Test"]);
  writeFileSync(join(workspace, "owned.txt"), "baseline\\n", "utf8");
  git(workspace, ["add", "owned.txt"]);
  git(workspace, ["commit", "--quiet", "-m", "baseline"]);
  return workspace;
}

beforeAll(() => ensureBuilt());
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("filesystem process restart integration", () => {
  it("continues a due synthetic usage-limit suspension in a new invocation after Process A exits", async () => {
    const root = temporaryRoot();
    const marker = join(root, "continuations.jsonl");
    const state = populatedTaskState({
      taskId: "task-restart",
      revision: 0,
      leaseGeneration: 0,
      status: "suspended",
      continuation: null,
      recoveryCounters: { ...populatedTaskState().recoveryCounters, recoveryAttempts: 0 },
      suspension: {
        ...populatedTaskState().suspension!,
        nextCheckAtMs: 1_000,
        resumeNotBeforeMs: 1_000,
        checkCount: 0,
        maxChecks: 2,
      },
    });

    const processA = child("suspend", root, marker);
    await waitFor(processA, "ready");
    const persisted = waitFor(processA, "result");
    processA.send({ type: "state", state });
    await persisted;
    await waitForExit(processA);

    const processB = child("resume", root, marker);
    await waitFor(processB, "ready");
    const resumed = waitFor(processB, "result");
    processB.send({ type: "go" });
    await resumed;
    await waitForExit(processB);

    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
    const stored = await new FilesystemDurableTaskStore(root, { now: () => 1_000 }).load(taskId("task-restart"));
    expect(stored.ok && stored.value).toMatchObject({
      status: "running",
      suspension: null,
      continuation: { continuationId: "task-restart:resume-1", phase: "launched", continuationOf: "inv-1" },
      invocationProvenance: { invocationId: "task-restart:resume-1" },
    });
  });

  it("blocks incompatible external drift without changing the disposable Git workspace", async () => {
    const workspace = createWorkspace();
    const root = temporaryRoot();
    const marker = join(root, "continuations.jsonl");
    const state = populatedTaskState({
      taskId: "task-negative-drift",
      revision: 0,
      leaseGeneration: 0,
      status: "suspended",
      workspace: null,
      continuation: null,
      suspension: {
        ...populatedTaskState().suspension!,
        nextCheckAtMs: 1_000,
        resumeNotBeforeMs: 1_000,
        checkCount: 0,
        maxChecks: 2,
      },
    });

    const processA = child("suspend", root, marker);
    await waitFor(processA, "ready");
    const persisted = waitFor(processA, "result");
    processA.send({ type: "capture-and-state", state, workspaceRoot: workspace, taskWriteSet: ["owned.txt"] });
    await persisted;
    await waitForExit(processA);

    const externalBytes = "external change must survive\\n";
    writeFileSync(join(workspace, "owned.txt"), externalBytes, "utf8");
    const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();

    const processB = child("resume", root, marker);
    await waitFor(processB, "ready");
    const resumed = waitFor(processB, "result");
    processB.send({ type: "go", recaptureWorkspace: true });
    await resumed;
    await waitForExit(processB);

    expect(readFileSync(join(workspace, "owned.txt"), "utf8")).toBe(externalBytes);
    expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(workspace, ["status", "--porcelain"]).trim()).toBe("M owned.txt");
    expect(existsSync(join(workspace, ".git", "refs", "stash"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const stored = await new FilesystemDurableTaskStore(root, { now: () => 1_000 }).load(taskId("task-negative-drift"));
    expect(stored.ok && stored.value).toMatchObject({
      status: "blocked",
      continuation: null,
      lastFailure: { code: "workspace_drift_conflict", message: expect.not.stringContaining("external change") },
    });
  });
});
