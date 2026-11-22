import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackgroundTunnelManager } from "../../../dist/tunnel/background-manager.js";
import { ensureManagedBinding } from "../../../dist/tunnel/managed-binding.js";
import { publishMessagingPair } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { createMultiSessionRegistration } from "../../../dist/tunnel/multi-session-policy.js";
import type { DurableStore } from "../../../dist/storage/store.js";
import type { CeSessionHost } from "../../../dist/endpoints/pi/session-host.js";

import { createHash } from "node:crypto";
const seam = vi.hoisted(() => ({ hosts: [] as CeSessionHost[], stores: [] as DurableStore[], manager: undefined as unknown,
  failNativeInboundStart: false,
  failPairingCompensation: false,
  defaultExec: vi.fn(() => { throw Error("FORBIDDEN default process inspection"); }),
  defaultSpawn: vi.fn(() => { throw Error("FORBIDDEN process spawn"); }),
  signal: vi.fn(() => { throw Error("FORBIDDEN process signal"); }),
}));
vi.mock("../../../pi-extension/native-inbound.js", async (original) => {
  const actual = await original<typeof import("../../../pi-extension/native-inbound.js")>();
  return { ...actual, createNativeInbound: (...args: Parameters<typeof actual.createNativeInbound>) => {
    if (seam.failNativeInboundStart) throw new Error("INJECTED_PAIRING_START_FAILURE");
    return actual.createNativeInbound(...args);
  } };
});
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: seam.defaultExec, spawn: seam.defaultSpawn }));
vi.mock("../../../dist/tunnel/background-scope.js", () => ({
  captureBackgroundAuthorizationScope: (input: { profileText: string; credentialPath: string; clientPath: string }) => ({
    digest: createHash("sha256").update(JSON.stringify(input)).digest("hex"), profileSha256: createHash("sha256").update(input.profileText).digest("hex"),
    clientPath: input.clientPath, credentialPath: input.credentialPath,
  }),
}));
vi.mock("../../../dist/runtime/native-readiness.js", async original => ({
  ...await original<typeof import("../../../dist/runtime/native-readiness.js")>(),
  assertNativeReadyForTunnel: () => ({ state: "READY", code: "CE_NATIVE_READY", driver: "rust-native" }),
}));
vi.mock("../../../dist/tunnel/messaging-activation-ui.js", () => ({ confirmMessagingActivation: (ctx: Context) => ctx.ui.confirm("activate", "synthetic operator confirmation") }));
vi.mock("../../../dist/tunnel/background-manager.js", async (original) => {
  const actual = await original<typeof import("../../../dist/tunnel/background-manager.js")>();
  return { ...actual, createBackgroundTunnelManager: (...args: Parameters<typeof actual.createBackgroundTunnelManager>) => seam.manager ?? actual.createBackgroundTunnelManager(...args) };
});
vi.mock("../../../dist/endpoints/pi/session-host.js", async (original) => {
  const actual = await original<typeof import("../../../dist/endpoints/pi/session-host.js")>();
  return { ...actual, CeSessionHost: class extends actual.CeSessionHost {
    constructor(store: DurableStore, policy: ConstructorParameters<typeof actual.CeSessionHost>[1]) { super(store, policy); seam.hosts.push(this); seam.stores.push(store); }
    override end(endpointId: string) {
      if (seam.failPairingCompensation) throw new Error("INJECTED_PAIRING_COMPENSATION_FAILURE");
      return super.end(endpointId);
    }
  } };
});
type Entry = { type: string; customType: string; data: unknown };
type Context = { mode: string; hasUI: boolean; cwd: string; reload?: () => Promise<void>; newSession?: (options?: { parentSession?: string; withSession?: (ctx: Context) => Promise<void> }) => Promise<{ cancelled: boolean }>; sessionManager: { getSessionId(): string; getSessionFile(): string; getBranch(): Entry[]; getEntries(): Entry[] }; ui: { notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn<(title: string, message: string) => Promise<boolean>>>; select: ReturnType<typeof vi.fn<(title: string, options: string[]) => Promise<string | undefined>>>; custom: ReturnType<typeof vi.fn> } };
type Handler = (event: { reason: string; previousSessionFile?: string; targetSessionFile?: string }, ctx: Context) => Promise<void>;
type Tool = { name: string; description: string; parameters: Record<string, unknown>; execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: Context): Promise<{ isError?: boolean; details?: Record<string, unknown>; content: Array<{ type: string; text?: string }> }> };
const dirs: string[] = []; const shutdowns: Array<() => Promise<void>> = [];
beforeEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith("CE_")) vi.stubEnv(key, undefined); vi.spyOn(process, "kill").mockImplementation(seam.signal); vi.useFakeTimers(); seam.hosts.length = 0; seam.stores.length = 0; seam.manager = undefined; seam.failNativeInboundStart = false; seam.failPairingCompensation = false; });
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
  fs.writeFileSync(join(dir, "NEVER-READ-CREDENTIAL"), "synthetic-metadata-only", { mode: 0o600 });
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
  async function runtime(id: string, entries: Entry[] = [], options: { cwd?: string; sessionFile?: string } = {}) {
    const events = new Map<string, Handler>(); const tools = new Map<string, Tool>(); const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
    let runtimeId = id;
    const cwd = options.cwd ?? join(dir, id); fs.mkdirSync(cwd, { recursive: true });
    const sessionFile = options.sessionFile ?? "not-authority";
    const ctx: Context = { mode: "tui", hasUI: true, cwd, sessionManager: { getSessionId: () => runtimeId, getSessionFile: () => sessionFile, getBranch: () => entries, getEntries: () => entries }, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), select: vi.fn(async () => undefined), custom: vi.fn() } };
    const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
    const reloadFactory = () => factory({ on: (name: string, handler: Handler) => events.set(name, handler), registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: (name: string, command: { handler(args: string, ctx: Context): Promise<void> }) => commands.set(name, command), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
      ...(seam.failNativeInboundStart ? { sendMessage: vi.fn() } : {}) });
    reloadFactory();
    const stop = (reason = "quit", event: { targetSessionFile?: string } = {}) => events.get("session_shutdown")!({ reason, ...event }, ctx); shutdowns.push(stop);
    return { ctx, entries, events, tools, stop, start: (reason = "startup", event: { previousSessionFile?: string } = {}) => events.get("session_start")!({ reason, ...event }, ctx),
      reloadFactory,
      call: (name: string, input: unknown = {}) => tools.get(name)!.execute("test", input, undefined, undefined, ctx),
      command: (args: string) => commands.get("ce-tunnel")!.handler(args, ctx),
      ce: (args = "") => commands.get("ce")!.handler(args, ctx),
      ceStatus: () => commands.get("ce-status")!.handler("", ctx),
      cenew: () => commands.get("cenew")!.handler("", ctx),
      switchSession: () => { runtimeId = "changed-runtime"; }, notices: () => ctx.ui.notify.mock.calls.map(([s]) => String(s)).join("\n") };
  }
  return { dir, profilePath, api, binding, runtime, setProcessState: (state: typeof processState) => { processState = state; } };
}

