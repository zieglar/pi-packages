/**
 * HANDOFF-CE-RELEASE-READINESS-01 REWORK-01 B0 — regression: the DEFAULT
 * `pnpm test` lane must never depend on the externally installed
 * `/opt/homebrew/bin/tunnel-client` binary, so a clean machine (CI-equivalent)
 * runs the default suite green without it. The two installed-client test files
 * keep an explicit, separately invoked lane (`pnpm run test:installed-client`),
 * and `offline.integration.test.ts` must fail LOUDLY when the client is absent
 * instead of silently skipping or hanging on a missing binary.
 *
 * REWORK-01 remediation adds the runtime dimension: the default lane script
 * sets CE_DEFAULT_CLIENT_GUARD=1 and a vitest setup file wraps child_process so
 * a forbidden tunnel-client spawn throws BEFORE process creation. Round 2 pins
 * the guard's LANE ISOLATION: vitest 4.1.11 hoists the setup file's nested
 * vi.mock out of its enclosing condition, so the wrapper is registered in
 * EVERY vitest lane that loads the setup file; isolation comes from the wrapper
 * consulting the env AT CALL TIME, which makes it a pass-through whenever
 * CE_DEFAULT_CLIENT_GUARD !== "1". The probes below prove both directions with
 * synthetic sentinels only:
 *   (i)   env-set plain-Node child + install(): a tunnel-client spawn is
 *         refused before process creation (fixed GUARD_MESSAGE, no ran-marker);
 *   (ii)  env-unset plain-Node child + install(): an EXECUTABLE tunnel-client
 *         sentinel runs (marker written) — registration without activation is
 *         a pass-through;
 *   (iii) this default-collected file's ORDINARY top-level
 *         `import { spawnSync } from "node:child_process"` is intercepted by
 *         the setupFiles/mock path (GUARD_MESSAGE fires);
 *   (iv)  a vitest child lane WITHOUT the env (its own minimal config loading
 *         this package's guard setup file) may spawn the executable sentinel.
 * The real installed client binary is never touched or executed by this file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GUARD_MESSAGE } from "../support/default-client-guard.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The two files that need the installed client. Every assertion below uses
 *  this exact list so a rename cannot silently loosen the isolation. */
const INSTALLED_CLIENT_TEST_FILES = [
  "test/tunnel/real-client-compat.test.ts",
  "test/tunnel/offline.integration.test.ts",
] as const;

/** HANDOFF-CE-RELEASE-READINESS-01 phase 3: the real-PTY crash-recovery lane is
 * excluded from the default `pnpm test` for a different reason — it drives the
 * real Pi CLI on a real pseudo-terminal for minutes and must never enter a
 * clean-machine default gate. Pinning it here keeps every default exclusion
 * explicit and reviewed instead of silently accumulating. */
const HOST_REGRESSION_TEST_FILE = "test/host-regression/real-host-recovery.test.ts" as const;

/** Distribution-fix Task 2: the installed-distribution heavy lane is excluded
 *  from the default `pnpm test` for the same clean-machine reason as the
 *  real-host lane — it npm-installs the private tarball plus an independent
 *  Pi host from the network and drives a real PTY first-run (minutes, registry
 *  access). It keeps its own loud opt-in precheck (CE_DISTRIBUTION_HOST_TEST)
 *  in `pnpm run test:distribution-host`; pinning the exclusion here keeps it
 *  explicit and reviewed, exactly like the real-host lane above. */
const DISTRIBUTION_HOST_TEST_FILE = "test/package/installed-host.test.ts" as const;
const DEFAULT_EXCLUDED_TEST_FILES = [...INSTALLED_CLIENT_TEST_FILES, HOST_REGRESSION_TEST_FILE, DISTRIBUTION_HOST_TEST_FILE] as const;

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const offlineGuardSource = readFileSync(join(packageRoot, "test/tunnel/offline.integration.test.ts"), "utf8");
const hostRegressionSource = existsSync(join(packageRoot, HOST_REGRESSION_TEST_FILE))
  ? readFileSync(join(packageRoot, HOST_REGRESSION_TEST_FILE), "utf8")
  : "";

/** Read a wiring file if present so a missing file fails the assertion, not collection. */
const readIfPresent = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

