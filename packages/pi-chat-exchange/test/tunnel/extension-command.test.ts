/**
 * HANDOFF-CE-HOST-09 B1 — /ce-tunnel command handler tests (T18/T19, r2).
 *
 * Loads the real extension module the same way the advisory tests do and
 * drives the registered command against a mock Pi API: refusal gates for
 * not-yet-wired subcommands, no echo of unknown input (secrecy), TUI-only
 * status-bar publishing, and value-bearing completions.
 */
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Tunnel lifecycle tests are not Native qualification: keep the Native readiness gate
// out of these scenarios. Native readiness itself is covered by native-readiness-gate.test.ts.
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../src/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
  inspectNativeReadiness: () => ({ state: "READY", code: "CE_NATIVE_READY", reason: "test", driver: "rust-native", version: "0.1.0", abiVersion: 1, sqliteVersion: "3.54.1", target: "test" }),
}));

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // LOCAL-BACKGROUND-01: default this file to the OFFLINE simulator surfaces;
  // real-mode routing tests override per-test. The profile override keeps any
  // accidental real-mode code path far from the operator's actual profile.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  vi.stubEnv("CE_TUNNEL_PROFILE", `${tmpdir()}/ce-ext-nonexistent/tunnel.yaml`);
});
afterEach(() => vi.unstubAllEnvs());

interface UiPort {
  notify: ReturnType<typeof vi.fn>;
  setStatus?: ReturnType<typeof vi.fn>;
}

interface Context {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: unknown;
  ui: UiPort;
}

interface CommandRegistration {
  name: string;
  description?: string;
  handler(args: string, ctx: Context): Promise<void> | void;
  getArgumentCompletions?(argumentPrefix: string): { value: string; label: string; description?: string }[] | null;
}

interface Api {
  on(name: string, handler: (event: unknown, ctx: Context) => unknown): void;
  registerTool(tool: unknown): void;
  registerCommand(name: string, options: CommandRegistration): void;
  appendEntry(customType: string, data?: unknown): void;
}

const MODULE_URL = new URL(
  "../../pi-extension/index.ts",
  import.meta.url,
).href;

async function loadExtension(): Promise<CommandRegistration[]> {
  const commands: CommandRegistration[] = [];
  const api: Api = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name, options) => commands.push({ ...options, name }),
    appendEntry: () => undefined,
  };
  const { default: factory } = (await import(MODULE_URL)) as { default: (pi: Api) => void };
  factory(api);
  return commands;
}

function makeCtx(mode: string): { ctx: Context; notifications: Array<{ message: string; level: string }>; status: Map<string, string | undefined> } {
  const notifications: Array<{ message: string; level: string }> = [];
  const status = new Map<string, string | undefined>();
  const ctx: Context = {
    mode,
    hasUI: true,
    cwd: "/tmp",
    sessionManager: {},
    ui: {
      notify: vi.fn((message: string, level: string) => notifications.push({ message, level })),
      setStatus: vi.fn((key: string, text: string | undefined) => status.set(key, text)),
    },
  };
  return { ctx, notifications, status };
}

async function ceTunnel(): Promise<CommandRegistration> {
  const commands = await loadExtension();
  const cmd = commands.find((c) => c.name === "ce-tunnel");
  if (cmd === undefined) throw new Error("/ce-tunnel was not registered");
  return cmd;
}

