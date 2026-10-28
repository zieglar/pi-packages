// End-to-end credential routing for the release scripts.
//
// The production scripts are executed as real child processes. Only the
// external `gh` binary is replaced, so the tests observe the credentials that
// the implementation actually hands to a subprocess.
//
//   CE_GH_STUB_LOG     JSON-lines invocation log written by the stub
//   CE_GH_STUB_ROUTES  JSON route table consumed by the stub
//
// A route is { "status": <number>, "body": <object> } for API reads, or
// { "exit": <number> } for other commands.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const releaseScript = resolve(import.meta.dirname, "../native-release.mjs");
const verifyScript = resolve(import.meta.dirname, "../verify-release-assets.mjs");
const stub = resolve(import.meta.dirname, "support/release-gh-stub.mjs");

const PUBLISH = "publish-token";
const ADMIN = "admin-token";
const SHA = "a".repeat(40);

const healthyRoutes = {
  "GET repos/zieglar/pi-packages/immutable-releases": { status: 200, body: { enabled: true } },
  "GET repos/zieglar/pi-packages/rulesets": {
    status: 200,
    body: [{ id: 26078349, name: "ce-sqlite-release-tags", target: "tag", enforcement: "active" }],
  },
  "GET repos/zieglar/pi-packages/rulesets/26078349": {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [],
      current_user_can_bypass: "never",
    },
  },
  "GET repos/zieglar/pi-packages/environments/native-sqlite-release": {
    status: 200,
    body: {
      name: "native-sqlite-release",
      can_admins_bypass: false,
      protection_rules: [{ type: "required_reviewers" }, { type: "branch_policy" }],
    },
  },
  "GET repos/zieglar/pi-packages/environments/native-sqlite-release/deployment-branch-policies": {
    status: 200,
    body: { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] },
  },
  "GET repos/zieglar/pi-packages/git/ref/tags/ce-sqlite-v0.1.0": { status: 404, body: { message: "Not Found" } },
  "GET repos/zieglar/pi-packages/releases/tags/ce-sqlite-v0.1.0": { status: 404, body: { message: "Not Found" } },
};

// Builds a directory whose `gh` is the stub, so the production script spawns
// the stub exactly as it would spawn the real CLI.
function harness(routes = healthyRoutes) {
  const directory = mkdtempSync(join(tmpdir(), "ce-release-"));
  const logPath = join(directory, "gh.log");
  const routesPath = join(directory, "routes.json");
  writeFileSync(routesPath, JSON.stringify(routes));
  const binDirectory = join(directory, "bin");
  mkdirSync(binDirectory);
  const ghPath = join(binDirectory, "gh");
  writeFileSync(ghPath, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  chmodSync(ghPath, 0o755);
  return { binDirectory, logPath, routesPath };
}
// Builds a release bundle directory holding the fixed eight-file inventory.
function assetDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "ce-assets-"));
  const binaries = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]
    .map(target => `ce-sqlite-0.1.0-${target}.node`);
  const lines = [];
  for (const name of binaries) {
    const content = `binary:${name}`;
    writeFileSync(join(directory, name), content);
    lines.push(`${createHash("sha256").update(content).digest("hex")}  ${name}`);
  }
  for (const name of ["SHA256SUMS", "native-manifest.json", "native-identities.json", "provenance.jsonl"]) {
    writeFileSync(join(directory, name), "content");
  }
  writeFileSync(join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
  return directory;
}
function invoke(args, { env = {}, routes, scriptPath = releaseScript, cwd } = {}) {
  const { binDirectory, logPath, routesPath } = harness(routes);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      CE_GH_STUB_LOG: logPath,
      CE_GH_STUB_ROUTES: routesPath,
      GH_TOKEN: PUBLISH,
      CE_RELEASE_ADMIN_TOKEN: ADMIN,
      GITHUB_REPOSITORY: "zieglar/pi-packages",
      VERSION: "0.1.0",
      GITHUB_SHA: SHA,
      EXPECTED_SHA: SHA,
      ...env,
    },
  });
  // A refusal that happens before any request leaves no invocation log.
  const calls = existsSync(logPath)
    ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

