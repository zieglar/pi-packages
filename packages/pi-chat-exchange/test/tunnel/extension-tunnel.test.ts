/**
 * HANDOFF-CE-HOST-09 B1.1 Task 4 — /ce-tunnel commands and the three separate
 * status surfaces, driven through the REAL registered extension module.
 *
 * Pinned contract:
 * - subcommands: setup, start, stop, status, help. `restart` and `autostart`
 *   are refused (no autostart code path at all).
 * - `setup` uses only the secure TUI + Keychain path; non-TUI or an
 *   unavailable custom component refuses CE_TUNNEL_INPUT_UNAVAILABLE and
 *   writes no configuration and no secret anywhere.
 * - `start` without the explicit offline opt-in routes to the REAL background
 *   manager (LOCAL-BACKGROUND-01) and refuses CE_TUNNEL_PROFILE_INVALID when no
 *   operator-managed profile exists; a plaintext credential hand-off stays
 *   unreachable in both modes.
 * - three separate status keys: CE runtime, offline tunnel health, and recent
 *   observed client activity. No URL, key, or path; never a ChatGPT-online
 *   claim; ACK is never completion; activity is only an actual attributed
 *   (clearly simulated) event, otherwise "no activity observed".
 * - unknown arguments are never echoed back.
 */
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODULE_URL = new URL("../../pi-extension/index.ts", import.meta.url).href;

beforeEach(() => {
  vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  // LOCAL-BACKGROUND-01: this file pins the OFFLINE surfaces by default; the
  // real-mode routing tests below override per-test. The profile override keeps
  // real-mode paths away from the operator's actual profile and key.
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  vi.stubEnv("CE_TUNNEL_PROFILE", `${tmpdir()}/ce-ext-nonexistent/tunnel.yaml`);
});
afterEach(() => vi.unstubAllEnvs());

interface Ctx {
  mode: string;
  hasUI: boolean;
  cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): undefined; getBranch(): [] };
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    input: ReturnType<typeof vi.fn>;
    custom?: ReturnType<typeof vi.fn>;
  };
}

type CommandHandler = (args: string, ctx: Ctx) => Promise<void> | void;
interface Registration {
  description?: string;
  handler: CommandHandler;
  getArgumentCompletions?(prefix: string): { value: string; label: string }[] | null;
}

async function loadExtension(): Promise<{
  commands: Map<string, Registration>;
  events: Map<string, (event: { reason: string }, ctx: Ctx) => unknown>;
}> {
  const commands = new Map<string, Registration>();
  const events = new Map<string, (event: { reason: string }, ctx: Ctx) => unknown>();
  const { default: factory } = (await import(MODULE_URL)) as { default: (pi: unknown) => void };
  factory({
    on: (name: string, handler: (event: { reason: string }, ctx: Ctx) => unknown) => events.set(name, handler),
    registerTool: () => undefined,
    registerCommand: (name: string, options: Registration) => commands.set(name, options),
    appendEntry: () => undefined,
  });
  return { commands, events };
}

function context(mode = "tui", withCustom = false): Ctx {
  const ui: Ctx["ui"] = {
    notify: vi.fn(),
    setStatus: vi.fn(),
    input: vi.fn(),
  };
  if (withCustom) ui.custom = vi.fn(async () => ({ kind: "cancelled", reason: "user" }));
  return {
    mode,
    hasUI: true,
    cwd: "/synthetic",
    sessionManager: { getSessionId: () => "unbound", getSessionFile: () => undefined, getBranch: () => [] },
    ui,
  };
}

async function tunnel(): Promise<Registration> {
  const { commands } = await loadExtension();
  const command = commands.get("ce-tunnel");
  expect(command, "/ce-tunnel registration").toBeDefined();
  return command as Registration;
}

function messages(ctx: Ctx): string {
  return ctx.ui.notify.mock.calls.map((call) => String(call[0])).join("\n");
}

function statuses(ctx: Ctx): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  for (const call of ctx.ui.setStatus.mock.calls) map.set(String(call[0]), call[1] as string | undefined);
  return map;
}

