import { tmpdir } from "node:os";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

// Tunnel lifecycle tests are not Native qualification: keep the Native readiness gate
// out of these scenarios. Native readiness itself is covered by native-readiness-gate.test.ts.
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

const extensionUrl = new URL("../../pi-extension/index.ts", import.meta.url).href;
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ce-manager-extension-"));
  directories.push(directory);
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  vi.stubEnv("CE_TUNNEL_PROFILE", join(directory, "profile.yaml"));
  vi.stubEnv("CE_TUNNEL_STATE_DIR", join(directory, "state"));
  vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "");
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const events = new Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>();
  const appendEntry = vi.fn();
  const { default: factory } = await import(extensionUrl);
  factory({ on: (name: string, handler: never) => events.set(name, handler), registerTool: vi.fn(), appendEntry,
    registerCommand: (name: string, command: never) => commands.set(name, command) });
  const custom = vi.fn(async () => undefined);
  const notify = vi.fn();
  const ctx = { mode: "tui", hasUI: true, cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui: { custom, notify, setStatus: vi.fn(), input: vi.fn() } };
  return { command: commands.get("ce-tunnel")!, ctx, custom, notify, appendEntry, directory, events };
}

async function flushUi() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function activateUi(h: ReturnType<typeof createTuiHarness>, index = 0) {
  for (let i = 0; i < index; i++) h.press("tui.select.down");
  h.press("tui.select.confirm"); await flushUi();
}
async function inputUi(h: ReturnType<typeof createTuiHarness>, value: string) {
  h.send("\x15"); h.type(value); h.press("tui.input.submit"); await flushUi();
}

