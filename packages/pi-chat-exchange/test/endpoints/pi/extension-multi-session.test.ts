import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackgroundTunnelManager } from "../../../dist/tunnel/background-manager.js";
import { ensureManagedBinding } from "../../../dist/tunnel/managed-binding.js";
import { publishMessagingPair } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { createMultiSessionRegistration, readSelectedMultiSessionPolicy } from "../../../dist/tunnel/multi-session-policy.js";
import { CeHostRefusal, CeEndpointHost } from "../../../dist/host/endpoint-host.js";
import { openStore, type DurableStore } from "../../../dist/storage/store.js";
import type { CeSessionHost } from "../../../dist/endpoints/pi/session-host.js";

const seam = vi.hoisted(() => ({ hosts: [] as CeSessionHost[], stores: [] as DurableStore[], manager: undefined as unknown,
  defaultExec: vi.fn(() => { throw Error("FORBIDDEN default process inspection"); }),
  defaultSpawn: vi.fn(() => { throw Error("FORBIDDEN process spawn"); }),
  signal: vi.fn(() => { throw Error("FORBIDDEN process signal"); }),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: seam.defaultExec, spawn: seam.defaultSpawn }));
vi.mock("../../../dist/tunnel/messaging-activation-ui.js", () => ({ confirmMessagingActivation: (ctx: Context) => ctx.ui.confirm("activate", "synthetic operator confirmation") }));
vi.mock("../../../dist/tunnel/background-manager.js", async (original) => {
  const actual = await original<typeof import("../../../dist/tunnel/background-manager.js")>();
  return { ...actual, createBackgroundTunnelManager: (...args: Parameters<typeof actual.createBackgroundTunnelManager>) => seam.manager ?? actual.createBackgroundTunnelManager(...args) };
});
vi.mock("../../../dist/endpoints/pi/session-host.js", async (original) => {
  const actual = await original<typeof import("../../../dist/endpoints/pi/session-host.js")>();
  return { ...actual, CeSessionHost: class extends actual.CeSessionHost {
    constructor(store: DurableStore, policy: ConstructorParameters<typeof actual.CeSessionHost>[1]) { super(store, policy); seam.hosts.push(this); seam.stores.push(store); }
  } };
});
type Entry = { type: string; customType: string; data: unknown };
type Context = { mode: string; hasUI: boolean; cwd: string; sessionManager: { getSessionId(): string; getSessionFile(): string; getBranch(): Entry[] }; ui: { notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn<(title: string, message: string) => Promise<boolean>>>; custom: ReturnType<typeof vi.fn> } };
type Handler = (event: { reason: string }, ctx: Context) => Promise<void>;
type Tool = { name: string; execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: Context): Promise<{ isError?: boolean; details?: Record<string, unknown> }> };
const dirs: string[] = []; const shutdowns: Array<() => Promise<void>> = [];
beforeEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith("CE_")) vi.stubEnv(key, undefined); vi.spyOn(process, "kill").mockImplementation(seam.signal); vi.useFakeTimers(); seam.hosts.length = 0; seam.stores.length = 0; seam.manager = undefined; });
afterEach(async () => {
  for (const stop of shutdowns.splice(0)) await stop();
  for (const store of new Set(seam.stores.splice(0))) store.close();
  expect(seam.defaultExec).not.toHaveBeenCalled(); expect(seam.defaultSpawn).not.toHaveBeenCalled(); expect(seam.signal).not.toHaveBeenCalled();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); seam.manager = undefined;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
async function fixture(convert = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-pi-multi-"))); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml");
  const binding = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined,
    adapter: "chatgpt", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/A" }], capabilities: { payloadRead: true, ack: true } });
  const pair = publishMessagingPair(profilePath, binding.config, { chatgptEndpoint: binding.config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "real-A",
    store: binding.config.store, exchangeNamespace: binding.config.exchange.namespace, exchangeIdempotencyKey: binding.config.exchange.idempotencyKey, payloadRead: true, ack: true });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: join(dir, "NEVER-READ-CREDENTIAL"), healthUrlFile: join(dir, "health.url"),
    mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  let processState: "ok" | "unknown" | "running" = "ok";
  const manager = createBackgroundTunnelManager({ env: {}, profilePath,
    listProcesses: async () => processState === "unknown" ? { kind: "unknown" } : { kind: "ok", processes: processState === "running" ? [{ pid: 123, command: `synthetic --profile-file ${profilePath}`, startedKey: "synthetic" }] : [] },
    inspectProcess: async () => ({ kind: "absent" }), spawn: seam.defaultSpawn, signal: seam.signal });
  seam.manager = manager;
  const api = createMultiSessionRegistration({ profilePath, manager });
  if (convert) { await api.convert({ expectedRevision: api.revision(), confirm: true }); await api.register({ expectedRevision: api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } }); }
  for (const [key, value] of Object.entries({ CE_ALLOWLIST: "", CE_STORE_DIR: "", CE_STORE_FILE: "", CE_TUNNEL_PROFILE: profilePath, CE_LEASE_TTL_SECONDS: "", CE_TUNNEL_OFFLINE_TEST: "" })) vi.stubEnv(key, value);
  async function runtime(id: string, entries: Entry[] = []) {
    const events = new Map<string, Handler>(); const tools = new Map<string, Tool>(); const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
    let runtimeId = id;
    const ctx: Context = { mode: "tui", hasUI: true, cwd: join(dir, id), sessionManager: { getSessionId: () => runtimeId, getSessionFile: () => "not-authority", getBranch: () => entries }, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), custom: vi.fn() } };
    const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
    factory({ on: (name: string, handler: Handler) => events.set(name, handler), registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: (name: string, command: { handler(args: string, ctx: Context): Promise<void> }) => commands.set(name, command), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) });
    const stop = (reason = "quit") => events.get("session_shutdown")!({ reason }, ctx); shutdowns.push(stop);
    return { ctx, entries, events, tools, stop, start: (reason = "startup") => events.get("session_start")!({ reason }, ctx),
      call: (name: string, input: unknown = {}) => tools.get(name)!.execute("test", input, undefined, undefined, ctx),
      command: (args: string) => commands.get("ce-tunnel")!.handler(args, ctx),
      ceStatus: () => commands.get("ce-status")!.handler("", ctx),
      switchSession: () => { runtimeId = "changed-runtime"; }, notices: () => ctx.ui.notify.mock.calls.map(([s]) => String(s)).join("\n") };
  }
  return { dir, profilePath, api, binding, runtime, setProcessState: (state: typeof processState) => { processState = state; } };
}

