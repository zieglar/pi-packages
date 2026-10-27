import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it } from "vitest";

// Behavioral cleanup proofs for the shared supervised-PTY wrapper used by the
// installed-distribution heavy lane. Nothing here inspects source text: every
// case drives a real synthetic workload through the committed guardian. The
// fixture owns its own process exclusively; only its own handles are signalled.
// Post-run evidence comes from BOTH the guardian barrier and independent
// read-only /bin/ps probes of the exact owned PIDs/process-group.
const module = new URL("./support/supervised_pty.py", import.meta.url).pathname;

/** mode: close (real SupervisedPty.close) | sigkill | sigterm (runner death). */
function fixtureProgram(mode: "close" | "sigkill" | "sigterm"): string {
  const workload = [
    "import os,pathlib,subprocess,sys,time",
    "r=pathlib.Path(sys.argv[1]);raw=r/'raw'",
    "child='import signal,time;signal.signal(signal.SIGTERM,lambda *_:None);time.sleep(12)'",
    "c=subprocess.Popen([sys.executable,'-c',child],stdout=subprocess.DEVNULL)",
    "(raw/'transcript-DESCENDANT').write_text('DESCENDANT '+str(c.pid))",
    "(raw/'transcript-READY').write_text('READY '+str(os.getpid()))",
    "time.sleep(12)",
  ].join(";");
  return [
    "import importlib.util,os,pathlib,pty,signal,sys,time",
    `s=importlib.util.spec_from_file_location('supervisor',${JSON.stringify(module)})`,
    "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)",
    "r=pathlib.Path(sys.argv[1])",
    "a,b=pty.openpty()",
    `p=m.SupervisedPty(r,[sys.executable,'-c',${JSON.stringify(workload)},str(r)],{'PATH':'/usr/bin:/bin'},r,b)`,
    "os.close(b)",
    mode === "close"
      ? "while not (r/'raw'/'transcript-READY').exists(): time.sleep(.05)\np.close();sys.exit(0)"
      : `while not (r/'raw'/'transcript-READY').exists(): time.sleep(.05)\ntime.sleep(.3);os.kill(os.getpid(),signal.${mode === "sigkill" ? "SIGKILL" : "SIGTERM"})`,
  ].join("\n");
}

interface Actual { pid: number; anchorPid: number; pgid: number; generation: string }
interface Outcome {
  successful: boolean;
  driverLost: boolean;
  barrier: { events: string[]; groupDead: boolean; anchorReaped: boolean; reaped?: boolean; confirmed?: boolean };
}

function spawnFixture(mode: "close" | "sigkill" | "sigterm", root: string) {
  return spawn("/usr/bin/python3", ["-B", "-c", fixtureProgram(mode), root], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
}

function readActual(root: string): Actual {
  const file = readdirSync(join(root, "raw")).find((name) => name.startsWith("actual-"));
  if (!file) throw new Error(`guardian actual record missing: ${root}`);
  return JSON.parse(readFileSync(join(root, "raw", file), "utf8")) as Actual;
}

async function awaitStarted(root: string): Promise<Actual> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (existsSync(join(root, "raw/transcript-DESCENDANT"))) return readActual(root);
    if (Date.now() > deadline) throw new Error(`fixture never started: ${root}`);
    await new Promise((done) => setTimeout(done, 30));
  }
}

async function awaitOutcome(root: string): Promise<Outcome> {
  const path = join(root, "raw/guardian-outcome.json");
  const deadline = Date.now() + 20_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`independent guardian did not settle: ${root}`);
    await new Promise((done) => setTimeout(done, 30));
  }
  return JSON.parse(readFileSync(path, "utf8")) as Outcome;
}

function probeDead(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  const probe = spawnSync("/bin/ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 10_000 });
  return probe.status === 1 || (probe.status === 0 && /^Z/.test(probe.stdout.trim()));
}

function groupEmpty(pgid: number): boolean {
  const listing = spawnSync("/bin/ps", ["-axo", "pid=,pgid="], { encoding: "utf8", timeout: 10_000 });
  if (listing.status !== 0) throw new Error(`ps listing failed: ${listing.stderr}`);
  return !listing.stdout.split("\n").some((row) => Number(row.trim().split(/\s+/)[1]) === pgid);
}

function ownedPid(root: string, marker: "READY" | "DESCENDANT"): number | undefined {
  const path = join(root, "raw", `transcript-${marker}`);
  if (!existsSync(path)) return undefined;
  return Number(readFileSync(path, "utf8").match(/\d+/)?.[0]);
}

async function runCase(root: string, mode: "close" | "sigkill" | "sigterm"): Promise<Outcome> {
  const child = spawnFixture(mode, root);
  const exited = once(child, "exit");
  try {
    await awaitStarted(root);
    await exited;
    return await awaitOutcome(root);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
}

function expectOwnedGroupEliminated(root: string, actual: Actual): void {
  for (const marker of ["READY", "DESCENDANT"] as const) {
    expect(probeDead(ownedPid(root, marker)), `${marker} pid survived`).toBe(true);
  }
  expect(groupEmpty(actual.pgid), "process group survived").toBe(true);
}

it("normal close confirms a successful barrier and eliminates the resistant descendant", async () => {
  const root = mkdtempSync(join(tmpdir(), "ce-installed-guardian-"));
  const outcome = await runCase(root, "close");
  expect(outcome).toMatchObject({ successful: true, driverLost: false, barrier: { groupDead: true, anchorReaped: true, confirmed: true } });
  expect(outcome.barrier.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
  expectOwnedGroupEliminated(root, readActual(root));
}, 30_000);

for (const fault of ["sigkill", "sigterm"] as const) {
  it(`independently cleans the resistant descendant after runner ${fault} without offline authority`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ce-installed-guardian-"));
    const outcome = await runCase(root, fault);
    expect(outcome).toMatchObject({ driverLost: true, successful: false, barrier: { groupDead: true, anchorReaped: true, reaped: true } });
    expect(outcome.barrier.events).toEqual(["final-group-kill", "no-live-members", "anchor-reaped"]);
    expectOwnedGroupEliminated(root, readActual(root));
  }, 30_000);
}
