import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { finishRun, nodePath, prepareRoot, runReconcile, startDriver } from "./support/harness.mjs";
import { settleFixtureDriver } from "./support/fixture.mjs";

// No environment fault backdoors: intercept only this fixture's filesystem operation.
for (const fault of ["record", "remove"] as const) {
  it(`reports the original root and honest evidence state after ${fault} failure`, async () => {
    const paths = prepareRoot();
    const marker = join(paths.raw, "marker");
    fs.writeFileSync(marker, "evidence");
    const originalWrite = fs.writeFileSync;
    const originalRemove = fs.rmSync;
    const injected = new Error(`injected ${fault} failure`);
    const driverError = new Error("prior driver failure");
    const providerError = new Error("prior provider failure");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (fault === "record" && String(args[0]).endsWith("cleanup.json")) throw injected;
      return originalWrite(...args);
    });
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((...args) => {
      if (String(args[0]) === paths.root) {
        originalRemove(marker); // deterministic partial deletion
        throw injected;
      }
      return originalRemove(...args);
    });
    try {
      const error = await finishRun(paths,
        fault === "record" ? { stop: async () => { throw driverError; } } : undefined,
        fault === "record" ? { close: async () => { throw providerError; } } : undefined,
        { successful: true }).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError & { evidence: { root: string; state: string } };
      expect(aggregate.errors).toEqual(fault === "record" ? [driverError, providerError, injected] : [injected]);
      expect(aggregate.evidence).toEqual({ root: paths.root, state: fault === "record" ? "retained" : "possibly-partially-removed" });
      expect(log.mock.calls.flat().join(" ")).toContain(paths.root);
      expect(fs.existsSync(marker)).toBe(fault === "record");
      if (fault === "record") expect(remove).not.toHaveBeenCalled();
    } finally {
      write.mockRestore(); remove.mockRestore(); log.mockRestore();
      originalRemove(paths.root, { recursive: true });
    }
  });
}

it("bounds a never-resolving provider close and retains evidence", async () => {
  const paths = prepareRoot();
  vi.useFakeTimers();
  const closeAllConnections = vi.fn();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const pending = finishRun(paths, { stop: async () => {} }, {
      close: () => new Promise<void>(() => {}), server: { closeAllConnections },
    }, { successful: true }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6_000);
    const error = await Promise.race([pending, Promise.resolve("still blocked")]);
    expect(error).toBeInstanceOf(AggregateError);
    expect(String((error as AggregateError).errors[0])).toContain("provider close timed out");
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join(" ")).toContain(paths.root);
    expect(JSON.parse(fs.readFileSync(join(paths.raw, "cleanup.json"), "utf8")).retained).toBe(true);
  } finally {
    vi.useRealTimers(); log.mockRestore(); fs.rmSync(paths.root, { recursive: true });
  }
});

async function fixture(program: string, verify: (driver: ReturnType<typeof startDriver>, paths: ReturnType<typeof prepareRoot>, pid: number) => Promise<void>) {
  const paths = prepareRoot();
  const driver = startDriver(paths);
  try {
    const { pid } = driver.launch("synthetic", [nodePath, "-e", program], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
    await driver.waitFor("synthetic", (text) => text.includes("ready") ? "ready" : undefined, 5_000);
    await verify(driver, paths, pid);
  } finally {
    await settleFixtureDriver(driver);
  }
}

for (const method of ["writeFileSync", "renameSync", "timeout"] as const) {
  it(`reaps the driver and its TERM-resistant child after stop publication ${method} failure`, async () => {
    await fixture("process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)", async (driver, paths, pid) => {
      const injected = new Error(`injected control ${method} failure`);
      const originalWrite = fs.writeFileSync;
      const originalRename = fs.renameSync;
      const write = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
        if (String(args[0]).startsWith(join(paths.raw, "control-"))) {
          if (method === "writeFileSync") throw injected;
          // Simulate a publication that never reaches the driver's queue. This
          // exercises the real parent deadline and TERM handler, not a sleep.
          if (method === "timeout") return;
        }
        return originalWrite(...args);
      });
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
        if (String(args[0]).startsWith(join(paths.raw, "control-"))) {
          if (method === "renameSync") throw injected;
          if (method === "timeout") return;
        }
        return originalRename(...args);
      });
      try {
        const error = await driver.stop().catch((error: unknown) => error);
        if (method === "timeout") expect(String(error)).toContain("exit timed out");
        else expect(error).toBe(injected);
        const child = driver.child as ChildProcess;
        expect(child.exitCode !== null || child.signalCode !== null, "driver must be reaped before rejection").toBe(true);
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
        const meta = JSON.parse(fs.readFileSync(join(paths.raw, "synthetic.meta.json"), "utf8"));
        expect(meta.cleanup).toMatchObject({ pid, reaped: true, exit: -9 });
      } finally { write.mockRestore(); rename.mockRestore(); }
      fs.rmSync(paths.root, { recursive: true });
    });
  }, 35_000);
}

it("blocks reconciliation until the CURRENT delayed-shutdown child is positively reaped", async () => {
  await fixture("console.log('ready'); process.stdin.on('data',()=>setTimeout(()=>process.exit(0),700)); setInterval(()=>{},1000)", async (driver, paths, pid) => {
    const script = join(paths.cwd, "reconcile.cjs");
    const receipt = join(paths.raw, "receipt");
    fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, 'published')`);
    // The real runReconcile launch boundary is exercised, not a timing-only assertion.
    const built = { packageRoot: paths.cwd, reconcileScript: script } as Parameters<typeof runReconcile>[1];
    expect(() => runReconcile(paths, built, [], "blocked-live", driver)).toThrow(/offline/);
    expect(fs.existsSync(receipt)).toBe(false);
    // Test a timeout BEFORE sending quit: deterministic failure regardless of load.
    expect(() => driver.awaitExit(100)).toThrow(/exit.*confirm|still live/i);
    expect(() => runReconcile(paths, built, [], "blocked-timeout", driver)).toThrow(/offline/);
    expect(fs.existsSync(receipt)).toBe(false);
    driver.send("quit\r", 0);
    const confirmation = driver.awaitExit(5_000);
    expect(confirmation).toMatchObject({ name: "synthetic", pid, reaped: true, exit: 0 });
    const result = runReconcile(paths, built, [], "confirmed", driver);
    expect(result.status).toBe(0);
    expect(fs.existsSync(receipt)).toBe(true);
    const record = JSON.parse(fs.readFileSync(join(paths.raw, "confirmed.json"), "utf8"));
    expect(record.offlineBefore).toEqual(confirmation);
    expect(record.offlineAfter).toEqual(confirmation);
    // A newer launch invalidates the old confirmation even though the old PID is dead.
    driver.launch("newer", [nodePath, "-e", "setInterval(()=>{},1000)"], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
    fs.rmSync(receipt);
    expect(() => runReconcile(paths, built, [], "blocked-newer", driver)).toThrow(/offline/);
    expect(fs.existsSync(receipt)).toBe(false);
    await driver.stop();
    fs.rmSync(paths.root, { recursive: true });
  });
}, 20_000);
