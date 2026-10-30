#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
const sourceRoot = resolve(packageRoot, "plugin/pi-chat-exchange");
const outputRoot = resolve(packageRoot, ".plugin-build");
const deployRoot = mkdtempSync(resolve(tmpdir(), "pi-chat-exchange-deploy-"));
process.on("exit", () => rmSync(deployRoot, { recursive: true, force: true }));
const stagedRoot = resolve(outputRoot, "pi-chat-exchange");
const marketplaceRoot = resolve(outputRoot, "marketplace");
const sourcePackage = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
const pluginManifest = JSON.parse(readFileSync(resolve(sourceRoot, "plugin.json"), "utf8"));
if (pluginManifest.version !== sourcePackage.version) {
  throw new Error("plugin version must match package version");
}
const archivePath = resolve(outputRoot, `pi-chat-exchange-${pluginManifest.version}.zip`);
const allowedPluginSourceFiles = [
  "README.md",
  "README.zh-CN.md",
  "config/binding.example.json",
  "mcp.json",
  "plugin.json",
  "server/configure.mjs",
  "server/launch-config.mjs",
  "server/launch.mjs",
];

function reset(path) {
  if (relative(outputRoot, path).startsWith("..")) throw new Error("refusing path outside output root");
  rmSync(path, { recursive: true, force: true });
}

function walk(root, relativePath = "") {
  for (const name of readdirSync(resolve(root, relativePath))) {
    const next = relativePath === "" ? name : `${relativePath}/${name}`;
    const stat = lstatSync(resolve(root, next));
    if (stat.isSymbolicLink()) throw new Error(`packaged symlink refused: ${next}`);
    if (stat.isDirectory()) walk(root, next);
  }
}

function collectFiles(root, relativePath = "") {
  const files = [];
  for (const name of readdirSync(resolve(root, relativePath))) {
    const next = relativePath === "" ? name : `${relativePath}/${name}`;
    const stat = lstatSync(resolve(root, next));
    if (stat.isSymbolicLink()) throw new Error(`plugin source symlink refused: ${next}`);
    if (stat.isDirectory()) files.push(...collectFiles(root, next));
    else files.push(next);
  }
  return files;
}

const actualPluginSourceFiles = collectFiles(sourceRoot).sort();
if (JSON.stringify(actualPluginSourceFiles) !== JSON.stringify(allowedPluginSourceFiles)) {
  throw new Error(`unexpected plugin source files: ${actualPluginSourceFiles.join(",")}`);
}

mkdirSync(outputRoot, { recursive: true });
reset(stagedRoot);
reset(marketplaceRoot);
rmSync(archivePath, { force: true });

execFileSync("pnpm", ["run", "build"], { cwd: packageRoot, stdio: "inherit" });
execFileSync(
  "pnpm",
  [
    "--dir",
    workspaceRoot,
    "--filter",
    "@zieglar/pi-chat-exchange",
    "deploy",
    "--prod",
    "--legacy",
    "--ignore-scripts",
    "--offline",
    "--node-linker=hoisted",
    deployRoot,
  ],
  { cwd: workspaceRoot, stdio: "inherit" },
);

for (const relativePath of allowedPluginSourceFiles) {
  const destination = resolve(stagedRoot, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(resolve(sourceRoot, relativePath), destination, { dereference: true });
}
const stagedServer = resolve(stagedRoot, "server");
mkdirSync(stagedServer, { recursive: true });
cpSync(resolve(packageRoot, "dist"), resolve(stagedServer, "dist"), {
  recursive: true,
  dereference: true,
});
cpSync(resolve(deployRoot, "node_modules"), resolve(stagedServer, "node_modules"), {
  recursive: true,
  dereference: true,
  // Hoisted deploys contain the actual runtime packages outside this private
  // mirror. Skip it before dereferencing/copying to avoid shipping them twice.
  filter: (source) => source !== resolve(deployRoot, "node_modules/.pnpm"),
});
rmSync(resolve(stagedServer, "node_modules/.bin"), { recursive: true, force: true });
// Never ship development-only host SDK/type packages in the plugin server. The
// R5 Lane B fix moved the Pi key-protocol seam into `pi-extension/` (loaded by
// the host, not bundled), so `src/` no longer imports `@earendil-works/*`; these
// pruned packages were previously dragged in only to satisfy type-check peers.
const PRUNED_DEV_PACKAGES = new Set(["@earendil-works/pi-coding-agent", "@types/node"]);
const nm = resolve(stagedServer, "node_modules");
for (const scopeOrName of readdirSync(nm)) {
  const scopeDir = resolve(nm, scopeOrName);
  if (scopeOrName.startsWith("@")) {
    for (const name of readdirSync(scopeDir)) {
      if (PRUNED_DEV_PACKAGES.has(`${scopeOrName}/${name}`)) rmSync(resolve(scopeDir, name), { recursive: true, force: true });
    }
  } else if (PRUNED_DEV_PACKAGES.has(scopeOrName)) {
    rmSync(scopeDir, { recursive: true, force: true });
  }
}
// Deployment metadata records the ephemeral deploy tmpdir — an absolute host
// path. The private mirror (including its lockfile) was excluded at copy time.
rmSync(resolve(nm, ".modules.yaml"), { force: true });

writeFileSync(
  resolve(stagedServer, "package.json"),
  `${JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: sourcePackage.type,
    engines: sourcePackage.engines,
    dependencies: sourcePackage.dependencies,
  }, undefined, 2)}\n`,
);

walk(stagedRoot);
mkdirSync(resolve(marketplaceRoot, "plugins"), { recursive: true });
cpSync(stagedRoot, resolve(marketplaceRoot, "plugins/pi-chat-exchange"), {
  recursive: true,
  dereference: true,
});
writeFileSync(
  (() => {
    const manifestPath = resolve(marketplaceRoot, ".agents/plugins/marketplace.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    return manifestPath;
  })(),
  `${JSON.stringify({
    name: "pi-chat-exchange-local",
    interface: { displayName: "Pi Chat Exchange Local" },
    plugins: [{
      name: "pi-chat-exchange",
      source: { source: "local", path: "./plugins/pi-chat-exchange" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  }, undefined, 2)}\n`,
);
walk(marketplaceRoot);
execFileSync("/usr/bin/zip", ["-X", "-q", "-r", archivePath, basename(stagedRoot)], {
  cwd: dirname(stagedRoot),
  stdio: "inherit",
});

console.log(archivePath);
