import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import vm from "node:vm";

const releaseScript = resolve(import.meta.dirname, "../npm-release.mjs");
const stub = resolve(import.meta.dirname, "support/npm-stub.mjs");
const workflowPath = resolve(import.meta.dirname, "../../../../.github/workflows/npm-publish.yml");
const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const packageDirectory = tempPackage();

const sourcePackageDirectory = resolve(import.meta.dirname, "../..");
const healthyInventory = JSON.parse(spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: packageDirectory, encoding: "utf8" }).stdout)[0].files
  .filter(entry => entry.path !== "README.zh-CN.md");
function harness(routes) {
  const directory = mkdtempSync(join(tmpdir(), "ce-npm-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const logPath = join(directory, "npm.log");
  const routesPath = join(directory, "routes.json");
  writeFileSync(routesPath, JSON.stringify(routes));
  const shim = join(bin, "npm");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
  chmodSync(shim, 0o755);
  return { bin, logPath, routesPath };
}

function invoke(args, { env = {}, routes = {}, scriptPath = releaseScript, cwd = packageDirectory } = {}) {
  const { bin, logPath, routesPath } = harness(routes);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CE_NPM_STUB_LOG: logPath,
      CE_NPM_STUB_ROUTES: routesPath,
      EXPECTED_SHA: SHA,
      GITHUB_SHA: SHA,
      ...env,
    },
  });
  const calls = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

function healthyRoutes() {
  return {
    pack: { status: 0, stdout: JSON.stringify([{ filename: "zieglar-pi-chat-exchange-0.2.0.tgz", files: healthyInventory }]) },
    view: { status: 1, stdout: "", stderr: "npm error code E404\n" },
  };
}

function tempPackage(fields = {}) {
  const directory = mkdtempSync(join(tmpdir(), "ce-pkg-"));
  const sourceRoot = resolve(import.meta.dirname, "../..");
  cpSync(join(sourceRoot, "dist"), join(directory, "dist"), { recursive: true });
  cpSync(join(sourceRoot, "pi-extension"), join(directory, "pi-extension"), { recursive: true });
  cpSync(join(sourceRoot, "README.md"), join(directory, "README.md"));
  cpSync(join(sourceRoot, "LICENSE"), join(directory, "LICENSE"));
  mkdirSync(join(directory, "native"), { recursive: true });
  cpSync(join(sourceRoot, "native/tunnel-keychain.swift"), join(directory, "native/tunnel-keychain.swift"));
  mkdirSync(join(directory, "scripts"), { recursive: true });
  for (const name of ["recover-stale-ownership.mjs", "reconcile-session-process-mutex.mjs"])
    cpSync(join(sourceRoot, "scripts", name), join(directory, "scripts", name));
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    ...JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")),
    name: "@zieglar/pi-chat-exchange",
    version: "0.2.0",
    repository: { type: "git", url: "git+https://github.com/zieglar/pi-packages.git", directory: "packages/pi-chat-exchange" },
    ...fields,
  }));
  const compatPath = join(directory, "dist/storage/native-compat.js");
  const compat = readFileSync(compatPath, "utf8").replaceAll("sha256: null", `sha256: "${"a".repeat(64)}"`);
  writeFileSync(compatPath, compat);
  return directory;
}