it("actual factory events bind independent A/B Hosts; exact ChatGPT messages/replies and no Pi-Pi or cross-read/ACK", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); const b = await f.runtime("real-B"); await a.start(); await b.start();
  expect(a.entries.find(e => e.customType === "ce-mapping")?.data).toMatchObject({ endpointId: "pi/A" });
  expect(b.entries.find(e => e.customType === "ce-mapping")?.data).toMatchObject({ endpointId: "pi/B" });
  expect(seam.hosts).toHaveLength(2);
  const store = openStore({ directory: f.binding.config.store.directory, filename: f.binding.config.store.file }); seam.stores.push(store);
  const config = readSelectedMultiSessionPolicy(f.profilePath).config;
  const chatHost = new CeEndpointHost(store, { adapter: "chatgpt", exchangeNamespace: config.exchange.namespace, exchangeIdempotencyKey: config.exchange.idempotencyKey,
    allowlist: [{ endpointId: "chatgpt/main" }], recipients: config.recipients, payloadRead: { enabled: true }, ack: { enabled: true } });
  chatHost.beginSession("chatgpt/main");
  const chat = { send: (input: unknown) => chatHost.send("chatgpt/main", input), readPayload: (input: unknown) => chatHost.readPayload("chatgpt/main", input), end: () => chatHost.end("chatgpt/main") };
  const sentA = chat.send({ to: "pi/A", text: "only A", idempotencyKey: "to-a" }); const sentB = chat.send({ to: "pi/B", text: "only B", idempotencyKey: "to-b" });
  const payloadA = await a.call("ce_read_payload", { messageId: sentA.messageId }); expect(payloadA.isError).not.toBe(true);
  expect((await b.call("ce_read", { messageId: sentA.messageId })).isError).toBe(true);
  expect((await b.call("ce_read_payload", { messageId: sentA.messageId })).isError).toBe(true);
  expect((await b.call("ce_ack", { messageId: sentA.messageId, payloadDigest: payloadA.details!.payloadDigest, payloadLength: payloadA.details!.payloadLength, messageCreatedAuditSequence: payloadA.details!.auditSequence })).isError).toBe(true);
  expect((await b.call("ce_read_payload", { messageId: sentB.messageId })).isError).not.toBe(true);
  for (const [runtime, text] of [[a, "reply A"], [b, "reply B"]] as const) {
    const reply = await runtime.call("ce_send", { to: "chatgpt/main", text, idempotencyKey: text }); expect(reply.isError).not.toBe(true);
    expect(chat.readPayload({ messageId: reply.details!.messageId }).payloadText).toBe(text);
  }
  expect((await a.call("ce_send", { to: "pi/B", text: "no", idempotencyKey: "no-pi-pi" })).isError).toBe(true);
  await a.stop(); expect((await b.call("ce_inbox_list")).isError).not.toBe(true); chat.end();
});

