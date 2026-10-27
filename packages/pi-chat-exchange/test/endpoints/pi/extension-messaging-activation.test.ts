import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTunnelProfileSetup, readGeneratedPiAllowlist } from "../../../dist/tunnel/setup.js";
import { createBackgroundTunnelManager } from "../../../dist/tunnel/background-manager.js";
import { parseTunnelMcpCommand, buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { parseTunnelProfile } from "../../../dist/tunnel/background-manager.js";
import { CeEndpointHost } from "../../../dist/host/endpoint-host.js";
import type { McpBindingConfig } from "../../../dist/host/mcp-binding-config.js";
import type { DurableStore } from "../../../dist/storage/store.js";
import type { CeSessionHost, CeMappingIdentifiers } from "../../../src/endpoints/pi/session-host.js";

const seam = vi.hoisted(() => ({ hosts: [] as CeSessionHost[], stores: [] as DurableStore[], confirm: vi.fn(async (_ctx: unknown, _options: unknown) => true),
  defaultExec: vi.fn(() => { throw Error("FORBIDDEN default process inspection"); }),
  defaultSpawn: vi.fn(() => { throw Error("FORBIDDEN default process spawn"); }),
  signal: vi.fn(() => { throw Error("FORBIDDEN process signal"); }),
  fallback: undefined as string | undefined,
}));
// Virtualize ONLY this isolated extension's default allowlist path; never
// create/read an installed or parent runtime allowlist.
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
    String(args[0]) === new URL("../../../pi-extension/allowlist.json", import.meta.url).pathname && seam.fallback !== undefined
      ? seam.fallback : actual.readFileSync(...args) };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: seam.defaultExec, spawn: seam.defaultSpawn }));
