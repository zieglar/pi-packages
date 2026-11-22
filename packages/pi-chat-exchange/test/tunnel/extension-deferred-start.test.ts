import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as background from "../../dist/tunnel/background-manager.js";

const seam = vi.hoisted(() => ({ gate: vi.fn() }));
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: seam.gate,
}));

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  seam.gate.mockReset();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ce-start-command-")); directories.push(directory);
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
  vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "");
  vi.stubEnv("CE_TUNNEL_PROFILE", join(directory, "profile.yaml"));
  vi.stubEnv("CE_TUNNEL_STATE_DIR", join(directory, "state"));
  const start = vi.fn();
  const actual = background.createBackgroundTunnelManager;
  const manager = vi.spyOn(background, "createBackgroundTunnelManager").mockImplementation(options => ({
    ...actual(options), startDeferred: start,
  }));
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const events = new Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>();
  const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: (name: string, handler: never) => events.set(name, handler), registerTool: vi.fn(), appendEntry: vi.fn(),
    registerCommand: (name: string, command: never) => commands.set(name, command) });
  const ctx = { mode: "tui", hasUI: true, cwd: directory,
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn(), confirm: vi.fn(), input: vi.fn(), custom: vi.fn(async () => undefined) } };
  return { start, manager, ctx, events, command: commands.get("ce-tunnel")! };
}

const guidance = "ce-tunnel: real service start is managed by Homebrew/launchd; CE only observes connectivity. Use /ce status, then operate the configured system service if needed.";

describe("real start command service guidance", () => {
  it("rechecks readiness and gives guidance for every repeated Start without queuing daemon work", async () => {
    const f = await fixture();
    for (let i = 0; i < 3; i++) await expect(f.command.handler("start", f.ctx)).resolves.toBeUndefined();
    expect(seam.gate).toHaveBeenCalledTimes(3);
    expect(f.manager).toHaveBeenCalledOnce();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.calls).toEqual(Array.from({ length: 3 }, () => [guidance, "info"]));
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
    expect(f.ctx.ui.custom).not.toHaveBeenCalled();
  });

  it("has no queued Start or late feedback after repeated Start and teardown", async () => {
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    await f.command.handler("start", f.ctx);
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(2);
    await f.events.get("session_shutdown")!({ reason: "exit" }, f.ctx);
    const notifications = f.ctx.ui.notify.mock.calls.length;
    const statusWrites = f.ctx.ui.setStatus.mock.calls.length;
    await Promise.resolve();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify).toHaveBeenCalledTimes(notifications);
    expect(f.ctx.ui.setStatus).toHaveBeenCalledTimes(statusWrites);
  });

  it.each(["CE_NATIVE_CACHE_MISSING", "CE_NATIVE_HASH_MISMATCH"])("preserves %s and rechecks readiness on the next Start", async code => {
    const f = await fixture();
    seam.gate.mockImplementationOnce(() => { throw Object.assign(new Error("private probe detail"), { code }); });
    await expect(f.command.handler("start", f.ctx)).resolves.toBeUndefined();
    expect(f.ctx.ui.notify).toHaveBeenCalledWith(`ce-tunnel: start refused ${code}; run /ce-native to inspect or install the trusted driver`, "warning");
    expect(f.manager).not.toHaveBeenCalled();
    await expect(f.command.handler("start", f.ctx)).resolves.toBeUndefined();
    expect(seam.gate).toHaveBeenCalledTimes(2);
    expect(f.manager).toHaveBeenCalledOnce();
    expect(f.ctx.ui.notify).toHaveBeenLastCalledWith(guidance, "info");
    expect(f.start).not.toHaveBeenCalled();
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
    expect(f.ctx.ui.custom).not.toHaveBeenCalled();
  });
});
