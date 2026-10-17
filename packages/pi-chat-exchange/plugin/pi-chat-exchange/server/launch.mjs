#!/usr/bin/env node
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { resolveLauncherConfigPath } from "./launch-config.mjs";

import { debugEvent, errorSummary } from "./dist/control/debug-log.js";

debugEvent("launcher", "LAUNCH_STARTED");
debugEvent("launcher", "NODE_RESOLVED", { stage: "process.execPath" });
debugEvent("launcher", "NODE_VERSION", { version: process.version });
process.on("exit", (exitCode) => debugEvent("launcher", "LAUNCH_EXITED", { exitCode }));
process.on("uncaughtExceptionMonitor", (error, origin) => debugEvent("launcher", origin === "unhandledRejection" ? "UNHANDLED_REJECTION" : "UNCAUGHT_EXCEPTION", { ...errorSummary(error), origin }));
const pluginRoot = join(import.meta.dirname, "..");
const entrypoint = join(pluginRoot, "server", "dist", "bin", "mcp-stdio.js");
let configPath;
try {
  configPath = resolveLauncherConfigPath(process.argv.slice(2), userInfo().homedir);
} catch {
  debugEvent("launcher", "LAUNCH_FAILED", { stage: "config-validation" });
  console.error("CE_PLUGIN_LAUNCH_INVALID");
  process.exit(1);
}
debugEvent("launcher", "SERVER_EXEC_STARTED");
const child = spawn(process.execPath, [entrypoint, "--config", configPath], {
  cwd: pluginRoot,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { debugEvent("launcher", "PROCESS_SIGNAL", { signal }); child.kill(signal); });
}

child.once("error", () => {
  debugEvent("launcher", "LAUNCH_FAILED", { stage: "spawn" });
  console.error("CE_PLUGIN_LAUNCH_FAILED");
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  debugEvent("launcher", "SERVER_EXITED", { exitCode: code, signal });
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