// Inject process seams into EVERY manager, including the extension-created one.
vi.mock("../../../dist/tunnel/background-manager.js", async original => {
  const actual = await original<typeof import("../../../dist/tunnel/background-manager.js")>();
  return { ...actual, createBackgroundTunnelManager: (options: Parameters<typeof actual.createBackgroundTunnelManager>[0]) => actual.createBackgroundTunnelManager({ ...options,
    listProcesses: async () => ({ kind: "ok", processes: [] }),
    inspectProcess: async () => ({ kind: "absent" }),
    spawn: seam.defaultSpawn, signal: seam.signal,
  }) };
});
// Setup, loader, Host and SQLite are real; process discovery is synthetic.
vi.mock("../../../dist/tunnel/messaging-activation-ui.js", () => ({ confirmMessagingActivation: (...args: [unknown, unknown]) => seam.confirm(...args) }));
vi.mock("../../../dist/endpoints/pi/session-host.js", async (original) => {
  const actual = await original<typeof import("../../../src/endpoints/pi/session-host.js")>();
  return { ...actual, CeSessionHost: class extends actual.CeSessionHost {
    constructor(store: DurableStore, policy: ConstructorParameters<typeof actual.CeSessionHost>[1]) {
      super(store, policy); seam.hosts.push(this); seam.stores.push(store);
    }
  } };
});
const rootDirs: string[] = [];
const shutdowns: Array<() => Promise<void>> = [];
const extensionUrl = new URL("../../../pi-extension/index.ts", import.meta.url).href;
type Entry = { type: string; customType: string; data: unknown };
type Context = { mode: string; hasUI: boolean; cwd: string; sessionManager: { getSessionId(): string; getSessionFile(): string; getBranch(): Entry[] }; ui: { confirm: ReturnType<typeof vi.fn>; custom: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } };
type Handler = (event: { reason: string }, ctx: Context) => Promise<void>;
type Command = { handler(args: string, ctx: Context): Promise<void> };
beforeEach(() => { seam.fallback = undefined; for (const key of Object.keys(process.env)) if (key.startsWith("CE_")) vi.stubEnv(key, undefined); vi.spyOn(process, "kill").mockImplementation(seam.signal); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-22T00:00:00Z")); seam.hosts.length = 0; seam.stores.length = 0; seam.confirm.mockReset().mockResolvedValue(true); });
afterEach(async () => {
  for (const end of shutdowns.splice(0)) await end().catch(() => undefined);
  for (const store of new Set(seam.stores.splice(0))) store.close();
  expect(seam.defaultExec).not.toHaveBeenCalled(); expect(seam.defaultSpawn).not.toHaveBeenCalled(); expect(seam.signal).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const dir of rootDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture(source: "generated" | "absent-profile" | "nonmessaging-profile" | "explicit" = "generated") {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-explicit-activation-"))); rootDirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml"); const key = join(dir, "key");
  fs.writeFileSync(key, "SYNTHETIC-ONLY", { mode: 0o600 });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", organizationId: "org-test", keyFile: key,
    healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: join(dir, "old.json") }) })), { mode: 0o600 });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, listProcesses: async () => ({ kind: "ok", processes: [] }),
    inspectProcess: async (pid) => ({ kind: "present", identity: { pid, command: "synthetic", startedKey: "synthetic" } }) });
  const setup = createTunnelProfileSetup({ env: {}, profilePath, manager, nodePath: "/abs/node" });
  const save = (piEndpointId = "pi/main") => setup.save({ expectedRevision: setup.inspect().revision, tunnelId: "tunnel_abcdefgh123456", organizationId: "org-test", credential: { kind: "keep" },
    binding: { kind: "managed", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: piEndpointId }], capabilities: { payloadRead: true, ack: true } },
    messaging: { chatgptEndpointId: "chatgpt/main", piEndpointId, piSessionId: "runtime-current", payloadRead: true, ack: true, replaceExisting: true } });
  await save();
  const bindingPath = parseTunnelMcpCommand(parseTunnelProfile(fs.readFileSync(profilePath, "utf8")).mcpCommand!).bindingPath!;
  const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
  for (const [name, value] of Object.entries({ CE_ALLOWLIST: "", CE_STORE_DIR: binding.store.directory, CE_STORE_FILE: binding.store.file,
    CE_TUNNEL_PROFILE: profilePath, CE_TUNNEL_OFFLINE_TEST: "", CE_LEASE_TTL_SECONDS: "" })) vi.stubEnv(name, value);
  if (source !== "generated") {
    const document = JSON.stringify(readGeneratedPiAllowlist(profilePath));
    if (source === "explicit") {
      const path = join(dir, "explicit-allowlist.json"); fs.writeFileSync(path, document, { mode: 0o600 }); vi.stubEnv("CE_ALLOWLIST", path);
    } else {
      seam.fallback = document;
      if (source === "absent-profile") fs.unlinkSync(profilePath);
      else fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: key, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: join(dir, "nonmessaging.json") }) })), { mode: 0o600 });
    }
  }
  const entries: Entry[] = []; let runtimeId = "runtime-current";
  const events = new Map<string, Handler>(); const commands = new Map<string, Command>();
  const append = vi.fn((customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); });
  const ctx: Context = { mode: "tui", hasUI: true, cwd: dir,
    sessionManager: { getSessionId: () => runtimeId, getSessionFile: () => join(dir, "not-an-identity"), getBranch: () => entries },
    ui: { confirm: vi.fn(async () => true), custom: vi.fn(), notify: vi.fn(), setStatus: vi.fn() } };
  const { default: factory } = await import(extensionUrl);
  const reloadFactory = () => factory({ on: (name: string, handler: Handler) => events.set(name, handler), registerTool: vi.fn(), registerCommand: (name: string, command: Command) => commands.set(name, command), appendEntry: append });
  reloadFactory();
  const shutdown = (reason = "quit") => events.get("session_shutdown")!({ reason }, ctx); shutdowns.push(shutdown);
  return { dir, profilePath, setup, save, binding, entries, ctx, append, shutdown, reloadFactory,
    start: (reason = "reload") => events.get("session_start")!({ reason }, ctx),
    activate: () => commands.get("ce-tunnel")!.handler("activate", ctx),
    command: (args: string) => commands.get("ce-tunnel")!.handler(args, ctx),
    switchSession: () => { runtimeId = "runtime-other"; },
    mapping: () => entries.findLast((e) => e.customType === "ce-mapping")?.data as CeMappingIdentifiers | undefined,
    notices: () => ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n"),
  };
}
function seedHistory(binding: McpBindingConfig) {
  const store = seam.stores[0]!;
  const chat = new CeEndpointHost(store, { adapter: "chatgpt", exchangeNamespace: binding.exchange.namespace,
    exchangeIdempotencyKey: binding.exchange.idempotencyKey, allowlist: [{ endpointId: "chatgpt/main" }],
    recipients: binding.recipients, payloadRead: { enabled: true }, ack: { enabled: true } });
  chat.beginSession("chatgpt/main"); shutdowns.push(async () => { chat.end("chatgpt/main"); });
  const sent = chat.send("chatgpt/main", { to: "pi/main", text: "synthetic history · 非空 🧪", idempotencyKey: "history-before-deactivate" });
  const pi = seam.hosts[0]!; const payload = pi.readPayload("pi/main", { messageId: sent.messageId });
  pi.acknowledge("pi/main", { messageId: sent.messageId, payloadDigest: payload.payloadDigest,
    payloadLength: payload.payloadLength, messageCreatedAuditSequence: payload.auditSequence });
  const snapshot = () => ({ messages: store.database.prepare("SELECT *, hex(payload_body) AS payload_hex FROM message ORDER BY message_id").all(),
    receipts: store.database.prepare("SELECT * FROM delivery_ack_receipt ORDER BY receipt_id").all() });
  const before = snapshot(); expect(before.messages).toHaveLength(1); expect(before.receipts).toHaveLength(1);
  expect(before.messages[0]!.payload_hex).toBe(Buffer.from("synthetic history · 非空 🧪").toString("hex").toUpperCase());
  return { snapshot, before };
}
function counts() { const db = seam.stores[0]!.database; return { sessions: db.prepare("SELECT count(*) n FROM participant_session").get()!.n,
  capabilities: db.prepare("SELECT count(*) n FROM participant_capability").get()!.n, owners: db.prepare("SELECT count(*) n FROM participant_ownership").get()!.n }; }

