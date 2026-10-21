/**
 * HANDOFF-CE-HOST-09 B1.1 Task 3 — owned offline lifecycle.
 *
 * Dynamic module load keeps the first run a real assertion failure.
 *
 * Pinned contract:
 * - the ONLY startable process is the fixed bundled offline fake client, and
 *   only under the explicit opt-in `CE_TUNNEL_OFFLINE_TEST === "1"`. Without
 *   it, start refuses CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED before any
 *   credential read, and no opt-in or existing credential can unblock a real
 *   client start (R11 stays blocked).
 * - ownership is the retained child handle plus a generation: never a PID from
 *   disk, config, or an external list; stop touches only the owned handle.
 * - health completions are stamped once, at actual completion, and must match
 *   the current run id and PID; stale callbacks cannot mutate a newer run.
 * - unexpected exit (even code 0) is an Error, timers are cleared, and there is
 *   NO auto-respawn or business retry.
 * - status reports offline/simulated clearly and separates tunnel health from
 *   observed client activity, which is only ever an actual attributed event.
 */
import { describe, expect, it, vi } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ManagerModule = any;

async function load(): Promise<ManagerModule | undefined> {
  try {
    return (await import("../../src/tunnel/manager.js")) as ManagerModule;
  } catch {
    return undefined;
  }
}

async function mod(): Promise<ManagerModule> {
  const loaded = await load();
  expect(loaded, "src/tunnel/manager.ts module namespace").toBeDefined();
  expect(typeof loaded.createTunnelManager, "createTunnelManager export").toBe("function");
  return loaded as ManagerModule;
}

const HEALTHY = {
  result: "ok",
  healthz: { ok: true, body: "live" },
  readyz: { ok: true },
  simulated: true,
};

class FakeChild {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly kills: string[] = [];
  readonly stdout = { listeners: [] as ((chunk: Buffer) => void)[], on(event: string, l: (chunk: Buffer) => void) { if (event === "data") this.listeners.push(l); }, resume() {} };
  readonly stderr = { on() {}, resume() {} };
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "exit") this.exitListeners.push(listener as unknown as (code: number | null, signal: string | null) => void);
    if (event === "error") this.errorListeners.push(listener as unknown as (error: Error) => void);
    return this;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }

  emitLine(value: unknown): void {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    for (const listener of [...this.stdout.listeners]) listener(Buffer.from(`${text}\n`, "utf8"));
  }

  emitExit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

interface SpawnCall {
  executable: string;
  args: readonly string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
}

function harness(
  api: ManagerModule,
  options: { optIn?: boolean; env?: NodeJS.ProcessEnv; simulateActivity?: boolean; spawnThrows?: boolean } = {},
) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let clock = 1_000;
  let sequence = 0;
  const spawn = vi.fn((executable: string, args: readonly string[], spawnOptions: SpawnCall["options"]) => {
    calls.push({ executable, args, options: spawnOptions });
    if (options.spawnThrows === true) throw new Error("synthetic spawn failure");
    const child = new FakeChild(5_000 + children.length);
    children.push(child);
    return child;
  });
  const manager = api.createTunnelManager({
    env: { ...(options.optIn === false ? {} : { CE_TUNNEL_OFFLINE_TEST: "1" }), ...options.env },
    now: () => clock,
    spawn,
    nodeExecPath: "/approved/node",
    clientScript: "/bundled/offline-client.js",
    ...(options.simulateActivity === undefined ? {} : { simulateActivity: options.simulateActivity }),
  });
  return {
    manager,
    spawn,
    calls,
    children,
    child: (index = 0) => {
      const child = children[index];
      if (child === undefined) throw new Error(`no child at index ${index}`);
      return child;
    },
    advance: (ms: number) => { clock += ms; },
    at: () => clock,
    // The simulator protocol stamps every health record with an explicit
    // `simulated` flag and a strictly increasing per-run sequence
    // (offline-client.ts), so the fixture mirrors that contract.
    healthLine: (child: FakeChild, overrides: Record<string, unknown> = {}) => {
      sequence += 1;
      return child.emitLine({
        event: "health",
        runId: manager.runId(),
        pid: child.pid,
        simulated: true,
        sequence,
        payload: HEALTHY,
        ...overrides,
      });
    },
  };
}

