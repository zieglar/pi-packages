import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnelManager, type TunnelManager } from "../../src/tunnel/manager.js";
import { DEFAULT_TUNNEL_TIMING } from "../../src/tunnel/state.js";

// Tunnel lifecycle tests are not Native qualification: keep the Native readiness gate
// out of these scenarios. Native readiness itself is covered by native-readiness-gate.test.ts.
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

// Exercise the registered production extension against the SOURCE manager,
// without rebuilding dist or replacing dispose with invented mock behavior.
const bridge = vi.hoisted(() => ({ create: undefined as undefined | (() => TunnelManager) }));
vi.mock("../../dist/tunnel/manager.js", () => ({ createTunnelManager: () => bridge.create!() }));
vi.mock("../../dist/tunnel/codes.js", async () => import("../../src/tunnel/codes.js"));

class Child extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = { resume() {} };
  readonly signals: string[] = [];
  constructor(readonly pid: number | undefined = 4100) { super(); }
  kill(signal = "SIGTERM"): boolean { this.signals.push(signal); return true; }
  exit(): void { this.emit("exit", 0, null); }
}
const HEALTHY = { result: "ok", healthz: { ok: true, body: "live" }, readyz: { ok: true }, simulated: true };
function harness(child = new Child()) {
  let clock = 1000;
  let sequence = 0;
  const spawn = vi.fn(() => child);
  const manager = createTunnelManager({
    env: { CE_TUNNEL_OFFLINE_TEST: "1" }, spawn, now: () => clock,
    timing: { ...DEFAULT_TUNNEL_TIMING, stopGraceMs: 5 },
  });
  return { manager, child, spawn, advance: (ms: number) => { clock += ms; },
    health(payload: unknown = HEALTHY) {
      child.stdout.emit("data", Buffer.from(JSON.stringify({ event: "health", runId: manager.runId(), pid: child.pid,
        simulated: true, sequence: ++sequence, payload }) + "\n"));
    },
  };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); bridge.create = undefined; });

async function extension() {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // LOCAL-BACKGROUND-01: these lifecycle tests drive the mocked OFFLINE manager.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  const commands = new Map<string, { handler: (args: string, ctx: typeof context) => unknown }>();
  const events = new Map<string, (event: { reason: string }, ctx: typeof context) => unknown>();
  const url = new URL("../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(url) as { default: (pi: unknown) => void };
  factory({ on: (name: string, handler: never) => events.set(name, handler),
    registerCommand: (name: string, options: never) => commands.set(name, options), registerTool() {}, appendEntry() {} });
  const context = { mode: "tui", hasUI: true, cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() } };
  return { context, command: (args: string) => commands.get("ce-tunnel")!.handler(args, context),
    shutdown: () => events.get("session_shutdown")!({ reason: "shutdown" }, context) };
}

