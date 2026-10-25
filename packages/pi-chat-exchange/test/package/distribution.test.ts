import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ce-distribution-"));
  fixtures.push(dir);
  for (const path of ["package.json", ".gitignore", "README.md", "pi-extension", "dist", "native", "scripts", "docs"])
    if (existsSync(join(root, path))) cpSync(join(root, path), join(dir, path), { recursive: true, dereference: false });
  return dir;
}
function pack(dir: string) {
  const out = join(dir, "artifacts"); mkdirSync(out);
  // npm is supplied by the invoking author environment, never downloaded by this test.
  execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", out], { cwd: dir, stdio: "pipe" });
  const archive = join(out, readdirSync(out)[0]!);
  return execFileSync("tar", ["tzf", archive], { encoding: "utf8" }).trim().split("\n");
}
it("native pack carries the runtime closure and no author/private state", () => {
  expect(existsSync(join(root, "dist/bin/mcp-stdio.js")), "author must build before this regression").toBe(true);
  const dir = fixture();
  for (const path of [".env", "store.sqlite", "test/private.test.ts", "src/private.ts", "node_modules/private/index.js"]) {
    const target = join(dir, path); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, "CE_SECRET_SENTINEL");
  }
  const files = pack(dir);
  for (const path of ["pi-extension/index.ts", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js", "native/tunnel-keychain.swift", "scripts/recover-stale-ownership.mjs", "scripts/reconcile-session-process-mutex.mjs"])
    expect(files).toContain(`package/${path}`);
  expect(files.filter((p) => /(?:node_modules|\/test\/|\/src\/|\.env|store\.sqlite|tsconfig)/.test(p))).toEqual([]);
});
it.each(["dist", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js"])("author validator fails closed with missing %s", (missing) => {
  const dir = fixture(); rmSync(join(dir, missing), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), "--validate-only"], { cwd: dir, encoding: "utf8" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Incomplete Pi payload");
});
it("rejects a missing transitive module and symlinked payload roots", () => {
  const dir = fixture();
  writeFileSync(join(dir, "dist/broken.js"), 'import "./absent.js";');
  let result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), "--validate-only"], { cwd: dir, encoding: "utf8" });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("absent.js");
  rmSync(join(dir, "dist"), { recursive: true });
  symlinkSync(join(root, "dist"), join(dir, "dist"), "dir");
  result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), "--validate-only"], { cwd: dir, encoding: "utf8" });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain("Incomplete Pi payload");
});
it("author command validates the native inventory before packing", () => {
  const dir = fixture();
  const result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), join(dir, "out")], { cwd: dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(join(dir, "out"))).toEqual(["zieglar-pi-chat-exchange-0.1.1.tgz"]);
});
it("author validator accepts complete outputs without consumer hooks", () => {
  const dir = fixture();
  const result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), "--validate-only"], { cwd: dir, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const hook of ["prepare", "prepack", "postpack", "preinstall", "install", "postinstall"])
    expect(manifest.scripts[hook]).toBeUndefined();
});
