import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorkspaceCheckpoint } from "../src/durable/workspace-checkpoint.js";

const roots: string[] = [];

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wayforge-workspace-"));
  roots.push(root);
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "wayforge@example.invalid"]);
  git(root, ["config", "user.name", "Wayforge Test"]);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/task.txt"), "task baseline\n");
  await writeFile(join(root, "tracked-delete.txt"), "delete me\n");
  git(root, ["add", "--", "src/task.txt", "tracked-delete.txt"]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("captureWorkspaceCheckpoint", () => {
  it("captures deterministic Git identity, index metadata, hashes, symlinks, and missing markers without contents", async () => {
    const root = await repository();
    await writeFile(join(root, "src/task.txt"), "task staged value\n");
    git(root, ["add", "--", "src/task.txt"]);
    await rm(join(root, "tracked-delete.txt"));
    await writeFile(join(root, "untracked.txt"), "private fixture content must not persist\n");
    await symlink("untracked.txt", join(root, "link.txt"));

    const first = await captureWorkspaceCheckpoint({
      workspaceRoot: root,
      taskWriteSet: ["src/task.txt", "tracked-delete.txt"],
      capturedAtMs: 10,
    });
    const second = await captureWorkspaceCheckpoint({
      workspaceRoot: root,
      taskWriteSet: ["tracked-delete.txt", "src/task.txt"],
      capturedAtMs: 20,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("expected workspace capture");

    expect(first.value.workspaceRoot).toBe(await realpath(root));
    expect(first.value.repositoryId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value.worktreeId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value.headCommit).toBe(git(root, ["rev-parse", "HEAD"]));
    expect(first.value.workingStateDigest).toBe(second.value.workingStateDigest);
    expect(first.value.taskWriteSet).toEqual(["src/task.txt", "tracked-delete.txt"]);

    const staged = first.value.changedPaths.find((entry) => entry.path === "src/task.txt");
    const deleted = first.value.changedPaths.find((entry) => entry.path === "tracked-delete.txt");
    const link = first.value.changedPaths.find((entry) => entry.path === "link.txt");
    expect(staged?.indexDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(staged?.worktreeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(deleted).toMatchObject({ status: "deleted", missing: true });
    expect(link).toMatchObject({ status: "added", symlink: true });
    expect(link?.worktreeDigest).toMatch(/^[a-f0-9]{64}$/);

    const serialized = JSON.stringify(first.value);
    expect(serialized).not.toContain("task staged value");
    expect(serialized).not.toContain("private fixture content");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toContain("private fixture content");
  });

  it("rejects write-set paths that escape the canonical workspace", async () => {
    const root = await repository();
    const result = await captureWorkspaceCheckpoint({
      workspaceRoot: root,
      taskWriteSet: ["../outside.txt"],
      capturedAtMs: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe("workspace_path_unsafe");
  });
});