describe("explicit current-session messaging activation over real isolated Host/Store", () => {
  it("does not fresh-bind on reload; explicit confirmation creates one identifier mapping and durable owner", async () => {
    const h = await fixture(); await h.start();
    expect(h.notices()).toContain("CE_HOST_MAPPING_INVALID"); expect(h.mapping()).toBeUndefined(); expect(counts().sessions).toBe(0);
    await h.activate();
    expect(seam.confirm).toHaveBeenCalledTimes(1); expect(h.mapping()?.endpointId).toBe("pi/main"); expect(counts()).toMatchObject({ sessions: 1, owners: 1 });
    expect(Object.keys(h.mapping()!).sort()).toEqual(["endpointId", "exchangeId", "participantId", "sessionId"]);
    expect(h.notices()).toContain("Pi messaging bound"); expect(h.notices()).toContain("not real Gate evidence");
    const before = counts(); const mapping = h.mapping(); await h.activate();
    expect(counts()).toEqual(before); expect(h.mapping()).toEqual(mapping); // same live authority, no provisioning
    await h.shutdown(); expect(counts().owners).toBe(0);
  });
  it("requires confirmation and preserves ordinary reload refusal after cancel", async () => {
    const h = await fixture(); await h.start(); seam.confirm.mockResolvedValue(false);
    await h.activate(); expect(h.mapping()).toBeUndefined(); expect(counts().sessions).toBe(0);
    await h.start(); expect(h.mapping()).toBeUndefined(); expect(counts().sessions).toBe(0);
  });
  it("appends a new Exchange mapping without modifying old history", async () => {
    const h = await fixture(); await h.start();
    const { CeSessionHost: ActualHost } = await vi.importActual<typeof import("../../../src/endpoints/pi/session-host.js")>("../../../dist/endpoints/pi/session-host.js");
    const historic = new ActualHost(seam.stores[0]!, { adapter: "pi", exchangeNamespace: "old-exchange", exchangeIdempotencyKey: "old-exchange",
      allowlist: [{ piSessionId: "runtime-current", endpointId: "pi/main" }] });
    const old = historic.beginSession("pi/main", { requireUnowned: true }); historic.end("pi/main"); historic.drop("pi/main");
    h.entries.push({ type: "custom", customType: "ce-mapping", data: old });
    h.entries.push({ type: "custom", customType: "ce-messaging-released", data: { piSessionId: "runtime-current", ...old } }); // trusted runtime record of the verified end above
    await h.start(); expect(h.notices()).toContain("CE_HOST_MAPPING_INVALID");
    await h.activate(); expect(h.entries.filter((e) => e.customType === "ce-mapping")).toHaveLength(2);
    expect(h.entries.find((e) => e.customType === "ce-mapping")!.data).toBe(old); expect(h.mapping()).not.toEqual(old);
  });
  it.each([false, true])("never takes over an existing owner, expired=%s", async (expired) => {
    const h = await fixture(); await h.start();
    const { CeSessionHost: ActualHost } = await vi.importActual<typeof import("../../../src/endpoints/pi/session-host.js")>("../../../dist/endpoints/pi/session-host.js");
    const foreign = new ActualHost(seam.stores[0]!, { adapter: "pi", exchangeNamespace: h.binding.exchange.namespace, exchangeIdempotencyKey: h.binding.exchange.idempotencyKey,
      allowlist: [{ piSessionId: "runtime-current", endpointId: "pi/main" }] });
    foreign.beginSession("pi/main", { requireUnowned: true }); if (expired) vi.setSystemTime(Date.now() + 180000);
    const before = counts(); await h.activate(); expect(h.mapping()).toBeUndefined(); expect(counts()).toEqual(before);
    expect(h.notices()).toContain("activation refused"); foreign.drop("pi/main");
  });
  it.each(["session", "configuration"])("rechecks %s after confirmation before authority writes", async (change) => {
    const h = await fixture(); await h.start();
    seam.confirm.mockImplementation(async () => { if (change === "session") h.switchSession(); else fs.appendFileSync(h.profilePath, "\n# changed\n"); return true; });
    await h.activate(); expect(h.mapping()).toBeUndefined(); expect(counts().sessions).toBe(0); expect(h.notices()).toContain("activation refused");
  });
  it("latches mapping persistence failure and never provisions on a second activation", async () => {
    const h = await fixture(); await h.start();
    h.append.mockImplementation((type: string) => { if (type === "ce-mapping") throw new Error("synthetic persist failure"); });
    await h.activate(); expect(h.mapping()).toBeUndefined(); const before = counts();
    expect(before.sessions).toBe(1); await h.activate(); expect(counts()).toEqual(before); expect(h.notices()).toContain("CE_HOST_UNAVAILABLE");
  });
  it("unknown old release latches failure, does not bind again and is not retried", async () => {
    const h = await fixture(); await h.start(); await h.activate();
    const { CeHostRefusal } = await import("../../../dist/endpoints/pi/session-host.js");
    const end = vi.spyOn(seam.hosts[0]!, "end").mockImplementation(() => { throw new CeHostRefusal("CE_HOST_UNCERTAIN"); });
    await h.shutdown(); const before = counts(); await h.activate(); await h.activate();
    expect(counts()).toEqual(before); expect(end).toHaveBeenCalledTimes(1); expect(h.notices()).toContain("CE_HOST_UNCERTAIN");
  });
  it("releases a known old binding, requires reload, then appends the new selected mapping", async () => {
    const h = await fixture(); await h.start(); await h.activate();
    const old = h.mapping()!; await h.save("pi/new");
    await h.activate();
    expect(counts()).toMatchObject({ sessions: 1, owners: 0 });
    expect(h.mapping()).toEqual(old); expect(h.notices()).toContain("reload the extension");
    h.reloadFactory(); await h.start(); // ordinary reload must not adopt old endpoint/Exchange mapping
    expect(h.mapping()).toEqual(old);
    await h.activate();
    expect(h.mapping()?.endpointId).toBe("pi/new");
    expect(h.entries.filter((e) => e.customType === "ce-mapping")).toHaveLength(2);
    expect(h.entries.find((e) => e.customType === "ce-mapping")!.data).toEqual(old);
  });
  it("an UNKNOWN release during policy change cannot be cleared by reload or another activation", async () => {
    const h = await fixture(); await h.start(); await h.activate();
    const { CeHostRefusal } = await import("../../../dist/endpoints/pi/session-host.js");
    const end = vi.spyOn(seam.hosts[0]!, "end").mockImplementation(() => { throw new CeHostRefusal("CE_HOST_UNCERTAIN"); });
    await h.save("pi/new"); await h.activate(); const before = counts();
    await h.activate(); expect(counts()).toEqual(before); expect(end).toHaveBeenCalledTimes(1);
    h.reloadFactory(); await h.start(); await h.activate();
    expect(h.mapping()?.endpointId).toBe("pi/main"); // blocked history must not yield fresh target authority
    expect(counts()).toEqual(before); expect(end).toHaveBeenCalledTimes(1);
    expect(seam.stores[0]!.database.prepare("SELECT count(*) n FROM participant WHERE endpoint_id = ?").get("pi/new")!.n).toBe(0);
  });
  it("merges activation UI ownership, refuses overlapping setup/Manager and aborts on shutdown", async () => {
    const h = await fixture(); await h.start();
    let confirm!: (value: boolean) => void;
    seam.confirm.mockImplementation(() => new Promise<boolean>((resolve) => { confirm = resolve; }));
    const pending = h.activate();
    try {
      await h.activate(); await h.command("setup"); await h.command("");
      expect(seam.confirm).toHaveBeenCalledTimes(1);
      expect(h.ctx.ui.custom).not.toHaveBeenCalled();
      const ending = h.shutdown(); confirm(true); await pending; await ending;
      expect(h.mapping()).toBeUndefined(); expect(counts().sessions).toBe(0);
    } finally { confirm(true); await pending; }
  });
  it("refuses endpoint B after skipping A's release and directly reloading", async () => {
    const h = await fixture(); await h.start(); await h.activate(); const old = h.mapping()!;
    const end = vi.spyOn(seam.hosts[0]!, "end");
    await h.save("pi/new"); await h.shutdown("reload");
    h.reloadFactory(); await h.start(); const before = counts();
    await h.activate();
    expect(h.mapping()).toEqual(old); expect(counts()).toEqual(before); expect(end).not.toHaveBeenCalled();
    expect(h.notices()).toContain("activation refused");
    expect(seam.stores[0]!.database.prepare("SELECT count(*) n FROM participant WHERE endpoint_id = ?").get("pi/new")!.n).toBe(0);
  });
  it.each(["missing", "wrong-session", "wrong-mapping"])("refuses %s release proof without new durable authority", async (kind) => {
    const h = await fixture(); await h.start(); await h.activate(); await h.save("pi/new"); await h.activate();
    const proof = h.entries.find((entry) => entry.customType === "ce-messaging-released")!;
    if (kind === "missing") h.entries.splice(h.entries.indexOf(proof), 1);
    else proof.data = { ...(proof.data as Record<string, unknown>), [kind === "wrong-session" ? "piSessionId" : "sessionId"]: "other" };
    h.reloadFactory(); await h.start(); const before = counts(); await h.activate();
    expect(counts()).toEqual(before); expect(h.mapping()?.endpointId).toBe("pi/main");
  });
  it("cannot turn failed release-proof persistence into a successful target bind", async () => {
    const h = await fixture(); await h.start(); await h.activate(); await h.save("pi/new");
    const append = h.append.getMockImplementation()!;
    h.append.mockImplementation((type, data) => { if (type === "ce-messaging-released") throw new Error("synthetic persistence failure"); append(type, data); });
    await h.activate(); h.reloadFactory(); await h.start(); const before = counts(); await h.activate();
    expect(counts()).toEqual(before); expect(h.mapping()?.endpointId).toBe("pi/main");
    expect(h.notices()).toContain("CE_HOST_UNAVAILABLE");
  });
});