describe("B1.1 manager — start authorization", () => {
  it("refuses start without the explicit offline opt-in and never spawns", async () => {
    const api = await mod();
    const h = harness(api, { optIn: false });
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED" });
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.manager.status().running).toBe(false);
  });

  it.each([
    { CE_TUNNEL_OFFLINE_TEST: "true" },
    { CE_TUNNEL_OFFLINE_TEST: "yes" },
    { CE_TUNNEL_OFFLINE_TEST: "0" },
    { CE_TUNNEL_OFFLINE_TEST: " 1" },
  ])("requires the exact opt-in value %o", async (env) => {
    const api = await mod();
    const h = harness(api, { optIn: false, env });
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("stays blocked even when a plaintext hand-off or key file is claimed to exist", async () => {
    const api = await mod();
    const h = harness(api, {
      optIn: false,
      env: {
        CE_TUNNEL_ALLOW_PLAINTEXT_TEMPFILE: "true",
        CE_TUNNEL_KEY_FILE: "/synthetic/key",
        CONTROL_PLANE_API_KEY: "sk-should-never-be-used",
      },
    });
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED" });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it("starts only the fixed bundled fake client, with no secret in argv or env", async () => {
    const api = await mod();
    const h = harness(api, { env: { CONTROL_PLANE_API_KEY: "sk-must-not-propagate", OPENAI_API_KEY: "sk-nope" } });
    await h.manager.start();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.executable).toBe("/approved/node");
    expect(h.calls[0]?.args[0]).toBe("/bundled/offline-client.js");
    const serialized = JSON.stringify(h.calls[0]);
    expect(serialized).not.toContain("sk-must-not-propagate");
    expect(serialized).not.toContain("sk-nope");
    const env = h.calls[0]?.options.env ?? {};
    expect(Object.keys(env)).not.toContain("CONTROL_PLANE_API_KEY");
    expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
    expect(env.CE_TUNNEL_OFFLINE_TEST).toBe("1");
  });

  it("reports a spawn failure as a closed refusal and keeps nothing running", async () => {
    const api = await mod();
    const h = harness(api, { spawnThrows: true });
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(h.manager.status().running).toBe(false);
  });

  it("joins a duplicate and concurrent start instead of spawning twice", async () => {
    const api = await mod();
    const h = harness(api);
    const [a, b] = await Promise.all([h.manager.start(), h.manager.start()]);
    await h.manager.start();
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(a.runId).toBe(b.runId);
  });
});

describe("B1.1 manager — simulated health and status surfaces", () => {
  it("reaches Connected only from an attributed simulated health completion", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    expect(h.manager.status().state).toBe("Starting");
    h.advance(500);
    h.healthLine(h.child());
    const status = h.manager.status();
    expect(status.state).toBe("Connected");
    expect(status.evidence).toBe("health-probe");
    expect(status.mode).toBe("offline-simulated");
    expect(status.label).toMatch(/simulated|offline/i);
  });

  it.each([
    ["wrong run id", { runId: "not-this-run" }],
    ["wrong pid", { pid: 999_999 }],
    ["missing payload", { payload: undefined }],
    ["unhealthy payload", { payload: { result: "fail", healthz: { ok: false }, readyz: { ok: false } } }],
  ])("ignores or refuses %s instead of reporting Connected", async (_name, overrides) => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    h.advance(500);
    h.healthLine(h.child(), overrides);
    expect(h.manager.status().state).not.toBe("Connected");
  });

  it("suppresses raw child output and never surfaces it in status", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    h.child().emitLine("auth failed for key sk-leaked-by-child-0003");
    h.child().emitLine("x".repeat(200_000));
    h.child().emitLine({ event: "health", runId: "x", pid: 1, payload: { note: "sk-leaked-by-child-0003" } });
    const status = h.manager.status();
    expect(JSON.stringify(status)).not.toContain("sk-leaked-by-child-0003");
    expect(status.state).not.toBe("Connected");
  });

  it("degrades stale evidence past the freshness window without a new probe", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    h.advance(500);
    h.healthLine(h.child());
    expect(h.manager.status().state).toBe("Connected");
    h.advance(60_000);
    expect(h.manager.status().state).not.toBe("Connected");
  });

  it("reports client activity only from an actual attributed simulated event", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    h.advance(100);
    h.healthLine(h.child());
    expect(h.manager.status().clientActivity.observed).toBe(false);
    // A health probe, a poll tick, and a PID are NOT activity evidence.
    h.child().emitLine({ event: "activity", runId: "someone-else", pid: h.child().pid, simulated: true, kind: "simulated-request" });
    expect(h.manager.status().clientActivity.observed).toBe(false);
    h.child().emitLine({ event: "activity", runId: h.manager.runId(), pid: h.child().pid, simulated: true, kind: "simulated-request" });
    const status = h.manager.status();
    expect(status.clientActivity.observed).toBe(true);
    expect(status.clientActivity.simulated).toBe(true);
    expect(status.clientActivity.at).toBe(h.at());
  });
});

