import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("installed-host runner delegates lifetime to the independent guardian", () => {
  const source = readFileSync(new URL("./support/installed-host.py", import.meta.url), "utf8");
  expect(source).toContain("SupervisedPty(");
  expect(source).not.toContain("p.kill()");
});
for (const fault of ["driver-death", "outer-timeout"] as const) {
  it(`reaps the owned workload and eliminates its resistant descendant on ${fault}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ce-installed-guardian-"));
    const module = new URL("./support/supervised_pty.py", import.meta.url).pathname;
    const program = `import importlib.util,os,pathlib,pty,sys,time,json
s=importlib.util.spec_from_file_location('supervisor',${JSON.stringify(module)})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=pathlib.Path(${JSON.stringify(root)})
a,b=pty.openpty()
child="import signal,time;signal.signal(signal.SIGTERM,lambda *_:None);time.sleep(12)"
work="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',"+repr(child)+"]);print('ready',flush=True);time.sleep(12)"
p=m.SupervisedPty(r,[sys.executable,'-c',work],{'PATH':'/usr/bin:/bin'},r,b)
os.close(b)
(r/'ready.json').write_text(json.dumps({'pid':p.pid}))
time.sleep(.5)
import signal
os.kill(os.getpid(),signal.${fault === "driver-death" ? "SIGKILL" : "SIGTERM"})
`;
    const child = spawn("/usr/bin/python3", ["-B", "-c", program], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    const exit = once(child, "exit");
    try {
      const deadline = Date.now() + 6000;
      while (!existsSync(join(root, "ready.json"))) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Guardian setup failed: ${root}`);
        await new Promise((done) => setTimeout(done, 30));
      }
      // The fixture kills only itself after the bounded timeout; no external
      // PID/PGID signaling and no Python finally block can perform cleanup.
      await exit;
      const outcome = join(root, "raw/guardian-outcome.json");
      const end = Date.now() + 12000;
      while (!existsSync(outcome)) {
        if (Date.now() > end) throw new Error(`Independent guardian did not settle: ${root}`);
        await new Promise((done) => setTimeout(done, 30));
      }
      const result = JSON.parse(readFileSync(outcome, "utf8"));
      expect(result).toMatchObject({ driverLost: true, successful: false, barrier: { groupDead: true, anchorReaped: true, reaped: true } });
      expect(result.barrier.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
      expect(result.barrier.members.every((row: { dead: boolean }) => row.dead)).toBe(true);
      // Probe only the owned synthetic workload; never signal its persisted PID.
      const pid = JSON.parse(readFileSync(join(root, "ready.json"), "utf8")).pid;
      const probe = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
      expect(probe.status === 1 || (probe.status === 0 && /^Z/.test(probe.stdout.trim()))).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  }, 22000);
}
