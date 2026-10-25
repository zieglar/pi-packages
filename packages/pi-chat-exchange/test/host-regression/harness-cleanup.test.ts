import fs from "node:fs";
import { spawnSync, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { driverPath, finishRun, nodePath, prepareRoot, startDriver } from "./support/harness.mjs";
import { settleFixtureDriver } from "./support/fixture.mjs";

// The descendant self-expires even against the old broken driver. Never use a
// stale numeric PID as cleanup authority in a failing characterization.
for (const end of ["quit", "crash"] as const) {
  it(`eliminates a TERM-resistant descendant after the actual leader ${end}`, async () => {
    const paths = prepareRoot();
    const driver = startDriver(paths);
    try {
      const descendant = "process.on('SIGTERM',()=>{}); console.log('descendant-ready '+process.pid); setTimeout(()=>process.exit(0),8000)";
      const program = `const cp=require('node:child_process'); const c=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']}); c.stdout.on('data',b=>process.stdout.write(b)); process.stdin.on('data',()=>process.exit(0)); setInterval(()=>{},1000)`;
      const { pid } = driver.launch("descendants", [nodePath, "-e", program], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
      const ready = await driver.waitFor("descendants", (text) => text.match(/descendant-ready (\d+)/)?.[1], 5_000);
      const descendantPid = Number(ready.matched);
      if (end === "quit") { driver.send("quit\r", 0); expect(driver.awaitExit(5_000)).toMatchObject({ pid, exit: 0 }); }
      else expect(driver.kill()).toMatchObject({ pid, exit: -9 });
      const probe = spawnSync("/bin/ps", ["-p", String(descendantPid), "-o", "stat="], { encoding: "utf8" });
      expect(probe.error).toBeUndefined();
      expect(probe.status === 1 || (probe.status === 0 && /^Z/.test(probe.stdout.trim())), "leader death must not authorize offline while descendant is live").toBe(true);
      const receipt = driver.requireOffline();
      expect(receipt).toMatchObject({ pid, groupDead: true, anchorReaped: true, confirmed: true, driverLost: false });
      expect(receipt.anchorPid).not.toBe(pid);
      expect(receipt.pgid).toBe(receipt.anchorPid);
      expect(receipt.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
      expect(receipt.members.every((member) => member.dead && !member.reaped)).toBe(true);
    } finally {
      await settleFixtureDriver(driver);
      await new Promise((done) => setTimeout(done, 8_500));
    }
  }, 25_000);
}

for (const failure of ["SIGKILL/EOF", "exception"] as const) {
it(`guardian independently cleans the resistant descendant on driver ${failure} without offline authority`, async () => {
  const paths = prepareRoot();
  const driver = startDriver(paths);
  try {
    const descendant = "process.on('SIGTERM',()=>{}); console.log('descendant-ready '+process.pid); setTimeout(()=>process.exit(0),8000)";
    const program = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','inherit']}); c.stdout.on('data',b=>process.stdout.write(b)); setInterval(()=>{},1000)`;
    const { pid } = driver.launch("eof", [nodePath, "-e", program], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
    const ready = await driver.waitFor("eof", (text) => text.match(/descendant-ready (\d+)/)?.[1], 5_000);
    if (failure === "SIGKILL/EOF") (driver.child as ChildProcess).kill("SIGKILL");
    else {
      const exited = once(driver.child as ChildProcess, "exit");
      fs.writeFileSync(join(paths.raw, "control-999.json"), JSON.stringify({ op: "invalid-control" }));
      await exited; // do not enqueue an earlier sorted stop ahead of the fault
    }
    await expect(driver.stop()).rejects.toThrow(/guardian|driver/i);
    const guardian = driver.guardian as ChildProcess;
    expect(guardian.exitCode !== null || guardian.signalCode !== null).toBe(true);
    const outcome = JSON.parse(fs.readFileSync(join(paths.raw, "guardian-outcome.json"), "utf8"));
    expect(outcome).toMatchObject({ driverLost: failure === "SIGKILL/EOF", barrier: { pid, groupDead: true, confirmed: failure !== "SIGKILL/EOF" } });
    if (failure === "SIGKILL/EOF") expect(outcome.successful).toBe(false);
    const probe = spawnSync("/bin/ps", ["-p", ready.matched, "-o", "stat="], { encoding: "utf8" });
    expect(probe.status === 1 || (probe.status === 0 && /^Z/.test(probe.stdout.trim()))).toBe(true);
    expect(() => driver.requireOffline()).toThrow();
  } finally { await settleFixtureDriver(driver); }
}, 25_000);
}

it("actual workload inherits anchor group but not the private driver-liveness descriptor", async () => {
  const paths = prepareRoot();
  const driver = startDriver(paths);
  try {
    const program = "import os,json\ntry:\n os.fstat(3); leaked=True\nexcept OSError:\n leaked=False\nprint(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp(),'leaked':leaked}),flush=True)";
    const { pid } = driver.launch("descriptor", ["/usr/bin/python3", "-c", program], { PATH: "/usr/bin:/bin" }, paths.cwd, 0);
    const output = await driver.waitFor("descriptor", (text) => text.match(/\{[^\r\n]+\}/)?.[0], 5_000);
    const observation = JSON.parse(output.matched);
    const barrier = driver.awaitExit(3_000);
    expect(observation).toEqual({ pid, pgid: barrier.anchorPid, leaked: false });
  } finally { await settleFixtureDriver(driver); }
}, 20_000);

// Literal rows captured from the installed macOS ps during the diagnosed
// failures. Unknown "?" states are transient, never proof of death.
it("classifies the captured transient unknown ps states conservatively", () => {
  const program = `
import importlib.util,json,subprocess,sys
spec=importlib.util.spec_from_file_location('driver',${JSON.stringify(driverPath)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def snapshot(text,status=0,stderr=''):
 return lambda *a,**k: subprocess.CompletedProcess([],status,text,stderr)
cases={}
# captured unrelated-group transient rows must not hide the target group's Z
unrelated='29796 29742 29796 Z   \\n31433 15671 31433 ?s  \\n31440 15671 31440 ?+  \\n'
cases['unrelatedTransient']=m.members(29796,snapshot(unrelated))
# captured owned mid-exit row must count NOT DEAD alongside the zombie anchor
owned='33764 33763 33764 Z   \\n33768     1 33764 ?E  \\n'
cases['ownedExiting']=m.members(33764,snapshot(owned))
cases['ownedUnknownPlain']=m.members(40,snapshot('40 1 40 ?   \\n'))
cases['ownedUnknownSession']=m.members(41,snapshot('41 1 41 ?s  \\n'))
cases['ownedUnknownForeground']=m.members(42,snapshot('42 1 42 ?+  \\n'))
cases['positiveDead']=m.members(43,snapshot('43 1 43 Z   \\n'))
refusals={}
for name,args in {'malformed':('44 1 44 \\u00a7bogus\\n',0,''),'shortRow':('44 1 44\\n',0,''),
  'invalidIdentity':('0 0 0 S   \\n',0,''),'nonzero':('45 1 45 S   \\n',1,''),
  'stderr':('45 1 45 S   \\n',0,'denied'),'empty':('   \\n',0,'')}.items():
 try:
  m.members(44,snapshot(*args)); refusals[name]='NOT REFUSED'
 except Exception as error: refusals[name]=type(error).__name__+': '+str(error)
print(json.dumps({'cases':cases,'refusals':refusals}))
`;
  const result = spawnSync("/usr/bin/python3", ["-c", program], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR }, timeout: 5_000 });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const { cases, refusals } = JSON.parse(result.stdout);
  // Unrelated transient rows are parsed, not filtered away, and excluded only by group.
  expect(cases.unrelatedTransient).toEqual([{ pid: 29796, ppid: 29742, pgid: 29796, state: "Z", dead: true, reaped: false }]);
  expect(cases.ownedExiting).toEqual([
    { pid: 33764, ppid: 33763, pgid: 33764, state: "Z", dead: true, reaped: false },
    { pid: 33768, ppid: 1, pgid: 33764, state: "?E", dead: false, reaped: false },
  ]);
  for (const key of ["ownedUnknownPlain", "ownedUnknownSession", "ownedUnknownForeground"]) {
    expect(cases[key], key).toHaveLength(1);
    expect(cases[key][0], key).toMatchObject({ dead: false, reaped: false });
  }
  expect(cases.positiveDead[0]).toMatchObject({ state: "Z", dead: true, reaped: false });
  expect(refusals).toEqual({
    malformed: "ValueError: malformed group inspection",
    shortRow: "ValueError: malformed group inspection",
    invalidIdentity: "ValueError: invalid process identity",
    nonzero: "RuntimeError: group inspection failed",
    stderr: "RuntimeError: group inspection failed",
    empty: "RuntimeError: group inspection failed",
  });
});

it("bounded polling refuses while an owned member stays in an unknown state, and confirms only on positive dead evidence", () => {
  const program = `
import importlib.util,json,subprocess
spec=importlib.util.spec_from_file_location('driver',${JSON.stringify(driverPath)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
results={}
for kind in ['persisting','settles']:
 events=[];polls=[]
 class Anchor:
  pid=33764
  def poll(self): raise AssertionError('must not poll anchor')
  def wait(self,timeout):
   events.append('reap'); return -9
 def send(pid,sig):
  assert 'reap' not in events, 'final group signal must precede the reap'
  events.append('signal')
 def inspect(group):
  polls.append(len(polls))
  exiting='33764 33763 33764 Z   \\n33768     1 33764 ?E  \\n'
  dead='33764 33763 33764 Z   \\n'
  text=exiting if (kind=='persisting' or len(polls)<3) else dead
  return m.members(group,lambda *a,**k: subprocess.CompletedProcess([],0,text,''))
 ticks=iter([0,0.1,0.2,0.3,0.4,0.5,9,9,9])
 outcome=m.final_barrier(Anchor(),inspect,send,lambda:next(ticks),lambda _:None)
 assert events==['signal','reap'], events
 results[kind]={'groupDead':outcome['groupDead'],'error':outcome.get('error'),'polls':len(polls),
   'anchorReaped':outcome['anchorReaped'],'members':outcome['members']}
print(json.dumps(results))
`;
  const result = spawnSync("/usr/bin/python3", ["-c", program], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR }, timeout: 5_000 });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const results = JSON.parse(result.stdout);
  expect(results.persisting.groupDead).toBe(false);
  expect(results.persisting.error).toMatch(/timed out/);
  expect(results.persisting.polls).toBeGreaterThan(1);
  expect(results.persisting.anchorReaped).toBe(true);
  expect(results.settles).toMatchObject({ groupDead: true, error: null, anchorReaped: true });
  expect(results.settles.members).toEqual([{ pid: 33764, ppid: 33763, pgid: 33764, state: "Z", dead: true, reaped: false }]);
});

