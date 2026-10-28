import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Explicit actual binaries only. These test inputs never override production policy.
const refusedNodes = [
  { path: process.env.CE_TEST_WAL_UNSAFE_NODE_A, sqlite: "3.50.4", reason: /WAL.reset/i },
  { path: process.env.CE_TEST_WAL_UNSAFE_NODE_B, sqlite: "3.50.4", reason: /WAL.reset/i },
  { path: process.env.CE_TEST_NATIVE_UNSAFE_NODE_A, sqlite: "3.53.3", reason: /native transaction-close crash/ },
  { path: process.env.CE_TEST_NATIVE_UNSAFE_NODE_B, sqlite: "3.51.3", reason: /native transaction-close crash/ },
].filter((candidate): candidate is { path: string; sqlite: string; reason: RegExp } => typeof candidate.path === "string" && candidate.path.length > 0);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(refusedNodes.length === 0)("actual known-defect runtimes refuse before persistent path preparation", () => {
  for (const { path: node, sqlite, reason } of refusedNodes) {
    it.each(["initializeStore", "openStore", "openMigratedStore", "migrateStore", "recoverTrustRoot"])(`%s refuses affected runtime in ${node}`, (operation) => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-wal-runtime-refusal-"));
      roots.push(root);
      const options = { directory: join(root, "untouched"), filename: "store.sqlite" };
      const source = `
        const { readRuntimeIdentity } = await import(${JSON.stringify(new URL("../../src/storage/runtime.ts", import.meta.url).href)});
        const module = ${JSON.stringify(operation === "migrateStore" ? "migration" : operation === "recoverTrustRoot" ? "recovery" : "store")};
        const { [${JSON.stringify(operation)}]: operation } = await import(new URL(module + '.ts', ${JSON.stringify(new URL("../../src/storage/", import.meta.url).href)}));
        const identity = readRuntimeIdentity();
        let refusal;
        try { operation(${JSON.stringify(options)}${operation === "openMigratedStore" ? ", 'v7'" : ""}); }
        catch (error) { refusal = { code: error.code, message: error.message }; }
        console.log(JSON.stringify({ node: process.version, sqlite: identity.sqliteVersion, refusal }));
      `;
      const result = JSON.parse(execFileSync(node, ["--import", fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url)), "--input-type=module", "-e", source], {
        env: { PATH: "/usr/bin:/bin", CE_NODE_VERSION: "v24.21.0", NODE_VERSION: "v24.22.1" },
        encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
      })) as { node: string; sqlite: string; refusal?: { code: string; message: string } };
      expect(result.sqlite).toBe(sqlite);
      expect(result.refusal?.code).toBe("STORAGE_RUNTIME_INELIGIBLE");
      expect(result.refusal?.message).toMatch(reason);
      expect(existsSync(options.directory)).toBe(false);
    });
  }
});
