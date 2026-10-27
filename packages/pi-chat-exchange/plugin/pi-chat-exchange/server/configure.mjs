import { resolve } from "node:path";
import { configureDesktopManifest } from "./dist/runtime/desktop-manifest.js";

try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--node") throw new Error("invalid arguments");
  configureDesktopManifest(resolve(import.meta.dirname, ".."), args[1]);
  console.log("CE_DESKTOP_CONFIGURED: local copy only; do not redistribute this machine-specific manifest");
} catch {
  console.error("CE_DESKTOP_CONFIG_INVALID: use a fresh private local plugin copy and --node /trusted/absolute/path/to/node (approved Node 24.21.0 or 24.22.1); no installation or registration performed");
  process.exitCode = 1;
}
