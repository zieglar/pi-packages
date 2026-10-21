import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";

// Guarded import makes the initial RED an assertion about the missing feature.
const MODULE = "../../src/tunnel/manager-ui.js";
interface ManagerApi {
  runTunnelManagerUi(ctx: { mode: string; hasUI: boolean; ui: object }, ports: {
    read(): Promise<unknown>; setup(): Promise<unknown>; start(): Promise<unknown>; stop(): Promise<unknown>;
  }, options?: Record<string, unknown>): Promise<unknown>;
  tunnelManagerActions(projection: unknown): readonly string[];
}
async function api() {
  const loaded = await import(MODULE).catch(() => undefined);
  expect(loaded, "Tunnel Manager TUI adapter module").toBeDefined();
  expect(typeof loaded?.runTunnelManagerUi).toBe("function");
  return loaded as ManagerApi;
}

function projection(state = "STOPPED") {
  // A STOPPED profile with one missing field is the repairable (Edit) case.
  const stoppedRepairable = state === "STOPPED";
  return {
    state, profilePath: "/synthetic/tunnel.yaml", tunnelIdAlreadyMasked: "tunnel_ABCDEF…",
    organizationConfigured: true, binding: stoppedRepairable ? "invalid" : "configured",
    credentialConfigured: !stoppedRepairable, evidence: "none",
  };
}
function fixture(state = "STOPPED") {
  const tui = createTuiHarness({ width: 110, rows: 35 });
  let view = projection(state);
  const ports = {
    read: vi.fn(async () => view), setup: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
  };
  const notify = vi.fn();
  const ctx = { mode: "tui", hasUI: true, ui: { custom: tui.custom, notify } };
  return { tui, ports, ctx, notify, set: (next: ReturnType<typeof projection>) => { view = next; }, current: () => view };
}
async function open(state = "STOPPED", options: Record<string, unknown> = {}) {
  const mod = await api();
  const f = fixture(state);
  const running = mod.runTunnelManagerUi(f.ctx, f.ports as Parameters<typeof mod.runTunnelManagerUi>[1], options);
  await f.tui.waitForOpen();
  return { ...f, running };
}
async function activate(f: Awaited<ReturnType<typeof open>>, label: string) {
  // Navigate actual Kit bindings, not a mocked action callback.
  const frame = f.tui.render();
  const rows = frame.filter((line) => /(?:Set Up Tunnel|Start Tunnel|Edit Configuration|Stop Tunnel|Refresh|Close)/.test(line));
  expect(rows.length).toBeGreaterThan(0);
  f.tui.press("home");
  const mod = await api();
  const state = (await f.ports.read.mock.results.at(-1)?.value)?.state ?? "UNKNOWN";
  const labels = rows.map((line) => line.replace(/^[^A-Za-z]*/, "").trim());
  const index = labels.findIndex((line) => line.startsWith(label));
  expect(index, `rendered actions include ${label}`).toBeGreaterThanOrEqual(0);
  for (let i = 0; i < index; i++) f.tui.press("tui.select.down");
  f.tui.press("tui.select.confirm");
  await f.tui.waitForPending();
  // Let runMenu finish its closed screen and load the next projection.
  await new Promise<void>((resolve) => setImmediate(resolve));
}
async function close(f: Awaited<ReturnType<typeof open>>) {
  f.tui.press("tui.select.cancel");
  await expect(f.running).resolves.toEqual({ status: "closed" });
}

afterEach(() => vi.useRealTimers());

