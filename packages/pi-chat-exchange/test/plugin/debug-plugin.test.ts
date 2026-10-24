import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
const root = resolve(import.meta.dirname, "../..");
const dirs: string[] = [];
function fixture() { const d = mkdtempSync(join(tmpdir(), "ce-debug-plugin-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function artifact() {
  const dir = fixture(); mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "server"));
  cpSync(join(root, "scripts/debug-plugin/version-guard.cjs"), join(dir, "bin/version-guard.cjs"));
  cpSync(join(root, "scripts/debug-plugin/launch"), join(dir, "bin/launch"));
  writeFileSync(join(dir, "server/launch.mjs"), "process.exit(0)");
  return dir;
}
it("guard logs pass and mismatch in-process without stdout, preserving fatal exit code", () => {
  const dir = artifact(); const guard = join(dir, "bin/version-guard.cjs");
  const ok = spawnSync(process.execPath, ["--require", guard, "-e", ""], { encoding: "utf8" });
  // The isolated debug derivative deliberately retains its own single-version pin.
  const approvedDebugRuntime = process.version === "v24.21.0";
  expect(ok.status).toBe(approvedDebugRuntime ? 0 : 78); expect(ok.stdout).toBe("");
  expect(ok.stderr).toContain(approvedDebugRuntime ? "VERSION_GUARD_PASSED" : "VERSION_GUARD_FAILED");
  const mismatch = spawnSync(process.execPath, ["-e", `Object.defineProperty(process,'version',{value:'v0.0.0'});require(${JSON.stringify(guard)});`], { encoding: "utf8" });
  expect(mismatch.status).toBe(78); expect(mismatch.stdout).toBe(""); expect(mismatch.stderr).toContain("VERSION_GUARD_FAILED");
  expect(readdirSync(join(dir, "server/.debug-logs")).length).toBeGreaterThan(0);
});
// Out of the production dual-runtime qualification: this derivative still pins 24.21.0.
it.skipIf(process.version !== "v24.21.0")("guard observes uncaught exceptions and rejections without swallowing their exits or logging secret messages", () => {
  const dir = artifact(); const guard = join(dir, "bin/version-guard.cjs");
  for (const [script, event] of [["throw new Error('SECRET_CANARY')", "UNCAUGHT_EXCEPTION"], ["Promise.reject(new Error('SECRET_CANARY'))", "UNHANDLED_REJECTION"]]) {
    const result = spawnSync(process.execPath, ["--require", guard, "-e", script!], { encoding: "utf8" });
    expect(result.status).toBe(1); expect(result.stdout).toBe("");
    const logs = readdirSync(join(dir, "server/.debug-logs")).map((n) => readFileSync(join(dir, "server/.debug-logs", n), "utf8")).join("");
    expect(logs).toContain(event!); expect(logs).not.toContain("SECRET_CANARY");
  }
});
it("shell launcher logs before Node and propagates mise failure without protocol stdout", () => {
  const dir = artifact(); const fake = join(dir, "mise");
  writeFileSync(fake, "#!/bin/sh\nexit 42\n", { mode: 0o700 });
  const launch = join(dir, "bin/launch");
  // Exact fixed executable substitution is confined to this temporary test artifact.
  writeFileSync(launch, readFileSync(launch, "utf8").replace("/opt/homebrew/bin/mise", fake), { mode: 0o700 });
  const result = spawnSync("/bin/sh", [launch], { encoding: "utf8" });
  expect(result.status).toBe(42); expect(result.stdout).toBe("");
  expect(result.stderr).toContain("LAUNCH_STARTED"); expect(result.stderr).toContain("LAUNCH_FAILED"); expect(result.stderr).toContain("LAUNCH_EXITED");
});
