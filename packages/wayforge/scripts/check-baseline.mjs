#!/usr/bin/env node

/**
 * Mechanical baseline gate for Wayforge handoffs.
 *
 * Verifies caller-supplied git invariants (branch, HEAD, upstream, ahead/behind,
 * worktree/index cleanliness, commit-range counts) against a repository and
 * exits non-zero naming every mismatch. Strictly read-only: it never fetches,
 * pulls, resets, checks out, stashes, cleans, commits, or pushes. Expected
 * values are invocation inputs supplied by the calling handoff; this tool
 * holds no Wayforge-specific constants.
 *
 * Exit codes: 0 = all requested invariants hold, 1 = invariant mismatch,
 * 2 = usage or environment error.
 */

import { execFileSync } from "node:child_process";

const USAGE = `Usage: node scripts/check-baseline.mjs [options]

Verifies caller-supplied git baseline invariants. Read-only; never mutates
git state and never touches the network. Only requested invariants are
asserted; measured values are always reported.

Repository:
  --repo <path>          repository to inspect (default: discover from cwd)

Invariants (all optional; asserted only when supplied):
  --branch <name>        current branch equals <name>
  --head <sha>           HEAD equals <sha> (full sha or prefix, min 7 chars)
  --upstream <ref>       upstream ref to measure (default: @{upstream} if set)
  --upstream-head <sha>  resolved upstream commit equals <sha>
  --ahead <n>            commits ahead of upstream equals <n>
  --behind <n>           commits behind upstream equals <n>
  --clean                tracked worktree and index are both clean
  --clean-worktree       tracked worktree is clean
  --clean-index          index has no staged changes
  --range <A..B>         rev range to count (requires --range-count)
  --range-count <n>      commit count in --range equals <n>

Output:
  --json                 machine-readable JSON instead of text
  --help                 show this reference

Exit codes: 0 PASS, 1 invariant mismatch, 2 usage/environment error.
Untracked files are reported but never fail --clean; allowed untracked
exceptions stay explicit in the calling handoff.`;