it("real final-barrier adapter pins final signal before reap and refuses failed/malformed/timed-out inspection", () => {
  const program = `
import importlib.util,json,subprocess
spec=importlib.util.spec_from_file_location('driver',${JSON.stringify(driverPath)})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
results=[]
for kind in ['dead','failed','malformed','timeout']:
 events=[]
 class Anchor:
  pid=123
  def poll(self): raise AssertionError('must not poll anchor')
  def wait(self,timeout):
   events.append('reap'); return -9
 def send(pid,sig):
  assert 'reap' not in events
  events.append('signal')
 def inspect(pgid):
  if kind=='failed': return m.members(pgid,lambda *a,**k:subprocess.CompletedProcess([],1,'','denied'))
  if kind=='malformed': return m.members(pgid,lambda *a,**k:subprocess.CompletedProcess([],0,'not a numeric process row',''))
  if kind=='timeout': return [{'pid':124,'dead':False,'reaped':False}]
  return m.members(pgid,lambda *a,**k:subprocess.CompletedProcess([],0,'123 1 123 Z\\n',''))
 ticks=iter([0,4])
 result=m.final_barrier(Anchor(),inspect,send,lambda:next(ticks),lambda _:None)
 assert events==['signal','reap'],events
 assert result['groupDead']==(kind=='dead'),result
 if kind!='dead': assert 'error' in result
 if kind=='dead': assert result['members'][0]['reaped']==False
 results.append({'kind':kind,'outcome':result})
print(json.dumps(results))
`;
  const result = spawnSync("/usr/bin/python3", ["-c", program], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR }, timeout: 5_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(4);
});