describe("/ce-tunnel — B1 offline wiring (T18)", () => {
  it("registers alongside the existing /ce-status command", async () => {
    const commands = await loadExtension();
    expect(commands.some((c) => c.name === "ce-status")).toBe(true);
    expect(commands.some((c) => c.name === "ce-tunnel")).toBe(true);
  });

  it("status reports the B1 observation state and the transport-only disclaimer", async () => {
    const { ctx, notifications } = makeCtx("tui");
    await (await ceTunnel()).handler("status", ctx);
    expect(notifications.length).toBe(1);
    expect(notifications[0]?.message).toContain("state=Stopped");
    expect(notifications[0]?.message).toContain("evidence=none");
    expect(notifications[0]?.message).toContain("not delivery/ACK/completion evidence");
  });

  // LOCAL-BACKGROUND-01 v2 contract (Lane S S1): without BOTH the offline
  // opt-in and the explicit CE_TUNNEL_BACKGROUND_ALLOW=1 gate, `start` refuses
  // before touching a profile, a process, or a credential.
  it("refuses start (real mode gate) and setup with closed CE_TUNNEL_* codes", async () => {
    vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", undefined as unknown as string);
    const start = makeCtx("tui");
    await (await ceTunnel()).handler("start", start.ctx);
    // REAL-START-FIX-01: the handler acknowledges the request immediately;
    // only a positive spawn acknowledgement may claim STARTING.
    expect(start.notifications[0]?.level).toBe("info");
    expect(start.notifications[0]?.message).toContain("real background start requested; awaiting spawn acknowledgement");
    await vi.waitFor(() => expect(start.notifications.some((n) => n.message.includes("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"))).toBe(true));

    // With the gate open but no operator profile, the refusal is still clean.
    vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "1");
    const start2 = makeCtx("tui");
    await (await ceTunnel()).handler("start", start2.ctx);
    await vi.waitFor(() => expect(start2.notifications.some((n) => n.message.includes("CE_TUNNEL_PROFILE_INVALID"))).toBe(true));
    expect(start2.notifications.map((n) => n.message).join(" ")).not.toContain("ce-ext-nonexistent");

    // This mock UI port exposes no `ui.custom`, so masked capture is absent.
    const setup = makeCtx("tui");
    await (await ceTunnel()).handler("setup", setup.ctx);
    expect(setup.notifications[0]?.level).toBe("warning");
    expect(setup.notifications[0]?.message).toContain("CE_TUNNEL_INPUT_UNAVAILABLE");
  });

  it("refuses restart/autostart outright (no autostart path in this phase)", async () => {
    for (const sub of ["restart", "autostart"]) {
      const { ctx, notifications } = makeCtx("tui");
      await (await ceTunnel()).handler(sub, ctx);
      expect(notifications[0]?.level).toBe("warning");
      expect(notifications[0]?.message).toContain(sub);
      expect(notifications[0]?.message).toContain("refused");
    }
  });

  it("stop with nothing owned is a no-op that claims no transport outcome", async () => {
    const { ctx, notifications } = makeCtx("tui");
    await (await ceTunnel()).handler("stop", ctx);
    expect(notifications[0]?.message).toContain("nothing was stopped");
    expect(notifications[0]?.message).not.toMatch(/delivered|acknowledged|completed/i);
  });

  it("does NOT echo unknown input back to the UI (r2, Lane A finding 6)", async () => {
    const { ctx, notifications } = makeCtx("tui");
    await (await ceTunnel()).handler("sk-pasted-secret-by-mistake-12345", ctx);
    expect(notifications[0]?.level).toBe("warning");
    expect(notifications[0]?.message).not.toContain("sk-pasted-secret-by-mistake-12345");
    expect(notifications[0]?.message).toContain("unknown subcommand");
  });

  it("completions carry `value` as required by pi-tui AutocompleteItem (r2, Lane D finding 1)", async () => {
    const cmd = await ceTunnel();
    const completions = cmd.getArgumentCompletions?.("") ?? [];
    expect(completions.length).toBeGreaterThan(0);
    for (const item of completions) expect(typeof item.value).toBe("string");
    const matching = cmd.getArgumentCompletions?.("sta") ?? [];
    // B1.1 adds `start`, which shares the "sta" prefix with `status`.
    expect(matching.map((i) => i.value)).toEqual(["start", "status"]);
  });
});

describe("/ce-tunnel — status bar (T19)", () => {
  it("publishes the transport label on the ce-tunnel status key in TUI mode", async () => {
    const { ctx, status } = makeCtx("tui");
    await (await ceTunnel()).handler("status", ctx);
    // B1.1: the tunnel segment is explicitly labelled offline/simulated.
    expect(status.get("ce-tunnel")).toBe("Tunnel ○ stopped (offline simulated)");
  });

  it("does NOT touch the status bar outside TUI mode (print/rpc/json)", async () => {
    for (const mode of ["print", "rpc", "json"]) {
      const { ctx, status } = makeCtx(mode);
      await (await ceTunnel()).handler("status", ctx);
      expect(status.has("ce-tunnel")).toBe(false);
    }
  });
});