// The API path is the first argument that names a repository route.
function apiPath(call) {
  const index = call.argv.indexOf("api");
  if (index === -1) return null;
  return call.argv.slice(index + 1).find(argument => !argument.startsWith("-") && argument.includes("/") && !argument.includes("=")) ?? null;
}

test("a missing administration credential refuses before any request", () => {
  const { status, stderr, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: "" } });
  assert.equal(status, 1);
  assert.match(stderr, /CE_RELEASE_ADMIN_TOKEN is missing/);
  assert.equal(calls.length, 0);
});

test("a missing publish credential refuses before any request", () => {
  const { status, stderr, calls } = invoke(["check"], { env: { GH_TOKEN: "", CE_RELEASE_ADMIN_TOKEN: ADMIN } });
  assert.equal(status, 1);
  assert.match(stderr, /GH_TOKEN is missing/);
  assert.equal(calls.length, 0);
});

test("one credential used for both roles refuses before any request", () => {
  const { status, stderr, calls } = invoke(["check"], { env: { GH_TOKEN: ADMIN, CE_RELEASE_ADMIN_TOKEN: ADMIN } });
  assert.equal(status, 1);
  assert.match(stderr, /must differ from the administration credential/);
  assert.equal(calls.length, 0);
});

test("a missing publish SHA refuses before any request", () => {
  const { status, stderr, calls } = invoke(["check"], { env: { EXPECTED_SHA: "" } });
  assert.equal(status, 1);
  assert.match(stderr, /explicit publish commit SHA is required/);
  assert.equal(calls.length, 0);
});

test("a publish SHA that is not the dispatched commit refuses before any request", () => {
  const { status, stderr, calls } = invoke(["check"], { env: { EXPECTED_SHA: "b".repeat(40) } });
  assert.equal(status, 1);
  assert.match(stderr, /does not match the dispatched commit/);
  assert.equal(calls.length, 0);
});

test("the administration credential is used only for the endpoints that need it", () => {
  const { status, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN } });
  assert.equal(status, 0);
  // Only immutable-releases and the tag ruleset need repository administration
  // read. Environment and branch policy are ordinary repository reads.
  const adminPaths = [
    "repos/zieglar/pi-packages/immutable-releases",
    "repos/zieglar/pi-packages/rulesets",
    "repos/zieglar/pi-packages/rulesets/26078349",
  ];
  for (const path of adminPaths) {
    const call = calls.find(entry => apiPath(entry) === path);
    assert.ok(call, `${path} was not read`);
    assert.equal(call.GH_TOKEN, ADMIN, `${path} did not use the administration credential`);
  }
  const publishPaths = [
    "repos/zieglar/pi-packages/environments/native-sqlite-release",
    "repos/zieglar/pi-packages/environments/native-sqlite-release/deployment-branch-policies",
    "repos/zieglar/pi-packages/git/ref/tags/ce-sqlite-v0.1.0",
    "repos/zieglar/pi-packages/releases/tags/ce-sqlite-v0.1.0",
  ];
  for (const path of publishPaths) {
    const call = calls.find(entry => apiPath(entry) === path);
    assert.ok(call, `${path} was not read`);
    assert.equal(call.GH_TOKEN, PUBLISH, `${path} did not use the publish credential`);
  }
  // No child ever receives the administration secret under its own name, and
  // GITHUB_TOKEN is removed so credential selection is unambiguous.
  for (const call of calls) {
    assert.equal(call.CE_RELEASE_ADMIN_TOKEN, null);
    assert.equal(call.GITHUB_TOKEN, null);
  }
});

test("the administration credential never reaches a write", () => {
  const { status, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN } });
  assert.equal(status, 0);
  const writes = calls.filter(call => call.argv[0] === "release" || (call.argv[0] === "api" && call.argv.includes("--method") && !call.argv.includes("--include")));
  assert.equal(writes.length, 0);
});

