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
  defaultExec: vi.fn(() => { throw Error("FORBIDDEN default process inspection"); }),
  defaultSpawn: vi.fn(() => { throw Error("FORBIDDEN process spawn"); }),
  signal: vi.fn(() => { throw Error("FORBIDDEN process signal"); }),
}));
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
  } };
});
type Entry = { type: string; customType: string; data: unknown };
type Context = { mode: string; hasUI: boolean; cwd: string; reload?: () => Promise<void>; sessionManager: { getSessionId(): string; getSessionFile(): string; getBranch(): Entry[]; getEntries(): Entry[] }; ui: { notify: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn<(title: string, message: string) => Promise<boolean>>>; custom: ReturnType<typeof vi.fn> } };
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
  async function runtime(id: string, entries: Entry[] = []) {
    const events = new Map<string, Handler>(); const tools = new Map<string, Tool>(); const commands = new Map<string, { handler(args: string, ctx: Context): Promise<void> }>();
    let runtimeId = id;
    const ctx: Context = { mode: "tui", hasUI: true, cwd: join(dir, id), sessionManager: { getSessionId: () => runtimeId, getSessionFile: () => "not-authority", getBranch: () => entries, getEntries: () => entries }, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), custom: vi.fn() } };
    const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
    const reloadFactory = () => factory({ on: (name: string, handler: Handler) => events.set(name, handler), registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: (name: string, command: { handler(args: string, ctx: Context): Promise<void> }) => commands.set(name, command), appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) });
    reloadFactory();
    const stop = (reason = "quit") => events.get("session_shutdown")!({ reason }, ctx); shutdowns.push(stop);
    return { ctx, entries, events, tools, stop, start: (reason = "startup") => events.get("session_start")!({ reason }, ctx),
      reloadFactory,
      call: (name: string, input: unknown = {}) => tools.get(name)!.execute("test", input, undefined, undefined, ctx),
      command: (args: string) => commands.get("ce-tunnel")!.handler(args, ctx),
      ceStatus: () => commands.get("ce-status")!.handler("", ctx),
      switchSession: () => { runtimeId = "changed-runtime"; }, notices: () => ctx.ui.notify.mock.calls.map(([s]) => String(s)).join("\n") };
  }
  return { dir, profilePath, api, binding, runtime, setProcessState: (state: typeof processState) => { processState = state; } };
}

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
  expect(start).toHaveBeenCalledTimes(1);
  await b.command("connect"); expect(start).toHaveBeenCalledTimes(2);
  await b.command("disconnect"); expect(stop).not.toHaveBeenCalled();
  expect(a.entries.findLast(e => e.customType === "ce-mapping")?.data).toEqual(before);
  await a.ceStatus(); expect(a.notices()).toContain("ACTIVE");
}, 20_000);
