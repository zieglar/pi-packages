import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializeStore, openStore, openMigratedStore } from "../../src/storage/store.js";
import { readRuntimeIdentity, RuntimeEligibilityError } from "../../src/storage/runtime.js";
import { migrateStore } from "../../src/storage/migration.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";

const roots: string[] = [];
function location() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-runtime-admission-"));
  roots.push(root);
  return { directory: join(root, "untouched"), filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The existing constructor-only identity seam is not a production setting.
describe("runtime refusal precedes all Store path preparation", () => {
  it.each(["initialize", "open", "migrated", "migration", "recovery"] as const)("%s refuses before creating a directory", (operation) => {
    const options = { ...location(), runtimeIdentity: () => ({ ...readRuntimeIdentity(), nodeVersion: "v25.2.1" }) };
    const invoke = () => operation === "initialize" ? initializeStore(options)
      : operation === "open" ? openStore(options) : operation === "migrated" ? openMigratedStore(options, "v7")
      : operation === "migration" ? migrateStore({ ...options, fromVersion: 1, toVersion: 2 }) : recoverTrustRoot(options);
    try {
      expect(invoke).toThrow(RuntimeEligibilityError);
      expect(existsSync(options.directory)).toBe(false);
    } finally { expect(existsSync(options.directory)).toBe(false); }
  });
});

// Qualification runs supply the actual unsupported binary explicitly. Never discover through PATH.
const unsupportedNode = process.env.CE_TEST_UNAPPROVED_NODE;
describe.skipIf(unsupportedNode === undefined)("actual unsupported runtime refuses with spoofed environment", () => {
  it.each(["initializeStore", "openStore", "openMigratedStore", "preflightStoreShape"])("%s has zero path side effects", (operation) => {
    const options = location();
    const moduleUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
    const loader = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
    const source = `
      const { ${operation}: operation } = await import(${JSON.stringify(moduleUrl)});
      const options = ${JSON.stringify(options)};
      let error;
      try { operation(${operation === "preflightStoreShape" ? "options.directory + '/store.sqlite'" : "options"}${operation === "openMigratedStore" ? ", 'v7'" : ""}); }
      catch (caught) { error = caught; }
      process.stdout.write(JSON.stringify({version:process.version, code:error?.code}));
    `;
    const result = JSON.parse(execFileSync(unsupportedNode!, ["--import", loader, "--input-type=module", "-e", source], {
      env: { PATH: "/usr/bin:/bin", CE_NODE_VERSION: "v24.21.0", NODE_VERSION: "v24.22.1" },
      encoding: "utf8", timeout: 10_000, maxBuffer: 16_384,
    })) as { version: string; code?: string };
    expect(result.version).toMatch(/^v25\./);
    expect(result.code).toBe("STORAGE_RUNTIME_INELIGIBLE");
    expect(existsSync(options.directory)).toBe(false);
  });
});
