/**
 * HANDOFF-CE-RELEASE-READINESS-01 REWORK-01 B0 — regression: the DEFAULT
 * `pnpm test` lane must never depend on the externally installed
 * `/opt/homebrew/bin/tunnel-client` binary, so a clean machine (CI-equivalent)
 * runs the default suite green without it. The two installed-client test files
 * keep an explicit, separately invoked lane (`pnpm run test:installed-client`),
 * and `offline.integration.test.ts` must fail LOUDLY when the client is absent
 * instead of silently skipping or hanging on a missing binary.
 *
 * This test never spawns the client: it reads package.json and the guarded
 * test file from disk and asserts exact script/guard literals.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("default test lane is isolated from the installed tunnel-client", () => {
  it("excludes exactly the two installed-client files from the default `pnpm test`", () => {
    expect(manifest.scripts.test).toBe(
      `vitest run --exclude ${INSTALLED_CLIENT_TEST_FILES[0]} --exclude ${INSTALLED_CLIENT_TEST_FILES[1]}`,
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
});
