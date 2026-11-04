import { describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { runTunnelManagerUi, tunnelManagerActions, type TunnelManagerUiProjection } from "../../src/tunnel/manager-ui.js";

const projection = (state: TunnelManagerUiProjection["state"], sessionBinding: "attached" | "detached" | "unknown") => ({
  state, sessionBinding, profilePath: "/synthetic/tunnel.yaml", tunnelIdAlreadyMasked: "tunnel_abcdef…",
  organizationConfigured: true, binding: "configured" as const, credentialConfigured: true, evidence: "none" as const,
});
const items = (h: ReturnType<typeof createTuiHarness>) => h.render().filter(line => /^[❯ ] /.test(line));
async function select(h: ReturnType<typeof createTuiHarness>, label: string) {
  const rows = items(h), index = rows.findIndex(row => row.trim().replace(/^❯ /, "") === label);
  expect(index, label).toBeGreaterThanOrEqual(0);
  const cursor = Math.max(0, rows.findIndex(row => row.startsWith("❯")));
  for (let i = cursor; i < index; i++) h.press("tui.select.down");
  for (let i = cursor; i > index; i--) h.press("tui.select.up");
  h.press("tui.select.confirm");
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe("current Session menu", () => {
  it.each([
    ["STOPPED", "detached", "connect"], ["CONNECTED", "detached", "connect"],
    ["CONNECTED", "attached", "disconnect"], ["CONNECTED", "unknown", "connect"],
    ["UNKNOWN", "unknown", "connect"],
  ] as const)("%s + %s offers only %s", (state, session, action) => {
    const actions = tunnelManagerActions(projection(state, session));
    expect(actions[0]).toBe(action);
    expect(actions).not.toContain(action === "connect" ? "disconnect" : "connect");
    expect(actions).not.toContain("start"); expect(actions).not.toContain("stop");
    for (const item of ["status", "permission", "advanced", "close"]) expect(actions).toContain(item);
  });

  it.each(["detached", "attached", "unknown"] as const)("separates shared transport from %s Session and navigates Advanced without effects", async session => {
    const h = createTuiHarness({ width: 100, rows: 45 });
    const ports = { read: vi.fn(async () => projection("CONNECTED", session)), setup: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const pending = runTunnelManagerUi({ mode: "tui", hasUI: true, ui: { custom: h.custom } }, ports);
    try {
      await h.waitForOpen();
      const frame = h.render().join("\n");
      expect(frame).toContain("Current Session"); expect(frame).toContain("Shared Tunnel");
      expect(frame).toContain(session === "attached" ? "Attached" : session === "detached" ? "Detached" : "Unknown");
      expect(frame).toContain("CONNECTED");
      expect(frame).not.toContain("Start Tunnel"); expect(frame).not.toContain("Stop Tunnel");
      await select(h, "Advanced");
      expect(h.render().join("\n")).toContain("Stop Tunnel");
      expect(h.render().join("\n")).toContain("all sessions");
      h.press("tui.select.cancel");
      expect(h.render().join("\n")).not.toContain("Stop Tunnel");
      for (const port of [ports.setup, ports.start, ports.stop]) expect(port).not.toHaveBeenCalled();
      h.press("tui.select.cancel"); await expect(pending).resolves.toEqual({ status: "closed" });
    } finally { h.dispose(); await pending; }
  });
  it("keeps STARTING/STOPPING in Advanced read-only and offers no lifecycle action", async () => {
    const h = createTuiHarness({ width: 100, rows: 45 });
    const ports = { read: vi.fn(async () => projection("STOPPING", "attached")), setup: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const pending = runTunnelManagerUi({ mode: "tui", hasUI: true, ui: { custom: h.custom } }, ports);
    try {
      await h.waitForOpen(); await select(h, "Advanced");
      const frame = h.render().join("\n");
      expect(frame).not.toContain("Start Tunnel"); expect(frame).not.toContain("Stop Tunnel");
      for (const port of [ports.setup, ports.start, ports.stop]) expect(port).not.toHaveBeenCalled();
      h.press("tui.select.cancel"); h.press("tui.select.cancel"); await pending;
    } finally { h.dispose(); await pending; }
  });

  it("retains explicit Start under Advanced and delegates once", async () => {
    const h = createTuiHarness({ width: 100, rows: 45 });
    const ports = { read: vi.fn(async () => projection("STOPPED", "detached")), setup: vi.fn(), start: vi.fn(), stop: vi.fn() };
    const pending = runTunnelManagerUi({ mode: "tui", hasUI: true, ui: { custom: h.custom } }, ports);
    try {
      await h.waitForOpen(); await select(h, "Advanced"); await select(h, "Start Tunnel");
      await h.waitForOpen(); expect(ports.start).toHaveBeenCalledTimes(1); expect(ports.stop).not.toHaveBeenCalled();
      h.press("tui.select.cancel"); await pending;
    } finally { h.dispose(); await pending; }
  });
});
