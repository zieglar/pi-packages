#!/usr/bin/env node
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { resolveLauncherConfigPath } from "./launch-config.mjs";

const pluginRoot = join(import.meta.dirname, "..");
const entrypoint = join(pluginRoot, "server", "dist", "bin", "mcp-stdio.js");
let configPath;
try {
  configPath = resolveLauncherConfigPath(process.argv.slice(2), userInfo().homedir);
} catch {
  console.error("CE_PLUGIN_LAUNCH_INVALID");
  process.exit(1);
}
const child = spawn(process.execPath, [entrypoint, "--config", configPath], {
  cwd: pluginRoot,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", () => {
  console.error("CE_PLUGIN_LAUNCH_FAILED");
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