it("guides inbound reads and forbids reading the sending Endpoint's own outbound Message ID", async () => {
  const f = await fixture();
  const session = await f.runtime("real-A");
  await session.start();
  for (const name of ["ce_read", "ce_read_payload"]) {
    const tool = session.tools.get(name)!;
    const fields = tool.parameters.properties as Record<string, { description: string }>;
    expect(`${tool.description} ${fields.messageId!.description}`).toContain("ce_inbox_list");
    expect(fields.messageId!.description).not.toContain("returned by ce_send");
  }
  const sent = await session.call("ce_send", { to: "chatgpt/main", text: "synthetic result", idempotencyKey: "outbound-guidance" });
  expect(sent.isError).not.toBe(true);
  expect(sent.content.map(item => item.text ?? "").join("\n")).toContain("Do not call ce_read or ce_read_payload on this outbound Message ID");
});

it("real Stop cancels pending Disconnect without stopping the shared service", async () => {
  const f = await fixture();
  const session = await f.runtime("real-A"); await session.start();
  const stop = vi.spyOn(seam.manager as ReturnType<typeof createBackgroundTunnelManager>, "stop");
  const end = vi.spyOn(seam.hosts[0]!, "end");
  let answer!: (value: boolean) => void, entered!: () => void;
  let confirmationSignal: AbortSignal | undefined;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const confirmed = new Promise<boolean>(resolve => { answer = resolve; });
  session.ctx.ui.confirm.mockImplementationOnce((_title, _message, options?: { signal: AbortSignal }) => {
    options?.signal.addEventListener("abort", () => answer(false), { once: true });
    confirmationSignal = options?.signal; entered(); return confirmed;
  });
  const disconnect = session.command("disconnect"); await waiting;
  const stopping = session.command("stop");
  try {
    expect(stop).not.toHaveBeenCalled();
    expect(confirmationSignal?.aborted).toBe(true);
  } finally { answer(false); await Promise.all([disconnect, stopping]); }
  expect(stop).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  expect(session.notices()).toContain("real service stop is managed by Homebrew/launchd");
});