test("an HTTP 403 on the administration read refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/immutable-releases"] = { status: 403, body: { message: "Must have admin rights to Repository." } };
  const { status, stderr, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /GitHub API refused \(403\)/);
  assert.equal(calls.filter(call => call.argv.includes("git/refs")).length, 0);
});

test("disabled immutable releases refuse before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/immutable-releases"] = { status: 200, body: { enabled: false } };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /immutable releases must be enabled/);
});

test("a missing ce-sqlite-v* tag ruleset refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets"] = { status: 200, body: [] };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /tag ruleset must protect release tags/);
});

test("a tag ruleset that excludes the release tag refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets/26078349"] = {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: ["refs/tags/ce-sqlite-v0.1.0"] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [],
      current_user_can_bypass: "never",
    },
  };
  const { status, stderr, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /tag ruleset must protect release tags/);
  assert.equal(calls.filter(call => call.argv.includes("git/refs")).length, 0);
});

test("an absent bypass field is unreadable, not an empty list", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets/26078349"] = {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      current_user_can_bypass: "never",
    },
  };
  const { status, stderr, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /bypass actor list is unreadable/);
  assert.equal(calls.filter(call => call.argv.includes("git/refs")).length, 0);
});

test("an absent bypass state is unreadable, not never", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets/26078349"] = {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [],
    },
  };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /bypass state is unreadable/);
});

test("an exempt tag ruleset refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets/26078349"] = {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [],
      current_user_can_bypass: "exempt",
    },
  };
  const { status, stderr, calls } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /must not allow bypass/);
  assert.equal(calls.filter(call => call.argv.includes("git/refs")).length, 0);
});

test("a bypassable tag ruleset refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/rulesets/26078349"] = {
    status: 200,
    body: {
      id: 26078349,
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
      rules: [{ type: "update" }, { type: "deletion" }],
      bypass_actors: [{ actor_id: 514693, actor_type: "User" }],
      current_user_can_bypass: "always",
    },
  };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /must not allow bypass/);
});

test("an environment that allows administrator bypass refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/environments/native-sqlite-release"] = {
    status: 200,
    body: {
      name: "native-sqlite-release",
      can_admins_bypass: true,
      protection_rules: [{ type: "required_reviewers" }, { type: "branch_policy" }],
    },
  };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /must not allow administrator bypass/);
});

test("an environment that may deploy from a branch other than main refuses before any write", () => {
  const routes = { ...healthyRoutes };
  routes["GET repos/zieglar/pi-packages/environments/native-sqlite-release/deployment-branch-policies"] = {
    status: 200,
    body: { total_count: 2, branch_policies: [{ id: 1, name: "main", type: "branch" }, { id: 2, name: "feature", type: "branch" }] },
  };
  const { status, stderr } = invoke(["check"], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /must deploy from main only/);
});

test("a publish with a wrong credential is refused without retry or cleanup", () => {
  const routes = { ...healthyRoutes };
  routes["POST repos/zieglar/pi-packages/git/refs"] = { status: 403, body: { message: "Must have push rights to Repository." } };
  const { status, stderr, calls } = invoke(["publish", assetDirectory()], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes });
  assert.equal(status, 1);
  assert.match(stderr, /release operation failed/);
  const writes = calls.filter(call => call.argv[0] === "release" || apiPath(call) === "repos/zieglar/pi-packages/git/refs");
  assert.equal(writes.length, 1, "a failed write must not be retried or cleaned up");
  assert.equal(calls.filter(call => call.argv[0] === "release").length, 0);
});

test("the attestation verification failure path refuses publication", () => {
  const routes = { ...healthyRoutes };
  routes["attestation SHA256SUMS"] = { exit: 1 };
  const { status, stderr } = invoke([assetDirectory()], { env: { CE_RELEASE_ADMIN_TOKEN: ADMIN }, routes, scriptPath: verifyScript });
  assert.equal(status, 1);
  assert.match(stderr, /attestation verification failed/);
});