it("reload transfers only a drained same-runtime handle; duplicate same-PID factory is denied and B survives", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); const b = await f.runtime("real-B"); await a.start(); await b.start();
  expect((await a.call("ce_inbox_list")).isError).not.toBe(true);
  const duplicate = await f.runtime("real-A"); await duplicate.start("resume"); expect((await duplicate.call("ce_inbox_list")).isError).toBe(true);
  const before = a.entries.findLast(e => e.customType === "ce-mapping")!.data;
  await a.stop("reload"); const fresh = await f.runtime("real-A", a.entries); await fresh.start("reload");
  expect(fresh.entries.findLast(e => e.customType === "ce-mapping")!.data).toEqual(before);
  expect((await fresh.call("ce_inbox_list")).isError).not.toBe(true); expect((await a.call("ce_inbox_list")).isError).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000); expect((await b.call("ce_inbox_list")).isError).not.toBe(true);
});

it("add C preserves loaded A/B; revoke and new epoch deny every old A operation while B remains usable", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); const b = await f.runtime("real-B"); await a.start(); await b.start();
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
  expect((await a.call("ce_inbox_list")).isError).not.toBe(true); expect((await b.call("ce_inbox_list")).isError).not.toBe(true);
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  const deniedHost = seam.hosts[0]!;
  const operations = { ce_send: { to: "chatgpt/main", text: "revoked", idempotencyKey: "revoked" }, ce_read: { messageId: "msg_00000000000000000000000000" },
    ce_read_payload: { messageId: "msg_00000000000000000000000000" }, ce_ack: { messageId: "msg_00000000000000000000000000", payloadDigest: "a".repeat(64), payloadLength: 0, messageCreatedAuditSequence: 1 }, ce_inbox_list: {} };
  const hostCalls = [vi.spyOn(deniedHost, "send"), vi.spyOn(deniedHost, "readMetadata"), vi.spyOn(deniedHost, "readPayload"), vi.spyOn(deniedHost, "acknowledge"), vi.spyOn(deniedHost, "listInbox"), vi.spyOn(deniedHost, "status")];
  for (const [name, input] of Object.entries(operations)) expect((await a.call(name, input)).isError, name).toBe(true);
  await a.ceStatus(); for (const call of hostCalls) expect(call).not.toHaveBeenCalled();
  const renew = vi.spyOn(deniedHost, "renew"); const bRenew = vi.spyOn(seam.hosts[1]!, "renew");
  await vi.advanceTimersByTimeAsync(30_000); expect(renew).not.toHaveBeenCalled(); expect(bRenew).toHaveBeenCalledTimes(1);
  expect((await b.call("ce_inbox_list")).isError).not.toBe(true);
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
  expect((await a.call("ce_inbox_list")).isError).toBe(true);
  await a.stop(); expect((await b.call("ce_inbox_list")).isError).not.toBe(true);
});