function usageError(message) {
  process.stderr.write(`baseline gate: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { json: false };
  const valueFlags = new Set([
    "--repo", "--branch", "--head", "--upstream", "--upstream-head",
    "--ahead", "--behind", "--range", "--range-count",
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === "--clean") { options.cleanWorktree = true; options.cleanIndex = true; continue; }
    if (arg === "--clean-worktree") { options.cleanWorktree = true; continue; }
    if (arg === "--clean-index") { options.cleanIndex = true; continue; }
    if (valueFlags.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        usageError(`${arg} requires a value`);
      }
      options[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    usageError(`unknown argument: ${arg} (see --help)`);
  }
  for (const numeric of ["ahead", "behind", "range-count"]) {
    if (options[numeric] !== undefined && !/^\d+$/.test(options[numeric])) {
      usageError(`--${numeric} requires a non-negative integer, got: ${options[numeric]}`);
    }
  }
  if ((options.range === undefined) !== (options["range-count"] === undefined)) {
    usageError("--range and --range-count must be supplied together");
  }
  for (const sha of ["head", "upstream-head"]) {
    if (options[sha] !== undefined && !/^[0-9a-f]{7,40}$/i.test(options[sha])) {
      usageError(`--${sha} requires a hex sha (7-40 chars), got: ${options[sha]}`);
    }
  }
  return options;
}

function git(repo, args) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    return undefined;
  }
}

function gitOrFail(repo, args, message) {
  const out = git(repo, args);
  if (out === undefined) usageError(message);
  return out;
}

function gitRaw(repo, args, message) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    usageError(message);
  }
}

function measure(repo, options) {
  const root = git(repo, ["rev-parse", "--show-toplevel"]);
  if (root === undefined) usageError(`not a git repository: ${repo}`);

  const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]) ?? "(detached)";
  const head = git(root, ["rev-parse", "HEAD"]) ?? "(unborn)";

  let upstreamRef = options.upstream;
  if (upstreamRef === undefined) {
    upstreamRef = git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]) || undefined;
  }
  let upstreamSha;
  let ahead;
  let behind;
  if (upstreamRef !== undefined) {
    upstreamSha = git(root, ["rev-parse", upstreamRef]);
    if (upstreamSha === undefined) usageError(`upstream ref does not resolve: ${upstreamRef}`);
    ahead = gitOrFail(root, ["rev-list", "--count", `${upstreamRef}..HEAD`], `cannot count ${upstreamRef}..HEAD`);
    behind = gitOrFail(root, ["rev-list", "--count", `HEAD..${upstreamRef}`], `cannot count HEAD..${upstreamRef}`);
  } else if (options["upstream-head"] !== undefined || options.ahead !== undefined || options.behind !== undefined) {
    usageError("no upstream configured; pass --upstream <ref>");
  }

  // Porcelain status codes are positional; never trim before parsing.
  const status = gitRaw(root, ["status", "--porcelain"], "git status failed");
  let indexDirty = 0;
  let worktreeDirty = 0;
  let untracked = 0;
  for (const line of status.split("\n")) {
    if (line.length < 2) continue;
    if (line.startsWith("??")) { untracked += 1; continue; }
    if (line[0] !== " ") indexDirty += 1;
    if (line[1] !== " ") worktreeDirty += 1;
  }

  let rangeCount;
  if (options.range !== undefined) {
    rangeCount = git(root, ["rev-list", "--count", options.range]);
    if (rangeCount === undefined) usageError(`range does not resolve: ${options.range}`);
  }

  return { root, branch, head, upstreamRef, upstreamSha, ahead, behind, indexDirty, worktreeDirty, untracked, range: options.range, rangeCount };
}

function shaMatches(actual, expected) {
  return actual.toLowerCase().startsWith(expected.toLowerCase());
}

function collectFailures(m, options) {
  const failures = [];
  const check = (invariant, expected, actual, holds) => {
    if (!holds) failures.push({ invariant, expected: String(expected), actual: String(actual) });
  };
  if (options.branch !== undefined) check("branch", options.branch, m.branch, m.branch === options.branch);
  if (options.head !== undefined) check("HEAD", options.head, m.head, m.head !== "(unborn)" && shaMatches(m.head, options.head));
  if (options["upstream-head"] !== undefined) {
    check("upstream HEAD", options["upstream-head"], m.upstreamSha ?? "(none)", m.upstreamSha !== undefined && shaMatches(m.upstreamSha, options["upstream-head"]));
  }
  if (options.ahead !== undefined) check("ahead", options.ahead, m.ahead ?? "(no upstream)", m.ahead === options.ahead);
  if (options.behind !== undefined) check("behind", options.behind, m.behind ?? "(no upstream)", m.behind === options.behind);
  if (options.cleanWorktree) check("worktree", "clean", m.worktreeDirty === 0 ? "clean" : `dirty (${m.worktreeDirty} tracked)`, m.worktreeDirty === 0);
  if (options.cleanIndex) check("index", "clean", m.indexDirty === 0 ? "clean" : `staged (${m.indexDirty})`, m.indexDirty === 0);
  if (options["range-count"] !== undefined) {
    check(`range ${options.range}`, options["range-count"], m.rangeCount ?? "(unresolved)", m.rangeCount === options["range-count"]);
  }
  return failures;
}

function textReport(m, failures) {
  const lines = [];
  if (failures.length === 0) {
    lines.push("BASELINE PASS", "");
  } else {
    lines.push("BASELINE FAIL", "");
    for (const failure of failures) {
      lines.push(failure.invariant, `expected ${failure.expected}`, `actual   ${failure.actual}`, "");
    }
  }
  lines.push(`branch       ${m.branch}`, `HEAD         ${m.head}`);
  if (m.upstreamRef !== undefined) {
    lines.push(`upstream     ${m.upstreamRef} ${m.upstreamSha}`, `ahead        ${m.ahead}`, `behind       ${m.behind}`);
  }
  lines.push(
    `worktree     ${m.worktreeDirty === 0 ? "clean" : `dirty (${m.worktreeDirty} tracked)`}`,
    `index        ${m.indexDirty === 0 ? "clean" : `staged (${m.indexDirty})`}`,
    `untracked    ${m.untracked}`,
  );
  if (m.range !== undefined) lines.push(`range        ${m.range} ${m.rangeCount}`);
  return `${lines.join("\n")}\n`;
}

const options = parseArgs(process.argv.slice(2));
const repo = options.repo ?? process.cwd();
const measurements = measure(repo, options);
const failures = collectFailures(measurements, options);

if (options.json) {
  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    measurements: {
      repo: measurements.root,
      branch: measurements.branch,
      head: measurements.head,
      upstream: measurements.upstreamRef ?? null,
      upstreamHead: measurements.upstreamSha ?? null,
      ahead: measurements.ahead === undefined ? null : Number(measurements.ahead),
      behind: measurements.behind === undefined ? null : Number(measurements.behind),
      worktreeDirty: measurements.worktreeDirty,
      indexDirty: measurements.indexDirty,
      untracked: measurements.untracked,
      range: measurements.range ?? null,
      rangeCount: measurements.rangeCount === undefined ? null : Number(measurements.rangeCount),
    },
    failures,
  })}\n`);
} else {
  process.stdout.write(textReport(measurements, failures));
}
process.exit(failures.length === 0 ? 0 : 1);
