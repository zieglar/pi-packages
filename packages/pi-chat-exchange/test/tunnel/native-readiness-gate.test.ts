import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeEligibilityError } from "../../dist/storage/runtime.js";

const seam = vi.hoisted(() => ({
  gate: vi.fn(),
  inspect: vi.fn(() => ({ state: "READY", code: "CE_NATIVE_READY" })),
  run: vi.fn(async () => "unused"),
  manager: vi.fn(),
}));

vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: seam.gate,
  inspectNativeReadiness: seam.inspect,
  runNativeCommand: seam.run,
}));

vi.mock("../../dist/tunnel/background-manager.js", async original => ({
  ...await original<typeof import("../../src/tunnel/background-manager.js")>(),
  createBackgroundTunnelManager: (options: unknown) => seam.manager(options),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ce-native-gate-"));
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
  vi.stubEnv("CE_TUNNEL_PROFILE", join(dir, "profile.yaml"));
  vi.stubEnv("CE_TUNNEL_STATE_DIR", join(dir, "state"));
  const ack = deferred<unknown>(); const settled = deferred<unknown>();
  const start = vi.fn(() => ({ ack: ack.promise, settled: settled.promise }));
  const stop = vi.fn(async () => undefined);
  seam.manager.mockReturnValue({
    kind: "background",
    startDeferred: start,
    stop,
    runId: () => "synthetic-run",
    status: () => ({ label: "Tunnel · synthetic" }),
    refresh: async () => ({ state: "STOPPED", evidence: "none" }),
  });
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: vi.fn(), registerTool: vi.fn(), appendEntry: vi.fn(),
    registerCommand: (name: string, command: never) => commands.set(name, command) });
  const ctx = { mode: "tui", hasUI: true, cwd: dir,
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn(async () => undefined) } };
  return { ctx, start, stop, command: commands.get("ce-tunnel")!, dir };
}

afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  seam.gate.mockReset(); seam.inspect.mockReset().mockReturnValue({ state: "READY", code: "CE_NATIVE_READY" });
  seam.manager.mockReset(); seam.run.mockReset();
});

describe("Tunnel Native readiness gate", () => {
  it.each(["CE_NATIVE_CACHE_MISSING", "CE_NATIVE_HASH_MISMATCH"])("refuses start for %s before creating a manager or process", async code => {
    seam.gate.mockImplementation(() => { throw Object.assign(new Error("not ready"), { code }); });
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    expect(seam.manager).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes(code) && String(text).includes("/ce-native"))).toBe(true);
  });

  it("preserves Store runtime refusal when Native is ready before creating a manager", async () => {
    seam.gate.mockImplementation(() => { throw new RuntimeEligibilityError("private probe detail"); });
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    const text = f.ctx.ui.notify.mock.calls.map(([message]) => String(message)).join("\n");
    expect(text).toContain("STORAGE_RUNTIME_INELIGIBLE");
    expect(text).not.toContain("CE_NATIVE_INITIALIZATION_FAILED");
    expect(text).not.toContain("private probe detail");
    expect(seam.manager).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });
  it("revalidates on every start and refuses after Native disappears", async () => {
    const f = await fixture();
    seam.gate.mockReturnValueOnce({ state: "READY", code: "CE_NATIVE_READY" })
      .mockImplementationOnce(() => { throw Object.assign(new Error("removed"), { code: "CE_NATIVE_CACHE_MISSING" }); });
    await f.command.handler("start", f.ctx);
    await f.command.handler("start", f.ctx);
    expect(seam.gate).toHaveBeenCalledTimes(2);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes("CE_NATIVE_CACHE_MISSING"))).toBe(true);
  });

  it("reports Native readiness separately from transport status", async () => {
    seam.inspect.mockReturnValue({ state: "MISSING", code: "CE_NATIVE_CACHE_MISSING" });
    const f = await fixture();
    await f.command.handler("status", f.ctx);
    const text = f.ctx.ui.notify.mock.calls.map(([message]) => String(message)).join("\n");
    expect(text).toContain("native=MISSING (CE_NATIVE_CACHE_MISSING)");
    expect(text).toContain("transport lifecycle is reported separately");
  });

  it("does not block owned stop when Native is unavailable", async () => {
    seam.gate.mockImplementation(() => { throw Object.assign(new Error("not ready"), { code: "CE_NATIVE_CACHE_MISSING" }); });
    const f = await fixture();
    await f.command.handler("stop", f.ctx);
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(seam.gate).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes("stopped the owned real background tunnel"))).toBe(true);
  });
});
