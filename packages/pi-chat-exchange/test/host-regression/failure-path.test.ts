import fs from "node:fs";
import childProcess, { spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { accounting, driverPath, finishRun, nodePath, piEnvironment, prepareRoot, runReconcile, startDriver } from "./support/harness.mjs";
import { settleFixtureDriver } from "./support/fixture.mjs";

it("rejects detached child escape before spawn and accounts for the refusal", async () => {
  const paths = prepareRoot();
  const driver = startDriver(paths);
  try {
    const program = "try {require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{detached:true}); console.log('ESCAPED')} catch(e) {console.log(e.message)}";
    driver.launch("escape", [nodePath, "-e", program], piEnvironment(paths), paths.cwd, 0);
    await driver.waitFor("escape", (text) => text.includes("HR_UNSUPPORTED_ESCAPE") ? "refused" : undefined, 3_000);
    driver.awaitExit(3_000);
    expect(accounting(paths)).toMatchObject({ unsupportedEscapes: 1 });
  } finally { await settleFixtureDriver(driver); }
}, 20_000);

for (const fault of ["failed", "malformed", "timeout"] as const) {
  it(`refuses real reconciliation and success cleanup on ${fault} guardian enumeration`, async () => {
    const paths = prepareRoot();
    const original = childProcess.spawn;
    // Inject only the inspection dependency inside this owned guardian process;
    // driver/anchor/barrier/reconcile are the real paths, not a fabricated receipt.
    const inspect = fault === "failed" ? "raise RuntimeError('injected inspection failure')"
      : fault === "timeout" ? "raise subprocess.TimeoutExpired('ps',2)"
      : "return original(group,lambda *a,**k:subprocess.CompletedProcess([],0,'malformed',''))";
    const source = `import importlib.util,subprocess,sys\ns=importlib.util.spec_from_file_location('driver',${JSON.stringify(driverPath)})\nm=importlib.util.module_from_spec(s);s.loader.exec_module(m)\noriginal=m.members\ndef inspect(group):\n ${inspect}\nm.members=inspect\nm.guardian_mode(__import__('pathlib').Path(sys.argv[1])/'raw')`;
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(((command: string, args: string[], options: unknown) => {
      if (args?.[1] === "--guardian") return original(command, ["-c", source, paths.root], options as Parameters<typeof original>[2]);
      return original(command, args, options as Parameters<typeof original>[2]);
    }) as typeof original);
    const driver = startDriver(paths);
    spawn.mockRestore();
    try {
      driver.launch("inspection", [nodePath, "-e", "console.log('ready');process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000)"], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
      await driver.waitFor("inspection", (text) => text.includes("ready") ? "ready" : undefined, 5_000);
      driver.send("quit\r", 0);
      expect(() => driver.awaitExit(3_000)).toThrow(/cleanup|driver|guardian/);
      const receipt = join(paths.raw, "receipt");
      const script = join(paths.cwd, "reconcile.cjs");
      fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(receipt)},'published')`);
      const built = { packageRoot: paths.cwd, reconcileScript: script } as Parameters<typeof runReconcile>[1];
      expect(() => runReconcile(paths, built, [], "no-offline", driver)).toThrow();
      expect(fs.existsSync(receipt)).toBe(false);
      await expect(finishRun(paths, driver, undefined, { successful: true })).rejects.toThrow(/cleanup/);
      expect(fs.existsSync(paths.root)).toBe(true);
      expect(JSON.parse(fs.readFileSync(join(paths.raw, "guardian-outcome.json"), "utf8"))).toMatchObject({ successful: false, barrier: { groupDead: false, confirmed: false, anchorReaped: true } });
    } finally { await settleFixtureDriver(driver); }
  }, 45_000);
}

for (const corruption of ["missing", "malformed", "mismatched"] as const) {
  it(`retains evidence and refuses successful cleanup for ${corruption} guardian outcome`, async () => {
    const paths = prepareRoot();
    const driver = startDriver(paths);
    try {
      driver.launch("outcome", [nodePath, "-e", "console.log('ready');setInterval(()=>{},1000)"], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
      await driver.waitFor("outcome", (text) => text.includes("ready") ? "ready" : undefined, 5_000);
      const original = fs.readFileSync;
      const read = vi.spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof original>) => {
        const result = original(...args);
        if (String(args[0]) !== join(paths.raw, "guardian-outcome.json")) return result;
        if (corruption === "missing") throw new Error("missing guardian evidence");
        const document = JSON.parse(String(result));
        if (corruption === "malformed") document.successful = "true";
        else document.barrier.generation = "stale-generation";
        return JSON.stringify(document);
      }) as typeof original);
      try {
        await expect(finishRun(paths, driver, undefined, { successful: true })).rejects.toThrow(/cleanup/);
        expect(fs.existsSync(paths.root)).toBe(true);
      } finally { read.mockRestore(); }
    } finally { await settleFixtureDriver(driver); }
  }, 25_000);
}

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
    const descendant = "process.on('SIGTERM',()=>{});console.log('descendant-ready '+process.pid);setTimeout(()=>process.exit(0),25000)";
    const decorated = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']}); c.stdout.once('data',b=>{process.stdout.write(b);${program}})`;
    const { pid } = driver.launch("synthetic", [nodePath, "-e", decorated], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
    const ready = await driver.waitFor("synthetic", (text) => text.match(/descendant-ready (\d+)/)?.[1], 5_000);
    await verify(driver, paths, pid);
    const probe = spawnSync("/bin/ps", ["-p", ready.matched, "-o", "stat="], { encoding: "utf8" });
    expect(probe.error).toBeUndefined();
    expect(probe.status === 1 || (probe.status === 0 && /^Z/.test(probe.stdout.trim())), "failure cleanup must eliminate resistant descendant").toBe(true);
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
    const barrierFile = join(paths.raw, `barrier-${confirmation.generation}.json`);
    const savedBarrier = fs.readFileSync(barrierFile);
    fs.rmSync(barrierFile);
    expect(() => runReconcile(paths, built, [], "blocked-missing-guardian", driver)).toThrow(/offline/);
    expect(fs.existsSync(receipt)).toBe(false);
    fs.writeFileSync(barrierFile, JSON.stringify({ ...confirmation, groupDead: false, confirmed: false }));
    expect(() => runReconcile(paths, built, [], "blocked-mismatched-guardian", driver)).toThrow(/offline/);
    expect(fs.existsSync(receipt)).toBe(false);
    fs.writeFileSync(barrierFile, savedBarrier);
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
