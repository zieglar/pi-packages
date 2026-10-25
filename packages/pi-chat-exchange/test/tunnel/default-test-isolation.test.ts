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
 * sets CE_DEFAULT_CLIENT_GUARD=1, a vitest setup file wraps child_process so a
 * forbidden tunnel-client spawn throws BEFORE process creation, and a runtime
 * probe proves the guard blocks a synthetic sentinel NAMED tunnel-client while
 * benign synthetic spawns keep working. The real installed client binary is
 * never touched or executed by this file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

/** The two files that need the installed client. Every assertion below uses
 *  this exact list so a rename cannot silently loosen the isolation. */
const INSTALLED_CLIENT_TEST_FILES = [
  "test/tunnel/real-client-compat.test.ts",
  "test/tunnel/offline.integration.test.ts",
] as const;

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const offlineGuardSource = readFileSync(join(packageRoot, "test/tunnel/offline.integration.test.ts"), "utf8");

/** Read a wiring file if present so a missing file fails the assertion, not collection. */
const readIfPresent = (path: string): string | undefined => {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
};

const probeDirs: string[] = [];
afterEach(() => { for (const dir of probeDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("default test lane is isolated from the installed tunnel-client", () => {
  it("excludes exactly the two installed-client files and sets the guard env on the default `pnpm test`", () => {
    expect(manifest.scripts.test).toBe(
      `CE_DEFAULT_CLIENT_GUARD=1 vitest run --exclude ${INSTALLED_CLIENT_TEST_FILES[0]} --exclude ${INSTALLED_CLIENT_TEST_FILES[1]}`,
    );
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
    ]) {
      expect(
        source!.includes(literal),
        `default-client-guard.ts must keep the guard contract (missing literal: ${JSON.stringify(literal)})`,
      ).toBe(true);
    }
  });

  it("runtime probe: install() blocks tunnel-client spawns before process creation and passes benign spawns through", () => {
    const probeDir = mkdtempSync(join(tmpdir(), "ce-guard-probe-"));
    probeDirs.push(probeDir);
    const sentinel = join(probeDir, "tunnel-client");
    const ranMarker = join(probeDir, "sentinel-ran");
    // A synthetic sentinel NAMED tunnel-client: the guard must throw before
    // process creation, so the sentinel is never executed. If it ever ran, it
    // would create ranMarker and exit 42.
    writeFileSync(sentinel, `#!/bin/sh\nprintf ran > ${JSON.stringify(ranMarker)}\nexit 42\n`, { mode: 0o755 });
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
    const childEnv = { ...process.env } as NodeJS.ProcessEnv;
    // The probe tests install() directly in a plain Node realm; the lane-level
    // env activation (which registers the vitest mock) must not fire here.
    delete childEnv.CE_DEFAULT_CLIENT_GUARD;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, sentinel], { encoding: "utf8", env: childEnv });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const out = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(out.spawnSync).toContain("CE default test lane isolation guard");
    expect(out.execFileSync).toBe(out.spawnSync);
    // Synthetic fixtures must keep spawning through the guard untouched.
    expect(out.benign).toBe(0);
    expect(existsSync(ranMarker), "the sentinel named tunnel-client must never be executed").toBe(false);
  });
});
