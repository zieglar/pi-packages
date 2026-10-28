// Author-only: no lifecycle hook and no consumer compiler/workspace requirement.
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(detail) { throw new Error(`Incomplete Pi payload: ${detail}`); }
function regular(path) {
  try {
    let parent = dirname(path);
    while (parent !== root) {
      if (!parent.startsWith(root + "/") || !lstatSync(parent).isDirectory()) fail(relative(root, path));
      parent = dirname(parent);
    }
    if (!lstatSync(path).isFile()) fail(relative(root, path));
  } catch { fail(relative(root, path)); }
}
function walk(dir) {
  let entries;
  try {
    if (!lstatSync(dir).isDirectory()) fail(relative(root, dir));
    entries = readdirSync(dir);
  } catch { fail(relative(root, dir)); }
  return entries.flatMap((name) => {
    const path = join(dir, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`symlink ${relative(root, path)}`);
    return stat.isDirectory() ? walk(path) : [path];
  });
}
try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const hook of ["prepare", "prepack", "postpack", "preinstall", "install", "postinstall"])
    if (manifest.scripts?.[hook]) fail(`consumer lifecycle hook ${hook}`);
  const modules = [...walk(join(root, "dist")).filter((p) => p.endsWith(".js")),
    ...walk(join(root, "pi-extension")).filter((p) => p.endsWith(".ts"))];
  const required = ["LICENSE", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js", "dist/tunnel/offline-client.js", "pi-extension/index.ts", "native/tunnel-keychain.swift", "scripts/recover-stale-ownership.mjs", "scripts/reconcile-session-process-mutex.mjs", "CHANGELOG.md", "docs/releases/0.2.0.md",
    // Consumer-facing contract closure: public consumers must be able to operate
    // the package safely without access to the private repository.
    "docs/architecture.md", "docs/native-sqlite.md", "docs/tunnel-manager-background.md", "docs/protocol-v2.md", "docs/ownership-contract.md", "docs/storage-contract.md", "docs/delivery-ack-contract.md", "docs/storage-security.md"];
  for (const path of required)
    regular(join(root, path));
  for (const path of modules) {
    regular(path);
    const text = readFileSync(path, "utf8");
    // Relative static imports/re-exports/dynamic imports; type-only .js TS
    // references resolve to their local .ts source in the Pi loader. Runtime
    // asset references (`new URL("./x", import.meta.url)`) are validated the
    // same way so a URL-resolved module/asset can never be missing on disk.
    const specifiers = [...text.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)["'](\.[^"']+)["']/g)].map((m) => m[1]);
    for (const match of text.matchAll(/new\s+URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) specifiers.push(match[1]);
    for (const specifier of specifiers) {
      let target = resolve(dirname(path), specifier);
      if (!target.startsWith(root + "/")) fail(`escaping import ${specifier}`);
      if (path.endsWith(".ts") && target.endsWith(".js") && !target.includes("/dist/")) target = target.slice(0, -3) + ".ts";
      regular(target);
    }
  }
  if (process.argv[2] === "--validate-only") console.log("Pi payload validated");
  else {
    if (process.argv.length > 3) fail("usage: package-pi-extension.mjs [output-directory | --validate-only]");
    const out = resolve(process.argv[2] ?? join(root, ".pi-artifacts"));
    mkdirSync(out, { recursive: true });
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] };
    const inventory = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--dry-run"], options))[0].files;
    const allowed = /^(?:package\.json|README\.md|CHANGELOG\.md|docs\/releases\/0\.2\.0\.md|LICENSE(?:\.[^/]+)?|pi-extension\/[^/]+\.ts|pi-extension\/(?:README\.md|allowlist\.example\.json)|dist\/.+\.js|native\/tunnel-keychain\.swift|scripts\/(?:recover-stale-ownership|reconcile-session-process-mutex)\.mjs|docs\/(?:independent-install|tunnel-setup|multi-session-usage|chatgpt-installation|architecture|native-sqlite|tunnel-manager-background|protocol-v2|ownership-contract|storage-contract|delivery-ack-contract|storage-security)\.md)$/;
    for (const entry of inventory) if (!allowed.test(entry.path)) fail(`unexpected native pack entry ${entry.path}`);
    for (const path of [...modules.map((path) => relative(root, path)), ...required])
      if (!inventory.some((entry) => entry.path === path)) fail(`native pack excludes ${path}`);
    const packed = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], options);
    console.log(packed);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