it("TUI commands preview current trusted registration, list exact targets without inbox calls, and revoke explicitly", async () => {
  const f = await fixture(); const c = await f.runtime("real-C");
  await c.command("register pi/C --payload-read --ack");
  expect(c.ctx.ui.confirm).toHaveBeenCalledTimes(1);
  expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toContainEqual(expect.objectContaining({ endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true }));
  expect(c.notices()).toContain("reload"); expect(c.entries).toHaveLength(0);
  c.ctx.ui.notify.mockClear(); await c.command("sessions"); expect(c.notices()).toContain("refused");
  expect(c.notices()).not.toContain("selected configured active Endpoint IDs"); expect(seam.hosts).toHaveLength(0);
  const b = await f.runtime("real-B"); await b.start(); const inbox = vi.spyOn(seam.hosts[0]!, "listInbox");
  await b.command("sessions"); expect(b.notices()).toContain("pi/A"); expect(b.notices()).toContain("pi/B"); expect(b.notices()).toContain("MCP loaded: unknown"); expect(inbox).not.toHaveBeenCalled();
  await c.command("revoke pi/A"); expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations[0]!.status).toBe("revoked");
});
it.each(["session", "revision", "environment", "shutdown"])("registration refuses stale %s confirmation", async (change) => {
  const f = await fixture(); const c = await f.runtime("real-C"); const before = f.api.revision();
  c.ctx.ui.confirm.mockImplementation(async () => { if (change === "session") c.switchSession(); else if (change === "revision") fs.appendFileSync(f.profilePath, "\n# changed\n"); else if (change === "environment") vi.stubEnv("CE_STORE_FILE", "changed.sqlite"); else void c.stop(); return true; });
  await c.command("register pi/C"); expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(2);
  expect(c.notices()).toContain("refused"); if (change !== "revision") expect(f.api.revision()).toBe(before);
});
it.each(["unknown", "running"] as const)("registration refuses transport %s without stop/start", async (state) => {
  const f = await fixture(); const c = await f.runtime("real-C"); f.setProcessState(state);
  await c.command("register pi/C"); expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(2); expect(c.notices()).toContain("Stop");
});
it("conversion requires separate legacy-runtime acknowledgement and confirmation, preserving mapping", async () => {
  const f = await fixture(false); const a = await f.runtime("real-A");
  a.ctx.ui.confirm.mockResolvedValueOnce(false); await a.command("convert"); expect(() => readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
  await a.command("convert"); expect(a.ctx.ui.confirm).toHaveBeenCalledTimes(3);
  expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations[0]).toMatchObject({ endpointId: "pi/A", runtimeSessionId: "real-A" });
});
it("new selected registration needs explicit reload; activation after reload uses released mapping proof", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start(); await a.stop();
  const fresh = await f.runtime("real-A", a.entries); await fresh.start("reload");
  expect((await fresh.call("ce_inbox_list")).isError).toBe(true);
  await fresh.command("activate"); expect((await fresh.call("ce_inbox_list")).isError).not.toBe(true);
});
it("unknown selected policy blocks reads/status and heartbeat without losing safe end cleanup", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start();
  const renew = vi.spyOn(seam.hosts[0]!, "renew"); const end = vi.spyOn(seam.hosts[0]!, "end");
  fs.appendFileSync(f.profilePath, "INVALID\n");
  expect((await a.call("ce_inbox_list")).isError).toBe(true); await vi.advanceTimersByTimeAsync(30_000); expect(renew).not.toHaveBeenCalled();
  await a.stop(); expect(end).toHaveBeenCalledTimes(1);
});
it("uncertain CE end retains marker and global failure latch across fresh factories", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start();
  vi.spyOn(seam.hosts[0]!, "end").mockImplementation(() => { throw new CeHostRefusal("CE_HOST_UNCERTAIN"); }); await a.stop();
  const fresh = await f.runtime("real-A", a.entries); await fresh.start("resume"); expect((await fresh.call("ce_inbox_list")).isError).toBe(true);
  const root = join(f.binding.config.store.directory, ".ce-session-process-mutex");
  expect(fs.readdirSync(root).flatMap(scope => fs.readdirSync(join(root, scope, "1")))).not.toContain("released.json");
});

