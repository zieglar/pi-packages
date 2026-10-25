import { defineConfig } from "vitest/config";

// Only the guard setup file is declared here. Test-file selection and the
// installed-client exclusions stay on the CLI (`pnpm test` / lanes) so this
// config cannot silently diverge from the pinned script contracts.
export default defineConfig({
  test: {
    setupFiles: ["test/support/default-client-guard.ts"],
  },
});