describe("B1.1 manager — stop, exit, and ownership", () => {
  it("stops only the owned child and confirms the exit", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    const child = h.child();
    const stopping = h.manager.stop();
    expect(child.kills).toEqual(["SIGTERM"]);
    child.emitExit(null, "SIGTERM");
    await stopping;
    expect(h.manager.status().state).toBe("Stopped");
    expect(h.manager.status().running).toBe(false);
  });

  it("joins duplicate and concurrent stops, and is a no-op with nothing running", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.stop();
    await h.manager.start();
    const child = h.child();
    const first = h.manager.stop();
    const second = h.manager.stop();
    child.emitExit(0, null);
    await Promise.all([first, second]);
    expect(child.kills.filter((s) => s === "SIGTERM")).toHaveLength(1);
    await h.manager.stop();
    expect(child.kills.filter((s) => s === "SIGTERM")).toHaveLength(1);
  });

  it("sends one SIGTERM without escalation and refuses an unconfirmed stop", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    const child = h.child();
    const stopping = h.manager.stop({ graceMs: 5, killTimeoutMs: 5 });
    await expect(stopping).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    // Approved policy: timeout retains ownership, never escalates or retries.
    expect(child.kills).toEqual(["SIGTERM"]);
    expect(h.manager.status().state).not.toBe("Stopped");
  });

  it("treats an unexpected exit — even code 0 — as an Error and never respawns", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    h.advance(100);
    h.healthLine(h.child());
    h.advance(100);
    h.child().emitExit(0, null);
    const status = h.manager.status();
    expect(status.state).toBe("Error");
    expect(status.running).toBe(false);
    h.advance(120_000);
    expect(h.manager.status().state).toBe("Error");
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it("ignores stale callbacks from a previous run", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    const first = h.child();
    const stopping = h.manager.stop();
    first.emitExit(null, "SIGTERM");
    await stopping;
    h.advance(1_000);
    await h.manager.start();
    const second = h.child(1);
    h.advance(100);
    h.healthLine(second);
    expect(h.manager.status().state).toBe("Connected");
    // Late noise from the dead first child must not touch the live run.
    first.emitExit(1, null);
    first.emitLine({ event: "health", runId: h.manager.runId(), pid: first.pid, simulated: true, sequence: 99, payload: HEALTHY });
    expect(h.manager.status().state).toBe("Connected");
    expect(first.kills.filter((s) => s === "SIGKILL")).toHaveLength(0);
  });

  it("never kills a process it did not spawn", async () => {
    const api = await mod();
    const h = harness(api);
    // There is no API to adopt a foreign PID at all.
    expect(typeof h.manager.adopt).toBe("undefined");
    expect(typeof h.manager.attach).toBe("undefined");
    await h.manager.start();
    // Bounded windows: this child never exits, so the stop ends unconfirmed
    // rather than hanging — and still signals only the owned handle.
    await h.manager.stop({ graceMs: 1, killTimeoutMs: 1 }).catch(() => undefined);
    expect(h.children).toHaveLength(1);
    expect(h.child().kills).toEqual(["SIGTERM"]);
    expect(h.manager.status().running).toBe(true);
  });

  it("disposes idempotently, stopping the owned child and releasing timers", async () => {
    const api = await mod();
    const h = harness(api);
    await h.manager.start();
    const child = h.child();
    const disposing = h.manager.dispose();
    child.emitExit(null, "SIGTERM");
    await disposing;
    await h.manager.dispose();
    expect(child.kills.filter((s) => s === "SIGTERM")).toHaveLength(1);
    expect(h.manager.status().running).toBe(false);
    await expect(h.manager.start()).rejects.toMatchObject({ name: "TunnelRefusal" });
  });
});