describe("F1 retained lifecycle ownership", () => {
  it("rejects disposal and repeat stop without ever re-signalling; late exit releases", async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.manager.start();
    const disposal = h.manager.dispose().then(() => undefined, (error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await disposal).toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.child.signals).toEqual(["SIGTERM"]);
    expect(h.manager.status().running).toBe(true);
    const stopping = h.manager.stop({ graceMs: 5 });
    expect(h.child.signals).toEqual(["SIGTERM"]);
    h.child.emit("error", new Error("signal failure is not exit"));
    expect(h.manager.status().running).toBe(true);
    h.child.exit();
    h.child.emit("close", 0, null);
    await stopping;
    await h.manager.dispose();
    expect(h.manager.status().state).toBe("Stopped");
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
  });

  it("registered extension retains the REAL manager after unconfirmed cleanup and cannot replace it", async () => {
    vi.useFakeTimers();
    const h = harness();
    const create = vi.fn(() => h.manager);
    bridge.create = create;
    const api = await extension();
    await api.command("start");
    for (let i = 0; i < 2; i++) {
      const shutting = api.shutdown();
      await vi.runAllTimersAsync();
      await shutting;
      await api.command("status");
    }
    expect(create).toHaveBeenCalledTimes(1);
    expect(h.child.signals).toEqual(["SIGTERM"]);
    expect(api.context.ui.notify.mock.calls.flat().join(" ")).toContain("CE_TUNNEL_STOP_UNCONFIRMED");
    await api.command("start");
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.child.exit();
    await api.shutdown();
    await api.command("status");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("normal stop joins, and old exit/close/error/output cannot change a newer run", async () => {
    const first = new Child();
    const second = new Child(4101);
    const spawn = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const manager = createTunnelManager({ env: { CE_TUNNEL_OFFLINE_TEST: "1" }, spawn });
    await manager.start();
    const a = manager.stop(); const b = manager.stop();
    first.exit(); first.emit("close", 0, null);
    await Promise.all([a, b]);
    await manager.start();
    const before = manager.status();
    first.exit(); first.emit("close", 1, null); first.emit("error", new Error("late"));
    first.stdout.emit("data", Buffer.from("{}\n"));
    expect(manager.status()).toEqual(before);
    expect(first.signals).toEqual(["SIGTERM"]);
    const stopping = manager.stop(); second.exit(); await stopping;
  });
});

describe("F4 status is a read-only freshness projection", () => {
  function disconnect(h: ReturnType<typeof harness>) {
    h.health();
    for (let i = 0; i < 3; i++) {
      h.advance(1);
      h.health({ result: "fail", healthz: { ok: false }, readyz: { ok: false } });
    }
    expect(h.manager.status().state).toBe("Disconnected");
  }

  it("M=2 recovers with status reads between distinct healthy completions; reads cannot advance M", async () => {
    const h = harness(); await h.manager.start(); disconnect(h);
    const id = h.manager.runId();
    h.advance(1); h.health();
    const first = h.manager.status();
    expect(first.state).toBe("Disconnected");
    for (let i = 0; i < 10; i++) expect(h.manager.status()).toEqual(first);
    h.advance(1); h.health();
    expect(h.manager.status().state).toBe("Connected");
    expect(h.manager.runId()).toBe(id);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.child.exit();
  });

  it("expiry projects Unknown without losing recovery, inventing health or refreshing evidence", async () => {
    const h = harness(); await h.manager.start(); disconnect(h);
    h.advance(16000);
    for (let i = 0; i < 5; i++) {
      expect(h.manager.status()).toMatchObject({ state: "Unknown", evidence: "none", running: true });
    }
    h.health();
    expect(h.manager.status().state).toBe("Disconnected");
    h.advance(1); h.health();
    expect(h.manager.status().state).toBe("Connected");
    h.advance(15001);
    for (let i = 0; i < 5; i++) expect(h.manager.status()).toMatchObject({ state: "Unknown", evidence: "none" });
    h.child.exit();
  });

  it("reads cannot refresh completion time, sequence, activity or startup deadline", async () => {
    const h = harness(); await h.manager.start();
    const id = h.manager.runId();
    h.health(); h.advance(15000);
    expect(h.manager.status()).toMatchObject({ state: "Connected", evidence: "health-probe" });
    for (let i = 0; i < 10; i++) h.manager.status();
    h.advance(1);
    expect(h.manager.status()).toMatchObject({ state: "Unknown", evidence: "none", runId: id,
      clientActivity: { observed: false, at: undefined } });
    h.child.exit();
    const startup = harness(); await startup.manager.start();
    startup.advance(30000);
    expect(startup.manager.status().state).toBe("Error");
    startup.health();
    expect(startup.manager.status().state).toBe("Error");
    startup.child.exit();
  });
});

describe("F3 spawn error protection", () => {
  it.each(["ENOENT", "EACCES"])("handles asynchronous %s without PID, adoption, signals or a listener gap", async (code) => {
    const child = new Child();
    Object.defineProperty(child, "pid", { value: undefined });
    const h = harness(child);
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    await Promise.resolve();
    expect(child.listenerCount("error")).toBeGreaterThan(0);
    expect(() => child.emit("error", Object.assign(new Error("synthetic"), { code }))).not.toThrow();
    child.emit("exit", -2, null); child.emit("close", -2, null);
    expect(() => child.emit("error", new Error("duplicate"))).not.toThrow();
    expect(h.manager.runId()).toBeUndefined();
    expect(h.manager.status().running).toBe(false);
    expect(child.signals).toEqual([]);
  });

  it("protects the child immediately, before even reading PID; retains a valid failed handle", async () => {
    const child = new Child();
    Object.defineProperty(child, "pid", { get() { child.emit("error", new Error("immediate")); return 4100; } });
    const h = harness(child);
    await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(h.manager.status().running).toBe(true);
    expect(h.manager.status().state).toBe("Error");
    const stopping = h.manager.stop(); child.exit(); await stopping;
  });

  it.each(["error-exit-close", "exit-error-close", "close-error-exit"])("folds %s and duplicate errors without resurrection", async (order) => {
    const h = harness(); await h.manager.start();
    await Promise.resolve();
    for (const event of order.split("-")) {
      if (event === "error") h.child.emit(event, new Error("synthetic"));
      else h.child.emit(event, 1, null);
      expect(h.manager.status().state).not.toBe("Connected");
    }
    h.child.emit("error", new Error("duplicate")); h.child.exit(); h.child.emit("close", 0, null);
    expect(h.manager.status().running).toBe(false);
    expect(h.manager.status().state).toBe("Error");
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});
