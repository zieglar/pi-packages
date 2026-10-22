import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTunnelMcpCommand, buildTunnelProfile, parseTunnelMcpCommand, serializeTunnelProfile } from "../../dist/tunnel/profile.js";
import { parseTunnelProfile } from "../../dist/tunnel/background-manager.js";
import { piAllowlistPath } from "../../dist/tunnel/messaging-config.js";

// Preserve the real manager, profile lock, Setup domain and filesystem writes.
// Only process discovery/control is isolated: these tests must never touch a daemon.
vi.mock("../../dist/tunnel/background-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../dist/tunnel/background-manager.js")>();
  return {
    ...actual,
    createBackgroundTunnelManager: (options: Parameters<typeof actual.createBackgroundTunnelManager>[0]) =>
      actual.createBackgroundTunnelManager({
        ...options,
        inspectProcess: async (pid) => ({ kind: "present", identity: { pid, command: "synthetic", startedKey: "synthetic" } }),
        listProcesses: async () => ({ kind: "ok", processes: [] }),
        spawn: () => { throw new Error("Messaging setup MUST NOT spawn"); },
        signal: () => { throw new Error("Messaging setup MUST NOT signal"); },
      }),
  };
});

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const ID = "tunnel_abcdefgh123456";
const SESSION = "trusted-runtime-session-9";
const CREDENTIAL = "synthetic-existing-credential";
const extensionUrl = new URL("../../pi-extension/index.ts", import.meta.url).href;

async function fixture(sessionId: () => string = () => SESSION) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ce-extension-messaging-")));
  directories.push(directory);
  const profilePath = join(directory, "profile.yaml");
  const keyFile = join(directory, "existing-key");
  // A synthetic pre-migration profile. No expected messaging output is seeded.
  const oldBinding = join(directory, "old-binding.json");
  writeFileSync(keyFile, CREDENTIAL, { mode: 0o600 });
  writeFileSync(oldBinding, JSON.stringify({ version: 1, store: { directory: join(directory, "old-store") },
    exchange: { namespace: "synthetic-old", idempotencyKey: "synthetic-old" },
    endpoint: { adapter: "local", endpointId: "synthetic-old" }, recipients: [] }), { mode: 0o600 });
  writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: ID,
    organizationId: "org-old", keyFile, healthUrlFile: join(directory, "health.url"),
    mcpCommand: buildTunnelMcpCommand({ nodePath: "/synthetic/node", scriptPath: "/synthetic/mcp-stdio.js", bindingPath: oldBinding }),
  })), { mode: 0o600 });
  const keyBefore = lstatSync(keyFile);
  vi.stubEnv("CE_ALLOWLIST", join(directory, "absent-runtime-allowlist.json"));
  vi.stubEnv("CE_TUNNEL_PROFILE", profilePath);
  vi.stubEnv("CE_TUNNEL_STATE_DIR", join(directory, "state"));
  vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "");
  vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "");
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const appendEntry = vi.fn();
  const { default: factory } = await import(extensionUrl);
  factory({ on: vi.fn(), registerTool: vi.fn(), appendEntry,
    registerCommand: (name: string, command: never) => commands.set(name, command) });
  const h = createTuiHarness({ width: 130, rows: 45 });
  const notify = vi.fn();
  const input = vi.fn();
  const getSessionId = vi.fn(sessionId);
  const ctx = { mode: "tui", hasUI: true, cwd: "/synthetic/not-a-session-id",
    sessionManager: { getSessionId, getSessionFile: () => "/synthetic/also-not-a-session.jsonl", getBranch: () => [] },
    ui: { custom: h.custom, notify, input, setStatus: vi.fn() } };
  return { directory, profilePath, keyFile, keyBefore, oldBinding, h, ctx, notify, input, getSessionId, appendEntry,
    command: commands.get("ce-tunnel")! };
}

