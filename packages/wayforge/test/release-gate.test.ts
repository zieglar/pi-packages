import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const CHECKER = fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repo, encoding: "utf8" }).trim();
}

function commitFile(repo: string, name: string, content: string): string {
  writeFileSync(join(repo, name), content);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", name]);
  return git(repo, ["rev-parse", "HEAD"]);
}

function fixture(): { repo: string; base: string; commits: string[]; head: string } {
  const repo = tempDir("release-gate-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "release@example.invalid"]);
  git(repo, ["config", "user.name", "Release Gate Test"]);
  const base = commitFile(repo, "base.txt", "base\n");
  const commits = [
    commitFile(repo, "one.txt", "one\n"),
    commitFile(repo, "two.txt", "two\n"),
  ];
  return { repo, base, commits, head: commits[1]! };
}

function prePushArgs(
  state: ReturnType<typeof fixture>,
  overrides: { commits?: string[]; base?: string; push?: string; tag?: string; remoteState?: string; requireFresh?: string } = {},
): string[] {
  const commits = overrides.commits ?? state.commits;
  return [
    "pre-push",
    "--repo", state.repo,
    "--branch", "main",
    "--head", state.head,
    "--upstream", overrides.base ?? state.base,
    "--upstream-head", overrides.base ?? state.base,
    "--ahead", String(commits.length),
    "--behind", "0",
    "--base", overrides.base ?? state.base,
    ...commits.flatMap((sha) => ["--authorized-commit", sha]),
    "--review-status", "P0",
    "--validation-status", "PASS",
    "--remote-state", overrides.remoteState ?? "existing",
    "--require-fresh", overrides.requireFresh ?? "false",
    ...(overrides.push === undefined ? [] : ["--push-authorized", overrides.push]),
    ...(overrides.tag === undefined ? [] : ["--tag-authorized", overrides.tag]),
    "--json",
  ];
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CHECKER, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function parse(result: ReturnType<typeof run>): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("release gate pre-push eligibility", () => {
  it("proves the exact ordered range while authority absence stays VERIFY ONLY", () => {
    const state = fixture();
    const result = run(prePushArgs(state));

    expect(result.status).toBe(0);
    const json = parse(result) as {
      eligible: boolean;
      mutationMode: string;
      authority: { push: string; tag: string };
      range: { actualCommits: string[]; authorizedCommits: string[] };
    };
    expect(json.eligible).toBe(true);
    expect(json.mutationMode).toBe("VERIFY ONLY");
    expect(json.authority).toEqual({ push: "absent", tag: "absent" });
    expect(json.range.actualCommits).toEqual(state.commits);
    expect(json.range.authorizedCommits).toEqual(state.commits);
  });

  it("fails closed when the authorized range has the wrong commit", () => {
    const state = fixture();
    const result = run(prePushArgs(state, { commits: [state.commits[0]!, state.base] }));

    expect(result.status).toBe(1);
    const json = parse(result) as { failures: { invariant: string }[] };
    expect(json.failures.map((failure) => failure.invariant)).toContain("authorized range");
  });

  it("fails closed when history contains an extra unauthorized commit", () => {
    const state = fixture();
    commitFile(state.repo, "extra.txt", "extra\n");
    state.head = git(state.repo, ["rev-parse", "HEAD"]);
    const result = run(prePushArgs(state));

    expect(result.status).toBe(1);
    const json = parse(result) as { failures: { invariant: string }[] };
    expect(json.failures.map((failure) => failure.invariant)).toContain("authorized range");
  });

  it("fails closed when the proposed base is not an ancestor of HEAD", () => {
    const state = fixture();
    git(state.repo, ["checkout", "-b", "side", state.base]);
    const sideBase = commitFile(state.repo, "side.txt", "side\n");
    git(state.repo, ["checkout", "main"]);

    const result = run(prePushArgs(state, { base: sideBase }));

    expect(result.status).toBe(1);
    const json = parse(result) as { failures: { invariant: string }[] };
    expect(json.failures.map((failure) => failure.invariant)).toContain("base ancestry");
  });

  it("delegates dirty-state rejection to the baseline gate", () => {
    const state = fixture();
    writeFileSync(join(state.repo, "two.txt"), "dirty\n");

    const result = run(prePushArgs(state));

    expect(result.status).toBe(1);
    const json = parse(result) as { failures: { invariant: string }[] };
    expect(json.failures.map((failure) => failure.invariant)).toContain("baseline:worktree");
  });

  it("requires fresh remote evidence only when the caller requests it", () => {
    const state = fixture();
    const stale = run(prePushArgs(state, { remoteState: "existing", requireFresh: "true" }));
    expect(stale.status).toBe(1);
    const staleJson = parse(stale) as { failures: { invariant: string }[] };
    expect(staleJson.failures.map((failure) => failure.invariant)).toContain("remote freshness");

    expect(run(prePushArgs(state, { remoteState: "fresh", requireFresh: "true" })).status).toBe(0);
  });

  it("records independent external push/tag authority without performing mutation", () => {
    const state = fixture();
    const before = {
      head: git(state.repo, ["rev-parse", "HEAD"]),
      refs: git(state.repo, ["for-each-ref"]),
      status: git(state.repo, ["status", "--porcelain"]),
    };
    const result = run(prePushArgs(state, { push: "true", tag: "false" }));

    expect(result.status).toBe(0);
    const json = parse(result) as { eligible: boolean; mutationMode: string; authority: { push: string; tag: string } };
    expect(json.eligible).toBe(true);
    expect(json.mutationMode).toBe("EXTERNAL PUSH AUTHORITY SUPPLIED; TOOL REMAINS READ-ONLY");
    expect(json.authority).toEqual({ push: "true", tag: "false" });
    expect({
      head: git(state.repo, ["rev-parse", "HEAD"]),
      refs: git(state.repo, ["for-each-ref"]),
      status: git(state.repo, ["status", "--porcelain"]),
    }).toEqual(before);
  });
});

describe("release gate hosted CI evidence", () => {
  function evidence(overrides: Record<string, unknown> = {}): string {
    const path = join(tempDir("release-gate-ci-"), "run.json");
    writeFileSync(path, JSON.stringify({
      workflowName: "CI",
      event: "push",
      headBranch: "main",
      headSha: "a".repeat(40),
      status: "completed",
      conclusion: "success",
      ...overrides,
    }));
    return path;
  }

  function ciArgs(path: string, extra: string[] = []): string[] {
    return [
      "ci", "--evidence", path,
      "--workflow", "CI", "--event", "push", "--branch", "main", "--head", "a".repeat(40),
      ...extra, "--json",
    ];
  }

  it("classifies exact terminal successful evidence as CI-PASS", () => {
    const result = run(ciArgs(evidence()));
    expect(result.status).toBe(0);
    expect(parse(result)).toMatchObject({ classification: "CI-PASS", exactIdentity: true });
  });

  it("classifies wrong-SHA evidence as CI-MISSING", () => {
    const result = run(ciArgs(evidence({ headSha: "b".repeat(40) })));
    expect(result.status).toBe(1);
    expect(parse(result)).toMatchObject({ classification: "CI-MISSING", exactIdentity: false });
  });

  it("classifies a matching non-terminal run as CI-IN-PROGRESS", () => {
    const result = run(ciArgs(evidence({ status: "in_progress", conclusion: "" })));
    expect(result.status).toBe(1);
    expect(parse(result)).toMatchObject({ classification: "CI-IN-PROGRESS", exactIdentity: true });
  });

  it("requires cause evidence to distinguish CI-FAIL from CI-INFRA", () => {
    const path = evidence({ status: "completed", conclusion: "failure" });
    const unknown = run(ciArgs(path));
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain("--failure-kind");

    expect(parse(run(ciArgs(path, ["--failure-kind", "milestone"])))).toMatchObject({ classification: "CI-FAIL" });
    expect(parse(run(ciArgs(path, ["--failure-kind", "infrastructure"])))).toMatchObject({ classification: "CI-INFRA" });
  });
});

describe("release gate input validation", () => {
  it("rejects a non-hex SHA fail-closed with exit 2", () => {
    const state = fixture();
    const args = prePushArgs(state);
    args[args.indexOf("--head") + 1] = "not-a-sha";
    expect(run(args).status).toBe(2);
  });

  it("rejects a missing required flag fail-closed with exit 2", () => {
    const state = fixture();
    const args = prePushArgs(state).filter((value, index, all) => value !== "--base" && all[index - 1] !== "--base");
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--base is required");
  });

  it("rejects unknown flags fail-closed with exit 2", () => {
    const state = fixture();
    expect(run([...prePushArgs(state), "--push-authorised", "true"]).status).toBe(2);
    expect(run(["ci", "--evidence", "x", "--workflow", "CI", "--event", "push", "--branch", "main", "--head", "a".repeat(40), "--repo", "."]).status).toBe(2);
  });

  it("rejects reversed authorized-commit order as an authorized-range failure", () => {
    const state = fixture();
    const result = run(prePushArgs(state, { commits: [...state.commits].reverse() }));
    expect(result.status).toBe(1);
    const json = parse(result) as { failures: { invariant: string }[] };
    expect(json.failures.map((failure) => failure.invariant)).toContain("authorized range");
  });

  it("rejects malformed CI evidence JSON with exit 2", () => {
    const path = join(tempDir("release-gate-badjson-"), "run.json");
    writeFileSync(path, "{not json");
    const result = run(["ci", "--evidence", path, "--workflow", "CI", "--event", "push", "--branch", "main", "--head", "a".repeat(40)]);
    expect(result.status).toBe(2);
  });

  it("classifies array evidence deterministically regardless of input order", () => {
    const completed = { databaseId: 2, workflowName: "CI", event: "push", headBranch: "main", headSha: "a".repeat(40), status: "completed", conclusion: "success" };
    const running = { databaseId: 1, workflowName: "CI", event: "push", headBranch: "main", headSha: "a".repeat(40), status: "in_progress", conclusion: "" };
    for (const order of [[running, completed], [completed, running]]) {
      const path = join(tempDir("release-gate-array-"), "runs.json");
      writeFileSync(path, JSON.stringify(order));
      const result = run(["ci", "--evidence", path, "--workflow", "CI", "--event", "push", "--branch", "main", "--head", "a".repeat(40), "--json"]);
      expect(result.status).toBe(0);
      expect(parse(result)).toMatchObject({ classification: "CI-PASS", exactIdentity: true });
    }
  });
});
