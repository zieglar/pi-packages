import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import baseConfig from "../vitest.config.js";

/** Explicit isolated Rust lane: setup verifies the actual cached driver. */
export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    setupFiles: [
      "test/support/default-client-guard.ts",
      fileURLToPath(new URL("./support/dev-native-setup.ts", import.meta.url)),
    ],
  },
});
