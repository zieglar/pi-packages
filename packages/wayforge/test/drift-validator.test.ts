import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkspaceCheckpoint } from "../src/durable/workspace-checkpoint.js";
import { applyDriftToTaskState, classifyWorkspaceDrift } from "../src/durable/drift-validator.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

const roots: string[] = [];
function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 2_097_152, timeout: 10_000 }).trim();
}
async function repository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `wayforge-drift-${name}-`));
  roots.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "wayforge@example.invalid"]);
  git(root, ["config", "user.name", "Wayforge Test"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/task.txt"), "task baseline\n");
  await writeFile(join(root, "notes.txt"), "notes baseline\n");
  git(root, ["add", "--", "src/task.txt", "notes.txt"]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
  return root;
}
async function capture(root: string, at: number) {
  const result = await captureWorkspaceCheckpoint({ workspaceRoot: root, taskWriteSet: ["src/task.txt"], capturedAtMs: at });
  if (!result.ok) throw new Error(result.failure.code);
  return result.value;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("classifyWorkspaceDrift", () => {
  it("returns NO_DRIFT for an identical workspace", async () => {
    const root = await repository("none");
    const baseline = await capture(root, 1);
    const current = await capture(root, 2);
    expect(classifyWorkspaceDrift(baseline, current)).toMatchObject({ classification: "NO_DRIFT", requiresRevalidation: false });
  });
  it("treats equivalent persisted path fingerprints as stable regardless of object key order", () => {
    const baseline = populatedTaskState().workspace!;
    const current = {
      ...baseline,
      changedPaths: baseline.changedPaths.map((entry) => ({
        status: entry.status,
        path: entry.path,
        ...(entry.worktreeDigest === undefined ? {} : { worktreeDigest: entry.worktreeDigest }),
        ...(entry.indexDigest === undefined ? {} : { indexDigest: entry.indexDigest }),
        ...(entry.symlink === undefined ? {} : { symlink: entry.symlink }),
        ...(entry.missing === undefined ? {} : { missing: entry.missing }),
      })),
    };
    expect(classifyWorkspaceDrift(baseline, current).classification).toBe("NO_DRIFT");
  });



  it("returns MINOR_DRIFT for external changes only outside the task write set and never mutates them", async () => {
    const root = await repository("minor");
    const baseline = await capture(root, 1);
    await writeFile(join(root, "notes.txt"), "external user change\n");
    const before = git(root, ["status", "--porcelain=v1"]);
    const current = await capture(root, 2);
    const result = classifyWorkspaceDrift(baseline, current);
    const after = git(root, ["status", "--porcelain=v1"]);
    expect(result).toMatchObject({ classification: "MINOR_DRIFT", requiresRevalidation: true });
    expect(result.changedPaths).toContain("notes.txt");
    expect(after).toBe(before);
  });

  it("fails closed with CONFLICTING_DRIFT for an incompatible external task-owned change", async () => {
    const root = await repository("owned");
    const baseline = await capture(root, 1);
    await writeFile(join(root, "src/task.txt"), "incompatible external edit\n");
    const current = await capture(root, 2);
    const result = classifyWorkspaceDrift(baseline, current);
    expect(result).toMatchObject({ classification: "CONFLICTING_DRIFT", requiresRevalidation: true });
    expect(result.conflictingPaths).toContain("src/task.txt");

    const state = populatedTaskState({ revision: 4, workspace: baseline, status: "resuming" });
    const blocked = applyDriftToTaskState(state, result, 3);
    expect(blocked.status).toBe("blocked");
    expect(blocked.revision).toBe(5);
    expect(blocked.lastFailure?.code).toBe("workspace_drift_conflict");
  });

  it("returns RECONCILABLE_DRIFT when HEAD changes but task-owned fingerprints and identity remain valid", async () => {
    const root = await repository("head");
    const baseline = await capture(root, 1);
    await writeFile(join(root, "notes.txt"), "new committed notes\n");
    git(root, ["add", "--", "notes.txt"]);
    git(root, ["commit", "--quiet", "-m", "external commit"]);
    const current = await capture(root, 2);
    expect(classifyWorkspaceDrift(baseline, current)).toMatchObject({
      classification: "RECONCILABLE_DRIFT",
      requiresRevalidation: true,
    });
  });

  it("returns CONFLICTING_DRIFT when repository identity changes", async () => {
    const firstRoot = await repository("identity-a");
    const secondRoot = await repository("identity-b");
    const baseline = await capture(firstRoot, 1);
    const current = await capture(secondRoot, 2);
    expect(classifyWorkspaceDrift(baseline, current).classification).toBe("CONFLICTING_DRIFT");
  });
});