describe("explicit current-session deactivation", () => {
  it("characterizes ended legacy mapping: reload must refuse auto-resume, explicit activation may rebind", async () => {
    const h = await fixture(); await h.start(); await h.activate(); await h.shutdown();
    const before = counts(); h.ctx.ui.notify.mockClear(); h.reloadFactory(); await h.start();
    expect(counts()).toEqual(before); expect(h.notices()).toContain("CE_HOST_MAPPING_INVALID");
    h.ctx.ui.notify.mockClear(); await h.activate();
    expect(h.notices()).toContain("Pi messaging bound"); expect(counts().owners).toBe(1);
  });
  it("ends once, preserves registration/history, cancels heartbeat and allows explicit activation", async () => {
    const h = await fixture(); await h.start(); await h.activate(); const mapping = h.mapping();
    const history = seedHistory(h.binding);
    const end = vi.spyOn(seam.hosts[0]!, "end"); const renew = vi.spyOn(seam.hosts[0]!, "renew");
    const profile = fs.readFileSync(h.profilePath, "utf8");
    const participants = seam.stores[0]!.database.prepare("SELECT * FROM participant").all();
    await h.command("deactivate"); expect(history.snapshot()).toEqual(history.before);
    await h.command("deactivate"); expect(history.snapshot()).toEqual(history.before);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(end).toHaveBeenCalledTimes(1); expect(renew).not.toHaveBeenCalled(); expect(counts().owners).toBe(1); // synthetic ChatGPT owner remains
    expect(h.mapping()).toEqual(mapping); expect(fs.readFileSync(h.profilePath, "utf8")).toBe(profile);
    expect(seam.stores[0]!.database.prepare("SELECT * FROM participant").all()).toEqual(participants);
    expect(h.notices()).toContain("Pi messaging deactivated");
    await h.activate(); expect(counts().owners).toBe(2); expect(history.snapshot()).toEqual(history.before);
  });
  it("no binding and cancellation write nothing", async () => {
    const h = await fixture(); await h.start(); const before = counts();
    await h.command("deactivate"); expect(counts()).toEqual(before); expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
    await h.activate(); const entries = [...h.entries]; const active = counts();
    h.ctx.ui.confirm.mockResolvedValue(false); await h.command("deactivate");
    expect(counts()).toEqual(active); expect(h.entries).toEqual(entries);
    expect(h.ctx.ui.confirm).toHaveBeenCalledTimes(1); expect(h.notices()).not.toContain("Pi messaging deactivated");
  });
  it.each(["session", "configuration", "environment", "generation", "dialog"])("refuses stale %s without end", async change => {
    const h = await fixture(); await h.start(); await h.activate(); const end = vi.spyOn(seam.hosts[0]!, "end");
    h.ctx.ui.confirm.mockImplementation(async () => {
      if (change === "session") h.switchSession();
      else if (change === "configuration") fs.appendFileSync(h.profilePath, "\n# changed\n");
      else if (change === "environment") vi.stubEnv("CE_STORE_FILE", "changed.sqlite");
      else if (change === "generation") void h.start("reload");
      else throw Error("private-dialog-error");
      return true;
    });
    await h.command("deactivate"); expect(end).not.toHaveBeenCalled();
    expect(h.notices()).not.toContain("Pi messaging deactivated"); expect(h.notices()).not.toContain("private-dialog-error");
  });
  it("rejects a stale native ID before opening the dialog", async () => {
    const h = await fixture(); await h.start(); await h.activate(); h.switchSession();
    const end = vi.spyOn(seam.hosts[0]!, "end"); await h.command("deactivate");
    expect(h.ctx.ui.confirm).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  });
  it("shares operation busy latch and cancels pending confirmation on teardown", async () => {
    const h = await fixture(); await h.start(); await h.activate();
    let resolve!: (value: boolean) => void;
    h.ctx.ui.confirm.mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    const pending = h.command("deactivate"); await Promise.resolve();
    const end = vi.spyOn(seam.hosts[0]!, "end");
    try {
      await h.command("deactivate"); await h.activate(); await h.command("setup"); await h.command("");
      expect(h.ctx.ui.confirm).toHaveBeenCalledTimes(1); expect(h.ctx.ui.custom).not.toHaveBeenCalled();
      const ending = h.shutdown("reload"); resolve(true); await pending; await ending;
      expect(end).not.toHaveBeenCalled(); expect(h.notices()).not.toContain("Pi messaging deactivated");
    } finally { resolve?.(false); await pending; }
  });
  it.each(["end", "persistence"])("unknown %s fails closed, reports no success and never ends twice", async kind => {
    const h = await fixture(); await h.start(); await h.activate();
    const end = vi.spyOn(seam.hosts[0]!, "end");
    if (kind === "end") end.mockImplementation(() => { throw Error("private-end-error"); });
    else { const append = h.append.getMockImplementation()!; h.append.mockImplementation((type, data) => { if (type === "ce-messaging-released") throw Error("private-proof-error"); append(type, data); }); }
    await h.command("deactivate"); await h.command("deactivate"); await h.activate();
    expect(end).toHaveBeenCalledTimes(1); expect(h.notices()).not.toContain("Pi messaging deactivated");
    expect(h.notices()).toContain("CE_HOST_UNAVAILABLE"); expect(h.notices()).not.toContain("private-end-error");
    expect(h.notices()).not.toContain("private-proof-error");
  });
  it.each(["rpc", "json"])("requires real TUI confirmation in %s mode", async mode => {
    const h = await fixture(); await h.start(); await h.activate(); h.ctx.mode = mode;
    const end = vi.spyOn(seam.hosts[0]!, "end"); await h.command("deactivate");
    expect(end).not.toHaveBeenCalled(); expect(h.ctx.ui.confirm).not.toHaveBeenCalled(); expect(h.notices()).toContain("CE_TUNNEL_INPUT_UNAVAILABLE");
  });
});

