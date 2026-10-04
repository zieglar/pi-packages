#!/usr/bin/env node
/**
 * Wayforge Alpha 0 assisted-dogfood gate.
 *
 * Verifies the repository is in a state where the isolated Alpha 0 workflow
 * may run safely:
 *   1. the frozen Phase 1A baseline is an ancestor of HEAD;
 *   2. runtime dependencies are pinned to the approved versions;
 *   3. the 9 static architecture gates pass;
 *   4. the built extension entry exists for the isolated launcher;
 *   5. the launcher isolates all Pi state below .wayforge-dev;
 *   6. no isolated state, credentials, or session artifacts are tracked;
 *   7. the required composition/e2e sentinel tests exist;
 *   8. dogfood evidence, when present, is valid JSON.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FROZEN_BASELINE = "9a71aaebe5d6831874a4c37dde927d9c769ac863";
const failures = [];

function fail(message) {
  failures.push(message);
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

// 1. Frozen baseline ancestry.
const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", FROZEN_BASELINE, "HEAD"], { cwd: ROOT });
if (ancestry.status !== 0) {
  fail(`frozen Phase 1A baseline ${FROZEN_BASELINE} is not an ancestor of HEAD`);
}

// 2. Pinned runtime dependencies.
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
} catch (error) {
  fail(`package.json is missing or malformed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
}
const expected = {
  dependencies: {
    "@earendil-works/pi-coding-agent": "1.0.2",
    "pi-subagents": "0.70.0",
    "@sinclair/typebox": "0.34.52",
  },
  devDependencies: {
    "@earendil-works/pi-ai": "1.0.2",
  },
};
for (const [section, pins] of Object.entries(expected)) {
  for (const [name, version] of Object.entries(pins)) {
    const actual = pkg[section]?.[name];
    if (actual !== version) {
      fail(`package.json ${section}.${name} must be pinned to ${version} (found ${String(actual)})`);
    }
  }
}

// 3. Static architecture gates.
const arch = spawnSync(process.execPath, [join(ROOT, "scripts", "check-architecture.mjs")], { encoding: "utf8" });
if (arch.status !== 0) {
  fail(`architecture gates failed:\n${arch.stdout}${arch.stderr}`.trim());
}

// 4. Built extension entry for the isolated launcher.
if (!existsSync(join(ROOT, "dist", "extension.js"))) {
  fail("dist/extension.js is missing; run 'npm run build' before the isolated launcher");
}

// 5. Launcher isolation.
const launcher = readFileSync(join(ROOT, "scripts", "pi1-dev.sh"), "utf8");
for (const required of [
  'export PI_CODING_AGENT_DIR="${DEV_DIR}/agent"',
  'export PI_CODING_AGENT_SESSION_DIR="${DEV_DIR}/sessions"',
  'export PI_TELEMETRY="0"',
  'dist/extension.js',
  'from "pi-subagents"',
]) {
  if (!launcher.includes(required)) {
    fail(`scripts/pi1-dev.sh must contain: ${required}`);
  }
}
const launcherCode = launcher
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");
if (/(~|\$HOME)/.test(launcherCode)) {
  fail("scripts/pi1-dev.sh code must never reference home or production Pi paths");
}

// 6. Tracked-file hygiene.
const tracked = git(["ls-files"]);
const trackedFiles = tracked.split("\n").filter(Boolean);
if (trackedFiles.some((file) => file.startsWith(".wayforge-dev/"))) {
  fail("files under .wayforge-dev/ must never be tracked");
}
const credentialLike = trackedFiles.filter((file) => /(^|\/)(secret|credential)s?(\.|$)|\.env$/i.test(file));
if (credentialLike.length > 0) {
  fail(`credential-like tracked files are forbidden: ${credentialLike.join(", ")}`);
}
const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
if (!/(^|\n)\.wayforge-dev\//.test(gitignore)) {
  fail(".gitignore must ignore .wayforge-dev/");
}

// 7. Required sentinel and integration tests.
for (const required of [
  "test/model-runtime-sentinel.test.ts",
  "test/pi-subagent-worker-adapter.test.ts",
  "test/extension-runtime.test.ts",
  "test/runtime-recovery-executor.test.ts",
  "test/workflow-controller.test.ts",
]) {
  if (!existsSync(join(ROOT, required))) {
    fail(`required sentinel test is missing: ${required}`);
  }
}

// 8. Dogfood evidence, when present, must be valid JSON.
const evidenceDir = join(ROOT, "docs", "evidence");
if (existsSync(evidenceDir)) {
  const evidenceFiles = tracked ? trackedFiles.filter((file) => file.startsWith("docs/evidence/") && file.endsWith(".json")) : [];
  for (const file of evidenceFiles) {
    try {
      JSON.parse(readFileSync(join(ROOT, file), "utf8"));
    } catch {
      fail(`evidence file is not valid JSON: ${file}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`ALPHA 0 GATE FAILURES (${failures.length}):`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log("ALPHA 0 OK: isolated assisted-dogfood preconditions satisfied");
