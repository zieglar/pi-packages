#!/usr/bin/env node

/**
 * Verify Wayforge release eligibility without acquiring or exercising release
 * authority. This tool is strictly read-only: it never fetches, pushes, tags,
 * commits, checks out, rebases, amends, resets, cleans, or writes repository
 * state. Authorization flags only record current external handoff/user input.
 *
 * Modes:
 *   pre-push  compose check-baseline.mjs with exact range + ancestry proof
 *   ci        classify authoritative hosted-CI JSON against an exact identity
 *
 * Exit codes: 0 = eligible / CI-PASS, 1 = ineligible / other CI classification,
 * 2 = usage or environment error.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASELINE_CHECKER = fileURLToPath(new URL("./check-baseline.mjs", import.meta.url));
const HEX_SHA = /^[0-9a-f]{40}$/i;

const USAGE = `Usage:
  node scripts/check-release.mjs pre-push [options]
  node scripts/check-release.mjs ci [options]

This tool verifies eligibility only. It cannot authorize or perform fetch, push,
tag, release, rebase, amend, squash, or any other mutation.

pre-push required inputs:
  --repo <path>
  --branch <name>
  --head <sha>
  --upstream <ref>
  --upstream-head <sha>
  --ahead <n> --behind <n>
  --base <sha>
  --authorized-commit <sha>   repeat in oldest-first authorized order
  --review-status P0
  --validation-status PASS
  --remote-state fresh|existing
  --require-fresh true|false

pre-push authority inputs (optional; absence means VERIFY ONLY):
  --push-authorized true|false
  --tag-authorized true|false

ci required inputs:
  --evidence <json-file>      authoritative gh/API run object or array
  --workflow <name>
  --event <name>
  --branch <name>
  --head <sha>
  --failure-kind milestone|infrastructure  required only for terminal non-success

common:
  --json
  --help

Remote freshness is caller-supplied evidence. This tool never fetches. Watcher
expiry is not CI evidence: query the authoritative run again, then pass that JSON
to ci mode.`;

function usageError(message) {
  process.stderr.write(`release gate: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  if (argv.length === 0) usageError("mode required: pre-push or ci (see --help)");
  if (argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const mode = argv[0];
  if (mode !== "pre-push" && mode !== "ci") usageError(`unknown mode: ${mode}`);
  const allowed = mode === "pre-push"
    ? new Set(["repo", "branch", "head", "upstream", "upstream-head", "ahead", "behind", "base", "authorized-commit", "review-status", "validation-status", "remote-state", "require-fresh", "push-authorized", "tag-authorized"])
    : new Set(["evidence", "workflow", "event", "branch", "head", "failure-kind"]);
  const options = { authorizedCommit: [], json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--json") { options.json = true; continue; }
    if (!arg.startsWith("--")) usageError(`unexpected argument: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usageError(`${arg} requires a value`);
    const key = arg.slice(2);
    if (!allowed.has(key)) usageError(`unknown option for ${mode}: --${key}`);
    if (key === "authorized-commit") options.authorizedCommit.push(value);
    else options[key] = value;
    i += 1;
  }
  return { mode, options };
}

function requireOptions(options, names) {
  for (const name of names) {
    if (options[name] === undefined || options[name] === "") usageError(`--${name} is required`);
  }
}

function requireSha(value, flag) {
  if (!HEX_SHA.test(value)) usageError(`--${flag} requires a full 40-character hex SHA`);
}

function requireBoolean(value, flag) {
  if (value !== "true" && value !== "false") usageError(`--${flag} requires true or false`);
}

function git(repo, args, message) {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    usageError(message);
  }
}

function isAncestor(repo, ancestor, descendant) {
  return spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).status === 0;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function runBaseline(options) {
  const args = [
    BASELINE_CHECKER,
    "--repo", options.repo,
    "--branch", options.branch,
    "--head", options.head,
    "--upstream", options.upstream,
    "--upstream-head", options["upstream-head"],
    "--ahead", options.ahead,
    "--behind", options.behind,
    "--clean",
    "--json",
  ];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status === 2) usageError(`baseline checker error: ${result.stderr.trim() || result.stdout.trim()}`);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    usageError("baseline checker returned invalid JSON");
  }
  return { status: result.status ?? 2, result: parsed };
}

function prePush(options) {
  requireOptions(options, [
    "repo", "branch", "head", "upstream", "upstream-head", "ahead", "behind", "base",
    "review-status", "validation-status", "remote-state", "require-fresh",
  ]);
  requireSha(options.head, "head");
  requireSha(options["upstream-head"], "upstream-head");
  requireSha(options.base, "base");
  if (options.authorizedCommit.length === 0) usageError("at least one --authorized-commit is required");
  for (const sha of options.authorizedCommit) requireSha(sha, "authorized-commit");
  if (!/^\d+$/.test(options.ahead) || !/^\d+$/.test(options.behind)) usageError("--ahead and --behind require non-negative integers");
  if (options["review-status"] !== "P0") usageError("--review-status must be P0 for release eligibility");
  if (options["validation-status"] !== "PASS") usageError("--validation-status must be PASS for release eligibility");
  if (options["remote-state"] !== "fresh" && options["remote-state"] !== "existing") usageError("--remote-state must be fresh or existing");
  requireBoolean(options["require-fresh"], "require-fresh");
  if (options["push-authorized"] !== undefined) requireBoolean(options["push-authorized"], "push-authorized");
  if (options["tag-authorized"] !== undefined) requireBoolean(options["tag-authorized"], "tag-authorized");

  const baseline = runBaseline(options);
  const failures = [];
  for (const failure of baseline.result.failures ?? []) {
    failures.push({
      invariant: `baseline:${failure.invariant}`,
      expected: failure.expected,
      actual: failure.actual,
    });
  }

  const actualCommitsText = git(options.repo, ["rev-list", "--reverse", `${options.base}..${options.head}`], "cannot resolve authorized range");
  const actualCommits = actualCommitsText === "" ? [] : actualCommitsText.split("\n");
  if (!arraysEqual(actualCommits, options.authorizedCommit)) {
    failures.push({ invariant: "authorized range", expected: options.authorizedCommit, actual: actualCommits });
  }
  if (!isAncestor(options.repo, options.base, options.head)) {
    failures.push({ invariant: "base ancestry", expected: `${options.base} ancestor of ${options.head}`, actual: "not ancestor" });
  }
  if (!isAncestor(options.repo, options["upstream-head"], options.head)) {
    failures.push({ invariant: "fast-forward ancestry", expected: `${options["upstream-head"]} ancestor of ${options.head}`, actual: "not ancestor" });
  }
  if (options["require-fresh"] === "true" && options["remote-state"] !== "fresh") {
    failures.push({ invariant: "remote freshness", expected: "fresh", actual: options["remote-state"] });
  }

  const pushAuthority = options["push-authorized"] ?? "absent";
  const tagAuthority = options["tag-authorized"] ?? "absent";
  const eligible = failures.length === 0;
  const mutationMode = pushAuthority === "true"
    ? "EXTERNAL PUSH AUTHORITY SUPPLIED; TOOL REMAINS READ-ONLY"
    : tagAuthority === "true"
      ? "EXTERNAL TAG AUTHORITY SUPPLIED; TOOL REMAINS READ-ONLY"
      : "VERIFY ONLY";
  const report = {
    phase: "PRE-PUSH",
    eligible,
    mutationMode,
    authority: { push: pushAuthority, tag: tagAuthority },
    authorityBoundary: "eligibility is not authorization; mutation authority comes only from the current explicit handoff/user",
    remoteEvidence: { state: options["remote-state"], freshnessRequired: options["require-fresh"] === "true" },
    suppliedEvidence: { reviewStatus: options["review-status"], validationStatus: options["validation-status"] },
    baseline: baseline.result.measurements,
    range: { base: options.base, head: options.head, authorizedCommits: options.authorizedCommit, actualCommits },
    failures,
  };
  emit(report, options.json, eligible ? "RELEASE ELIGIBLE" : "RELEASE INELIGIBLE");
  process.exit(eligible ? 0 : 1);
}

function normalizeEvidence(raw) {
  return Array.isArray(raw) ? raw : [raw];
}

function ci(options) {
  requireOptions(options, ["evidence", "workflow", "event", "branch", "head"]);
  requireSha(options.head, "head");
  if (options["failure-kind"] !== undefined && !["milestone", "infrastructure"].includes(options["failure-kind"])) {
    usageError("--failure-kind must be milestone or infrastructure");
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(options.evidence, "utf8"));
  } catch (error) {
    usageError(`cannot read CI evidence JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const matches = normalizeEvidence(raw).filter((run) =>
    run?.workflowName === options.workflow
    && run?.event === options.event
    && run?.headBranch === options.branch
    && run?.headSha === options.head
  );
  // Deterministic selection independent of input order: newest databaseId
  // wins; ties prefer a terminal (completed) run over a non-terminal one.
  matches.sort((a, b) => {
    const byId = (b.databaseId ?? 0) - (a.databaseId ?? 0);
    if (byId !== 0) return byId;
    return (b.status === "completed" ? 1 : 0) - (a.status === "completed" ? 1 : 0);
  });
  const exact = matches[0];
  let classification;
  if (exact === undefined) classification = "CI-MISSING";
  else if (exact.status !== "completed") classification = "CI-IN-PROGRESS";
  else if (exact.conclusion === "success") classification = "CI-PASS";
  else if (options["failure-kind"] === "milestone") classification = "CI-FAIL";
  else if (options["failure-kind"] === "infrastructure") classification = "CI-INFRA";
  else usageError("terminal non-success requires --failure-kind milestone|infrastructure after inspecting authoritative job evidence");

  const report = {
    phase: "HOSTED-CI",
    classification,
    exactIdentity: exact !== undefined,
    expected: { workflow: options.workflow, event: options.event, branch: options.branch, headSha: options.head },
    evidence: exact ?? null,
    watcherRule: "watcher timeout is not CI failure; authoritative hosted state governs",
  };
  emit(report, options.json, classification);
  process.exit(classification === "CI-PASS" ? 0 : 1);
}

function emit(report, json, heading) {
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(`${heading}\n\n${JSON.stringify(report, null, 2)}\n`);
}

const { mode, options } = parseArgs(process.argv.slice(2));
if (mode === "pre-push") prePush(options);
else ci(options);
