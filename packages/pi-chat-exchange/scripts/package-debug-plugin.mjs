#!/usr/bin/env node
// DIAG-01: build an isolated derivative; never overwrite an existing artifact.
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
const argv = process.argv.slice(2);
if (argv.length !== 4 || argv[0] !== "--root" || argv[2] !== "--dependencies" || !argv[1].startsWith("/") || !argv[3].startsWith("/")) throw new Error("usage: --root /isolated-root --dependencies /existing/node_modules");
const root = realpathSync(argv[1]);
const dependencies = realpathSync(argv[3]);
if (root === homedir() || root === resolve(homedir(), ".codex") || root.startsWith(resolve(homedir(), ".codex") + sep)) throw new Error("production root refused");
const configPath = join(root, "mcp-config/binding.json");
function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("invalid debug packaging JSON"); }
}
if (realpathSync(configPath) !== configPath) throw new Error("linked config refused");
const config = readJson(configPath);
if (typeof config.store?.directory !== "string" || !resolve(config.store.directory).startsWith(root + sep)) throw new Error("Store must be isolated under root");
// Lexical containment alone is insufficient when an existing ancestor is linked.
let ancestor = resolve(config.store.directory);
while (ancestor !== root) {
  try {
    if (lstatSync(ancestor).isSymbolicLink() || realpathSync(ancestor) !== ancestor) throw new Error("linked Store ancestor refused");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  ancestor = dirname(ancestor);
}
const packageRoot = resolve(import.meta.dirname, "..");
const name = "pi-chat-exchange-gate-b1-debug";
const version = "0.1.0-debug.3";
const marketplace = join(root, "marketplace");
const output = join(marketplace, "plugins", name);
function noLinks(path) {
  if (lstatSync(path).isSymbolicLink()) throw new Error("symlink in input refused");
  if (lstatSync(path).isDirectory()) for (const entry of readdirSync(path)) noLinks(join(path, entry));
}
noLinks(join(packageRoot, "dist"));
noLinks(dependencies);
// mkdir without recursive at artifact boundary refuses any existing output.
mkdirSync(marketplace, { mode: 0o700 });
mkdirSync(join(marketplace, "plugins"), { mode: 0o700 });
mkdirSync(output, { mode: 0o700 });
for (const dir of ["server", "bin"]) mkdirSync(join(output, dir), { mode: 0o700 });
cpSync(join(packageRoot, "dist"), join(output, "server/dist"), { recursive: true });
cpSync(dependencies, join(output, "server/node_modules"), { recursive: true });
writeFileSync(join(output, "server/package.json"), JSON.stringify({ type: "module", private: true }));
cpSync(join(packageRoot, "plugin/pi-chat-exchange/server/launch-config.mjs"), join(output, "server/launch-config.mjs"));
const original = readFileSync(join(packageRoot, "plugin/pi-chat-exchange/server/launch.mjs"), "utf8");
const anchor = '[entrypoint, "--config", configPath]';
if (original.split(anchor).length !== 2) throw new Error("launcher projection anchor drift");
writeFileSync(join(output, "server/launch.mjs"), original.replace(anchor, '["--require", join(pluginRoot, "bin/version-guard.cjs"), entrypoint, "--config", configPath]'));
for (const file of ["launch", "version-guard.cjs"]) cpSync(join(packageRoot, "scripts/debug-plugin", file), join(output, "bin", file));
chmodSync(join(output, "bin/launch"), 0o700);
const plugin = readJson(join(packageRoot, "plugin/pi-chat-exchange/plugin.json"));
plugin.name = name; plugin.version = version;
plugin.extensions["com.openai"].interface.displayName = "Pi Chat Exchange Gate B1 Debug";
// No defaultPrompt change: discovery does not authorize invoking a tool.
writeFileSync(join(output, "plugin.json"), JSON.stringify(plugin, null, 2) + "\n");
writeFileSync(join(output, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [name]: { type: "stdio", command: "./bin/launch", args: ["--config", configPath], cwd: "${PLUGIN_ROOT}" } } }, null, 2) + "\n");
const manifest = join(marketplace, ".agents/plugins/marketplace.json");
mkdirSync(dirname(manifest), { recursive: true });
writeFileSync(manifest, JSON.stringify({ name: "pi-chat-exchange-gate-b1-debug-local", interface: { displayName: "Pi Chat Exchange Debug Local" }, plugins: [{ name, source: { source: "local", path: `./plugins/${name}` }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] }, null, 2) + "\n");
writeFileSync(join(output, "README.md"), `# ${name}\nDevelopment-only; always-on private JSONL diagnostics in server/.debug-logs/ce-debug-PID.jsonl. No stdout diagnostics, no environment switch. Strict Node v24.21.0 in both launcher and server. No business-tool permissions added.\n`);
console.error(`DEBUG_PLUGIN_BUILT ${output}`);