it.each(["absent-profile", "nonmessaging-profile", "explicit"] as const)("standalone %s source deactivates normally without requiring generated configuration", async source => {
  const h = await fixture(source);
  if (source === "explicit") fs.writeFileSync(h.profilePath, "irrelevant malformed profile\n", { mode: 0o600 });
  await h.start("startup");
  expect(counts().owners).toBe(1); const end = vi.spyOn(seam.hosts[0]!, "end");
  await h.command("deactivate"); expect(end).toHaveBeenCalledTimes(1); expect(counts().owners).toBe(0);
  expect(h.notices()).toContain("Pi messaging deactivated");
});
it("standalone fallback allowlist drift during confirmation refuses before end", async () => {
  const h = await fixture("nonmessaging-profile"); await h.start("startup");
  const end = vi.spyOn(seam.hosts[0]!, "end");
  h.ctx.ui.confirm.mockImplementation(async () => { seam.fallback += "\n "; return true; });
  await h.command("deactivate"); expect(end).not.toHaveBeenCalled(); expect(counts().owners).toBe(1);
  expect(h.notices()).not.toContain("Pi messaging deactivated"); expect(h.notices()).toContain("CE_HOST_MAPPING_INVALID");
});
it("standalone explicit allowlist drift during confirmation refuses before end", async () => {
  const h = await fixture("explicit"); await h.start("startup");
  const end = vi.spyOn(seam.hosts[0]!, "end");
  h.ctx.ui.confirm.mockImplementation(async () => { fs.appendFileSync(process.env.CE_ALLOWLIST!, "\n "); return true; });
  await h.command("deactivate"); expect(end).not.toHaveBeenCalled(); expect(counts().owners).toBe(1);
});
it("a malformed selected generated pair cannot redirect deactivation to the fallback", async () => {
  const h = await fixture(); await h.start(); await h.activate();
  seam.fallback = JSON.stringify(readGeneratedPiAllowlist(h.profilePath));
  const selectedBinding = parseTunnelMcpCommand(parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).mcpCommand!).bindingPath;
  fs.writeFileSync(selectedBinding, "{}", { mode: 0o600 });
  const end = vi.spyOn(seam.hosts[0]!, "end"); await h.command("deactivate");
  expect(end).not.toHaveBeenCalled(); expect(h.ctx.ui.confirm).not.toHaveBeenCalled(); expect(counts().owners).toBe(1);
});