describe("Tunnel Manager Kit interaction", () => {
  it("loads fresh projection and separates configuration from runtime", async () => {
    const f = await open();
    expect(f.ports.read).toHaveBeenCalledTimes(1);
    const frame = f.tui.render().join("\n");
    for (const label of ["Profile", "Tunnel", "Organization", "MCP binding", "Runtime State", "Credential", "Configured != Connected"]) expect(frame).toContain(label);
    expect(frame).toContain("STOPPED");
    expect(frame).toContain("tunnel_ABCDEF…");
    expect(f.notify).not.toHaveBeenCalled();
    await close(f);
    for (const action of [f.ports.setup, f.ports.start, f.ports.stop]) expect(action).not.toHaveBeenCalled();
  });

  it.each([
    // [projection, expected actions]
    [projection("UNCONFIGURED"), ["setup", "refresh", "close"]],
    [projection("STOPPED"), ["edit", "start", "refresh", "close"]],
    [projection("CONNECTED"), ["stop", "refresh", "close"]],
    [projection("STARTING"), ["refresh", "close"]],
    [projection("STOPPING"), ["refresh", "close"]],
    // Valid config + ERROR runtime: no start, no repair needed.
    [{ ...projection("ERROR") }, ["refresh", "close"]],
    [projection("DEGRADED"), ["refresh", "close"]],
    // UNKNOWN + fully valid config: no repair, no start (UNKNOWN != STOPPED).
    [projection("UNKNOWN"), ["refresh", "close"]],
  ])("limits contextual actions to the projection", async (proj, expected) => {
    const mod = await api();
    expect(mod.tunnelManagerActions(proj)).toEqual(expected);
    const f = await open((proj as ReturnType<typeof projection>).state);
    expect(f.tui.render().join("\n")).toContain((proj as ReturnType<typeof projection>).state);
    await close(f);
  });

  it.each([
    // invalid/unconfigured profile + runtime UNKNOWN -> setup/edit offered, no start/stop.
    [{ ...projection("UNKNOWN"), tunnelIdAlreadyMasked: undefined, organizationConfigured: false, binding: "missing", credentialConfigured: false, errorCode: "CE_TUNNEL_PROFILE_INVALID" }, "setup", "Set Up Tunnel"],
    [{ ...projection("UNKNOWN"), binding: "invalid", errorCode: "CE_TUNNEL_PROFILE_INVALID" }, "edit", "Edit Configuration"],
    [{ ...projection("UNKNOWN"), binding: "missing", credentialConfigured: false }, "edit", "Edit Configuration"],
  ])("UNKNOWN runtime with a repairable configuration offers %s as primary", async (proj, action, label) => {
    const mod = await api();
    const actions = mod.tunnelManagerActions(proj);
    expect(actions[0]).toBe(action);
    expect(actions).not.toContain("start");
    expect(actions).not.toContain("stop");
    expect(actions).toContain("refresh");
    expect(actions).toContain("close");
    const f = await open("UNKNOWN");
    f.set(proj as ReturnType<typeof projection>);
    await activate(f, "Refresh");
    const frame = f.tui.render().join("\n");
    expect(frame).toContain("Runtime State: UNKNOWN");
    expect(frame).not.toContain("Runtime State: STOPPED");
    expect(frame).toContain(label);
    expect(frame).not.toContain("Start Tunnel");
    expect(frame).not.toContain("Stop Tunnel");
    await close(f);
  });



  it("does not convert UNKNOWN into STOPPED when configuration is missing", async () => {
    const f = await open("UNKNOWN");
    f.set({ ...projection("UNKNOWN"), binding: "missing", credentialConfigured: false, organizationConfigured: false, tunnelIdAlreadyMasked: "" });
    await activate(f, "Refresh");
    expect(f.tui.render().join("\n")).toContain("Runtime State: UNKNOWN");
    expect(f.tui.render().join("\n")).toContain("Credential: not configured");
    expect(f.tui.render().join("\n")).not.toContain("STOPPED");
    expect((await api()).tunnelManagerActions(projection("UNKNOWN"))).toEqual(["refresh", "close"]);
    await close(f);
  });

  it.each([
    ["UNCONFIGURED", "Set Up Tunnel", "setup", "STOPPED"],
    ["STOPPED", "Edit Configuration", "setup", "STOPPED"],
    ["STOPPED", "Start Tunnel", "start", "CONNECTED"],
    ["CONNECTED", "Stop Tunnel", "stop", "STOPPED"],
  ])("%s %s calls shared port once, then rereads without leaving manager", async (state, label, port, next) => {
    const f = await open(state);
    f.ports[port as "setup" | "start" | "stop"].mockImplementation(async () => { f.set(projection(next)); });
    await activate(f, label);
    expect(f.ports[port as "setup" | "start" | "stop"]).toHaveBeenCalledTimes(1);
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(f.tui.isOpen).toBe(true);
    expect(f.tui.render().join("\n")).toContain(next);
    for (const other of ["setup", "start", "stop"] as const) if (other !== port) expect(f.ports[other]).not.toHaveBeenCalled();
    await close(f);
  });

  it.each([
    ["UNCONFIGURED", "Set Up Tunnel", "setup"],
    ["STOPPED", "Edit Configuration", "setup"],
    ["CONNECTED", "Stop Tunnel", "stop"],
  ])("refreshes after %s %s failure without automatic follow-up operations", async (state, label, port) => {
    const f = await open(state);
    f.ports[port as "setup" | "stop"].mockRejectedValue(new Error("private operation failure"));
    await activate(f, label);
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(f.ports[port as "setup" | "stop"]).toHaveBeenCalledTimes(1);
    expect(f.ports.start).not.toHaveBeenCalled();
    expect(f.tui.render().join("\n")).toContain("CE_TUNNEL_HEALTH_UNAVAILABLE");
    expect(f.tui.render().join("\n")).not.toContain("private operation failure");
    await close(f);
  });

  it("setup runs after manager releases custom ownership, then returns to fresh manager", async () => {
    const f = await open("UNCONFIGURED");
    f.ports.setup.mockImplementation(async () => {
      expect(f.tui.isOpen).toBe(false);
      await f.tui.custom<void>((_tui, _theme, _kb, done) => ({
        render: () => ["Synthetic nested wizard"], invalidate() {},
        handleInput: () => done(),
      }));
      f.set(projection("STOPPED"));
    });
    f.tui.press("tui.select.confirm");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.tui.render().join("\n")).toContain("Synthetic nested wizard");
    f.tui.send("complete");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(f.tui.render().join("\n")).toContain("Tunnel Manager");
    expect(f.ports.start).not.toHaveBeenCalled();
    await close(f);
  });

  it("Refresh performs a new projection read", async () => {
    const f = await open("STOPPED");
    f.set(projection("UNKNOWN"));
    await activate(f, "Refresh");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(f.tui.render().join("\n")).toContain("UNKNOWN");
    await close(f);
  });

  it("shows only a fixed authorization refusal, rereads after failure, and never retries start", async () => {
    const f = await open();
    f.ports.start.mockRejectedValue(Object.assign(new Error("untrusted diagnostic must stay private"), { code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" }));
    await activate(f, "Start");
    const frame = f.tui.render().join("\n");
    expect(frame).toContain("CE_TUNNEL_BACKGROUND_UNAUTHORIZED");
    expect(frame).not.toContain("untrusted diagnostic");
    expect(f.ports.read).toHaveBeenCalledTimes(2);
    expect(f.ports.start).toHaveBeenCalledTimes(1);
    expect(f.notify).not.toHaveBeenCalled();
    await close(f);
  });

  it("suppresses arbitrary errors and credential-shaped extra projection fields", async () => {
    const f = await open();
    const privateValue = ["synthetic", "private", "value"].join("-");
    f.ports.start.mockRejectedValue(new Error(privateValue));
    f.set({ ...projection(), credentialReference: `/private/${privateValue}`, secret: privateValue, tunnelIdAlreadyMasked: privateValue } as ReturnType<typeof projection>);
    await activate(f, "Start");
    const frame = f.tui.render().join("\n");
    expect(frame.includes(privateValue)).toBe(false);
    expect(frame).toContain("CE_TUNNEL_HEALTH_UNAVAILABLE");
    expect(frame).not.toContain("/private/");
    expect(f.notify).not.toHaveBeenCalled();
    await close(f);
  });

  it("read failure removes unsafe actions instead of reusing an old STOPPED snapshot", async () => {
    const f = await open();
    f.ports.read.mockRejectedValue(new Error("private read failure"));
    await activate(f, "Refresh");
    expect(f.tui.render().join("\n")).toContain("UNKNOWN");
    expect(f.tui.render().join("\n")).not.toContain("private read failure");
    expect(f.tui.render().join("\n")).not.toMatch(/Edit Configuration|Start Tunnel\s*$/m);
    await close(f);
  });

  it("Close action does not call a domain operation", async () => {
    const f = await open();
    await activate(f, "Close");
    await expect(f.running).resolves.toEqual({ status: "closed" });
    expect(f.ports.read).toHaveBeenCalledTimes(1);
    expect(f.ports.start).not.toHaveBeenCalled();
  });

  it("owner abort closes the custom screen and prevents later operations", async () => {
    const controller = new AbortController();
    const f = await open("STOPPED", { signal: controller.signal });
    controller.abort();
    await expect(f.running).resolves.toEqual({ status: "cancelled" });
    expect(f.tui.isOpen).toBe(false);
    f.tui.press("tui.select.confirm");
    expect(f.ports.start).not.toHaveBeenCalled();
  });

  it("timeout closes cleanly and leaves no pending timer", async () => {
    vi.useFakeTimers();
    const f = await open("STOPPED", { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await expect(f.running).resolves.toEqual({ status: "cancelled" });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.ports.start).not.toHaveBeenCalled();
  });

  it("drains an in-flight operation on abort and does not reread a dead context", async () => {
    const controller = new AbortController();
    const f = await open("STOPPED", { signal: controller.signal });
    let finish!: () => void;
    f.ports.start.mockImplementation(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const rows = f.tui.render().filter((line) => /(?:Set Up Tunnel|Start Tunnel|Edit Configuration|Stop Tunnel|Refresh|Close)/.test(line));
    const labels = rows.map((line) => line.replace(/^[^A-Za-z]*/, "").trim());
    const idx = labels.findIndex((line) => line.startsWith("Start Tunnel"));
    expect(idx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < idx; i++) f.tui.press("tui.select.down");
    f.tui.press("tui.select.confirm");
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    let settled = false;
    void f.running.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(f.running).resolves.toEqual({ status: "cancelled" });
    expect(f.ports.read).toHaveBeenCalledTimes(1);
    expect(f.ports.start).toHaveBeenCalledTimes(1);
  });

  it("external disposal closes without executing an action", async () => {
    const f = await open();
    f.tui.dispose();
    await expect(f.running).resolves.toEqual({ status: "closed" });
    expect(f.ports.start).not.toHaveBeenCalled();
  });

  it("pre-aborted ownership never reads or mounts a component", async () => {
    const controller = new AbortController(); controller.abort();
    const f = fixture();
    await expect((await api()).runTunnelManagerUi(f.ctx, f.ports, { signal: controller.signal })).resolves.toEqual({ status: "cancelled" });
    expect(f.ports.read).not.toHaveBeenCalled();
    expect(f.tui.openCount).toBe(0);
  });

  it("removes the caller abort listener and timeout after normal close", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const f = await open("STOPPED", { signal: controller.signal, timeoutMs: 60_000 });
    await close(f);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(f.ports.start).not.toHaveBeenCalled();
  });

  it("refuses non-TUI before reading or invoking operations", async () => {
    const mod = await api();
    const f = fixture(); f.ctx.mode = "rpc";
    await expect(mod.runTunnelManagerUi(f.ctx, f.ports as Parameters<typeof mod.runTunnelManagerUi>[1])).resolves.toEqual({ status: "unsupported" });
    expect(f.ports.read).not.toHaveBeenCalled();
    expect(f.tui.openCount).toBe(0);
  });
});