it("publishes /cenew authority before session_start and consumes it in the direct successor", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const predecessorSessionFile = join(f.dir, "cenew-predecessor.jsonl");
  const session = await f.runtime("real-A", [], { sessionFile: predecessorSessionFile });
  await session.start();
  await session.ce("inbound enable --from chatgpt/main");
  const workspace = session.ctx.cwd;
  let stale = false;
  Object.defineProperty(session.ctx, "cwd", { configurable: true, get: () => {
    if (stale) throw new Error("stale command context used during newSession setup");
    return workspace;
  } });
  const successorEntries: Entry[] = [];
  const successorRuntimeSessionId = "01a1fdc8-da9e-7203-be97-29493b2b7cdd";
  const successorSessionFile = join(f.dir, "cenew-successor.jsonl");
  let successor: Awaited<ReturnType<typeof f.runtime>> | undefined;
  session.ctx.newSession = vi.fn(async options => {
    expect(options?.parentSession).toBe(predecessorSessionFile);
    await session.stop("new", { targetSessionFile: successorSessionFile });
    stale = true;
    successor = await f.runtime(successorRuntimeSessionId, successorEntries, { cwd: workspace, sessionFile: successorSessionFile });
    await successor.start("new", { previousSessionFile: predecessorSessionFile });
    await options?.withSession?.(successor.ctx);
    return { cancelled: false };
  });

  await session.cenew();

  expect(session.ctx.newSession, session.notices()).toHaveBeenCalledOnce();
  expect(successor).toBeDefined();
  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  const registration = readLivePolicy(migrated.ref)
    .manifest.registrations.find(item => item.runtimeSessionId === successorRuntimeSessionId);
  expect(registration).toMatchObject({ status: "active", payloadRead: true, ack: true, presenceDisclosure: false });
  expect(successor!.entries.some(entry => entry.customType === "ce-mapping")).toBe(true);
  expect(successor!.entries.some(entry => entry.customType === "ce-session-succession-consumed")).toBe(true);
  expect(successor!.notices()).toContain("CE pairing inherited");
  const inboundPolicies = fs.readdirSync(`${f.profilePath}.native-inbound`).map(name => JSON.parse(fs.readFileSync(join(`${f.profilePath}.native-inbound`, name), "utf8")) as Record<string, unknown>);
  expect(inboundPolicies).toContainEqual(expect.objectContaining({ runtimeSessionId: successorRuntimeSessionId, endpointId: registration!.endpointId, from: "chatgpt/main", enabled: true }));
});

it("does not inherit CE pairing for an ordinary /new successor", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const ordinary = await f.runtime("01a1fdc8-da9e-7203-be97-29493b2b7cee", [], {
    cwd: join(f.dir, "real-A"), sessionFile: join(f.dir, "ordinary-new.jsonl"),
  });

  await ordinary.start("new", { previousSessionFile: "not-authority" });

  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  expect(readLivePolicy(migrated.ref).manifest.registrations.some(item => item.runtimeSessionId === "01a1fdc8-da9e-7203-be97-29493b2b7cee")).toBe(false);
  expect(ordinary.entries.some(entry => entry.customType === "ce-mapping")).toBe(false);
  expect(ordinary.notices()).toContain("pairing required");
});

it("does not publish a successor registration when /cenew is cancelled before teardown", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("real-A");
  await session.start();
  await session.ce("inbound enable --from chatgpt/main");
  const successorRuntimeSessionId = "01a1fdc8-da9e-7203-be97-29493b2b7cff";
  session.ctx.newSession = vi.fn(async () => ({ cancelled: true }));

  await session.cenew();

  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  expect(readLivePolicy(migrated.ref).manifest.registrations.some(item => item.runtimeSessionId === successorRuntimeSessionId && item.status === "active")).toBe(false);
  expect(session.notices()).toContain("was cancelled");
});

it("shows a replaceable one-step pairing instruction for an unbound live Session", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("pairing-session");
  session.ctx.reload = vi.fn(async () => undefined);
  await session.start();
  expect(session.ctx.ui.confirm).not.toHaveBeenCalled();
  const first = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  expect(first).toBeDefined();
  await session.ce("pair complete");
  expect(session.notices()).toContain("waiting for ChatGPT pairing");
  await session.ce("pair --from chatgpt/work");
  const commands = session.notices().match(/\/ce pair ce_pair_[A-Za-z0-9_-]{32} --from chatgpt\/(?:main|work)/g) ?? [];
  expect(commands).toHaveLength(2);
  expect(commands[1]).toContain("--from chatgpt/work");
  expect(commands[1]).not.toContain(first!);
  await session.ce("pair chatgpt/work");
  expect(session.notices().match(/\/ce pair ce_pair_[A-Za-z0-9_-]{32} --from chatgpt\/(?:main|work)/g)).toHaveLength(2);
  expect(session.notices()).toContain("usage: /ce pair [--from <endpoint>]");
  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  expect(readLivePolicy(migrated.ref).manifest.registrations.some(r => r.runtimeSessionId === "pairing-session")).toBe(false);
});

