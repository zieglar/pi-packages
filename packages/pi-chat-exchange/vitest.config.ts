import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Native is the production SQLite driver, so an absent selection file means Native. The
// default test lane runs the non-production node:sqlite compatibility driver, which must
// be chosen explicitly. This private HOME carries that explicit selection; the Rust lane
// (test/rust-native.vitest.config.ts) overrides it with the operator's verified HOME.
const compatHome = mkdtempSync(join(tmpdir(), "ce-vitest-node-sqlite-"));
// Keep the selection alive for subprocess tests, then remove only this invocation's HOME.
process.once("exit", () => rmSync(compatHome, { recursive: true, force: true }));
const selectionDirectory = join(compatHome, ".config", "pi-chat-exchange");
mkdirSync(selectionDirectory, { recursive: true, mode: 0o700 });
writeFileSync(join(selectionDirectory, "sqlite-driver.json"), `${JSON.stringify({ version: 1, driver: "node-sqlite" })}\n`, { mode: 0o600 });

// Test-file selection and the installed-client exclusions stay on the CLI
// (`pnpm test` / lanes) so this config cannot silently diverge from the pinned
// script contracts.
export default defineConfig({
  test: {
    // Release helper suites use node:test and run separately with node --test.
    include: ["**/*.test.ts"],
    setupFiles: ["test/support/default-client-guard.ts"],
    env: { HOME: compatHome },
  },
});