test("a missing publish SHA refuses before any npm call", () => {
  const result = invoke(["preflight"], { env: { EXPECTED_SHA: "" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /explicit publish commit SHA is required/);
  assert.equal(result.calls.length, 0);
});

test("a publish SHA that is not the dispatched commit refuses before any npm call", () => {
  const result = invoke(["preflight"], { env: { EXPECTED_SHA: OTHER_SHA } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match the dispatched commit/);
  assert.equal(result.calls.length, 0);
});

test("invalid package.json refuses before any npm call", () => {
  const directory = mkdtempSync(join(tmpdir(), "ce-bad-json-"));
  writeFileSync(join(directory, "package.json"), "{ not json");
  const result = invoke(["preflight"], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unreadable or invalid JSON/);
  assert.equal(result.calls.length, 0);
});

test("a repository.url mismatch refuses before any npm call", () => {
  const directory = tempPackage({ repository: { type: "git", url: "git+https://github.com/other/repo.git" } });
  const result = invoke(["preflight"], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository.url must exactly match/);
  assert.equal(result.calls.length, 0);
});

test("an unexpected package name refuses before any npm call", () => {
  const directory = tempPackage({ name: "@other/package" });
  const result = invoke(["preflight"], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected npm package name/);
  assert.equal(result.calls.length, 0);
});

test("a non-semver version refuses before any npm call", () => {
  const directory = tempPackage({ version: "latest" });
  const result = invoke(["preflight"], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /concrete semver version/);
  assert.equal(result.calls.length, 0);
});

test("an existing version refuses without overwrite or retry", () => {
  const routes = { ...healthyRoutes(), view: { status: 0, stdout: "0.2.0\n" } };
  const result = invoke(["preflight"], { routes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already exists on npm; no overwrite or retry/);
  assert.equal(result.calls.filter(call => call.argv[0] === "publish").length, 0);
});

test("registry failure is not proof of absence and refuses", () => {
  const routes = { ...healthyRoutes(), view: { status: 1, stdout: "", stderr: "npm error code E401\n" } };
  const result = invoke(["preflight"], { routes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /version state is unreadable/);
});

for (const [label, stderr] of [
  ["proxy hostname containing 404", "npm error code ENOTFOUND\nnpm error proxy404.internal\n"],
  ["request id containing 404 digits", "npm error code E500\nnpm error request 404123\n"],
  ["generic not found text", "npm error ENOTFOUND: proxy not found\n"],
]) {
  test(`misleading ${label} is not accepted as version absence`, () => {
    const routes = { ...healthyRoutes(), view: { status: 1, stdout: "", stderr } };
    const result = invoke(["preflight"], { routes });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /version state is unreadable/);
    assert.equal(result.calls.filter(call => call.argv[0] === "publish").length, 0);
  });
}

test("leading-zero semver is refused", () => {
  const directory = tempPackage({ version: "01.2.3" });
  const result = invoke(["preflight"], { cwd: directory });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package version must be a concrete semver version/);
  assert.equal(result.calls.length, 0);
});

test("Native-default publication with unpinned production assets refuses", () => {
  const directory = tempPackage();
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "@zieglar/pi-chat-exchange", version: "0.2.0",
    repository: { type: "git", url: "git+https://github.com/zieglar/pi-packages.git", directory: "packages/pi-chat-exchange" },
  }));
  // Default Native path exists, but the production trust pin is null. No npm call is allowed.
  writeFileSync(join(directory, "dist/storage/native-compat.js"), readFileSync(join(sourcePackageDirectory, "dist/storage/native-compat.js")));
  const result = invoke(["preflight"], { cwd: directory, routes: healthyRoutes() });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Native default requires verified production trust pins/);
  assert.equal(result.calls.length, 0);
});
test("fully pinned production assets pass the publish trust gate", async () => {
  const { assertNativeDefaultPublishable } = await import("../npm-release.mjs");
  const { NATIVE_COMPAT, parseNativeCompat } = await import(pathToFileURL(join(sourcePackageDirectory, "dist/storage/native-compat.js")).href);
  const all = ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"];
  const manifest = structuredClone(NATIVE_COMPAT);
  for (const target of all) manifest.versions["0.1.0"].assets[target].sha256 = "a".repeat(64);
  assert.doesNotThrow(() => assertNativeDefaultPublishable({ manifest, parseNativeCompat }));
  for (const t of all) {
    const broken = structuredClone(manifest); broken.versions["0.1.0"].assets[t].sha256 = null;
    assert.throws(() => assertNativeDefaultPublishable({ manifest: broken, parseNativeCompat }),
      /Native default requires verified production trust pins/);
  }
  assert.throws(() => assertNativeDefaultPublishable({ manifest: structuredClone(NATIVE_COMPAT), parseNativeCompat }), /Native default requires verified production trust pins/);
  for (const broken of [
    { ...manifest, abiVersion: 2 },
    { ...manifest, repository: "other/repository" },
    { ...manifest, defaultVersion: "9.9.9" },
    { ...manifest, versions: { "0.1.0": { assets: Object.fromEntries(["a", "b", "c", "d"].map(t => [t, { asset: `ce-sqlite-0.1.0-${t}.node`, sha256: "a".repeat(64) }])) } } },
  ]) assert.throws(() => assertNativeDefaultPublishable({ manifest: broken, parseNativeCompat }));
  const wrongAsset = structuredClone(manifest);
  wrongAsset.versions["0.1.0"].assets[all[0]].asset = "wrong.node";
  assert.throws(() => assertNativeDefaultPublishable({ manifest: wrongAsset, parseNativeCompat }));
});
test("a new version with a clean pack passes preflight", () => {
  const result = invoke(["preflight"], { routes: healthyRoutes() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preflight passed for @zieglar\/pi-chat-exchange@0.2.0/);
});

for (const forbidden of [
  "native/ce-sqlite/ce-sqlite-0.1.0-aarch64-apple-darwin.node",
  "SHA256SUMS",
  "provenance.jsonl",
  "native-manifest.json",
  "native-identities.json",
  "docs/release/public-export-ledger.jsonl",
  "AGENTS.md",
  ".herdr-web-ui/screenshot.png",
]) {
  test(`release or private asset ${forbidden} is refused in the pack`, () => {
    const routes = {
      pack: { status: 0, stdout: JSON.stringify([{ files: [{ path: forbidden }, { path: "README.md" }] }]) },
      view: { status: 1, stdout: "", stderr: "npm error code E404\n" },
    };
    const result = invoke(["preflight"], { routes });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must not enter the npm payload/);
  });
}