it("applies a redeemed pairing with payload read, ACK, inbound, and one Pi reload", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("paired-session");
  let reloads = 0;
  let stale = false;
  Object.defineProperty(session.ctx, "mode", { configurable: true, get: () => {
    if (stale) throw new Error("stale command context used after reload");
    return "tui";
  } });
  session.ctx.reload = vi.fn(async () => {
    reloads += 1;
    await session.stop("reload");
    session.reloadFactory();
    await session.start("reload");
    stale = true;
  });
  await session.start();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  expect(token).toBeDefined();
  const { pairingExchangeIdentity, redeemPairingCapability } = await import("../../../dist/tunnel/session-pairing.js");
  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  const before = readLivePolicy(migrated.ref);
  expect(redeemPairingCapability({ directory: migrated.ref.root, secret: token!, exchangeId: pairingExchangeIdentity(before.manifest.exchange), from: "chatgpt/work" })).toMatchObject({ status: "accepted" });
  await session.ce("status");
  expect(reloads).toBe(0);
  await session.ce("pair complete");
  expect(reloads).toBe(1);
  const registration = readLivePolicy(migrated.ref).manifest.registrations.find(r => r.runtimeSessionId === "paired-session");
  expect(registration).toMatchObject({ status: "active", payloadRead: true, ack: true });
  const policies = fs.readdirSync(`${f.profilePath}.native-inbound`);
  expect(policies).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(join(`${f.profilePath}.native-inbound`, policies[0]!), "utf8"))).toMatchObject({
    enabled: true, runtimeSessionId: "paired-session", endpointId: registration!.endpointId, from: "chatgpt/work",
  });
  expect(session.notices()).toContain("CE connected");
});

it("applies a redeemed pairing during the operator's direct reload", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("direct-reload-paired-session");
  session.ctx.reload = vi.fn(async () => { throw new Error("must not request a second reload"); });
  await session.start();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  const pairing = await import("../../../dist/tunnel/session-pairing.js");
  const policy = await import("../../../dist/tunnel/live-session-policy.js");
  const before = policy.readLivePolicy(migrated.ref);
  expect(pairing.redeemPairingCapability({ directory: migrated.ref.root, secret: token!, exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange) })).toMatchObject({ status: "accepted" });
  await session.stop("reload");
  session.reloadFactory();
  await session.start("reload");
  expect(session.ctx.reload).not.toHaveBeenCalled();
  expect(policy.readLivePolicy(migrated.ref).manifest.registrations.find(r => r.runtimeSessionId === "direct-reload-paired-session")).toMatchObject({ status: "active" });
  expect(session.notices()).toContain("CE connected");
});

it("applies the saved workspace Hooks before reloading a newly paired Session", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const policy = await import("../../../dist/tunnel/live-session-policy.js");
  const messaging = await import("../../../dist/tunnel/messaging-config.js");
  const { parseMcpBindingConfig } = await import("../../../dist/host/mcp-binding-config.js");
  const ref = policy.prepareLivePolicyUpgrade(migrated.ref, f.profilePath);
  const selected = messaging.readMessagingGeneration(f.profilePath, migrated.bindingPath, join(f.dir, "NEVER-READ-CREDENTIAL"))!;
  const config = parseMcpBindingConfig({ version: 1, ...selected.config, admissionPolicy: ref });
  const v2 = messaging.publishMessagingGeneration(f.profilePath, config, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: join(f.dir, "NEVER-READ-CREDENTIAL") });
  policy.createLivePolicyRegistration({ ref, credentialFile: join(f.dir, "NEVER-READ-CREDENTIAL") }).upgrade({ expectedDigest: policy.readLivePolicy(migrated.ref).digest,
    actorRuntimeSessionId: "real-A", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) });
  fs.writeFileSync(f.profilePath, fs.readFileSync(f.profilePath, "utf8").replace(migrated.bindingPath, v2.bindingPath), { mode: 0o600 });
  const session = await f.runtime("paired-workspace-hooks");
  fs.mkdirSync(session.ctx.cwd, { recursive: true });
  const hooks = [
    { id: "ce-agent-desktop-wake", event: "ce.message.committed.v1" as const, recipient: { adapter: "chatgpt" as const, endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: true, scope: "workspace" as const },
    { id: "disabled-notice", event: "ce.message.committed.v1" as const, recipient: { adapter: "chatgpt" as const, endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: false, scope: "workspace" as const },
  ];
  const { writeWorkspaceHookProfile } = await import("../../../pi-extension/workspace-hook-profile.js");
  writeWorkspaceHookProfile(ref, session.ctx.cwd, hooks);
  const { readWorkspaceHookProfile } = await import("../../../pi-extension/workspace-hook-profile.js");
  expect(readWorkspaceHookProfile(ref, session.ctx.cwd)).toEqual(hooks);
  session.ctx.reload = vi.fn(async () => { await session.stop("reload"); session.reloadFactory(); await session.start("reload"); });
  await session.start();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  const pairing = await import("../../../dist/tunnel/session-pairing.js");
  expect(pairing.redeemPairingCapability({ directory: ref.root, secret: token!, exchangeId: pairing.pairingExchangeIdentity(policy.readLivePolicy(ref).manifest.exchange) })).toMatchObject({ status: "accepted" });
  await session.ce("pair complete");
  expect(session.notices()).toContain("pairing accepted");
  expect(policy.readLivePolicy(ref).manifest.registrations.find(r => r.runtimeSessionId === "paired-workspace-hooks")?.hooks).toEqual(hooks);
});

