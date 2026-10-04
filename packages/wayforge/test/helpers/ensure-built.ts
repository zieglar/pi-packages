import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared build-once guard for test files that need `dist/` (child-process
 * fixtures import compiled output). Concurrent vitest workers previously each
 * ran a full `tsc` build in `beforeAll`; under suite-wide load those
 * duplicated builds exceeded the default hook timeout. This helper keeps the
 * exact same guarantee — dist is freshly built from the current src — while
 * building once per repository: fresh dist returns immediately, the lock
 * holder builds, and other workers wait briefly for the fresh artifact
 * (falling back to building themselves if the holder vanished). No timeout
 * values are changed anywhere.
 */

function newestSrcMs(cwd: string): number {
  return Math.max(
    ...readdirSync(join(cwd, "src"), { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => statSync(join(cwd, "src", entry)).mtimeMs),
  );
}

function distFresh(cwd: string, srcNewest: number): boolean {
  const distEntry = join(cwd, "dist", "extension.js");
  return existsSync(distEntry) && statSync(distEntry).mtimeMs >= srcNewest;
}

export function ensureBuilt(): void {
  const cwd = process.cwd();
  const srcNewest = newestSrcMs(cwd);
  if (distFresh(cwd, srcNewest)) return;

  const lockPath = join(cwd, "node_modules", ".wayforge-test-build.lock");
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx");
  } catch {
    // Another worker holds the build lock: wait for its fresh artifact.
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (distFresh(cwd, srcNewest)) return;
      const lockGone = !existsSync(lockPath);
      if (lockGone && distFresh(cwd, srcNewest)) return;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
    if (distFresh(cwd, newestSrcMs(cwd))) return;
    execFileSync("npm", ["run", "build"], { cwd, stdio: "pipe" });
    return;
  }
  try {
    if (!distFresh(cwd, newestSrcMs(cwd))) {
      execFileSync("npm", ["run", "build"], { cwd, stdio: "pipe" });
    }
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}