const probeDirs: string[] = [];
afterEach(() => { for (const dir of probeDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A synthetic sentinel NAMED tunnel-client plus a ran-marker in a fresh temp
 *  dir — NEVER the real installed client. Non-executable sentinels cannot run
 *  at all; executable ones write the marker and exit 42 when run. */
function sentinelFixture(executable: boolean): { sentinel: string; ranMarker: string } {
  const dir = mkdtempSync(join(tmpdir(), "ce-guard-probe-"));
  probeDirs.push(dir);
  const sentinel = join(dir, "tunnel-client");
  const ranMarker = join(dir, "sentinel-ran");
  writeFileSync(sentinel, `#!/bin/sh\nprintf ran > ${JSON.stringify(ranMarker)}\nexit 42\n`, { mode: executable ? 0o755 : 0o644 });
  return { sentinel, ranMarker };
}

describe("default test lane is isolated from the installed tunnel-client", () => {
  it("excludes exactly the installed-client files, the real-host lane and the distribution heavy lane, and sets the guard env on the default `pnpm test`", () => {
    expect(manifest.scripts.test).toBe(
      `CE_DEFAULT_CLIENT_GUARD=1 vitest run${DEFAULT_EXCLUDED_TEST_FILES.map((file) => ` --exclude ${file}`).join("")}`,
    );
  });

  it("keeps an explicit opt-in real-host lane that sets its own opt-in variable", () => {
    expect(manifest.scripts["test:host-regression"]).toBe(
      `CE_HOST_REGRESSION_TEST=1 vitest run ${HOST_REGRESSION_TEST_FILE}`,
    );
  });

  it("guards the real-host lane with a loud opt-in precheck instead of a skip", () => {
    expect(existsSync(join(packageRoot, HOST_REGRESSION_TEST_FILE)), `${HOST_REGRESSION_TEST_FILE} must exist`).toBe(true);
    for (const literal of [
      'process.env.CE_HOST_REGRESSION_TEST === "1"',
      "if (!laneEnabled) {",
      "throw new Error(",
      "pnpm run test:host-regression",
      "excluded from the default",
      "setup error, not a skip",
    ]) {
      expect(
        hostRegressionSource.includes(literal),
        `${HOST_REGRESSION_TEST_FILE} must keep the loud opt-in guard (missing literal: ${JSON.stringify(literal)})`,
      ).toBe(true);
    }
    // An availability/env skipIf would silently hide a missing prerequisite
    // instead of failing this opt-in lane loudly.
    expect(hostRegressionSource.includes("skipIf")).toBe(false);
    expect(hostRegressionSource.includes("runIf")).toBe(false);
  });

  it("keeps an explicit installed-client lane referencing exactly those two files", () => {
    expect(manifest.scripts["test:installed-client"]).toBe(
      `vitest run ${INSTALLED_CLIENT_TEST_FILES[0]} ${INSTALLED_CLIENT_TEST_FILES[1]}`,
    );
  });

  it("still ships both installed-client test files (exclusion must not delete coverage)", () => {
    for (const file of INSTALLED_CLIENT_TEST_FILES) {
      expect(
        existsSync(join(packageRoot, file)),
        `${file} must exist; the default exclusion must not remove the file`,
      ).toBe(true);
    }
  });

  it("guards offline.integration.test.ts with a loud client-availability precheck", () => {
    for (const literal of [
      "const clientAvailable = existsSync(CLIENT);",
      "if (!clientAvailable)",
      "throw new Error(",
      "pnpm run test:installed-client",
    ]) {
      expect(
        offlineGuardSource.includes(literal),
        `offline.integration.test.ts must keep the availability guard (missing literal: ${JSON.stringify(literal)})`,
      ).toBe(true);
    }
    // An availability skipIf would silently hide a missing client instead of
    // failing this opt-in lane loudly.
    expect(offlineGuardSource.includes("skipIf")).toBe(false);
  });

  it("wires a vitest config whose only test setting is the guard setup file", () => {
    const source = readIfPresent(join(packageRoot, "vitest.config.ts"));
    expect(source, "vitest.config.ts must exist at the package root").toBeDefined();
    // The config must not restate the CLI exclusions: they stay pinned in the
    // package.json script so the two contracts cannot silently diverge.
    expect(source).toContain('setupFiles: ["test/support/default-client-guard.ts"]');
    expect(source).not.toContain("--exclude");
  });

  it("pins the guard module's closed activation and forbidden-target contract", () => {
    const source = readIfPresent(join(packageRoot, "test/support/default-client-guard.ts"));
    expect(source, "test/support/default-client-guard.ts must exist").toBeDefined();
    for (const literal of [
      'CE_DEFAULT_CLIENT_GUARD === "1"',
      "export function install()",
      '"/opt/homebrew/bin/tunnel-client"',
      'basename(command) === "tunnel-client"',
      '"spawn", "spawnSync", "execFile", "execFileSync"',
      // Per-call activation is the round-2 lane-isolation mechanism: the
      // wrapper consults the env AT CALL TIME, not at registration.
      "guardActive() && forbiddenTarget(command)",
    ]) {
      expect(
        source!.includes(literal),
        `default-client-guard.ts must keep the guard contract (missing literal: ${JSON.stringify(literal)})`,
      ).toBe(true);
    }
  });

  it("probe (i): with CE_DEFAULT_CLIENT_GUARD=1, install() refuses tunnel-client spawns before process creation", () => {
    const { sentinel, ranMarker } = sentinelFixture(false);
    const guardUrl = new URL("../support/default-client-guard.ts", import.meta.url).href;
    const probe = `
      const { install } = await import(${JSON.stringify(guardUrl)});
      install();
      // Imported only after install(): ESM named imports of node builtins
      // snapshot at first import per realm, so the patch must be in place first.
      const cp = await import("node:child_process");
      const out = {};
      for (const name of ["spawnSync", "execFileSync"]) {
        try { cp[name](process.argv[1], []); out[name] = "no-throw"; } catch (e) { out[name] = e.message; }
      }
      const benign = cp.spawnSync("/bin/sh", ["-c", "exit 0"]);
      out.benign = benign && benign.status;
      console.log(JSON.stringify(out));
    `;
    const childEnv = { ...process.env, CE_DEFAULT_CLIENT_GUARD: "1" } as NodeJS.ProcessEnv;
    // The child is plain Node: strip the inherited VITEST marker so the guard's
    // vitest-only mock registration cannot fire without a mocker.
    delete childEnv.VITEST;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, sentinel], { encoding: "utf8", env: childEnv });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out.spawnSync).toBe(GUARD_MESSAGE);
    expect(out.execFileSync).toBe(GUARD_MESSAGE);
    // Synthetic non-tunnel-client targets must keep spawning through the guard.
    expect(out.benign).toBe(0);
    expect(existsSync(ranMarker), "the sentinel named tunnel-client must never be executed").toBe(false);
  });

  it("probe (ii): without CE_DEFAULT_CLIENT_GUARD, install() passes an executable tunnel-client sentinel through", () => {
    const { sentinel, ranMarker } = sentinelFixture(true);
    const guardUrl = new URL("../support/default-client-guard.ts", import.meta.url).href;
    const probe = `
      const { install } = await import(${JSON.stringify(guardUrl)});
      install();
      const cp = await import("node:child_process");
      const r = cp.spawnSync(process.argv[1], []);
      console.log(JSON.stringify({ status: r.status, error: r.error ? String(r.error) : null }));
    `;
    const childEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete childEnv.CE_DEFAULT_CLIENT_GUARD;
    delete childEnv.VITEST;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, sentinel], { encoding: "utf8", env: childEnv });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout) as { status: number | null; error: string | null };
    // The wrapper is REGISTERED (install() ran) but the activation env is
    // absent, so the call must pass through: the sentinel EXECUTES.
    expect(out.error).toBeNull();
    expect(out.status).toBe(42);
    expect(existsSync(ranMarker), "an executable sentinel must run when the guard env is absent").toBe(true);
  });

  it("probe (iii): the default lane intercepts an ordinary top-level child_process import", () => {
    const { sentinel, ranMarker } = sentinelFixture(false);
    // This uses the module-top-level `import { spawnSync } from
    // "node:child_process"` above — no install() call, no env changes — proving
    // the setupFiles/mock path intercepts plain imports in the default lane. If
    // the guard were unwired, the non-executable spawn would EACCES without a
    // marker: still a loud failure, never executing anything real.
    expect(() => spawnSync(sentinel, [])).toThrow(GUARD_MESSAGE);
    expect(existsSync(ranMarker)).toBe(false);
  });

  it("probe (iv): a vitest child lane without CE_DEFAULT_CLIENT_GUARD is not blocked", { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-lane-probe-"));
    probeDirs.push(dir);
    const sentinel = join(dir, "tunnel-client");
    const ranMarker = join(dir, "sentinel-ran");
    writeFileSync(sentinel, `#!/bin/sh\nprintf ran > ${JSON.stringify(ranMarker)}\nexit 42\n`, { mode: 0o755 });
    // A minimal config loading THIS package's guard setup file: the child lane
    // registers the hoisted child_process mock exactly like the installed-
    // client lane does — but without the guard env.
    writeFileSync(join(dir, "vitest.config.mts"), `export default { test: { setupFiles: [${JSON.stringify(join(packageRoot, "test/support/default-client-guard.ts"))}] } };\n`);
    writeFileSync(join(dir, "lane-probe.test.ts"), `
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
it("spawns the executable tunnel-client sentinel via an ordinary import", () => {
  const r = spawnSync(${JSON.stringify(sentinel)}, []);
  expect(r.error).toBeUndefined();
  expect(r.status).toBe(42);
});
`);
    const childEnv = { ...process.env } as NodeJS.ProcessEnv;
    delete childEnv.CE_DEFAULT_CLIENT_GUARD;
    const vitestEntry = join(packageRoot, "node_modules", "vitest", "vitest.mjs");
    const result = spawnSync(process.execPath, [vitestEntry, "run", "--root", dir, "lane-probe.test.ts"], { encoding: "utf8", env: childEnv });
    expect(result.status, `lane probe failed:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(existsSync(ranMarker), "the executable sentinel must run in a lane without the guard env").toBe(true);
  });
});
