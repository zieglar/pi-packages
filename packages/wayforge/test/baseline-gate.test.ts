import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Overridable so mutation evidence can point the same suite at a deliberately
// wrong checker (see COVERAGE RED runs in handoff 64831 evidence).
const CHECKER = process.env.BASELINE_GATE_CHECKER ?? fileURLToPath(new URL("../scripts/check-baseline.mjs", import.meta.url));

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

  // C-11 (64831): branch truth comes from an independently chosen fixture
  // branch, observed through git — never from a hardcoded "main" literal.
  it("binds branch reporting to independently observed git state", () => {
    const { repo } = initRepo();
    git(repo, ["checkout", "-b", "feature/independent"]);
    const observed = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(observed).toBe("feature/independent");

    expect(runChecker(["--repo", repo, "--branch", observed]).status).toBe(0);

    const result = runChecker(["--repo", repo, "--branch", "main", "--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      failures: { invariant: string; expected: string; actual: string }[];
    };
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.invariant).toBe("branch");
    expect(parsed.failures[0]?.expected).toBe("main");
    expect(parsed.failures[0]?.actual).toBe(observed);
  });

  // C-16 (64831): real divergent history (ahead 1, behind 1); the checker's
  // reported actuals must equal independent git observation, killing any
  // implementation that echoes CLI expectations back as actuals.
  it("binds ahead/behind actuals to independently constructed divergence", () => {
    const { repo } = initRepo();
    const remote = withPushedRemote(repo);
    commitFile(repo, "local-diverge.txt", "local\n", "local diverge");
    const other = tempDir("baseline-gate-diverge-");
    git(".", ["clone", remote, other]);
    git(other, ["config", "user.email", "gate@example.invalid"]);
    git(other, ["config", "user.name", "Baseline Gate Test"]);
    commitFile(other, "remote-diverge.txt", "remote\n", "remote diverge");
    git(other, ["push", "origin", "main"]);
    git(repo, ["fetch", "origin"]);

    const ahead = git(repo, ["rev-list", "--count", "origin/main..HEAD"]);
    const behind = git(repo, ["rev-list", "--count", "HEAD..origin/main"]);
    expect(Number(ahead)).toBeGreaterThan(0);
    expect(Number(behind)).toBeGreaterThan(0);

    expect(
      runChecker(["--repo", repo, "--upstream", "origin/main", "--ahead", ahead, "--behind", behind]).status,
    ).toBe(0);

    const result = runChecker([
      "--repo", repo, "--upstream", "origin/main",
      "--ahead", String(Number(ahead) + 1),
      "--behind", String(Number(behind) + 1),
      "--json",
    ]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      failures: { invariant: string; expected: string; actual: string }[];
    };
    const byInvariant = Object.fromEntries(parsed.failures.map((failure) => [failure.invariant, failure]));
    expect(byInvariant.ahead?.actual).toBe(ahead);
    expect(byInvariant.behind?.actual).toBe(behind);
    expect(byInvariant.ahead?.expected).toBe(String(Number(ahead) + 1));
    expect(byInvariant.behind?.expected).toBe(String(Number(behind) + 1));
  });

  // C-1 (64831): --upstream-head PASS/FAIL against a local bare remote; the
  // failure must name the invariant and expose independently observed truth.
  it("covers --upstream-head pass and fail against independent observation", () => {
    const { repo } = initRepo();
    withPushedRemote(repo);
    const upstreamSha = git(repo, ["rev-parse", "origin/main"]);

    expect(runChecker(["--repo", repo, "--upstream", "origin/main", "--upstream-head", upstreamSha]).status).toBe(0);

    const wrongSha = commitFile(repo, "local-only.txt", "local\n", "local only");
    expect(wrongSha).not.toBe(upstreamSha);
    const result = runChecker(["--repo", repo, "--upstream", "origin/main", "--upstream-head", wrongSha, "--json"]);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as {
      failures: { invariant: string; expected: string; actual: string }[];
    };
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.invariant).toBe("upstream HEAD");
    expect(parsed.failures[0]?.expected).toBe(wrongSha);
    expect(parsed.failures[0]?.actual).toBe(upstreamSha);
  });

  // C-13 (64831): mechanical proof the checker is read-only — git state is
  // identical before and after a passing and a failing invocation.
  it("leaves repository state untouched across passing and failing checks", () => {
    const { repo, headSha } = initRepo();
    withPushedRemote(repo);
    const snapshot = () => ({
      head: git(repo, ["rev-parse", "HEAD"]),
      branch: git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
      refs: git(repo, ["for-each-ref"]),
      status: git(repo, ["status", "--porcelain"]),
    });

    const before = snapshot();
    expect(runChecker(["--repo", repo, "--branch", "main", "--head", headSha, "--clean"]).status).toBe(0);
    expect(runChecker(["--repo", repo, "--head", "0".repeat(40)]).status).toBe(1);
    expect(snapshot()).toEqual(before);
  });
});
