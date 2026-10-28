import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../.."); // Author workspace only; never the installed-host entry
const authorManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
/** npm's pack naming rule for scoped names: @scope/name -> scope-name. */
const archiveName = `${authorManifest.name.replace(/^@/, "").replace(/\//g, "-")}-${authorManifest.version}.tgz`;
/**
 * The deliberate consumer documentation closure: exactly these ship, nothing else from docs/.
 * Operating guides plus every safety/behaviour contract a shipped doc links to, so a
 * public npm consumer never needs the private repository. Author-side governance and
 * evidence records stay repo-only and are referenced as plain text, never as links.
 */
const consumerDocs = ["docs/chatgpt-installation.md", "docs/independent-install.md", "docs/multi-session-usage.md", "docs/tunnel-setup.md", "docs/releases/0.2.0.md",
  "docs/architecture.md", "docs/native-sqlite.md", "docs/tunnel-manager-background.md", "docs/protocol-v2.md", "docs/ownership-contract.md", "docs/storage-contract.md", "docs/delivery-ack-contract.md", "docs/storage-security.md"] as const;
/** Author-side records that must never enter the consumer tarball. */
const repoOnlyDocs = ["docs/license-audit.md", "docs/runtime-qualification.md", "docs/protocol-v1.md", "docs/quarantine-hotfix-ph0003.md", "docs/chat-bridge-audit-ph0003.md", "docs/identity-hotfix-ph0002.md"] as const;
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ce-distribution-"));
  fixtures.push(dir);
  for (const path of ["package.json", ".gitignore", "README.md", "CHANGELOG.md", "LICENSE", "pi-extension", "dist", "native", "scripts", "docs"])
    if (existsSync(join(root, path))) cpSync(join(root, path), join(dir, path), { recursive: true, dereference: false });
  return dir;
}
function pack(dir: string) {
  const out = join(dir, "artifacts"); mkdirSync(out);
  // npm itself is supplied by the invoking author environment, but every npm
  // invocation runs with a fresh private HOME/cache/userconfig (offline, no
  // lifecycle scripts) so the default suite never touches the real user's
  // npm state and never downloads anything.
  const safe = npmEnv(dir);
  execFileSync("npm", ["pack", "--ignore-scripts", "--offline", "--pack-destination", out], { cwd: dir, stdio: "pipe", env: safe });
  const archive = join(out, readdirSync(out)[0]!);
  return execFileSync("tar", ["tzf", archive], { encoding: "utf8" }).trim().split("\n");
}
function npmEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, "npm-home"); const cache = join(dir, "npm-cache"); const tmp = join(dir, "npm-tmp");
  for (const path of [home, cache, tmp]) mkdirSync(path, { recursive: true });
  writeFileSync(join(home, ".npmrc"), ""); writeFileSync(join(home, "global-npmrc"), "");
  return {
    PATH: process.env.PATH, HOME: home, TMPDIR: tmp,
    npm_config_cache: cache, npm_config_userconfig: join(home, ".npmrc"), npm_config_globalconfig: join(home, "global-npmrc"),
    npm_config_registry: "https://registry.npmjs.org/", npm_config_ignore_scripts: "true", npm_config_offline: "true",
    npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false",
  };
}
function runValidator(dir: string, arg: string) {
  return spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), arg], { cwd: dir, encoding: "utf8", env: npmEnv(dir) });
}
it("the documented local-prefix CLI points to the installed package entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-guide-cli-")); fixtures.push(dir);
  const entry = join(dir, "host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  mkdirSync(resolve(entry, ".."), { recursive: true });
  writeFileSync(entry, 'console.log("synthetic installed CLI reached")');
  const guide = readFileSync(join(root, "docs/independent-install.md"), "utf8");
  expect(guide).toContain("独立 Pi 本体（本指南必需，即使已有全局 Pi；同样禁用 lifecycle scripts）");
  const relative = guide.match(/CE_PI_CLI="\$HOME\/ce-install\/([^"\n]+)"/)?.[1]
    ?? guide.match(/~\/ce-install\/(host\/\S+) install/)?.[1];
  expect(relative).toBeDefined();
  const result = spawnSync(process.execPath, [join(dir, relative!)], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe("synthetic installed CLI reached");
});