describe("real tunnel manager extension routing", () => {
  it("Manager Setup saves a real isolated profile, returns fresh STOPPED, and Start still refuses the gate", async () => {
    const f = await fixture();
    // Hosted toolcache ancestors need not satisfy executable admission.
    const node = join(realpathSync(f.directory), "node");
    copyFileSync(process.execPath, node); chmodSync(node, 0o700);
    vi.stubEnv("CE_NODE_PATH", node);
    const binding = join(f.directory, "binding.json");
    const store = join(f.directory, "STORE-MUST-NOT-EXIST");
    writeFileSync(binding, JSON.stringify({ version: 1, store: { directory: store },
      exchange: { namespace: "fixture", idempotencyKey: "fixture" },
      endpoint: { adapter: "local", endpointId: "fixture" }, recipients: [] }), { mode: 0o600 });
    const h = createTuiHarness({ width: 130, rows: 42 });
    Object.assign(f.ctx.ui, { custom: h.custom });
    const pending = f.command.handler("", f.ctx);
    const privateValue = ["fixture", "masked", "value"].join("-");
    try {
      await h.waitForOpen();
      await activateUi(h); // Manager Set Up Tunnel -> Wizard step 1
      await inputUi(h, "tunnel_12345678");
      await inputUi(h, "");
      // Step 3 is the masked credential input itself: no intermediate choice,
      // and recipients are Advanced-only (CE-managed default applies).
      h.type(privateValue);
      expect(h.render().join("\n").includes(privateValue)).toBe(false);
      h.send("\r"); await flushUi();
      await activateUi(h); // Review
      expect(h.render().join("\n").includes(privateValue)).toBe(false);
      await activateUi(h); // Continue -> Save
      expect(existsSync(join(f.directory, "profile.yaml"))).toBe(false);
      await activateUi(h); // Save -> fresh Manager
      await vi.waitFor(() => expect(existsSync(join(f.directory, "profile.yaml"))).toBe(true));
      await vi.waitFor(() => expect(h.render().join("\n")).toMatch(/State +STOPPED/));
      const text = readFileSync(join(f.directory, "profile.yaml"), "utf8");
      const { parseTunnelProfile } = await import("../../dist/tunnel/background-manager.js");
      const facts = parseTunnelProfile(text);
      expect(text.includes(privateValue)).toBe(false);
      expect(readFileSync(facts.keyFile, "utf8") === privateValue).toBe(true);
      expect(lstatSync(facts.keyFile).mode & 0o777).toBe(0o600);
      // The binding is CE-managed: identity-derived name beside the profile,
      // never the operator-typed path, with no implicit recipients.
      const managedBinding = join(f.directory, ".ce-bindings", "ce-345678-none.yaml");
      expect(facts.mcpCommand?.includes(managedBinding)).toBe(true);
      const managedDoc = JSON.parse(readFileSync(managedBinding, "utf8"));
      expect(managedDoc.managed).toMatchObject({ tunnelId: "tunnel_12345678", adapter: "pi" });
      expect(managedDoc.recipients).toEqual([]);
      expect(existsSync(store)).toBe(false);
      expect(h.render().join("\n").includes("tunnel_12345678")).toBe(false);
      await activateUi(h); // Start: exact gate remains closed
      await vi.waitFor(() => expect(h.render().join("\n")).toContain("Chat Exchange Tunnel"));
      expect(f.notify.mock.calls.some(([text]) => String(text).includes("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"))).toBe(true);
      expect(existsSync(join(f.directory, "background-state.json"))).toBe(false);
      expect(f.notify.mock.calls.some(([text]) => String(text).includes(privateValue))).toBe(false);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.ctx.ui.input).not.toHaveBeenCalled();
      h.press("tui.select.cancel"); await pending;
    } finally { h.dispose(); await pending; }
  });

  it("bare command opens the Manager custom TUI, not the old status notification", async () => {
    const f = await fixture();
    await f.command.handler("", f.ctx);
    expect(f.custom).toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
  });


  it("renders the real unconfigured Manager and Escape closes without persistence", async () => {
    const f = await fixture();
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler("", f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      expect(harness.render().join("\n")).toContain("UNCONFIGURED");
      harness.press("tui.select.cancel");
      await pending;
      expect(harness.isOpen).toBe(false);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.ctx.ui.input).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
      await pending;
    }
  });
  it.each(["", "status"])("session teardown aborts the transport screen and drains its command (%s)", async (command) => {
    const f = await fixture();
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler(command, f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      await f.events.get("session_shutdown")!({ reason: "shutdown" }, f.ctx);
      await vi.waitFor(() => expect(harness.isOpen).toBe(false));
      await pending;
      expect(harness.isOpen).toBe(false);
      expect(readdirSync(f.directory)).toEqual([]);
      expect(f.appendEntry).not.toHaveBeenCalled();
    } finally { harness.dispose(); await pending; }
  });

  it("direct real setup starts with Profile and Escape cancels without filesystem or transcript writes", async () => {
    const f = await fixture();
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler("setup", f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      const screen = harness.render().join("\n");
      // Step 1 is the first real decision; the write target moved to
      // Review/Save/Edit context instead of decorating every step.
      expect(screen).toContain("Tunnel Setup · 1/4 · Tunnel ID");
      expect(screen).toContain("Required · tunnel_ followed by at least 8 alphanumeric characters");
      expect(screen).not.toContain(join(f.directory, "profile.yaml"));
      harness.press("tui.select.cancel");
      await pending;
      expect(readdirSync(f.directory)).toEqual([]);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.ctx.ui.input).not.toHaveBeenCalled();
      expect(f.notify.mock.calls.some(([text, level]) => String(text).includes("CANCELLED") && level === "info")).toBe(true);
    } finally { harness.dispose(); await pending; }
  });
  it("Escape after the masked capture and at Review writes no profile, key, or binding", async () => {
    const f = await fixture();
    const h = createTuiHarness({ width: 120, rows: 40 });
    Object.assign(f.ctx.ui, { custom: h.custom });
    const pending = f.command.handler("setup", f.ctx);
    const privateValue = ["fixture", "no", "write"].join("-");
    try {
      await vi.waitFor(() => expect(h.isOpen).toBe(true));
      await inputUi(h, "tunnel_12345678");
      await inputUi(h, "");
      // The masked capture is reached: the secret exists in flight, then cancel.
      expect(h.render().join("\n")).toContain("Tunnel Setup · 3/4 · Credential");
      h.type(privateValue);
      expect(h.render().join("\n").includes(privateValue)).toBe(false);
      h.send("\r"); await flushUi();
      expect(h.render().join("\n")).toContain("Tunnel Setup · 4/4 · Review");
      h.press("tui.select.cancel"); await pending;
      expect(readdirSync(f.directory)).toEqual([]);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.ctx.ui.input).not.toHaveBeenCalled();
      expect(f.notify.mock.calls.some(([text]) => String(text).includes(privateValue))).toBe(false);
    } finally { h.dispose(); await pending; }
  });


  it("direct status keeps malformed configuration distinct from stopped runtime", async () => {
    const f = await fixture();
    writeFileSync(join(f.directory, "profile.yaml"), "not: a tunnel profile\n", { mode: 0o600 });
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler("status", f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      const screen = harness.render().join("\n");
      expect(screen).toContain("Configuration State: UNKNOWN");
      expect(screen).toContain("Runtime state: STOPPED");
      expect(screen).toContain("Error: CE_TUNNEL_PROFILE_INVALID");
      harness.press("tui.select.cancel"); await pending;
    } finally { harness.dispose(); await pending; }
  });

  it("refuses a control-bearing profile environment value before status rendering", async () => {
    const f = await fixture();
    vi.stubEnv("CE_TUNNEL_PROFILE", "/tmp/\u001b[2Jspoof.yaml");
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler("status", f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      const screen = harness.render().join("\n");
      expect(screen).toContain("Profile: Unavailable");
      expect(screen).toContain("Error: CE_TUNNEL_PROFILE_INVALID");
      expect(screen).not.toContain("spoof.yaml");
      harness.press("tui.select.cancel"); await pending;
    } finally { harness.dispose(); await pending; }
  });

  it("direct status renders structured configuration separately from runtime without secret input", async () => {
    const f = await fixture();
    const harness = createTuiHarness();
    Object.assign(f.ctx.ui, { custom: harness.custom });
    const pending = f.command.handler("status", f.ctx);
    try {
      await vi.waitFor(() => expect(harness.isOpen).toBe(true));
      const screen = harness.render().join("\n");
      for (const field of ["Profile", "Tunnel", "Organization", "Runtime"]) expect(screen).toContain(field);
      expect(screen).toContain("STOPPED");
      expect(screen).not.toContain("CONNECTED");
      harness.press("tui.select.cancel");
      await pending;
      expect(readdirSync(f.directory)).toEqual([]);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.ctx.ui.input).not.toHaveBeenCalled();
    } finally { harness.dispose(); await pending; }
  });

  it("non-TUI bare command never falls back to an interactive plaintext dialog", async () => {
    const f = await fixture();
    f.ctx.mode = "rpc";
    await f.command.handler("", f.ctx);
    expect(f.custom).not.toHaveBeenCalled();
    expect(f.ctx.ui.input).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it("direct start still enforces the exact background authorization gate", async () => {
    const f = await fixture();
    await f.command.handler("start", f.ctx);
    // REAL-START-FIX-01: non-blocking start acknowledges first; the gate refusal
    // then surfaces asynchronously on the supervised start promise.
    await vi.waitFor(() => expect(f.notify.mock.calls.some(([text]) => String(text).includes("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"))).toBe(true));
    expect(f.custom).not.toHaveBeenCalled();
  });
  it("TUI start with a malformed CE_TUNNEL_PROFILE refuses closed and never rejects the handler", async () => {
    const f = await fixture();
    vi.stubEnv("CE_TUNNEL_PROFILE", "relative.yaml");
    await expect(f.command.handler("start", f.ctx)).resolves.toBeUndefined();
    expect(f.notify.mock.calls.some(([text, level]) => level === "warning" && String(text).includes("start refused CE_TUNNEL_PROFILE_INVALID"))).toBe(true);
    expect(f.ctx.ui.setStatus.mock.calls.some(([key, text]) => key === "ce-tunnel" && String(text).includes("unavailable"))).toBe(true);
  });
});
