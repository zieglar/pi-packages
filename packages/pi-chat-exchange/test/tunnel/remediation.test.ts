/**
 * HANDOFF-CE-HOST-09 B1.1 remediation — regressions for the five correctness
 * gaps the parent reproduced (evidence/b11/parent-gap-repro.mjs).
 *
 * 1. `component.dispose()` left the `ui.custom` capture promise unsettled, so a
 *    session teardown could hang the caller forever.
 * 2. A replayed/duplicate, missing, or non-integer simulator health `sequence`
 *    was stamped as a fresh completion, refreshing an expired Unknown back to
 *    Connected.
 * 3. A ChildProcess `error` event was treated as exit proof even though it is
 *    also emitted when signal delivery fails while the process stays alive;
 *    `stop()` then no-opped (no signal at all) and claimed "not running".
 * 4. The extension dropped the manager and fire-and-forgot `dispose()`, so a
 *    shutdown/reload/session_start could resolve before the owned child exited
 *    and the live handle was lost on a stop failure.
 * 5. The native runner could compile twice concurrently and leak a temporary
 *    directory when disposed during a compile, and had no way to target an
 *    exclusively owned probe keychain without touching the default one.
 *
 * None of these tests touch a real Keychain, a real tunnel client, a provider,
 * or a user configuration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TEST_KEYS } from "./keys-stub.js";
import {
  captureTunnelSecret,
  type SecureInputContextView,
  type SecureInputTuiView,
} from "../../src/tunnel/secure-input.js";
import { createTunnelManager, type ManagedChildView } from "../../src/tunnel/manager.js";
import {
  createKeychainCredentialStore,
  createNativeKeychainRunner,
  OFFLINE_SYNTHETIC_SCOPE,
  type HelperSpawnOptions,
} from "../../src/tunnel/keychain.js";

// Tunnel lifecycle tests are not Native qualification: keep the Native readiness gate
// out of these scenarios. Native readiness itself is covered by native-readiness-gate.test.ts.
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

// ---------------------------------------------------------------------------
// Gap 1 — dispose must settle the capture exactly once.
// ---------------------------------------------------------------------------

interface CapturedComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}

function tuiPort(options: { disposeOnDone?: boolean } = {}) {
  let component: CapturedComponent | undefined;
  let doneCalls = 0;
  const ctx: SecureInputContextView = {
    mode: "tui",
    ui: {
      custom<T>(factory: (tui: SecureInputTuiView, theme: unknown, keys: unknown, done: (result: T) => void) => CapturedComponent): Promise<T> {
        return new Promise<T>((resolve) => {
          component = factory({ requestRender() {} }, null, null, (result: T) => {
            doneCalls += 1;
            // The real runtime unmounts (and therefore disposes) the component
            // when it resolves, which must not re-enter the finish path.
            if (options.disposeOnDone === true) component?.dispose?.();
            resolve(result);
          });
        });
      },
    },
  };
  return {
    ctx,
    component: (): CapturedComponent => {
      if (component === undefined) throw new Error("component was not installed");
      return component;
    },
    doneCalls: () => doneCalls,
  };
}

const settledWithin = async <T,>(promise: Promise<T>, ms: number): Promise<T | "UNSETTLED"> =>
  Promise.race([promise, new Promise<"UNSETTLED">((resolve) => setTimeout(() => resolve("UNSETTLED"), ms))]);

describe("B1.1 remediation 1 — secure input dispose settles the capture", () => {
  it("settles the capture promise as cancelled when the component is disposed", async () => {
    const port = tuiPort();
    const store = vi.fn(async () => {
      throw new Error("must never store on dispose");
    });
    const capture = captureTunnelSecret(port.ctx, { store }, { timeoutMs: 60_000, keys: TEST_KEYS });
    port.component().dispose?.();
    const outcome = await settledWithin(capture, 50);
    expect(outcome).toMatchObject({ status: "cancelled" });
    expect(store).not.toHaveBeenCalled();
  });

  it("finishes once when the runtime disposes re-entrantly from done", async () => {
    const port = tuiPort({ disposeOnDone: true });
    const capture = captureTunnelSecret(port.ctx, { async store() {} }, { timeoutMs: 60_000, keys: TEST_KEYS });
    port.component().dispose?.();
    await expect(settledWithin(capture, 50)).resolves.toMatchObject({ status: "cancelled" });
    port.component().dispose?.();
    expect(port.doneCalls()).toBe(1);
  });

  it("does not override a submitted outcome when the runtime disposes afterwards", async () => {
    const port = tuiPort({ disposeOnDone: true });
    const stored: string[] = [];
    const capture = captureTunnelSecret(
      port.ctx,
      {
        async store(secret: string) {
          stored.push(secret);
        },
      },
      { timeoutMs: 60_000, keys: TEST_KEYS },
    );
    port.component().handleInput?.("s3cret-value");
    port.component().handleInput?.("\r");
    await expect(settledWithin(capture, 50)).resolves.toMatchObject({ status: "stored" });
    expect(stored).toEqual(["s3cret-value"]);
    expect(port.doneCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gaps 2 and 3 — manager health sequence discipline and error-is-not-exit.
// ---------------------------------------------------------------------------

const HEALTHY = {
  simulated: true,
  result: "ok",
  healthz: { ok: true, status: 200, body: "live" },
  readyz: { ok: true, status: 200, body: "ready" },
  process: { running: true },
};

const UNHEALTHY = {
  simulated: true,
  result: "fail",
  healthz: { ok: true, status: 200, body: "live" },
  readyz: { ok: false, status: 503, body: "not ready" },
  process: { running: true },
};

class FakeChild {
  readonly kills: string[] = [];
  readonly stdout = {
    listeners: [] as ((chunk: Buffer) => void)[],
    on(event: string, listener: (chunk: Buffer) => void) {
      if (event === "data") this.listeners.push(listener);
    },
  };
  readonly stderr = { resume() {} };
  private readonly exitListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  private readonly errorListeners: ((error: Error) => void)[] = [];

  constructor(readonly pid: number) {}

  on(event: string, listener: (...args: never[]) => void): this {
    if (event === "exit" || event === "close") {
      this.exitListeners.push(listener as unknown as (code: number | null, signal: NodeJS.Signals | null) => void);
    }
    if (event === "error") this.errorListeners.push(listener as unknown as (error: Error) => void);
    return this;
  }

  kill(signal?: string): boolean {
    this.kills.push(signal ?? "SIGTERM");
    return true;
  }

  emit(record: unknown): void {
    const text = typeof record === "string" ? record : JSON.stringify(record);
    for (const listener of [...this.stdout.listeners]) listener(Buffer.from(`${text}\n`, "utf8"));
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }
}

function managerHarness() {
  let clock = 1_000;
  const children: FakeChild[] = [];
  const spawn = vi.fn(() => {
    const child = new FakeChild(40_000 + children.length);
    children.push(child);
    return child as unknown as ManagedChildView;
  });
  const manager = createTunnelManager({
    env: { CE_TUNNEL_OFFLINE_TEST: "1" },
    now: () => clock,
    spawn,
    nodeExecPath: "/approved/node",
    clientScript: "/bundled/offline-client.js",
  });
  const child = (index = 0): FakeChild => {
    const found = children[index];
    if (found === undefined) throw new Error(`no child at index ${index}`);
    return found;
  };
  return {
    manager,
    spawn,
    children,
    child,
    advance: (ms: number) => {
      clock += ms;
    },
    at: () => clock,
    health: (overrides: Record<string, unknown> = {}, index = 0) =>
      child(index).emit({
        event: "health",
        runId: manager.runId(),
        pid: child(index).pid,
        simulated: true,
        sequence: 1,
        payload: HEALTHY,
        ...overrides,
      }),
  };
}

describe("B1.1 remediation 2 — only a strictly increasing simulator sequence is consumed", () => {
  it("never refreshes an expired Unknown from a replayed identical record", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(500);
    h.health({ sequence: 1 });
    expect(h.manager.status().state).toBe("Connected");
    h.advance(20_000);
    expect(h.manager.status().state).not.toBe("Connected");
    // Exactly the record the parent replayed: same run, same pid, same sequence.
    h.health({ sequence: 1 });
    h.advance(1);
    h.health({ sequence: 1 });
    expect(h.manager.status().state).not.toBe("Connected");
  });

  it.each([
    ["missing sequence", { sequence: undefined }],
    ["zero sequence", { sequence: 0 }],
    ["negative sequence", { sequence: -1 }],
    ["fractional sequence", { sequence: 1.5 }],
    ["string sequence", { sequence: "1" }],
    ["unsafe sequence", { sequence: Number.MAX_SAFE_INTEGER + 2 }],
    ["not explicitly simulated", { simulated: false }],
  ])("refuses a record with %s", async (_name, overrides) => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(500);
    h.health(overrides);
    expect(h.manager.status().state).not.toBe("Connected");
  });

  it("refuses a lower or equal sequence after a higher one, and accepts the next increase", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(500);
    h.health({ sequence: 7 });
    expect(h.manager.status().state).toBe("Connected");
    h.advance(20_000);
    h.health({ sequence: 6 });
    h.health({ sequence: 7 });
    expect(h.manager.status().state).not.toBe("Connected");
    h.health({ sequence: 8 });
    expect(h.manager.status().state).toBe("Connected");
  });

  it("keeps failure and recovery counting on distinct increasing sequences", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(500);
    h.health({ sequence: 1 });
    expect(h.manager.status().state).toBe("Connected");
    for (const sequence of [2, 3, 4]) {
      h.advance(100);
      h.health({ sequence, payload: UNHEALTHY });
    }
    expect(h.manager.status().state).toBe("Disconnected");
    // A replayed sequence cannot advance the recovery counter M.
    h.advance(100);
    h.health({ sequence: 5 });
    h.advance(100);
    h.health({ sequence: 5 });
    expect(h.manager.status().state).not.toBe("Connected");
    // M = 2 DISTINCT healthy completions do leave recovery. A status read is a
    // freshness tick that resets the healthy streak (frozen state.ts), so the
    // two completions are observed without an intervening read.
    h.advance(100);
    h.health({ sequence: 6 });
    h.advance(100);
    h.health({ sequence: 7 });
    expect(h.manager.status().state).toBe("Connected");
  });

  it("accepts activity only from an explicitly simulated, attributed, live record", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(100);
    const base = { event: "activity", runId: h.manager.runId(), pid: h.child().pid, kind: "simulated-request" };
    h.child().emit({ ...base, simulated: false });
    expect(h.manager.status().clientActivity.observed).toBe(false);
    h.child().emit({ ...base, runId: "another-run", simulated: true });
    expect(h.manager.status().clientActivity.observed).toBe(false);
    h.child().emit({ ...base, simulated: true });
    expect(h.manager.status().clientActivity.observed).toBe(true);
  });

  it("refuses a stale activity record emitted after the owned child exited", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(100);
    h.child().emitExit(0, null);
    h.child().emit({
      event: "activity",
      runId: h.manager.runId(),
      pid: h.child().pid,
      kind: "simulated-request",
      simulated: true,
    });
    expect(h.manager.status().clientActivity.observed).toBe(false);
  });
});

describe("B1.1 remediation 3 — a ChildProcess error is not exit proof", () => {
  it("keeps the owned pid and still signals and awaits an actual exit", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.advance(100);
    h.child().emitError(new Error("synthetic signal failure, child still alive"));
    const errored = h.manager.status();
    expect(errored.state).toBe("Error");
    // The pid was retained: ownership cannot be abandoned on a signal error.
    expect(errored.running).toBe(true);
    await expect(h.manager.stop({ graceMs: 1, killTimeoutMs: 1 })).rejects.toMatchObject({
      code: "CE_TUNNEL_STOP_UNCONFIRMED",
    });
    // Approved single-request policy; unconfirmed still means owned/live.
    expect(h.child().kills).toEqual(["SIGTERM"]);
    expect(h.manager.status().running).toBe(true);
  });

  it("never spawns a second child because of an error event", async () => {
    const h = managerHarness();
    const first = await h.manager.start();
    h.child().emitError(new Error("synthetic signal failure"));
    const second = await h.manager.start();
    expect(second.runId).toBe(first.runId);
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.children).toHaveLength(1);
  });

  it("confirms the stop once the actual exit arrives after the error", async () => {
    const h = managerHarness();
    await h.manager.start();
    h.child().emitError(new Error("synthetic signal failure"));
    const stopping = h.manager.stop({ graceMs: 5_000, killTimeoutMs: 5_000 });
    expect(h.child().kills).toEqual(["SIGTERM"]);
    h.child().emitExit(null, "SIGTERM");
    await expect(stopping).resolves.toBeUndefined();
    const stopped = h.manager.status();
    expect(stopped.running).toBe(false);
    expect(stopped.state).toBe("Stopped");
  });

  it("treats a close event as exit proof exactly once", async () => {
    const h = managerHarness();
    await h.manager.start();
    const stopping = h.manager.stop({ graceMs: 5_000, killTimeoutMs: 5_000 });
    h.child().emitExit(0, null);
    h.child().emitExit(0, null);
    await expect(stopping).resolves.toBeUndefined();
    expect(h.manager.status().running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gap 5 — native runner concurrency, dispose during compile, probe keychain.
// ---------------------------------------------------------------------------

const PROBE_SECRET = "probe-secret-0001";

function compileSeam(options: { delayMs?: number; fail?: boolean } = {}) {
  const disposals: string[] = [];
  let created = 0;
  const compile = vi.fn(async () => {
    created += 1;
    const executable = `/tmp/fake-helper-${created}/tunnel-keychain`;
    if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    if (options.fail === true) throw new Error("synthetic compile failure");
    return {
      executable,
      dispose: async () => {
        disposals.push(executable);
      },
    };
  });
  return { compile, disposals, created: () => created };
}

function spawnSeam(response: string) {
  const frames: string[] = [];
  const spawnHelper = vi.fn(async (_executable: string, options: HelperSpawnOptions) => {
    frames.push(options.stdin);
    return { stdout: `${response}\n`, code: 0, timedOut: false };
  });
  return { spawnHelper, frames };
}

describe("B1.1 remediation 5 — native runner compile serialization and dispose", () => {
  it("compiles at most once for concurrent operations", async () => {
    const seam = compileSeam({ delayMs: 10 });
    const transport = spawnSeam('{"status":"ok"}');
    const runner = createNativeKeychainRunner({ compile: seam.compile, spawnHelper: transport.spawnHelper });
    const store = createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE });
    await Promise.all([store.exists(), store.exists(), store.exists()]);
    expect(seam.compile).toHaveBeenCalledTimes(1);
    await runner.dispose();
    expect(seam.disposals).toHaveLength(1);
  });

  it("disposes the artifact exactly once when disposed during a compile", async () => {
    const seam = compileSeam({ delayMs: 20 });
    const transport = spawnSeam('{"status":"ok"}');
    const runner = createNativeKeychainRunner({ compile: seam.compile, spawnHelper: transport.spawnHelper });
    const store = createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE });
    const inFlight = store.exists();
    await runner.dispose();
    await expect(inFlight).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    expect(seam.created()).toBe(1);
    // The temporary directory created while disposing must not leak.
    expect(seam.disposals).toHaveLength(1);
    expect(transport.spawnHelper).not.toHaveBeenCalled();
  });

  it("does not cache a failed compile as success and never retries inside one call", async () => {
    const seam = compileSeam({ fail: true });
    const transport = spawnSeam('{"status":"ok"}');
    const runner = createNativeKeychainRunner({ compile: seam.compile, spawnHelper: transport.spawnHelper });
    const store = createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE });
    await expect(store.exists()).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    await expect(store.exists()).rejects.toMatchObject({ code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE" });
    expect(seam.compile).toHaveBeenCalledTimes(2);
    await runner.dispose();
    expect(seam.disposals).toHaveLength(0);
  });
});

describe("B1.1 remediation 5 — explicit probe keychain targeting", () => {
  const frameHeader = (frame: string): string => frame.split("\n", 1)[0] ?? "";

  it("sends the production frame with no keychain field by default", async () => {
    const seam = compileSeam();
    const transport = spawnSeam('{"status":"ok"}');
    const runner = createNativeKeychainRunner({ compile: seam.compile, spawnHelper: transport.spawnHelper });
    await createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE }).exists();
    expect(frameHeader(transport.frames[0] ?? "").split(" ")).toHaveLength(4);
  });

  it("appends exactly one explicit probe keychain path when configured", async () => {
    const seam = compileSeam();
    const transport = spawnSeam('{"status":"ok"}');
    const probeKeychainPath = "/tmp/b11-probe/owned-probe.keychain";
    const runner = createNativeKeychainRunner({
      compile: seam.compile,
      spawnHelper: transport.spawnHelper,
      probeKeychainPath,
    });
    await createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE }).store(PROBE_SECRET);
    for (const frame of transport.frames) {
      const fields = frameHeader(frame).split(" ");
      expect(fields).toHaveLength(5);
      expect(Number(fields[4])).toBe(Buffer.byteLength(probeKeychainPath, "utf8"));
      expect(frame.endsWith(probeKeychainPath)).toBe(true);
    }
    // The secret still travels only on framed stdin, never in argv or env.
    const call = transport.spawnHelper.mock.calls.at(-1);
    expect(JSON.stringify(call?.[1]?.args ?? [])).not.toContain(PROBE_SECRET);
  });

  it.each([
    ["relative", "owned-probe.keychain"],
    ["newline", "/tmp/probe\n.keychain"],
    ["nul", "/tmp/probe\u0000.keychain"],
    ["empty", ""],
  ])("refuses a %s probe keychain path without spawning the helper", async (_name, probeKeychainPath) => {
    const seam = compileSeam();
    const transport = spawnSeam('{"status":"ok"}');
    const runner = createNativeKeychainRunner({
      compile: seam.compile,
      spawnHelper: transport.spawnHelper,
      probeKeychainPath,
    });
    await expect(createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE }).exists()).rejects.toMatchObject({
      code: "CE_TUNNEL_KEYCHAIN_UNAVAILABLE",
    });
    expect(transport.spawnHelper).not.toHaveBeenCalled();
  });

  it("never takes the keychain path from the environment or a request", async () => {
    vi.stubEnv("CE_TUNNEL_KEYCHAIN_PATH", "/tmp/attacker.keychain");
    try {
      const seam = compileSeam();
      const transport = spawnSeam('{"status":"ok"}');
      const runner = createNativeKeychainRunner({ compile: seam.compile, spawnHelper: transport.spawnHelper });
      await createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE }).exists();
      expect(transport.frames.join("\n")).not.toContain("attacker");
      // A request-level keychain field is ignored by the runner contract.
      await runner.run({
        op: "exists",
        service: "pi-chat-exchange-tunnel",
        account: (await Promise.resolve(createKeychainCredentialStore({ runner, scope: OFFLINE_SYNTHETIC_SCOPE }))).account,
        keychainPath: "/tmp/attacker.keychain",
      } as never);
      expect(transport.frames.join("\n")).not.toContain("attacker");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 4 — awaitable, idempotent extension transport cleanup.
// ---------------------------------------------------------------------------

interface FakeManagerScript {
  readonly disposeMode: "resolve" | "delay" | "reject";
}

const managerScript: { current: FakeManagerScript } = { current: { disposeMode: "resolve" } };
const managerLog: { created: number; disposes: number; releaseDispose: (() => void)[] } = {
  created: 0,
  disposes: 0,
  releaseDispose: [],
};

// The extension runs against `dist`, so the refusal thrown here must be the
// dist class: `refusalText` maps it by `instanceof`.
vi.mock("../../dist/tunnel/manager.js", async () => {
  const { TunnelRefusal } = await import("../../dist/tunnel/codes.js");
  return {
  createTunnelManager: () => {
    managerLog.created += 1;
    let running = true;
    return {
      start: async () => ({ runId: "offline-fake-run" }),
      stop: async () => undefined,
      runId: () => "offline-fake-run",
      status: () => ({
        mode: "offline-simulated",
        state: running ? "Starting" : "Stopped",
        label: `Tunnel ${running ? "◐ starting" : "○ stopped"} (offline simulated)`,
        evidence: "none",
        running,
        runId: "offline-fake-run",
        clientActivity: { observed: false, simulated: true, at: undefined },
      }),
      dispose: async () => {
        managerLog.disposes += 1;
        const mode = managerScript.current.disposeMode;
        if (mode === "reject") throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
        if (mode === "delay") {
          await new Promise<void>((resolve) => {
            managerLog.releaseDispose.push(resolve);
          });
        }
        running = false;
      },
    };
  },
  };
});

const EXTENSION_URL = new URL("../../pi-extension/index.ts", import.meta.url).href;

interface FakeCtx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): undefined; getBranch(): [] };
  ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> };
}

function fakeCtx(mode = "tui"): FakeCtx {
  return {
    mode,
    hasUI: true,
    cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}

async function extension() {
  const events = new Map<string, (event: { reason: string }, ctx: FakeCtx) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: FakeCtx) => unknown }>();
  const { default: factory } = (await import(EXTENSION_URL)) as { default: (pi: unknown) => void };
  factory({
    on: (name: string, handler: (event: { reason: string }, ctx: FakeCtx) => unknown) => events.set(name, handler),
    registerTool: () => undefined,
    registerCommand: (name: string, options: { handler: (args: string, ctx: FakeCtx) => unknown }) => commands.set(name, options),
    appendEntry: () => undefined,
  });
  return {
    command: (args: string, ctx: FakeCtx) => commands.get("ce-tunnel")?.handler(args, ctx),
    event: (name: string, reason: string, ctx: FakeCtx) => events.get(name)?.({ reason }, ctx),
  };
}

function notifications(ctx: FakeCtx): string {
  return ctx.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
}

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // LOCAL-BACKGROUND-01: these lifecycle tests drive the mocked OFFLINE manager.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  managerScript.current = { disposeMode: "resolve" };
  managerLog.created = 0;
  managerLog.disposes = 0;
  managerLog.releaseDispose = [];
});

afterEach(() => {
  for (const release of managerLog.releaseDispose) release();
  managerLog.releaseDispose = [];
  vi.unstubAllEnvs();
});

describe("B1.1 remediation 4 — extension transport cleanup is awaitable", () => {
  it("does not resolve a shutdown before the owned child actually exits", async () => {
    managerScript.current = { disposeMode: "delay" };
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("status", ctx);
    let settled = false;
    const shutting = Promise.resolve(api.event("session_shutdown", "shutdown", ctx)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled, "shutdown resolved while the owned child was still exiting").toBe(false);
    for (const release of managerLog.releaseDispose) release();
    managerLog.releaseDispose = [];
    await shutting;
    expect(settled).toBe(true);
    expect(managerLog.disposes).toBe(1);
  });

  it("does not resolve session_start before the previous transport is released", async () => {
    managerScript.current = { disposeMode: "delay" };
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("status", ctx);
    let settled = false;
    const starting = Promise.resolve(api.event("session_start", "reload", ctx)).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    for (const release of managerLog.releaseDispose) release();
    managerLog.releaseDispose = [];
    await starting;
    expect(managerLog.disposes).toBe(1);
  });

  it("joins overlapping teardowns into a single dispose", async () => {
    managerScript.current = { disposeMode: "delay" };
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("status", ctx);
    const first = Promise.resolve(api.event("session_shutdown", "shutdown", ctx));
    const second = Promise.resolve(api.event("session_shutdown", "shutdown", ctx));
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const release of managerLog.releaseDispose) release();
    managerLog.releaseDispose = [];
    await Promise.all([first, second]);
    expect(managerLog.disposes).toBe(1);
  });

  it("keeps the live owned handle when the stop cannot be confirmed and reports the code", async () => {
    managerScript.current = { disposeMode: "reject" };
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("status", ctx);
    expect(managerLog.created).toBe(1);
    await expect(Promise.resolve(api.event("session_shutdown", "shutdown", ctx))).resolves.not.toThrow();
    // The handle must NOT be dropped: a second teardown retries the same one.
    await Promise.resolve(api.event("session_shutdown", "shutdown", ctx));
    expect(managerLog.disposes).toBe(2);
    expect(managerLog.created).toBe(1);
    const report = fakeCtx();
    await api.command("status", report);
    expect(notifications(report)).toContain("CE_TUNNEL_STOP_UNCONFIRMED");
    expect(managerLog.created).toBe(1);
  });

  it("releases a successfully disposed manager so a new session starts a fresh one", async () => {
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("status", ctx);
    await Promise.resolve(api.event("session_shutdown", "shutdown", ctx));
    expect(managerLog.disposes).toBe(1);
    await api.command("status", fakeCtx());
    expect(managerLog.created).toBe(2);
  });

  it("cleans up and awaits even when CE is disabled for the session", async () => {
    managerScript.current = { disposeMode: "delay" };
    const api = await extension();
    const ctx = fakeCtx();
    await api.command("start", ctx);
    const shutting = Promise.resolve(api.event("session_shutdown", "shutdown", ctx));
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const release of managerLog.releaseDispose) release();
    managerLog.releaseDispose = [];
    await shutting;
    expect(managerLog.disposes).toBe(1);
    expect(notifications(ctx)).not.toMatch(/delivered|acknowledged|ChatGPT/i);
  });

  it("never publishes a cleared status key to a new session port", async () => {
    const api = await extension();
    const old = fakeCtx();
    await api.command("status", old);
    await Promise.resolve(api.event("session_shutdown", "shutdown", old));
    const fresh = fakeCtx();
    old.ui.setStatus.mockClear();
    await Promise.resolve(api.event("session_shutdown", "shutdown", fresh));
    expect(old.ui.setStatus).not.toHaveBeenCalled();
    expect(fresh.ui.setStatus).not.toHaveBeenCalled();
  });
});
