import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import { it } from "vitest";

// Separate explicit lane: never install dependencies or launch a host by default.
if (process.env.CE_DISTRIBUTION_HOST_TEST !== "1")
  throw new Error("Use test:distribution-host with CE_DISTRIBUTION_ARCHIVE and CE_DISTRIBUTION_NPM_CLI; this lane never silently skips");
it("installs the native archive and exercises real Pi first-run on an isolated PTY", () => {
  const archive = process.env.CE_DISTRIBUTION_ARCHIVE;
  const npm = process.env.CE_DISTRIBUTION_NPM_CLI;
  if (process.platform !== "darwin" || !archive || !npm || !existsSync(archive) || !existsSync(npm))
    throw new Error("Requires macOS sandbox-exec, Python3, native archive and npm CLI absolute paths; the installed candidate qualifies the selected Node");
  const mode = process.env.CE_DISTRIBUTION_MODE ?? "tarball";
  if (!["tarball", "managed-npm"].includes(mode)) throw new Error("Unknown distribution mode");
  execFileSync("/usr/bin/python3", ["-B", new URL("./support/installed-host.py", import.meta.url).pathname, process.execPath, npm, archive, mode], {
    stdio: "inherit", timeout: 420_000,
  });
}, 430_000);
