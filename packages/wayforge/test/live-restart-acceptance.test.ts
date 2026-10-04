import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./helpers/ensure-built.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesystemDurableTaskStore } from "../src/durable/filesystem-task-store.js";
import { taskId } from "../src/types/identity.js";

/**
 * Phase 1.1 restart acceptance across a real process boundary. Process A
 * composes the live Wayforge extension, starts a governed task, persists the
 * authoritative checkpoint, and suspends through a real RecoveryCoordinator
 * decision before exiting. Process B constructs the extension again in a
 * fresh process; its startup scan must discover the suspended task, claim the
 * fenced lease, validate the workspace, transition RESUMING, and launch a NEW
 * continuation session exactly once.
 */

const roots: string[] = [];
const childScript = fileURLToPath(new URL("./fixtures/live-extension-child.mjs", import.meta.url));
const T0 = 20_000;

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(workspace: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: workspace, encoding: "utf8" });
}

function waitFor(child: ChildProcess, type: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const message = (value: unknown): void => {
      if (typeof value !== "object" || value === null || (value as { type?: unknown }).type !== type) return;
      cleanup();
      resolve(value);
    };
    const exited = (code: number | null): void => {
      cleanup();
      reject(new Error(`live extension child exited before ${type}: ${String(code)}`));
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
  return new Promise((resolve, reject) =>
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${String(code)}`)))),
  );
}

beforeAll(() => ensureBuilt());

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("live extension restart acceptance", () => {
  it(
    "resumes a live-created suspended task in a new process and new session exactly once",
    { timeout: 30_000 },
    async () => {
      const agentRoot = temporaryRoot("wayforge-live-restart-agent-");
      const storeRoot = join(agentRoot, "wayforge", "tasks");
      const workspace = temporaryRoot("wayforge-live-restart-ws-");
      git(workspace, ["init", "--quiet"]);
      git(workspace, ["config", "user.email", "wayforge-test@example.invalid"]);
      git(workspace, ["config", "user.name", "Wayforge Test"]);
      writeFileSync(join(workspace, "owned.txt"), "baseline\n", "utf8");
      git(workspace, ["add", "owned.txt"]);
      git(workspace, ["commit", "--quiet", "-m", "baseline"]);
      const marker = join(agentRoot, "continuations.jsonl");

      const processA = fork(childScript, ["start", storeRoot, workspace, marker, String(T0)], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      await waitFor(processA, "ready");
      const started = waitFor(processA, "result");
      processA.send({ type: "go" });
      const startResult = await started;
      await waitForExit(processA);
      expect(startResult.status).toBe("suspended");
      expect(startResult.revision).toBeGreaterThan(0);

      const headBefore = git(workspace, ["rev-parse", "HEAD"]).trim();
      const processB = fork(childScript, ["resume", storeRoot, workspace, marker, String(T0 + 2_000)], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      await waitFor(processB, "ready");
      const resumed = waitFor(processB, "result");
      processB.send({ type: "go" });
      const resumeResult = await resumed;
      await waitForExit(processB);

      expect(resumeResult.status).toBe("running");
      expect(resumeResult.continuationId).toBe("alpha0-1:resume-1");
      expect(resumeResult.continuationPhase).toBe("launched");
      expect(resumeResult.leaseGeneration).toBeGreaterThan(0);
      expect(resumeResult.invocationProvenance).toMatchObject({
        invocationId: "alpha0-1:resume-1",
        role: "continuation",
      });

      expect(existsSync(marker)).toBe(true);
      const launches = readFileSync(marker, "utf8").trim().split("\n").filter(Boolean);
      expect(launches).toHaveLength(1);
      const launch = JSON.parse(launches[0]!) as { sessionId: string; prompt: string };
      expect(launch.sessionId).toContain("fresh-continuation-session-1");
      expect(launch.prompt).toContain("Wayforge continuation package");
      expect(launch.prompt).toContain("restart acceptance through the live extension");
      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);

      const store = new FilesystemDurableTaskStore(storeRoot, { now: () => T0 + 2_000 });
      const stored = await store.load(taskId("alpha0-1"));
      expect(stored.ok && stored.value).toMatchObject({
        status: "running",
        suspension: null,
        continuation: { continuationId: "alpha0-1:resume-1", phase: "launched" },
        invocationProvenance: { invocationId: "alpha0-1:resume-1", role: "continuation" },
      });
      const state = stored.ok ? stored.value : undefined;
      expect(state?.recoveryCounters.continuationLaunches).toBe(1);
      expect(state?.recoveryCounters.recoveryAttempts).toBe(1);
    },
  );
});