it("compensates a failed first pairing application and reuses the redeemed receipt", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("pair-compensation-session");
  session.ctx.reload = vi.fn(async () => { await session.stop("reload"); session.reloadFactory(); await session.start("reload"); });
  await session.start();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  expect(token).toBeDefined();
  const pairing = await import("../../../dist/tunnel/session-pairing.js");
  const policy = await import("../../../dist/tunnel/live-session-policy.js");
  const before = policy.readLivePolicy(migrated.ref);
  expect(pairing.redeemPairingCapability({ directory: migrated.ref.root, secret: token!, exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange) })).toMatchObject({ status: "accepted" });

  seam.failNativeInboundStart = true;
  await session.ce("pair complete");
  const registration = policy.readLivePolicy(migrated.ref).manifest.registrations.find(r => r.runtimeSessionId === "pair-compensation-session");
  expect(registration).toBeDefined();
  expect(pairing.inspectPairingReceipt({ directory: migrated.ref.root, identity: {
    runtimeSessionId: "pair-compensation-session", endpointId: registration!.endpointId,
    exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange),
  } }).status).toBe("redeemed");
  expect(session.entries.some(entry => entry.customType === "ce-lifecycle-blocked")).toBe(false);
  expect(session.entries.some(entry => entry.customType === "ce-pair-application-compensated")).toBe(true);
  expect(seam.hosts.at(-1)!.status(registration!.endpointId).lease).toBe("ABSENT");

  seam.failNativeInboundStart = false;
  await session.ce("pair complete");
  expect(session.notices()).toContain("CE connected");
  expect(session.entries.filter(entry => entry.customType === "ce-mapping")).toHaveLength(2);
  expect(pairing.inspectPairingReceipt({ directory: migrated.ref.root, identity: {
    runtimeSessionId: "pair-compensation-session", endpointId: registration!.endpointId,
    exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange),
  } }).status).toBe("missing");
});

it("retains the fail-closed lifecycle latch when pairing compensation is incomplete", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const session = await f.runtime("pair-compensation-refused");
  session.ctx.reload = vi.fn(async () => { await session.stop("reload"); session.reloadFactory(); await session.start("reload"); });
  await session.start();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  const pairing = await import("../../../dist/tunnel/session-pairing.js");
  const policy = await import("../../../dist/tunnel/live-session-policy.js");
  const before = policy.readLivePolicy(migrated.ref);
  expect(pairing.redeemPairingCapability({ directory: migrated.ref.root, secret: token!, exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange) })).toMatchObject({ status: "accepted" });

  seam.failNativeInboundStart = true;
  seam.failPairingCompensation = true;
  await session.ce("pair complete");
  const registration = policy.readLivePolicy(migrated.ref).manifest.registrations.find(r => r.runtimeSessionId === "pair-compensation-refused")!;
  expect(session.entries.some(entry => entry.customType === "ce-pair-application-compensated")).toBe(false);
  expect(session.entries.some(entry => entry.customType === "ce-lifecycle-blocked")).toBe(true);
  expect(session.notices()).toContain("lifecycle failed closed (CE_HOST_UNAVAILABLE)");
  expect(pairing.inspectPairingReceipt({ directory: migrated.ref.root, identity: {
    runtimeSessionId: "pair-compensation-refused", endpointId: registration.endpointId,
    exchangeId: pairing.pairingExchangeIdentity(before.manifest.exchange),
  } }).status).toBe("redeemed");
});