async function flush() { for (let i = 0; i < 50; i++) await Promise.resolve(); }
async function press(h: TuiHarness, key: Parameters<TuiHarness["press"]>[0] = "tui.select.confirm") {
  h.press(key); await flush();
}
function frame(h: TuiHarness) { return h.render().join("\n"); }
async function select(h: TuiHarness, label: string) {
  const rows = h.render().filter((line) => /^(?:→|\s) /.test(line) && /[A-Za-z]/.test(line));
  const target = rows.findIndex((line) => line.includes(label));
  expect(target, `missing menu item ${label}\n${frame(h)}`).toBeGreaterThanOrEqual(0);
  const cursor = Math.max(0, rows.findIndex((line) => line.trimStart().startsWith("→")));
  for (let i = cursor; i < target; i++) h.press("tui.select.down");
  for (let i = cursor; i > target; i--) h.press("tui.select.up");
  await press(h);
}
async function enter(h: TuiHarness, value: string) {
  h.send("\x15"); h.type(value); await press(h, "tui.input.submit");
}
async function messagingScreen(f: Awaited<ReturnType<typeof fixture>>) {
  await f.h.waitForOpen();
  await enter(f.h, ID);
  await enter(f.h, "org-old");
  await select(f.h, "Keep existing credential");
  await select(f.h, "Back · Edit configuration");
  await select(f.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
}

/** Actual extension command -> actual wizard -> actual Setup transaction. */
describe("extension setup messaging authorization", () => {
  it("persists both sides for the trusted runtime session, keeps the credential and requires restart/reload", async () => {
    const f = await fixture();
    const pending = f.command.handler("setup", f.ctx);
    try {
      await messagingScreen(f);
      expect(frame(f.h)).toContain(SESSION);
      await select(f.h, "Authorize messaging for this session");
      await select(f.h, "Back · Review");
      await select(f.h, "Review");
      await press(f.h); // Review -> explicit messaging change confirmation
      expect(frame(f.h)).toContain("Existing Tunnel configuration will be changed");
      await press(f.h);
      expect(existsSync(piAllowlistPath(f.profilePath))).toBe(false);
      await select(f.h, "Save configuration");
      await pending;

      expect(f.getSessionId).toHaveBeenCalled();
      const facts = parseTunnelProfile(readFileSync(f.profilePath, "utf8"));
      const bindingPath = parseTunnelMcpCommand(facts.mcpCommand!).bindingPath;
      expect(bindingPath).not.toBe(f.oldBinding);
      const binding = JSON.parse(readFileSync(bindingPath, "utf8"));
      expect(binding.managed).toEqual({ tunnelId: ID, organizationId: "org-old", adapter: "chatgpt" });
      expect(binding.endpoint).toEqual({ adapter: "chatgpt", endpointId: "chatgpt/main" });
      expect(binding.recipients).toEqual([{ adapter: "pi", endpointId: "pi/main" }]);
      expect(binding.payloadRead).toEqual({ enabled: true });
      expect(binding.ack).toEqual({ enabled: true });
      expect(binding.debugExecutionGuard).toEqual({ enabled: false });
      const allowlistPath = piAllowlistPath(f.profilePath, bindingPath);
      const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
      expect(allowlist.sessions).toEqual({ [SESSION]: { endpointId: "pi/main" } });
      expect(allowlist.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
      expect(allowlist.exchangeNamespace).toBe(binding.exchange.namespace);
      expect(allowlist.exchangeIdempotencyKey).toBe(binding.exchange.idempotencyKey);
      expect(allowlist.store).toEqual(binding.store);
      expect(allowlist.payloadRead).toEqual({ enabled: true });
      expect(allowlist.ack).toEqual({ enabled: true });
      expect(lstatSync(allowlistPath).mode & 0o777).toBe(0o600);
      expect(existsSync(join(binding.store.directory, binding.store.file))).toBe(false); // Configured, not live CE.
      // A fresh extension factory consumes the generated default after reload,
      // without a CE_ALLOWLIST/Store environment override or hand-written JSON.
      vi.stubEnv("CE_ALLOWLIST", "");
      const registered: string[] = [];
      const { default: freshFactory } = await import(extensionUrl);
      type Entry = { type: string; customType: string; data: unknown };
      const entries: Entry[] = [];
      const events = new Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>();
      const freshCommands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
      freshFactory({ on: (event: string, handler: never) => events.set(event, handler),
        appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
        registerCommand: (name: string, command: never) => freshCommands.set(name, command),
        registerTool: (tool: { name: string }) => registered.push(tool.name) });
      expect(registered).toContain("ce_ack");
      expect(registered).toContain("ce_read_payload");
      const freshCtx = { ...f.ctx, sessionManager: { ...f.ctx.sessionManager, getBranch: () => entries } };
      await events.get("session_start")!({ reason: "reload" }, freshCtx);
      expect(entries.filter((entry) => entry.customType === "ce-mapping")).toHaveLength(0);
      const activating = freshCommands.get("ce-tunnel")!.handler("setup", freshCtx);
      try {
        await messagingScreen(f);
        await select(f.h, "Activate current session"); // closes the wizard, no save
        expect(frame(f.h)).toContain("Messaging · explicit confirmation");
        expect(frame(f.h)).toContain("Cancel"); // confirmation has not bound anything
        expect(entries.filter((entry) => entry.customType === "ce-mapping")).toHaveLength(0);
        await select(f.h, "Activate current session");
        await activating;
        expect(entries.filter((entry) => entry.customType === "ce-mapping")).toHaveLength(1);
        expect(entries.find((entry) => entry.customType === "ce-mapping")!.data).toMatchObject({ endpointId: "pi/main" });
        expect(existsSync(join(binding.store.directory, binding.store.file))).toBe(true);
      } finally {
        f.h.dispose(); await activating;
        await events.get("session_shutdown")!({ reason: "quit" }, freshCtx);
      }
      expect(facts.keyFile).toBe(f.keyFile);
      expect(readFileSync(f.keyFile, "utf8")).toBe(CREDENTIAL);
      const keyAfter = lstatSync(f.keyFile);
      expect([keyAfter.ino, keyAfter.dev, keyAfter.mtimeMs, keyAfter.mode]).toEqual(
        [f.keyBefore.ino, f.keyBefore.dev, f.keyBefore.mtimeMs, f.keyBefore.mode]);
      const notice = f.notify.mock.calls.map(([text]) => String(text)).join("\n");
      expect(notice).toContain("configuration saved");
      expect(notice).toContain("restart the Tunnel (Stop then Start)");
      expect(notice).toContain("reload this Pi session/extension");
      expect(notice).toContain("Configured != Connected != live messaging");
      expect(notice).not.toContain(CREDENTIAL);
      expect(f.input).not.toHaveBeenCalled();
      expect(f.appendEntry).not.toHaveBeenCalled();
    } finally { f.h.dispose(); await pending; }
  });

  it.each(["empty", "throws"])("does not guess a runtime session when getSessionId %s", async (kind) => {
    const f = await fixture(() => { if (kind === "throws") throw new Error("unavailable"); return ""; });
    const before = readFileSync(f.profilePath, "utf8");
    const pending = f.command.handler("setup", f.ctx);
    try {
      await messagingScreen(f);
      expect(frame(f.h)).toContain("Unavailable");
      expect(frame(f.h)).toContain("never guessed");
      expect(frame(f.h)).not.toContain("Authorize messaging");
      await press(f.h, "tui.select.cancel");
      await pending;
      expect(readFileSync(f.profilePath, "utf8")).toBe(before);
      expect(existsSync(piAllowlistPath(f.profilePath))).toBe(false);
      expect(existsSync(join(f.directory, ".ce-bindings"))).toBe(false);
      expect(readFileSync(f.keyFile, "utf8")).toBe(CREDENTIAL);
      expect(f.appendEntry).not.toHaveBeenCalled();
      expect(f.input).not.toHaveBeenCalled();
    } finally { f.h.dispose(); await pending; }
  });
});
