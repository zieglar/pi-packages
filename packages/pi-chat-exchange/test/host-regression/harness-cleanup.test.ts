import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { finishRun, nodePath, prepareRoot, startDriver } from "./support/harness.mjs";

function gone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}

for (const mode of ["normal", "assertion-failure", "exception", "prior-kill", "escalation"] as const) {
  it(`reaps the owned synthetic child and driver before fixture removal: ${mode}`, async () => {
    const paths = prepareRoot();
    const driver = startDriver(paths);
    const child = driver.child as ChildProcess;
    let pid: number | undefined;
    try {
      const program = mode === "escalation"
        ? "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"
        : "console.log('ready'); setInterval(()=>{},1000)";
      pid = driver.launch("synthetic", [nodePath, "-e", program], { PATH: "/usr/bin:/bin" }, paths.cwd, 0).pid;
      await driver.waitFor("synthetic", (text) => text.includes("ready") ? "ready" : undefined, 5_000);
      expect(() => process.kill(pid!, 0)).not.toThrow();
      if (mode === "prior-kill") driver.kill();
      if (mode === "exception") {
        const exited = once(child, "exit");
        fs.writeFileSync(join(paths.raw, "control-999.json"), JSON.stringify({ op: "invalid-for-cleanup-regression" }));
        await exited;
        await expect(driver.stop()).rejects.toThrow(/driver exited/);
      } else if (mode === "assertion-failure") {
        try { expect("injected assertion failure").toBe("success"); }
        catch {
          await finishRun(paths, driver, undefined, { successful: false });
          expect(JSON.parse(fs.readFileSync(join(paths.raw, "cleanup.json"), "utf8")).retained).toBe(true);
        }
      } else {
        await driver.stop();
      }
      // Node's exit event is delivered only after waitpid has reaped Python;
      // Python's metadata records its own wait of the owned synthetic child.
      expect(child.exitCode).not.toBeNull();
      gone(pid);
      const ownedPid = pid;
      pid = undefined; // confirmed gone: never signal a potentially reused PID
      const meta = JSON.parse(fs.readFileSync(join(paths.raw, "synthetic.meta.json"), "utf8"));
      expect(meta.exit).not.toBeNull();
      expect(meta.cleanup).toMatchObject({ pid: ownedPid, reaped: true });
      if (mode === "escalation" || mode === "prior-kill") expect(meta.exit).toBe(-9);
      if (mode !== "exception") await driver.stop(); // idempotent after confirmed exit
      expect(fs.existsSync(paths.root)).toBe(true);
      fs.rmSync(paths.root, { recursive: true });
      expect(fs.existsSync(paths.root)).toBe(false);
    } finally {
      // RED safety net: signal ONLY the PID returned by our synthetic launch.
      if (pid !== undefined) { try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ } }
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      // Keep failed fixtures, including the old driver's unreaped-child metadata.
    }
  }, 20_000);
}