it("applies a fresh pairing receipt when a registered Session lost its local mapping history", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const original = await f.runtime("pair-recovery-session");
  original.ctx.reload = vi.fn(async () => { await original.stop("reload"); original.reloadFactory(); await original.start("reload"); });
  await original.start();
  const first = original.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  const { pairingExchangeIdentity, redeemPairingCapability } = await import("../../../dist/tunnel/session-pairing.js");
  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  expect(redeemPairingCapability({ directory: migrated.ref.root, secret: first!, exchangeId: pairingExchangeIdentity(readLivePolicy(migrated.ref).manifest.exchange) })).toMatchObject({ status: "accepted" });
  await original.ce("pair complete");
  await original.stop("quit");

  const recovered = await f.runtime("pair-recovery-session");
  let reloads = 0;
  await recovered.start();
  expect(recovered.notices()).toContain("CE_HOST_MAPPING_INVALID");
  await recovered.ce("pair");
  const second = recovered.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/g)?.at(-1)?.match(/ce_pair_[A-Za-z0-9_-]{32}/)?.[0];
  expect(redeemPairingCapability({ directory: migrated.ref.root, secret: second!, exchangeId: pairingExchangeIdentity(readLivePolicy(migrated.ref).manifest.exchange) })).toMatchObject({ status: "accepted" });
  await recovered.ce("pair complete");
  expect(recovered.notices()).toContain("this context cannot reload Pi");
  recovered.ctx.reload = vi.fn(async () => { reloads += 1; await recovered.stop("reload"); recovered.reloadFactory(); await recovered.start("reload"); });
  await recovered.ce("pair complete");
  expect(reloads).toBe(1);
  expect(recovered.notices()).toContain("CE connected");
});

it("Manager observes current binding independently of shared transport and refuses stale ownership/policy", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const manager = seam.manager as ReturnType<typeof createBackgroundTunnelManager>;
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const a = await f.runtime("real-A"); await a.start();
  const stopped = await manager.refresh();
  const refresh = vi.spyOn(manager, "refresh").mockResolvedValue({ ...stopped, state: "CONNECTED", running: true });
  const start = vi.spyOn(manager, "start"), stop = vi.spyOn(manager, "stop");
  const frame = async (runtime: typeof a) => {
    let lines: string[] = [];
    runtime.ctx.ui.custom.mockImplementationOnce(async factory => {
      const component = factory({ terminal: { rows: 80 } }, undefined, undefined, () => undefined);
      lines = component.render(100); component.dispose?.();
      return undefined;
    });
    await runtime.command(""); return lines.join("\n");
  };
  expect(a.notices()).toContain("bound (participant");
  expect(seam.hosts[0]!.status("pi/A").lease).toBe("ACTIVE");
  expect(await frame(a)).toMatch(/Current Session +Attached/);
  expect(await frame(a)).toContain("❯ Disconnect");
  const unbound = await f.runtime("new-unbound"); await unbound.start();
  expect(await frame(unbound)).toMatch(/Current Session +Detached/);
  expect(await frame(unbound)).toContain("❯ Connect");
  refresh.mockResolvedValue({ ...stopped, state: "STOPPED", running: false });
  expect(await frame(unbound)).toMatch(/Current Session +Detached/);
  refresh.mockResolvedValue({ ...stopped, state: "CONNECTED", running: true });
  const host = seam.hosts[0]!;
  const actual = host.status("pi/A");
  const status = vi.spyOn(host, "status").mockReturnValue({ ...actual, lease: "EXPIRED" });
  expect(await frame(a)).toMatch(/Current Session +Unknown/);
  status.mockReturnValue({ ...actual, lease: "ABSENT" });
  expect(await frame(a)).toMatch(/Current Session +Unknown/);
  status.mockRestore();
  await host.end("pi/A");
  expect(await frame(a)).toMatch(/Current Session +Unknown/);
  const { createLivePolicyRegistration, readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  const snapshot = readLivePolicy(migrated.ref);
  await createLivePolicyRegistration({ ref: migrated.ref }).revoke({ expectedDigest: snapshot.digest, endpointId: "pi/A" });
  expect(await frame(a)).toMatch(/Current Session +Unknown/);
  a.switchSession();
  expect(await frame(a)).toMatch(/Current Session +Unknown/);
  expect(start).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
});

