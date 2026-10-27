import fs from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { finishRun, prepareRoot } from "./support/harness.mjs";

for (const mode of ["success", "test-failure", "keep", "driver-failure", "provider-failure"] as const) {
  it(`awaits both cleanup operations and applies evidence retention: ${mode}`, async () => {
    const paths = prepareRoot();
    const order: string[] = [];
    const driver = { stop: async () => {
      expect(fs.existsSync(paths.root)).toBe(true);
      order.push("driver-reaped");
      if (mode === "driver-failure") throw new Error("injected driver cleanup failure");
    } };
    const provider = { close: async () => {
      await new Promise((done) => setTimeout(done, 10));
      expect(order).toEqual(["driver-reaped"]);
      expect(fs.existsSync(paths.root)).toBe(true);
      order.push("provider-closed");
      if (mode === "provider-failure") throw new Error("injected provider cleanup failure");
    } };
    const cleanup = finishRun(paths, driver, provider, { successful: mode !== "test-failure", keep: mode === "keep" });
    if (mode.endsWith("failure") && mode !== "test-failure") {
      await expect(cleanup).rejects.toThrow("cleanup failed; evidence retained");
    } else {
      await expect(cleanup).resolves.toEqual({ retained: mode !== "success" });
    }
    expect(order).toEqual(["driver-reaped", "provider-closed"]);
    expect(fs.existsSync(paths.root)).toBe(mode !== "success");
    if (mode !== "success") {
      const record = JSON.parse(fs.readFileSync(join(paths.raw, "cleanup.json"), "utf8"));
      expect(record.retained).toBe(true);
      expect(record.errors.length).toBe(mode === "driver-failure" || mode === "provider-failure" ? 1 : 0);
      // Expected injected failures were verified; only now discard this unit fixture.
      fs.rmSync(paths.root, { recursive: true });
    }
  });
}
