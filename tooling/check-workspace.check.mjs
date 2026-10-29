import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

const tooling = dirname(fileURLToPath(import.meta.url));
const root = resolve(tooling, "..");
const fixtures = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "workspace-check-"));
  fixtures.push(directory);
  mkdirSync(join(directory, "tooling"));
  copyFileSync(join(tooling, "check-workspace.mjs"), join(directory, "tooling/check-workspace.mjs"));
  const packageRoot = join(directory, "packages/pi-chat-exchange");
  mkdirSync(join(packageRoot, "src"), { recursive: true });
  writeFileSync(join(packageRoot, "src/index.js"), "export {};\n");
  const manifest = { name: "@fixture/chat-exchange", type: "module", main: "./src/index.js",
    scripts: { typecheck: "tsc --noEmit", test: "node --test", check: "node scripts/check.mjs" } };
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify(manifest));
  return { directory, packageRoot, manifest };
}
function check(fixture) {
  return spawnSync(process.execPath, [join(fixture.directory, "tooling/check-workspace.mjs")], {
    cwd: fixture.directory, encoding: "utf8", env: { PATH: dirname(process.execPath) },
  });
}
function saveManifest(fixture) { writeFileSync(join(fixture.packageRoot, "package.json"), JSON.stringify(fixture.manifest)); }

test("CI invokes the shipped checker and its regression suite without a missing root script", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /node --test tooling\/check-workspace\.check\.mjs/);
  assert.match(workflow, /node tooling\/check-workspace\.mjs/);
  assert.doesNotMatch(workflow, /run: pnpm check:workspace/);
});
test("accepts the Public single-package workspace without any Private files or dependencies", () => {
  const result = check(workspace());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WORKSPACE OK: 1 package/);
});
for (const [name, mutate, expected] of [
  ["unknown package inventory", f => { mkdirSync(join(f.directory, "packages/unapproved")); }, /not in the frozen package inventory/],
  ["missing required script", f => { delete f.manifest.scripts.check; saveManifest(f); }, /missing required script check/],
  ["nested lockfile", f => { writeFileSync(join(f.packageRoot, "package-lock.json"), "{}"); }, /nested lockfile is forbidden/],
  ["escaping relative import", f => { writeFileSync(join(f.packageRoot, "src/index.js"), 'import "../../outside.js";'); }, /relative import escapes package/],
  ["missing declared entry", f => { f.manifest.main = "./missing.js"; saveManifest(f); }, /entry does not exist/],
  ["symbolic link", f => { symlinkSync("src/index.js", join(f.packageRoot, "linked.js")); }, /symbolic link is not allowed/],
]) test(`rejects ${name}`, () => {
  const fixture = workspace(); mutate(fixture);
  const result = check(fixture);
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, expected);
});
test("rejects undeclared/private cross-package imports and runtime dependency cycles", () => {
  const fixture = workspace();
  const other = join(fixture.directory, "packages/wayforge"); mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@fixture/other", scripts: fixture.manifest.scripts,
    dependencies: { "@fixture/chat-exchange": "workspace:^" } }));
  writeFileSync(join(fixture.packageRoot, "src/index.js"), 'import "@fixture/other/src/private.js";');
  let result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /undeclared internal dependency/);
  assert.match(result.stderr, /private source\/output import/);
  fixture.manifest.dependencies = { "@fixture/other": "workspace:^" }; saveManifest(fixture);
  result = check(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /circular runtime dependency/);
});