it("pairs a new live session without restarting the shared transport", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  const migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const manager = seam.manager as ReturnType<typeof createBackgroundTunnelManager>;
  vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "1");
  vi.spyOn(manager, "authorizationStatus").mockReturnValue("environment");
  vi.spyOn(manager, "authorizationScope").mockReturnValue({ digest: "synthetic", profileSha256: "synthetic", clientPath: "/synthetic", credentialPath: "/synthetic" });
  const stopped = await manager.refresh();
  vi.spyOn(manager, "refresh").mockResolvedValue({ ...stopped, state: "CONNECTED", running: true, evidence: "health-probe" });
  vi.spyOn(manager, "start").mockResolvedValue({ runId: "same-run", pid: 123, tunnelId: "tunnel_abcdefgh123456", startedAt: "test", health: "connected", alreadyRunning: true });
  const stop = vi.spyOn(manager, "stop");
  const existing = await f.runtime("real-A");
  await existing.start();
  const { parseMcpBindingConfig } = await import("../../../dist/host/mcp-binding-config.js");
  const { createLiveMcpComposition } = await import("../../../dist/tunnel/live-mcp-composition.js");
  const { CeEndpointHost } = await import("../../../dist/host/endpoint-host.js");
  const { CeBoundEndpoint } = await import("../../../dist/host/bound-endpoint.js");
  const config = parseMcpBindingConfig(JSON.parse(fs.readFileSync(migrated.bindingPath, "utf8")));
  const live = createLiveMcpComposition(config);
  const host = new CeEndpointHost(seam.stores[0]!, { adapter: "chatgpt", allowlist: [config.endpoint],
    recipients: config.recipients, liveRecipients: live.recipients, exchangeNamespace: config.exchange.namespace,
    exchangeIdempotencyKey: config.exchange.idempotencyKey, payloadRead: { enabled: true }, ack: { enabled: true } });
  const sender = CeBoundEndpoint.start(host, config.endpoint.endpointId, { admission: live.admission, renewIntervalMs: 100000 });
  const oldMessage = sender.send({ to: "pi/A", text: "work for A", idempotencyKey: "test-old-a" });
  const session = await f.runtime("new-auto-session");
  session.ctx.reload = vi.fn(async () => { await session.stop("reload"); session.reloadFactory(); await session.start("reload"); });
  await session.start();
  expect(session.ctx.ui.confirm).not.toHaveBeenCalled();
  const token = session.notices().match(/\/ce pair (ce_pair_[A-Za-z0-9_-]{32}) --from chatgpt\/main/)?.[1];
  expect(token).toBeDefined();
  const { pairingExchangeIdentity, redeemPairingCapability } = await import("../../../dist/tunnel/session-pairing.js");
  const beforePair = (await import("../../../dist/tunnel/live-session-policy.js")).readLivePolicy(migrated.ref);
  expect(redeemPairingCapability({ directory: migrated.ref.root, secret: token!, exchangeId: pairingExchangeIdentity(beforePair.manifest.exchange) })).toMatchObject({ status: "accepted" });
  await session.ce("pair complete");
  const { readLivePolicy } = await import("../../../dist/tunnel/live-session-policy.js");
  const registration = readLivePolicy(migrated.ref).manifest.registrations.find(r => r.runtimeSessionId === "new-auto-session");
  expect(registration?.status).toBe("active");
  expect(registration!.endpointId).toContain("new-auto-session");
  expect(session.entries.some(e => e.customType === "ce-mapping")).toBe(true);
  expect(seam.stores[0]!.database.prepare("SELECT * FROM native_session_binding WHERE runtime_session_id=?").get("new-auto-session")).toBeDefined();
  const target = registration!.endpointId;
  session.ctx.ui.select.mockImplementation(async (title, options) => title.startsWith("Chat Exchange ·")
    ? "Send target"
    : options.find(option => option.includes("new-auto-session")));
  await session.ce();
  expect(session.ctx.ui.select.mock.calls[1]![0]).toContain("所有使用此连接的 ChatGPT 对话共享");
  expect(session.ctx.ui.select.mock.calls[1]![1].some(option => option.includes("new-auto-session") && option.includes("在线"))).toBe(true);
  const selected = readLivePolicy(migrated.ref).manifest.selectedTarget;
  expect(selected?.endpointId).toBe(target);
  expect(seam.stores[0]!.database.prepare("SELECT * FROM selected_session_binding WHERE policy_id=? AND selection_version=?").get(migrated.ref.policyId, selected!.generation)).toBeDefined();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createExchangeMcpServer } = await import("../../../dist/control/mcp/server.js");
  const { discoverLiveEndpoints } = await import("../../../dist/tunnel/live-mcp-composition.js");
  const server = createExchangeMcpServer("fixture", { port: sender, selectedTarget: live.selectedTarget, discovery: { discover: previous => discoverLiveEndpoints(live, sender, previous) } });
  const client = new Client({ name: "fixture", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const sent = await client.callTool({ name: "ce_send", arguments: { selectionVersion: selected!.generation, text: "selected via TUI", idempotencyKey: "selected-via-tui" } });
    expect(sent.isError).not.toBe(true);
    expect((await session.call("ce_read_payload", { messageId: (sent.structuredContent as { messageId: string }).messageId })).isError).not.toBe(true);
  } finally { await client.close(); await server.close(); }
  const policyApi = (await import("../../../dist/tunnel/live-session-policy.js")).createLivePolicyRegistration({ ref: migrated.ref });
  session.ctx.ui.select.mockImplementationOnce(async () => "Send target");
  session.ctx.ui.select.mockImplementationOnce(async (_title, options) => {
    const snapshot = readLivePolicy(migrated.ref);
    policyApi.register({ expectedDigest: snapshot.digest, registration: { endpointId: "pi/concurrent", runtimeSessionId: "concurrent", payloadRead: false, ack: false, presenceDisclosure: false } });
    return options.find(option => option.includes("new-auto-session"));
  });
  await session.ce();
  expect(readLivePolicy(migrated.ref).manifest.selectedTarget).toEqual(selected);
  expect(session.notices()).toContain("会话或选择已变化");
  const newMessage = sender.send({ to: target, text: "work for new session", idempotencyKey: "test-new-session" });
  expect(sender.send({ to: target, text: "work for new session", idempotencyKey: "test-new-session" }).messageId).toBe(newMessage.messageId);
  expect((await session.call("ce_read_payload", { messageId: newMessage.messageId })).isError).not.toBe(true);
  expect((await session.call("ce_read_payload", { messageId: oldMessage.messageId })).isError).toBe(true);
  expect((await existing.call("ce_read_payload", { messageId: oldMessage.messageId })).isError).not.toBe(true);
  expect(() => sender.send({ to: "pi/not-authorized", text: "denied", idempotencyKey: "test-denied" })).toThrow();
  const reply = await session.call("ce_send", { to: "chatgpt/main", text: `Result for ${newMessage.messageId}`, idempotencyKey: "test-reply" });
  expect(reply.isError).not.toBe(true);
  const replyId = reply.details!.messageId as string;
  expect(sender.listInbox({}).messages.some(message => message.messageId === replyId)).toBe(true);
  expect(sender.readPayload({ messageId: replyId }).payloadText).toBe(`Result for ${newMessage.messageId}`);
  await sender.shutdown();
  expect(stop).not.toHaveBeenCalled();
}, 15_000);

