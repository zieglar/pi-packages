import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CHECKER = fileURLToPath(new URL("../scripts/check-baseline.mjs", import.meta.url));

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repo, encoding: "utf8" }).trim();
}

/**
 * Builds an independent git repository with one commit on main and returns
 * the state observed through git itself. Expected values in every test come
 * from this harness (real git state), never from the checker's own parsing.
 */
function initRepo(): { repo: string; headSha: string } {
  const repo = tempDir("baseline-gate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "gate@example.invalid"]);
  git(repo, ["config", "user.name", "Baseline Gate Test"]);
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  git(repo, ["add", "tracked.txt"]);
  git(repo, ["commit", "-m", "initial"]);
  return { repo, headSha: git(repo, ["rev-parse", "HEAD"]) };
}

function commitFile(repo: string, name: string, content: string, message: string): string {
  writeFileSync(join(repo, name), content);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

/** Adds a bare remote with the current main pushed and upstream configured. */
function withPushedRemote(repo: string): string {
  const remote = tempDir("baseline-gate-remote-");
  git(remote, ["init", "--bare", "-b", "main"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-u", "origin", "main"]);
  return remote;
}

function runChecker(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe("baseline gate", () => {
  it("passes a clean matching baseline", () => {
    const { repo, headSha } = initRepo();

    const result = runChecker(["--repo", repo, "--branch", "main", "--head", headSha, "--clean"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BASELINE PASS");
    expect(result.stdout).toContain("main");
    expect(result.stdout).toContain(headSha);
  });

  it("fails on wrong HEAD and names expected and actual", () => {
    const { repo, headSha } = initRepo();
    commitFile(repo, "second.txt", "two\n", "second");

    const result = runChecker(["--repo", repo, "--head", headSha]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BASELINE FAIL");
    expect(result.stdout).toContain("HEAD");
    expect(result.stdout).toContain(headSha);
    expect(result.stdout).toContain(git(repo, ["rev-parse", "HEAD"]));
  });

  it("fails on wrong branch", () => {
    const { repo } = initRepo();

    const result = runChecker(["--repo", repo, "--branch", "trunk"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("BASELINE FAIL");
    expect(result.stdout).toContain("branch");
    expect(result.stdout).toContain("trunk");
    expect(result.stdout).toContain("main");
  });

  it("fails on a dirty tracked file", () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "tracked.txt"), "modified\n");

    const result = runChecker(["--repo", repo, "--clean"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("worktree");
    expect(result.stdout).toContain("dirty");
  });

  it("fails on a staged file", () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "staged.txt"), "staged\n");
    git(repo, ["add", "staged.txt"]);

    const result = runChecker(["--repo", repo, "--clean"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("index");
    expect(result.stdout).toContain("staged");
  });

  it("passes --clean with only untracked files present and reports them", () => {
    const { repo } = initRepo();
    writeFileSync(join(repo, "untracked.txt"), "scratch\n");

    const result = runChecker(["--repo", repo, "--clean"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("BASELINE PASS");
    expect(result.stdout).toContain("untracked");
  });

  it("fails on ahead-count mismatch against the upstream", () => {
    const { repo } = initRepo();
    withPushedRemote(repo);
    commitFile(repo, "local-only.txt", "local\n", "local only");

    // Expected counts come from git itself, not from constants the checker could fake.
    const ahead = git(repo, ["rev-list", "--count", "origin/main..HEAD"]);
    const result = runChecker(["--repo", repo, "--upstream", "origin/main", "--ahead", String(Number(ahead) + 1)]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ahead");
    expect(runChecker(["--repo", repo, "--upstream", "origin/main", "--ahead", ahead]).status).toBe(0);
  });

  it("fails on behind-count mismatch against the upstream", () => {
    const { repo } = initRepo();
    const remote = withPushedRemote(repo);
    const other = tempDir("baseline-gate-other-");
    git(".", ["clone", remote, other]);
    git(other, ["config", "user.email", "gate@example.invalid"]);
    git(other, ["config", "user.name", "Baseline Gate Test"]);
    commitFile(other, "remote-only.txt", "remote\n", "remote only");
    git(other, ["push", "origin", "main"]);
    git(repo, ["fetch", "origin"]);

    const behind = git(repo, ["rev-list", "--count", "HEAD..origin/main"]);
    const result = runChecker(["--repo", repo, "--upstream", "origin/main", "--behind", String(Number(behind) + 1)]);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("behind");
    expect(runChecker(["--repo", repo, "--upstream", "origin/main", "--behind", behind]).status).toBe(0);
  });

  it("fails on commit-range count mismatch", () => {
    const { repo } = initRepo();
    commitFile(repo, "second.txt", "two\n", "second");

    const count = git(repo, ["rev-list", "--count", "HEAD~1..HEAD"]);
    const wrong = runChecker(["--repo", repo, "--range", "HEAD~1..HEAD", "--range-count", String(Number(count) + 1)]);
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toContain("range");
    expect(wrong.stdout).toContain(String(Number(count) + 1));
    expect(wrong.stdout).toContain(count);

    const right = runChecker(["--repo", repo, "--range", "HEAD~1..HEAD", "--range-count", count]);
    expect(right.status).toBe(0);
  });

  it("emits machine-readable JSON with per-invariant failures", () => {
    const { repo, headSha } = initRepo();
    commitFile(repo, "second.txt", "two\n", "second");

    const result = runChecker(["--repo", repo, "--head", headSha, "--json"]);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      failures: { invariant: string; expected: string; actual: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.invariant).toBe("HEAD");
    expect(parsed.failures[0]?.expected).toBe(headSha);
    expect(parsed.failures[0]?.actual).toBe(git(repo, ["rev-parse", "HEAD"]));
  });

  it("exits non-zero with a usage error outside a git repository", () => {
    const notARepo = tempDir("baseline-gate-plain-");

    const result = runChecker(["--repo", notARepo, "--clean"]);

    expect(result.status).toBe(2);
    expect(result.stderr + result.stdout).toContain("git");
  });
});
