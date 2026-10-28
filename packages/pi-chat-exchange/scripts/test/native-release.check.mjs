import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { apiGet, publishRelease } from "../native-release.mjs";

const source = readFileSync(new URL("../native-release.mjs", import.meta.url), "utf8");
const workflowPath = new URL("../../../../.github/workflows/native-release.yml", import.meta.url);

const options = {
  repository: "zieglar/pi-packages",
  version: "0.1.0",
  sha: "a".repeat(40),
  expectedSha: "a".repeat(40),
};
const assets = ["aarch64-apple-darwin", "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]
  .map(target => `ce-sqlite-0.1.0-${target}.node`)
  .concat(["SHA256SUMS", "native-manifest.json", "native-identities.json", "provenance.jsonl"]);

const response = (code, body) => ({ status: code === 200 ? 0 : 1, stdout: `HTTP/2.0 ${code} Status\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}` });

const enabled = response(200, { enabled: true });
const ruleset = response(200, {
  id: 26078349,
  target: "tag",
  enforcement: "active",
  conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: [] } },
  rules: [{ type: "update" }, { type: "deletion" }],
  bypass_actors: [],
  current_user_can_bypass: "never",
});
const environment = response(200, {
  name: "native-sqlite-release",
  can_admins_bypass: false,
  protection_rules: [{ type: "required_reviewers" }, { type: "branch_policy" }],
});
const branchPolicies = response(200, { total_count: 1, branch_policies: [{ id: 1, name: "main", type: "branch" }] });

// One fixture serves both credentials. `route` maps an API path to a
// response, so a test can weaken exactly one repository control.
function fixture({ route = () => undefined, failWrite = -1 } = {}) {
  const calls = [];
  let writes = 0;
  const run = args => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "--include") {
      const path = args.at(-1);
      const override = route(path);
      if (override) return override;
      if (path.endsWith("/immutable-releases")) return enabled;
      if (path.endsWith("/rulesets/26078349")) return ruleset;
      if (path.endsWith("/rulesets")) return response(200, [{ id: 26078349, target: "tag", enforcement: "active" }]);
      if (path.endsWith("/deployment-branch-policies")) return branchPolicies;
      if (path.includes("/environments/")) return environment;
      return response(404, { message: "Not Found" });
    }
    return { status: ++writes === failWrite ? 1 : 0, stdout: "" };
  };
  return { calls, run, adminRun: run, deps: { run, adminRun: run }, writes: () => writes };
}

for (const kind of ["tag", "release"]) test(`existing ${kind} refuses before any write`, () => {
  const f = fixture({ route: path => (path.includes(kind) ? response(200, { id: 1, draft: true }) : undefined) });
  assert.throws(() => publishRelease(options, ["asset.node"], f.deps), /already exists/);
  assert.equal(f.writes(), 0);
});

for (const code of [401, 403, 429, 500]) test(`HTTP ${code} is not absence`, () => {
  const f = fixture({ route: path => (path.includes("git/ref") ? response(code, { message: "failure" }) : undefined) });
  assert.throws(() => publishRelease(options, [], f.deps), /refused/);
  assert.equal(f.writes(), 0);
});

for (const result of [{ status: 1, stdout: "" }, { status: 1, stdout: "HTTP/2.0 404 Status\n\n<html>" }, response(404, { message: "unauthorized" })]) {
  test(`invalid/ambiguous API response refuses: ${result.stdout}`, () => {
    assert.throws(() => apiGet("fixture", () => result));
  });
}

test("disabled repository immutable releases refuse", () => {
  const f = fixture({ route: path => (path.endsWith("/immutable-releases") ? response(200, { enabled: false }) : undefined) });
  assert.throws(() => publishRelease(options, [], f.deps), /administrator/);
  assert.equal(f.writes(), 0);
});

test("a weakened tag ruleset refuses before any write", () => {
  for (const weakened of [
    response(200, { id: 26078349, target: "tag", enforcement: "disabled", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [], current_user_can_bypass: "never" }),
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }], bypass_actors: [], current_user_can_bypass: "never" }),
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [{ actor_id: 1, actor_type: "RepositoryRole" }], current_user_can_bypass: "never" }),
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [], current_user_can_bypass: "always" }),
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/other-*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [], current_user_can_bypass: "never" }),
    // include matches the namespace but exclude removes the release tag: not protection.
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"], exclude: ["refs/tags/ce-sqlite-v0.1.0"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [], current_user_can_bypass: "never" }),
    // bypass_actors is absent: unreadable, not an empty list.
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], current_user_can_bypass: "never" }),
    // current_user_can_bypass is absent: unreadable, not "never".
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [] }),
    response(200, { id: 26078349, target: "tag", enforcement: "active", conditions: { ref_name: { include: ["refs/tags/ce-sqlite-v*"] } }, rules: [{ type: "update" }, { type: "deletion" }], bypass_actors: [], current_user_can_bypass: "exempt" }),
  ]) {
    const f = fixture({ route: path => (path.endsWith("/rulesets/26078349") ? weakened : undefined) });
    assert.throws(() => publishRelease(options, [], f.deps), /ruleset/);
    assert.equal(f.writes(), 0);
  }
});