it("live B Connect joins a running shared transport and Disconnect retains A", async () => {
  const f = await fixture();
  const { createLiveSessionMigration } = await import("../../../dist/tunnel/live-session-migration.js");
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: seam.manager as never });
  await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  const a = await f.runtime("real-A"); await a.start();
  const before = a.entries.findLast(e => e.customType === "ce-mapping")?.data;
  const manager = seam.manager as ReturnType<typeof createBackgroundTunnelManager>;
  vi.stubEnv("CE_TUNNEL_BACKGROUND_ALLOW", "1");
  vi.spyOn(manager, "authorizationStatus").mockReturnValue("environment");
  vi.spyOn(manager, "authorizationScope").mockReturnValue({ digest: "synthetic", profileSha256: "synthetic", clientPath: "/synthetic", credentialPath: "/synthetic" });
  const stopped = await manager.refresh();
  vi.spyOn(manager, "refresh").mockResolvedValue({ ...stopped, state: "CONNECTED", running: true, evidence: "health-probe" });
  const start = vi.spyOn(manager, "start").mockResolvedValue({ runId: "same-run", pid: 123, tunnelId: "tunnel_abcdefgh123456", startedAt: "test", health: "connected", alreadyRunning: true });
  const stop = vi.spyOn(manager, "stop");
  const b = await f.runtime("new-live-B"); await b.start();
  b.ctx.reload = vi.fn(async () => { await b.stop("reload"); b.reloadFactory(); await b.start("reload"); });
  await b.command("connect");
expect(b.entries.findLast(e => e.customType === "ce-mapping")?.data).toBeDefined();
  expect(b.tools.has("ce_read_payload")).toBe(true); expect(b.tools.has("ce_ack")).toBe(true);
  expect(start).not.toHaveBeenCalled();
  await b.command("connect"); expect(start).not.toHaveBeenCalled();
  await b.command("disconnect"); expect(stop).not.toHaveBeenCalled();
  expect(a.entries.findLast(e => e.customType === "ce-mapping")?.data).toEqual(before);
  await a.ceStatus(); expect(seam.hosts[0]!.status("pi/A").lease).toBe("ACTIVE");
}, 20_000);
