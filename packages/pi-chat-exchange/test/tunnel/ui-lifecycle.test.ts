import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_URL = new URL("../../pi-extension/index.ts", import.meta.url).href;
function context(mode = "tui") {
  return {
    mode, hasUI: true, cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { notify: vi.fn(), setStatus: vi.fn() },
  };
}
type Context = ReturnType<typeof context>;
type Handler = (event: { reason: string }, ctx: Context) => void | Promise<void>;
async function instance() {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { handler: (arg: string, ctx: Context) => void | Promise<void> }>();
  const { default: factory } = await import(MODULE_URL);
  factory({ on: (name: string, handler: Handler) => events.set(name, handler), registerTool() {}, registerCommand: (name: string, command: { handler: (arg: string, ctx: Context) => void | Promise<void> }) => commands.set(name, command), appendEntry() {} });
  return {
    status: (ctx: Context) => commands.get("ce-tunnel")!.handler("status", ctx),
    event: (name: string, reason: string, ctx: Context) => events.get(name)!({ reason }, ctx),
  };
}
beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // LOCAL-BACKGROUND-01: this file pins the OFFLINE simulator surfaces.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
});
afterEach(() => vi.unstubAllEnvs());
// B1.1 contract update: the transport now publishes THREE separate status keys
// (CE runtime, offline tunnel health, observed client activity) instead of one,
// so cleanup must clear all three. The FG-C3 lifecycle intent is unchanged.
const KEYS = ["ce", "ce-client", "ce-tunnel"] as const;
function keysOf(ctx: Context): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const call of ctx.ui.setStatus.mock.calls) map.set(String(call[0]), call[1] as string | undefined);
  return map;
}
function expectAllCleared(ctx: Context): void {
  const seen = keysOf(ctx);
  expect([...seen.keys()].sort()).toEqual([...KEYS]);
  for (const key of KEYS) expect(seen.get(key)).toBeUndefined();
}
describe("FG-C3 real registered lifecycle handlers, instance-local UI", () => {
  it.each(["shutdown", "reload"])("clears unbound UI on %s and releases reference", async (reason) => {
    const api = await instance();
    const ctx = context();
    await api.event("session_start", "startup", ctx);
    await api.status(ctx);
    expect(keysOf(ctx).get("ce-tunnel")).toBe("Tunnel ○ stopped (offline simulated)");
    ctx.ui.setStatus.mockClear();
    await api.event(reason === "reload" ? "session_start" : "session_shutdown", reason, ctx);
    expectAllCleared(ctx);
    const count = ctx.ui.setStatus.mock.calls.length;
    await api.event("session_shutdown", "shutdown", ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(count);
  });
  it("does not clear another factory's UI target", async () => {
    const a = await instance(), b = await instance();
    const ca = context(), cb = context();
    await a.status(ca);
    await b.status(cb);
    const publishedByB = cb.ui.setStatus.mock.calls.length;
    ca.ui.setStatus.mockClear();
    await a.event("session_shutdown", "shutdown", ca);
    expectAllCleared(ca);
    // B's port must be untouched by A's teardown.
    expect(cb.ui.setStatus.mock.calls.length).toBe(publishedByB);
    cb.ui.setStatus.mockClear();
    await b.event("session_shutdown", "shutdown", cb);
    expectAllCleared(cb);
  });
  it("retains mode=tui guard for command and lifecycle paths", async () => {
    for (const mode of ["rpc", "json", "print"]) {
      const api = await instance(), ctx = context(mode);
      await api.status(ctx);
      await api.event("session_start", "reload", ctx);
      await api.event("session_shutdown", "shutdown", ctx);
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    }
  });
  it("cleanup failure does not block teardown or retain the port", async () => {
    const api = await instance(), ctx = context();
    await api.status(ctx);
    ctx.ui.setStatus.mockImplementation(() => { throw new Error("synthetic UI failure"); });
    await expect(Promise.resolve(api.event("session_shutdown", "shutdown", ctx))).resolves.toBeUndefined();
    const count = ctx.ui.setStatus.mock.calls.length;
    await api.event("session_shutdown", "shutdown", ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledTimes(count);
  });
});