test("a weakened release environment refuses before any write", () => {
  for (const weakened of [
    response(200, { name: "native-sqlite-release", can_admins_bypass: true, protection_rules: [{ type: "branch_policy" }] }),
    response(200, { name: "native-sqlite-release", can_admins_bypass: false, protection_rules: [{ type: "required_reviewers" }] }),
  ]) {
    const f = fixture({ route: path => (path.includes("/environments/") && !path.includes("deployment-branch-policies") ? weakened : undefined) });
    assert.throws(() => publishRelease(options, [], f.deps), /environment/);
    assert.equal(f.writes(), 0);
  }
  const branches = fixture({ route: path => (path.includes("deployment-branch-policies") ? response(200, { total_count: 2, branch_policies: [{ name: "main", type: "branch" }, { name: "other", type: "branch" }] }) : undefined) });
  assert.throws(() => publishRelease(options, [], branches.deps), /main only/);
  assert.equal(branches.writes(), 0);
});

test("a publish SHA that is not the dispatched commit refuses before any write", () => {
  const f = fixture();
  assert.throws(() => publishRelease({ ...options, expectedSha: "b".repeat(40) }, [], f.deps), /does not match the dispatched commit/);
  assert.equal(f.writes(), 0);
});

test("a missing publish SHA refuses before any write", () => {
  const f = fixture();
  assert.throws(() => publishRelease({ ...options, expectedSha: undefined }, [], f.deps), /explicit publish commit SHA is required/);
  assert.equal(f.writes(), 0);
});

test("new version creates an exact SHA tag, draft assets, then publishes", () => {
  const f = fixture();
  publishRelease(options, assets, f.deps);
  const writes = f.calls.filter(args => !(args[0] === "api" && args[1] === "--include"));
  assert.deepEqual(writes[0], ["api", "--method", "POST", "repos/zieglar/pi-packages/git/refs", "-f", "ref=refs/tags/ce-sqlite-v0.1.0", "-f", `sha=${options.sha}`]);
  assert.ok(writes[1].includes("--verify-tag"));
  assert.ok(writes[1].includes("--draft"));
  assert.ok(writes[1].includes("provenance.jsonl"));
  assert.deepEqual(writes[2], ["release", "edit", "ce-sqlite-v0.1.0", "--repo", "zieglar/pi-packages", "--draft=false"]);
  assert.ok(!writes.flat().some(arg => /clobber|force|delete/.test(arg)));
});

for (const step of [1, 2, 3]) test(`write failure ${step} stops immediately without retry/cleanup`, () => {
  const f = fixture({ failWrite: step });
  assert.throws(() => publishRelease(options, assets, f.deps), /manual review; no retry/);
  assert.equal(f.writes(), step);
});

test("repository/version/commit validation prevents writes", () => {
  for (const bad of [{ repository: "evil/repo" }, { version: "latest" }, { sha: "main" }]) {
    const f = fixture();
    assert.throws(() => publishRelease({ ...options, ...bad }, [], f.deps), /invalid release/);
    assert.equal(f.calls.length, 0);
  }
});

test("missing or additional release files refuse before creating a tag", () => {
  for (const files of [assets.slice(1), [...assets, "unexpected.bin"]]) {
    const f = fixture();
    assert.throws(() => publishRelease(options, files, f.deps), /fixed version inventory/);
    assert.equal(f.writes(), 0);
  }
});

test("the administration credential is confined to repository control reads", () => {
  assert.match(source, /export const ADMIN_TOKEN_ENV = "CE_RELEASE_ADMIN_TOKEN"/);
  assert.match(source, /delete child\.GITHUB_TOKEN/);
  assert.match(source, /delete child\[ADMIN_TOKEN_ENV\]/);
  const adminBlock = source.slice(source.indexOf("export function adminRunner"), source.indexOf("export function apiGet"));
  assert.doesNotMatch(adminBlock, /git\/refs|"release", "create"|"release", "edit"/);
});

test("the release workflow keeps Store admission and privileged jobs separate", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const store = workflow.slice(workflow.indexOf("      - name: Build TypeScript and verify cross-driver databases"), workflow.indexOf("      - name: Test release refusal"));
  assert.match(store, /matrix.target == 'aarch64-apple-darwin' \|\|/);
  assert.match(store, /matrix.target == 'x86_64-unknown-linux-gnu'/);
  assert.doesNotMatch(store, /x86_64-apple-darwin/);
  const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  attest:"));
  assert.doesNotMatch(build, /contents: write|id-token: write|attestations: write/);
  const attest = workflow.slice(workflow.indexOf("  attest:"), workflow.indexOf("  release:"));
  assert.match(attest, /attestations: write/);
  assert.match(attest, /id-token: write/);
  assert.doesNotMatch(attest, /contents: write/);
  assert.match(attest, /subject-path: release-files\/\*/);
  for (const job of [attest, workflow.slice(workflow.indexOf("  release:"))]) {
    assert.match(job, /github.ref == 'refs\/heads\/main'/);
    assert.match(job, /github.repository == 'zieglar\/pi-packages'/);
    assert.match(job, /github.event_name == 'workflow_dispatch'/);
  }
  assert.match(workflow, /cancel-in-progress: false/);
  for (const match of workflow.matchAll(/uses: [^@\s]+@([^\s]+)/g)) assert.match(match[1], /^[a-f0-9]{40}$/);
  // Syntax-check every literal shell body without executing GitHub operations.
  for (const match of workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)) {
    const script = match[1].replace(/^          /gm, "").replace(/\$\{\{[^}]+\}\}/g, "fixture");
    execFileSync("bash", ["-n"], { input: script });
  }
});
