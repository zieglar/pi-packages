// Author-only: no lifecycle hook and no consumer compiler/workspace requirement.
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function fail(detail) { throw new Error(`Incomplete Pi payload: ${detail}`); }
function regular(path, root) {
  try {
    let parent = dirname(path);
    while (parent !== root) {
      if (!parent.startsWith(root + "/") || !lstatSync(parent).isDirectory()) fail(relative(root, path));
      parent = dirname(parent);
    }
    if (!lstatSync(path).isFile()) fail(relative(root, path));
  } catch { fail(relative(root, path)); }
}
function walk(dir, root) {
  let entries;
  try {
    if (!lstatSync(dir).isDirectory()) fail(relative(root, dir));
    entries = readdirSync(dir);
  } catch { fail(relative(root, dir)); }
  return entries.flatMap((name) => {
    const path = join(dir, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`symlink ${relative(root, path)}`);
    return stat.isDirectory() ? walk(path, root) : [path];
  });
}
function cliNpm(args, cwd) {
  try { return { status: 0, stdout: execFileSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (error) { return { status: error.status ?? -1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") }; }
}

/** Build and validate the one tarball that may later be published. The returned
 * artifactPath is the only publishable payload; callers must not repack the root. */
export function buildPackageArtifact({ root = defaultRoot, out, run = cliNpm, validateOnly = false } = {}) {
  if (!validateOnly && out === undefined) fail("an explicit output directory is required");
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const hook of ["prepare", "prepack", "postpack", "preinstall", "install", "postinstall"])
      if (manifest.scripts?.[hook]) fail(`consumer lifecycle hook ${hook}`);
    const modules = [...walk(join(root, "dist"), root).filter((p) => p.endsWith(".js")),
      ...walk(join(root, "pi-extension"), root).filter((p) => p.endsWith(".ts"))];
    const required = ["README.md", "package.json", "LICENSE", "dist/bin/mcp-stdio.js", "dist/tunnel/multi-session-policy.js", "dist/tunnel/offline-client.js", "pi-extension/index.ts", "native/tunnel-keychain.swift", "scripts/recover-stale-ownership.mjs", "scripts/reconcile-session-process-mutex.mjs"];
    for (const path of required) regular(join(root, path), root);
    for (const path of modules) {
      regular(path, root);
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
        regular(target, root);
      }
    }
    if (validateOnly) return { validated: true };
    const output = resolve(out);
    mkdirSync(output, { recursive: true });
    const dryRun = run(["pack", "--ignore-scripts", "--json", "--dry-run"], root);
    if (dryRun.status !== 0) fail(`npm pack --dry-run failed: ${dryRun.stderr ?? dryRun.stdout}`);
    const inventory = JSON.parse(dryRun.stdout)[0].files.filter((entry) => entry.path !== "README.zh-CN.md");
    if (inventory.length === 0) fail("npm package content inventory is empty");
    const allowed = /^(?:package\.json|README\.md|LICENSE(?:\.[^/]+)?|pi-extension\/[^/]+\.ts|pi-extension\/allowlist\.example\.json|dist\/.+\.js|native\/tunnel-keychain\.swift|scripts\/(?:recover-stale-ownership|reconcile-session-process-mutex)\.mjs)$/;
    for (const entry of inventory) if (!allowed.test(entry.path)) fail(`native release or private files must not enter the npm payload: ${entry.path}`);
    for (const path of [...modules.map((path) => relative(root, path)), ...required])
      if (!inventory.some((entry) => entry.path === path)) fail(`native pack excludes ${path}`);
    // npm automatically includes root README variants despite the files allowlist.
    // Stage only the validated inventory so the Chinese guide stays on GitHub.
    const stage = mkdtempSync(join(tmpdir(), "ce-npm-stage-"));
    try {
      for (const entry of inventory) {
        const source = join(root, entry.path);
        regular(source, root);
        const target = join(stage, entry.path);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target);
      }
      const packed = run(["pack", "--ignore-scripts", "--json", "--pack-destination", output], stage);
      if (packed.status !== 0) fail(`staged npm pack failed: ${packed.stderr ?? packed.stdout}`);
      const report = JSON.parse(packed.stdout);
      const filename = report[0]?.filename;
      if (typeof filename !== "string" || !filename.endsWith(".tgz")) fail("npm pack returned no tarball filename");
      return { artifactPath: join(output, filename), inventory: inventory.map(entry => entry.path) };
    } finally { rmSync(stage, { recursive: true, force: true }); }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Incomplete Pi payload:")) throw error;
    fail(error instanceof Error ? error.message : String(error));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  try {
    if (process.argv[2] === "--validate-only") {
      // Preserve the existing author-side dry validation command.
      buildPackageArtifact({ validateOnly: true });
      console.log("Pi payload validated");
    } else {
      if (process.argv.length > 3) fail("usage: package-pi-extension.mjs [output-directory | --validate-only]");
      const out = resolve(process.argv[2] ?? join(defaultRoot, ".pi-artifacts"));
      console.log(JSON.stringify(buildPackageArtifact({ out }), null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
