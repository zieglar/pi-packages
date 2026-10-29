import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as background from "../../dist/tunnel/background-manager.js";
import type { BackgroundStartAck, BackgroundStartResult } from "../../dist/tunnel/background-manager.js";

// Tunnel lifecycle tests are not Native qualification: keep the Native readiness gate
// out of these scenarios. Native readiness itself is covered by native-readiness-gate.test.ts.
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const ackValue: BackgroundStartAck = { runId: "synthetic-run", pid: 40001, tunnelId: "tunnel_123456…", startedAt: "2026-01-01T00:00:00.000Z" };
const resultValue: BackgroundStartResult = { ...ackValue, health: "connected", alreadyRunning: false };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ce-start-command-")); directories.push(directory);
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
  vi.stubEnv("CE_TUNNEL_PROFILE", join(directory, "profile.yaml"));
  vi.stubEnv("CE_TUNNEL_STATE_DIR", join(directory, "state"));
  const ack = pending<BackgroundStartAck>();
  const settled = pending<BackgroundStartResult>();
  const start = vi.fn(() => ({ ack: ack.promise, settled: settled.promise }));
  const actual = background.createBackgroundTunnelManager;
  // Only the daemon start is controlled: the registered extension, its command
  // lifecycle, status projection and notification guards are production code.
  vi.spyOn(background, "createBackgroundTunnelManager").mockImplementation((options) => ({
    ...actual(options), startDeferred: start,
  }));
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const events = new Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>();
  const extensionUrl = new URL("../../pi-extension/index.ts", import.meta.url).href;
  const { default: factory } = await import(extensionUrl);
  factory({ on: (name: string, handler: never) => events.set(name, handler), registerTool: vi.fn(), appendEntry: vi.fn(),
    registerCommand: (name: string, command: never) => commands.set(name, command) });
  const ctx = { mode: "tui", hasUI: true, cwd: directory,
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn(async () => undefined) } };
  return { start, ack, settled, ctx, events, command: commands.get("ce-tunnel")! };
}
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

describe("real start command session latch", () => {
  it("returns before readiness and merges repeated Start until the terminal result", async () => {
    const f = await fixture();
    await f.command.handler("start", f.ctx); // must not await the pending daemon
    await f.command.handler("start", f.ctx);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => /already in progress/i.test(String(text)))).toBe(true);
    f.ack.resolve(ackValue); await flush();
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes("real background tunnel starting (run synthetic-run"))).toBe(true);
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes("health=connected"))).toBe(false);
    f.settled.resolve(resultValue); await flush();
    await f.command.handler("start", f.ctx);
    expect(f.start).toHaveBeenCalledTimes(2); // latch releases at terminal success
  });

  it("suppresses every deferred notification after a repeated start then session teardown", async () => {
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    await f.command.handler("start", f.ctx);
    await f.events.get("session_shutdown")!({ reason: "exit" }, f.ctx);
    const notifications = f.ctx.ui.notify.mock.calls.length;
    const statusWrites = f.ctx.ui.setStatus.mock.calls.length;
    f.ack.resolve(ackValue); f.settled.resolve(resultValue); await flush();
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(notifications);
    expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(statusWrites);
  });

  it("keeps the failure code and releases the latch after a refusal", async () => {
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    const { TunnelRefusal } = await import("../../dist/tunnel/codes.js");
    const error = new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT");
    f.ack.reject(error); f.settled.reject(error); await flush();
    expect(f.ctx.ui.notify.mock.calls.some(([text]) => String(text).includes("CE_TUNNEL_READY_TIMEOUT"))).toBe(true);
    await f.command.handler("start", f.ctx);
    expect(f.start).toHaveBeenCalledTimes(2);
  });
});