it("rechecks runtime after asynchronous transport-lock validation, before publication", async () => {
  const f = await fixture(); const c = await f.runtime("real-C");
  const manager = seam.manager as ReturnType<typeof createBackgroundTunnelManager>;
  const lock = manager.withProfileConfigurationLock.bind(manager);
  vi.spyOn(manager, "withProfileConfigurationLock").mockImplementation(async operation => { c.switchSession(); return lock(operation); });
  await c.command("register pi/C");
  expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(2);
});
it("current read/ACK narrowing gates old loaded handles while metadata remains usable", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start();
  const payload = vi.spyOn(seam.hosts[0]!, "readPayload"); const ack = vi.spyOn(seam.hosts[0]!, "acknowledge");
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: false, ack: false } });
  await a.call("ce_read_payload", { messageId: "msg_00000000000000000000000000" });
  await a.call("ce_ack", { messageId: "msg_00000000000000000000000000", payloadDigest: "a".repeat(64), payloadLength: 0, messageCreatedAuditSequence: 1 });
  expect(payload).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled(); expect((await a.call("ce_inbox_list")).isError).not.toBe(true);
});
it("a factory captured before C registration cannot acquire C without explicit reload", async () => {
  const f = await fixture(); const old = await f.runtime("real-C");
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
  await old.start(); expect((await old.call("ce_inbox_list")).isError).toBe(true);
  const fresh = await f.runtime("real-C"); await fresh.start(); expect((await fresh.call("ce_inbox_list")).isError).not.toBe(true);
});

it("cannot acknowledge stopped legacy bindings while this factory still holds one", async () => {
  const f = await fixture(false); const a = await f.runtime("real-A"); await a.start();
  await a.command("convert"); expect(() => readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
  expect(a.notices()).toContain("legacy binding"); expect(a.ctx.ui.confirm).not.toHaveBeenCalled();
});
it("explicit module replacement consumes only the trusted global drained handoff", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start();
  const before = a.entries.findLast(e => e.customType === "ce-mapping")!.data; await a.stop("reload");
  vi.resetModules();
  const fresh = await f.runtime("real-A", a.entries); await fresh.start("reload");
  expect(fresh.entries.findLast(e => e.customType === "ce-mapping")!.data).toEqual(before);
  expect((await fresh.call("ce_inbox_list")).isError).not.toBe(true);
});