it("durable validators and Node probes inherit only the private environment and cwd", () => {
  const result = spawnSync("/usr/bin/python3", ["-B", join(root, "test/package/support/durable-env.test.py"), process.execPath], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
});

it("never publishes final PASS after validator, cleanup or identity failure", () => {
  const result = spawnSync("/usr/bin/python3", ["-B", join(root, "test/package/support/installed-result.test.py")], { encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stderr).toBe(0);
});

it("origin validation refuses CJS, URL, symlink and non-managed managed-root escapes", () => {
  const result = spawnSync("/usr/bin/python3", ["-B", join(root, "test/package/support/module-origin.test.py")], { encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
});

/** Regression: an unresolved fixture root made the 500-record positive control reject itself. */
it("origin validation stays canonical under a symlinked temp root", () => {
  const dir = mkdtempSync(join(tmpdir(), "ce-origin-link-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "real"));
  symlinkSync(join(dir, "real"), join(dir, "link"));
  const result = spawnSync("/usr/bin/python3", ["-B", join(root, "test/package/support/module-origin.test.py")], { encoding: "utf8", timeout: 30_000, env: { ...process.env, TMPDIR: join(dir, "link") } });
  expect(result.status, result.stderr).toBe(0);
});

it("loopback registry serves only the exact candidate with integrity and refuses publication", () => {
  const result = spawnSync("/usr/bin/python3", ["-B", join(root, "test/package/support/loopback-registry.test.py")], { encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr).toBe(0);
});

it("native pack carries the runtime closure and no author/private state", () => {
  expect(existsSync(join(root, "dist/bin/mcp-stdio.js")), "author must build before this regression").toBe(true);
  const dir = fixture();
  for (const path of [".env", "store.sqlite", "test/private.test.ts", "src/private.ts", "node_modules/private/index.js"]) {
    const target = join(dir, path); mkdirSync(resolve(target, ".."), { recursive: true }); writeFileSync(target, "CE_SECRET_SENTINEL");
  }
  const files = pack(dir);
  for (const path of ["LICENSE", "pi-extension/index.ts", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js", "dist/tunnel/offline-client.js", "native/tunnel-keychain.swift", "scripts/recover-stale-ownership.mjs", "scripts/reconcile-session-process-mutex.mjs"])
    expect(files).toContain(`package/${path}`);
  expect(files.filter((p) => /(?:node_modules|\/test\/|\/src\/|\.env|store\.sqlite|tsconfig)/.test(p))).toEqual([]);
  // URL-asset boundary: the bundled offline simulator ships, no real native
  // client binary (or any .node addon) may ever ride the consumer tarball.
  expect(files.some((p) => p.split("/").pop() === "tunnel-client" || p.endsWith(".node")), "native client binary shipped").toBe(false);
});
it("ships exactly the consumer documentation closure and no internal docs", () => {
  const files = pack(fixture());
  const docs = files.filter((p) => p.startsWith("package/docs/")).sort();
  expect(docs).toEqual([...consumerDocs].map((doc) => `package/${doc}`).sort());
  for (const doc of repoOnlyDocs) expect(docs, doc).not.toContain(`package/${doc}`);
});
/**
 * npm renders shipped docs with relative links rewritten against the PRIVATE
 * repository, so a link to a non-shipped file 404s for every public consumer.
 * Fail closed on any dangling relative link and on any private-repo URL.
 */
it("leaves no relative link in a shipped doc pointing outside the distribution", () => {
  const members = new Set(pack(fixture()).map((p) => p.replace(/^package\//, "")));
  const shipped = [...members].filter((p) => p.endsWith(".md")).sort();
  expect(shipped.length).toBe(consumerDocs.length + 3); // + README.md, CHANGELOG.md, pi-extension/README.md
  const dangling: string[] = [];
  for (const member of shipped) {
    readFileSync(join(root, member), "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const raw = match[1]!;
        if (/^(?:https?|mailto):/i.test(raw)) {
          if (/github\.com\/zieglar\/pi-packages/i.test(raw)) dangling.push(`${member}:${index + 1} private-repo URL ${raw}`);
          continue;
        }
        const target = raw.split("#")[0]!;
        if (!target) continue; // in-document anchor
        const resolved = resolve("/", member, "..", target).slice(1);
        if (!members.has(resolved)) dangling.push(`${member}:${index + 1} -> ${raw} (${resolved} not shipped)`);
      }
    });
  }
  expect(dangling).toEqual([]);
});
it.each(["LICENSE", "dist", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js"])("author validator fails closed with missing %s", (missing) => {
  const dir = fixture(); rmSync(join(dir, missing), { recursive: true, force: true });
  const result = spawnSync(process.execPath, [join(dir, "scripts/package-pi-extension.mjs"), "--validate-only"], { cwd: dir, encoding: "utf8", env: npmEnv(dir) });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Incomplete Pi payload");
});
it("fails closed when the runtime-URL-resolved offline client asset is missing on disk", () => {
  const dir = fixture(); rmSync(join(dir, "dist/tunnel/offline-client.js"));
  const result = runValidator(dir, "--validate-only");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dist/tunnel/offline-client.js");
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
  const result = runValidator(dir, join(dir, "out"));
  expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(join(dir, "out"))).toEqual([archiveName]);
});
it.each(["native/tunnel-keychain.swift", "scripts/recover-stale-ownership.mjs", "scripts/reconcile-session-process-mutex.mjs", "CHANGELOG.md", "docs/releases/0.2.0.md", "docs/architecture.md", "docs/native-sqlite.md", "docs/tunnel-manager-background.md", "docs/protocol-v2.md", "docs/ownership-contract.md", "docs/storage-contract.md", "docs/delivery-ack-contract.md", "docs/storage-security.md"])("refuses native pack excluding required %s despite disk presence", (missing) => {
  const dir = fixture();
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  manifest.files = manifest.files.filter((path: string) => path !== missing);
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const result = runValidator(dir, join(dir, "out"));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(`native pack excludes ${missing}`);
  expect(readdirSync(join(dir, "out"))).toEqual([]);
});
it("refuses a native pack that excludes the runtime-URL offline client asset", () => {
  const dir = fixture();
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  manifest.files = [...manifest.files.filter((path: string) => path !== "dist/**/*.js"), "dist/**/*.js", "!dist/tunnel/offline-client.js"];
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  const result = runValidator(dir, join(dir, "out"));
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("dist/tunnel/offline-client.js");
  expect(readdirSync(join(dir, "out"))).toEqual([]);
});
it("author validator accepts complete outputs without consumer hooks", () => {
  const dir = fixture();
  const result = runValidator(dir, "--validate-only");
  expect(result.status, result.stderr).toBe(0);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const hook of ["prepare", "prepack", "postpack", "preinstall", "install", "postinstall"])
    expect(manifest.scripts[hook]).toBeUndefined();
});