function gone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}

for (const mode of ["normal", "assertion-failure", "exception", "prior-kill", "escalation", "post-reap-assertion-failure"] as const) {
  it(`reaps the owned synthetic child and driver before fixture removal: ${mode}`, async () => {
    const paths = prepareRoot();
    const driver = startDriver(paths);
    const child = driver.child as ChildProcess;
    let pid: number | undefined;
    let failure: unknown;
    const originalKill = process.kill;
    const signals = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal !== 0) throw new Error("numeric PID signalling forbidden in fixture cleanup");
      return originalKill(pid, signal);
    });
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
      if (mode === "post-reap-assertion-failure") expect("injected post-reap assertion").toBe("success");
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
    } catch (error) {
      failure = error;
    } finally {
      await settleFixtureDriver(driver);
      // Keep failed fixtures, including the old driver's unreaped-child metadata.
    }
    try {
      expect(signals.mock.calls.filter(([, signal]) => signal !== 0), "never signal a numeric PID after reap").toEqual([]);
      if (mode === "post-reap-assertion-failure") {
        expect(String(failure)).toContain("injected post-reap assertion");
        fs.rmSync(paths.root, { recursive: true });
      } else if (failure) throw failure;
    } finally { signals.mockRestore(); }
  }, 20_000);
}