it("non-TUI and cancelled confirmations cannot publish authority configuration", async () => {
  const f = await fixture(); const c = await f.runtime("real-C"); const before = f.api.revision();
  c.ctx.mode = "rpc"; await c.command("register pi/C"); expect(c.ctx.ui.confirm).not.toHaveBeenCalled();
  c.ctx.mode = "tui"; c.ctx.ui.confirm.mockResolvedValue(false);
  await c.command("register pi/C --ack"); await c.command("revoke pi/A");
  expect(f.api.revision()).toBe(before); expect(readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(2);
});

it("sessions denies revoked and old-epoch A without target enumeration while bound B can list", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); const b = await f.runtime("real-B"); await a.start(); await b.start();
  const inboxA = vi.spyOn(seam.hosts[0]!, "listInbox"); const inboxB = vi.spyOn(seam.hosts[1]!, "listInbox");
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  a.ctx.ui.notify.mockClear(); await a.command("sessions");
  expect(a.notices()).toContain("refused"); expect(a.notices()).not.toContain("pi/B"); expect(a.notices()).not.toContain("selected configured active Endpoint IDs");
  b.ctx.ui.notify.mockClear(); await b.command("sessions"); expect(b.notices()).toContain("selected configured active Endpoint IDs"); expect(b.notices()).toContain("pi/B"); expect(b.notices()).toContain("MCP loaded: unknown");
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
  a.ctx.ui.notify.mockClear(); await a.command("sessions"); expect(a.notices()).toContain("refused"); expect(a.notices()).not.toContain("selected configured active Endpoint IDs");
  expect(inboxA).not.toHaveBeenCalled(); expect(inboxB).not.toHaveBeenCalled();
});
it.each(["unbound", "unloaded", "runtime", "mutex", "uncertain"])("sessions refuses %s current generation before enumeration", async (change) => {
  const f = await fixture(); const a = await f.runtime(change === "unloaded" ? "real-C" : "real-A");
  if (change === "unloaded") await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
  if (change !== "unbound") await a.start();
  if (change === "runtime") a.switchSession();
  if (change === "mutex") {
    const root = join(f.binding.config.store.directory, ".ce-session-process-mutex"); const scope = fs.readdirSync(root)[0]!;
    fs.writeFileSync(join(root, scope, "1", "owner.json"), "{}", { mode: 0o600 });
  }
  if (change === "uncertain") { vi.spyOn(seam.hosts[0]!, "end").mockImplementation(() => { throw new CeHostRefusal("CE_HOST_UNCERTAIN"); }); await a.stop(); }
  a.ctx.ui.notify.mockClear(); await a.command("sessions");
  expect(a.notices()).toContain("refused"); expect(a.notices()).not.toContain("selected configured active Endpoint IDs"); expect(a.notices()).not.toContain("pi/B");
});

it.each([false, true])("deactivate ends only current A, revoked=%s; B, registrations and history survive with no transport effects", async revoked => {
  const f = await fixture(); const a = await f.runtime("real-A"); const b = await f.runtime("real-B"); await a.start(); await b.start();
  if (revoked) { await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" }); await vi.advanceTimersByTimeAsync(30_000); }
  const selected = fs.readFileSync(f.profilePath, "utf8"); const mapping = a.entries.findLast(e => e.customType === "ce-mapping")!.data;
  const manager = seam.manager as ReturnType<typeof createBackgroundTunnelManager>;
  const effects = [vi.spyOn(manager, "start"), vi.spyOn(manager, "stop"), vi.spyOn(manager, "status")];
  const aEnd = vi.spyOn(seam.hosts[0]!, "end"); const bEnd = vi.spyOn(seam.hosts[1]!, "end");
  a.ctx.ui.notify.mockClear(); await a.command("deactivate"); await a.command("deactivate");
  expect(aEnd).toHaveBeenCalledTimes(1); expect(bEnd).not.toHaveBeenCalled();
  expect(a.notices()).toContain("Pi messaging deactivated"); expect((await b.call("ce_inbox_list")).isError).not.toBe(true);
  expect(a.entries.findLast(e => e.customType === "ce-mapping")!.data).toEqual(mapping);
  expect(fs.readFileSync(f.profilePath, "utf8")).toBe(selected); for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  if (!revoked) {
    await a.stop("reload"); const fresh = await f.runtime("real-A", a.entries); await fresh.start("reload");
    expect((await fresh.call("ce_inbox_list")).isError).toBe(true);
    await fresh.command("activate"); expect((await fresh.call("ce_inbox_list")).isError).not.toBe(true);
  }
});
it("ce-status displays native Pi and Exchange only through admission", async () => {
  const f = await fixture(); const a = await f.runtime("real-A"); await a.start();
  const mapping = a.entries.findLast(e => e.customType === "ce-mapping")!.data as { exchangeId: string };
  a.ctx.ui.notify.mockClear(); await a.ceStatus(); expect(a.notices()).toContain("piSession=real-A"); expect(a.notices()).toContain(`exchange=${mapping.exchangeId}`);
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  a.ctx.ui.notify.mockClear(); await a.ceStatus(); expect(a.notices()).not.toContain("real-A"); expect(a.notices()).not.toContain(mapping.exchangeId);
});