test("an empty pack inventory refuses", () => {
  const routes = { pack: { status: 0, stdout: JSON.stringify([{ files: [] }]) }, view: { status: 1, stdout: "", stderr: "npm error code E404\n" } };
  const result = invoke(["preflight"], { routes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content inventory is empty/);
});

test("publishOnce refuses a long-lived token before any invocation", () => {
  const result = invoke(["publish"], { env: { NPM_TOKEN: "long-lived-secret" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /long-lived NPM_TOKEN must not be used/);
  assert.equal(result.calls.length, 0);
});

test("publish entry runs preflight and publishes exactly once with no dist-tag command", () => {
  const result = invoke(["publish"], { routes: healthyRoutes() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter(call => call.argv[0] === "publish").length, 1);
  assert.deepEqual(result.calls.filter(call => call.argv[0] === "publish").map(call => call.argv),
    [["publish", join(realpathSync(packageDirectory), ".pi-artifacts", "zieglar-pi-chat-exchange-0.2.0.tgz")]],
    "publish must use exactly the validated preflight tarball, not the package root");
  assert.equal(result.calls.filter(call => call.argv[0] === "dist-tag").length, 0);
  assert.ok(result.calls.some(call => call.argv[0] === "pack"), "preflight must run before publish");
  assert.ok(result.calls.some(call => call.argv[0] === "view"), "duplicate-version check must run before publish");
});

test("simulated OIDC ENEEDAUTH fails once with no retry and no dist-tag", () => {
  const routes = { ...healthyRoutes(), publish: { status: 1, stdout: "", stderr: "npm error code ENEEDAUTH\n" } };
  const result = invoke(["publish"], { routes });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no retry and no explicit dist-tag commands/);
  assert.equal(result.calls.filter(call => call.argv[0] === "publish").length, 1);
  assert.equal(result.calls.filter(call => call.argv[0] === "dist-tag").length, 0);
});

function releaseCondition() {
  const source = readFileSync(workflowPath, "utf8");
  const match = source.match(/    if: >-\n((?:      .*\n)+)/);
  assert.ok(match, "release job must have an explicit dispatch condition");
  return match[1].replace(/\s+/g, " ").trim();
}

function evaluateCondition(context) {
  return vm.runInNewContext(releaseCondition(), context);
}

const mainContext = {
  inputs: { publish: true },
  github: { event_name: "workflow_dispatch", repository: "zieglar/pi-packages", ref: "refs/heads/main" },
};

test("main with publish=true is authorized", () => {
  assert.equal(evaluateCondition(mainContext), true);
});

test("a non-main branch is refused", () => {
  assert.equal(evaluateCondition({ ...mainContext, github: { ...mainContext.github, ref: "refs/heads/feature" } }), false);
});

test("publish=false is refused", () => {
  assert.equal(evaluateCondition({ ...mainContext, inputs: { publish: false } }), false);
});

test("a different repository is refused", () => {
  assert.equal(evaluateCondition({ ...mainContext, github: { ...mainContext.github, repository: "other/repo" } }), false);
});

test("workflow uses only the publish environment, OIDC and no long-lived token", () => {
  const source = readFileSync(workflowPath, "utf8");
  assert.match(source, /environment: npm-release/);
  assert.match(source, /contents: read/);
  assert.equal(source.match(/id-token: write/g).length, 1);
  assert.doesNotMatch(source, /NPM_TOKEN/);
  assert.doesNotMatch(source, /dist-tag/);
  assert.doesNotMatch(source, /native-release\.yml|ce-sqlite-v|native\/ce-sqlite\//);
  assert.match(source, /publish_sha/);
  assert.match(source, /npm-release\.mjs preflight/);
  assert.match(source, /npm-release\.mjs publish/);
  const steps = source.matchAll(/^      - name: .+$(?:\n(?!      - ).*)*/gm);
  for (const step of steps) {
    assert.match(step[0], /\n        (uses|run):/, "every step must have run or uses");
  }
  for (const match of source.matchAll(/uses: [^@\s]+@([^\s]+)/g)) assert.match(match[1], /^[a-f0-9]{40}$/);
});