describe("B1.1 /ce-tunnel — subcommand surface", () => {
  it("offers exactly the legacy operations, the five explicit multi-session operations and doctor as completions", async () => {
    const command = await tunnel();
    const values = (command.getArgumentCompletions?.("") ?? []).map((item) => item.value);
    expect([...values].sort()).toEqual(["activate", "authorize", "convert", "deactivate", "doctor", "help", "migrate", "register", "revoke", "sessions", "setup", "start", "status", "stop"]);
    expect((command.getArgumentCompletions?.("sta") ?? []).map((i) => i.value).sort()).toEqual(["start", "status"]);
    for (const item of command.getArgumentCompletions?.("") ?? []) expect(typeof item.value).toBe("string");
  });

  it("help lists the subcommands and the transport-only disclaimer", async () => {
    const ctx = context();
    await (await tunnel()).handler("help", ctx);
    const text = messages(ctx);
    for (const sub of ["setup", "authorize", "start", "stop", "status", "help", "sessions", "register", "revoke", "convert"]) expect(text).toContain(sub);
    expect(text).toMatch(/transport/i);
    expect(text).not.toMatch(/https?:\/\//);
  });

  it.each(["restart", "autostart"])("refuses %s with a fixed reason and no autostart path", async (sub) => {
    const ctx = context();
    await (await tunnel()).handler(sub, ctx);
    expect(ctx.ui.notify.mock.calls[0]?.[1]).toBe("warning");
    expect(messages(ctx)).toContain(sub);
    expect(messages(ctx)).toMatch(/refus|not available|blocked/i);
  });

  it("never echoes an unknown argument", async () => {
    const ctx = context();
    await (await tunnel()).handler("sk-pasted-secret-by-mistake-12345", ctx);
    expect(messages(ctx)).not.toContain("sk-pasted-secret-by-mistake-12345");
    expect(messages(ctx)).toContain("unknown subcommand");
  });
});

describe("B1.1 /ce-tunnel — setup never leaves the secure path", () => {
  it.each(["print", "rpc", "json"])("refuses setup in %s mode without touching a credential", async (mode) => {
    const ctx = context(mode);
    await (await tunnel()).handler("setup", ctx);
    expect(messages(ctx)).toContain("CE_TUNNEL_INPUT_UNAVAILABLE");
    expect(ctx.ui.input).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("refuses setup in TUI mode when no custom component surface exists", async () => {
    const ctx = context("tui", false);
    await (await tunnel()).handler("setup", ctx);
    expect(messages(ctx)).toContain("CE_TUNNEL_INPUT_UNAVAILABLE");
    expect(ctx.ui.input).not.toHaveBeenCalled();
  });

  it("reports a cancelled capture without storing or echoing anything", async () => {
    const ctx = context("tui", true);
    await (await tunnel()).handler("setup", ctx);
    expect(ctx.ui.custom).toHaveBeenCalledTimes(1);
    const text = messages(ctx);
    expect(text).toMatch(/cancel/i);
    expect(text).not.toMatch(/secret|key=|sk-/i);
  });
});

describe("B1.1 /ce-tunnel — start and stop stay offline", () => {
  it("routes start to the gated real background manager without the offline opt-in (LOCAL-BACKGROUND-01 v2)", async () => {
    vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", undefined as unknown as string);
    const ctx = context();
    await (await tunnel()).handler("start", ctx);
    // REAL-START-FIX-01: acknowledge the request, not a spawn, before the
    // gate refusal surfaces asynchronously on the supervised start.
    expect(messages(ctx)).toContain("real background start requested; awaiting spawn acknowledgement");
    await vi.waitFor(() => expect(messages(ctx)).toContain("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"));
    // Even with the gate open, a missing operator profile refuses cleanly.
    vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "1");
    const ctx2 = context();
    await (await tunnel()).handler("start", ctx2);
    await vi.waitFor(() => expect(messages(ctx2)).toContain("CE_TUNNEL_PROFILE_INVALID"));
  });

  it("stop with nothing running is a safe no-op, not a false success claim", async () => {
    const ctx = context();
    await (await tunnel()).handler("stop", ctx);
    const text = messages(ctx);
    expect(text).not.toMatch(/disconnected from ChatGPT|delivered|acknowledged/i);
    expect(text).toMatch(/not running|no owned|stopped/i);
  });
});

describe("LOCAL-BACKGROUND-01 /ce-tunnel — real background mode surface", () => {
  it("status reports the measured real-background vocabulary, never offline text", async () => {
    vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", undefined as unknown as string);
    const ctx = context();
    await (await tunnel()).handler("status", ctx);
    const text = messages(ctx);
    expect(text).toContain("real background");
    expect(text).toContain("STOPPED");
    expect(text).toContain("not delivery/ACK/completion evidence");
    expect(String(statuses(ctx).get("ce-tunnel"))).toContain("real background");
    expect(String(statuses(ctx).get("ce-client"))).toContain("not observed");
  });

  it("stop with no owned record is a safe no-op and signals nothing", async () => {
    vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", undefined as unknown as string);
    const ctx = context();
    await (await tunnel()).handler("stop", ctx);
    expect(messages(ctx)).toContain("no owned real background tunnel record");
  });
});

describe("B1.1 /ce-tunnel — three separate status surfaces", () => {
  it("publishes CE runtime, offline tunnel health and client activity separately", async () => {
    const ctx = context();
    await (await tunnel()).handler("status", ctx);
    const keys = statuses(ctx);
    expect([...keys.keys()].sort()).toEqual(["ce", "ce-client", "ce-tunnel"]);
    expect(String(keys.get("ce-tunnel"))).toMatch(/offline|simulated/i);
    expect(String(keys.get("ce-client"))).toMatch(/no activity observed/i);
    // The CE segment must not be manufactured when CE is unavailable.
    expect(String(keys.get("ce"))).not.toMatch(/✓|bound/);
  });

  it("states offline/simulated scope and never claims delivery, ACK or a client being online", async () => {
    const ctx = context();
    await (await tunnel()).handler("status", ctx);
    const text = messages(ctx);
    expect(text).toMatch(/offline|simulated/i);
    expect(text).toContain("not delivery/ACK/completion evidence");
    expect(text).not.toMatch(/ChatGPT (is )?online|client online|connected to ChatGPT/i);
    expect(text).not.toMatch(/https?:\/\/|\/Users\/|sk-/);
  });

  it("does not touch any status key outside TUI mode", async () => {
    for (const mode of ["print", "rpc", "json"]) {
      const ctx = context(mode);
      await (await tunnel()).handler("status", ctx);
      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    }
  });
});

describe("B1.1 /ce-tunnel — lifecycle cleanup independent of CE", () => {
  it.each(["session_start", "session_shutdown"])("clears all three status keys on %s", async (event) => {
    const { commands, events } = await loadExtension();
    const ctx = context();
    await commands.get("ce-tunnel")?.handler("status", ctx);
    ctx.ui.setStatus.mockClear();
    await events.get(event)?.({ reason: event === "session_start" ? "reload" : "shutdown" }, ctx);
    const cleared = statuses(ctx);
    expect([...cleared.keys()].sort()).toEqual(["ce", "ce-client", "ce-tunnel"]);
    for (const key of ["ce", "ce-client", "ce-tunnel"]) expect(cleared.get(key)).toBeUndefined();
  });

  it("cleans up even when CE is disabled for this session, and stays idempotent", async () => {
    const { commands, events } = await loadExtension();
    const ctx = context();
    await commands.get("ce-tunnel")?.handler("status", ctx);
    await events.get("session_shutdown")?.({ reason: "shutdown" }, ctx);
    const count = ctx.ui.setStatus.mock.calls.length;
    await events.get("session_shutdown")?.({ reason: "shutdown" }, ctx);
    expect(ctx.ui.setStatus.mock.calls.length).toBe(count);
  });

  it("does not clear another extension instance's UI target", async () => {
    const a = await loadExtension();
    const b = await loadExtension();
    const ctxA = context();
    const ctxB = context();
    await a.commands.get("ce-tunnel")?.handler("status", ctxA);
    await b.commands.get("ce-tunnel")?.handler("status", ctxB);
    const beforeB = ctxB.ui.setStatus.mock.calls.length;
    await a.events.get("session_shutdown")?.({ reason: "shutdown" }, ctxA);
    expect(ctxB.ui.setStatus.mock.calls.length).toBe(beforeB);
  });
});
