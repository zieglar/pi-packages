import fs from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { expect, it, vi, afterEach } from "vitest";
import { initializeStore } from "../../../dist/storage/store.js";
import { initializeLivePolicy, prepareLivePolicyUpgrade, createLivePolicyRegistration, readLivePolicy } from "../../../dist/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../../dist/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { CeEndpointHost } from "../../../dist/host/endpoint-host.js";
import { acquireSessionProcessMutex } from "../../../dist/tunnel/session-process-mutex.js";
import { PiMultiSessionRuntime } from "../../../pi-extension/multi-session-runtime.js";
import { recoveryDiagnostics } from "../../../pi-extension/session-recovery.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createHash, randomUUID } from "node:crypto";
import { CeSessionHost } from "../../../dist/endpoints/pi/session-host.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs(); vi.useRealTimers(); });

async function rig(options: { marker?: boolean; owner?: boolean; nativeId?: string; endpointId?: string; v1?: boolean; realSession?: boolean; policyExchangeKey?: string; missingIdentity?: "membership" | "participant" } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-extension-recovery-"))); fs.chmodSync(dir, 0o700);
  let manager = options.realSession !== false && options.nativeId === undefined ? SessionManager.create(dir, join(dir, "sessions")) : undefined;
  const nativeId = manager?.getSessionId() ?? options.nativeId ?? randomUUID();
  const endpointId = options.endpointId ?? "pi/A";
  const rootEntryId = manager?.appendMessage({ role: "user", content: "Synthetic session persistence fixture", timestamp: Date.now() });
  const root = join(dir, "policy"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const keyFile = join(dir, "credential"); fs.writeFileSync(keyFile, "synthetic", { mode: 0o600 });
  const store = initializeStore({ directory: dir, filename: "ce.sqlite" });
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "hooks-v2-pi", idempotencyKey: options.policyExchangeKey ?? "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId, runtimeSessionId: nativeId, epoch: 1, status: "active" as const, payloadRead: true, ack: true }] };
  const v1 = initializeLivePolicy({ root, manifest }); const ref = options.v1 ? v1 : prepareLivePolicyUpgrade(v1, profilePath); const api = createLivePolicyRegistration({ ref });
  const config = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint, recipients: [{ adapter: "pi", endpointId }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref });
  const pair = publishMessagingGeneration(profilePath, config, { kind: options.v1 ? "ce-live-launch-v1" : "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
  if (!options.v1) api.upgrade({ expectedDigest: readLivePolicy(v1).digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(process.cwd(), "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });

  vi.stubEnv("CE_ALLOWLIST", ""); vi.stubEnv("CE_TUNNEL_PROFILE", profilePath); vi.stubEnv("CE_STORE_DIR", ""); vi.stubEnv("CE_STORE_FILE", "");
  const nativeFile = manager?.getSessionFile() ?? join(dir, "native.jsonl");
  if (!manager) fs.writeFileSync(nativeFile, JSON.stringify({ type: "session", version: 3, id: nativeId, timestamp: new Date().toISOString(), cwd: dir }) + "\n", { mode: 0o644 });
  const entries: Array<Record<string, unknown>> = [];
  const append = (customType: string, data: unknown) => {
    if (manager) { manager.appendCustomEntry(customType, data); return; }
    const entry = { type: "custom", id: randomUUID(), parentId: entries.at(-1)?.id ?? null, customType, data };
    entries.push(entry); fs.appendFileSync(nativeFile, JSON.stringify(entry) + "\n");
  };
  const original = new CeSessionHost(store, { adapter: "pi", exchangeNamespace: manifest.exchange.namespace,
    exchangeIdempotencyKey: "test", allowlist: [{ piSessionId: nativeId, endpointId }], leaseTtlSeconds: 120 });
  let old = original.beginSession(endpointId);
  const oldFence = original.status(endpointId).fencingToken;
  if (!options.owner) original.end(endpointId);
  original.drop(endpointId);
  // Model historical identifiers whose current Store identity no longer matches,
  // without bypassing SQLite's immutable identity/membership constraints.
  if (options.missingIdentity === "membership") {
    const other = new CeEndpointHost(store, { adapter: "chatgpt", exchangeNamespace: "hooks-v2-pi", exchangeIdempotencyKey: "other",
      allowlist: [{ endpointId: "chatgpt/other" }], recipients: [] });
    const otherMapping = other.beginSession("chatgpt/other");
    other.end("chatgpt/other"); other.drop("chatgpt/other");
    old = { ...old, exchangeId: otherMapping.exchangeId };
  }
  if (options.missingIdentity === "participant") old = { ...old, participantId: old.participantId.slice(0, -1) + (old.participantId.endsWith("0") ? "1" : "0") };
  append("ce-mapping", old);
  if (manager && rootEntryId) manager.branch(rootEntryId);
  if (options.marker !== false) append("ce-lifecycle-blocked", { piSessionId: nativeId, endpointId, code: "CE_HOST_AUTHORITY_ABSENT" });
  if (manager && rootEntryId) {
    manager.branchWithSummary(rootEntryId, "Synthetic continuation after context compaction");
    manager = SessionManager.open(nativeFile);
  }
  const ctx = { mode: "tui", hasUI: true, cwd: dir, sessionManager: { getSessionId: () => nativeId, getSessionFile: (): string | undefined => nativeFile,
    getBranch: () => manager?.getBranch() as unknown as Array<Record<string, unknown>> ?? entries,
    getEntries: (): Array<Record<string, unknown>> => manager?.getEntries() as unknown as Array<Record<string, unknown>> ?? entries }, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), custom: vi.fn() } };
  const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
  function extension() {
    const events = new Map<string, any>(); const commands = new Map<string, any>(); const tools = new Map<string, any>();
    const appender = vi.fn(append);
    factory({ on: (name: string, handler: any) => events.set(name, handler), registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand: (name: string, command: any) => commands.set(name, command.handler), appendEntry: appender });
    return { appender, start: (reason = "startup") => events.get("session_start")({ reason }, ctx), stop: (reason = "quit") => events.get("session_shutdown")({ reason }, ctx),
      command: (args: string) => commands.get("ce-tunnel")(args, ctx), tool: (name: string, params: unknown) => tools.get(name).execute(randomUUID(), params, undefined, undefined, ctx) };
  }
  let current = extension();
  cleanups.push(async () => { await current.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ctx, get entries() { return ctx.sessionManager.getEntries(); }, old, oldFence, store, nativeFile, append, profilePath, ref, api, nativeId, dir,
    diagnostics: () => recoveryDiagnostics(ctx.sessionManager.getBranch(), ctx.sessionManager.getEntries(), nativeId, manifest.store),
    reopen() { if (manager) manager = SessionManager.open(nativeFile); },
    branchToRoot() { if (!manager || !rootEntryId) throw new Error("persistent fixture required"); manager.branch(rootEntryId); },
    get current() { return current; }, replace() { current = extension(); return current; } };
}

it("native resume: stable ACTIVE binding preserves its durable Session and fence without a repair journal", async () => {
  const r = await rig({ marker: false, owner: true, realSession: true });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 30_000);
  const before = r.store.database.prepare("SELECT * FROM participant_ownership").all();
  await r.current.start();
  expect((await r.current.tool("ce_inbox_list", {})).isError).not.toBe(true);
  expect(r.entries.findLast(e => e.customType === "ce-mapping")!.data).toEqual(r.old);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toEqual(before);
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
});

it.each(["disk-only", "memory-and-disk"])("native resume: %s unexpected history refuses authority adoption", async change => {
  const r = await rig({ marker: false, owner: true, realSession: true });
  const before = r.store.database.prepare("SELECT * FROM participant_ownership").all();
  let injected = change === "disk-only";
  if (change === "disk-only") fs.appendFileSync(r.nativeFile, JSON.stringify({ type: "custom", id: randomUUID(), parentId: null,
    timestamp: new Date().toISOString(), customType: "unexpected", data: {} }) + "\n");
  else {
    const read = fs.readSync, inode = fs.statSync(r.nativeFile).ino;
    let reads = 0;
    vi.spyOn(fs, "readSync").mockImplementation(((fd: number, ...args: any[]) => {
      if (fs.fstatSync(fd).ino === inode && ++reads === 2) { r.append("unexpected", {}); injected = true; }
      return (read as any)(fd, ...args);
    }) as typeof fs.readSync);
    syncBuiltinESMExports();
  }
  await r.current.start();
  expect(injected).toBe(true);
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toEqual(before);
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
});

it.each(["deactivate", "legacy"])("native release: %s intent renders Current Session Detached after startup", async intent => {
  const r = await rig({ marker: false, realSession: true });
  r.append("ce-messaging-released", { ...r.old, piSessionId: r.nativeId, ...(intent === "deactivate" ? { intent } : {}) });
  await r.current.start();
  const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
  const tui = createTuiHarness({ width: 110, rows: 45 });
  r.ctx.ui.custom.mockImplementation(tui.custom);
  const screen = r.current.command("");
  try {
    await tui.waitForOpen();
    const frame = tui.render().join("\n");
    expect(frame).toMatch(/Current Session[^\n]*Detached/);
    expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
    expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  } finally { tui.press("tui.select.cancel"); await screen; tui.dispose(); }
});

it.each(["deactivate", "legacy"])("native release: %s continues an explicit Connect reload through ordinary readiness checks", async intent => {
  const r = await rig({ marker: false, realSession: true });
  r.append("ce-messaging-released", { ...r.old, piSessionId: r.nativeId, ...(intent === "deactivate" ? { intent } : {}) });
  const { runtimeEnvironment } = await import("../../../pi-extension/multi-session-runtime.js");
  r.append("ce-connect-reload", { requestId: "detached-connect", piSessionId: r.nativeId, profilePath: r.profilePath,
    policyDigest: readLivePolicy(r.ref).digest, requestedAt: Date.now(), environment: runtimeEnvironment() });
  await r.current.start("reload");
  expect(r.entries.filter(e => e.customType === "ce-connect-reload-consumed").map(e => e.data)).toEqual([{ requestId: "detached-connect" }]);
  // The compatibility lane explicitly selects node:sqlite. Connect must still
  // cross Native readiness, without granting authority from the reload marker.
  expect(r.ctx.ui.notify.mock.calls.map(([message]) => String(message)).join("\n")).toContain("connect refused CE_HOST_UNAVAILABLE");
  expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it.each(["repair", "shutdown"] as const)("native auto: %s restoration continues the pending Connect reload", async mode => {
  const r = await rig({ marker: mode === "repair", realSession: true });
  if (mode === "shutdown") r.append("ce-messaging-released", { ...r.old, piSessionId: r.nativeId, intent: "shutdown" });
  r.append("ce-connect-reload", { requestId: "pending-native-connect", piSessionId: r.nativeId,
    policyDigest: "stale-policy", requestedAt: Date.now(), environment: "stale-environment" });
  await r.current.start("reload");
  expect((await r.current.tool("ce_inbox_list", {})).isError).not.toBe(true);
  expect(r.entries.filter(e => e.customType === "ce-connect-reload-consumed").map(e => e.data)).toEqual([{ requestId: "pending-native-connect" }]);
  expect(r.ctx.ui.notify.mock.calls.some(([message]) => String(message).includes("Endpoint policy changed during reload"))).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("native auto: restores persistent Pi branches with real Host traffic and reload transfer", async () => {
  const r = await rig({ realSession: true });
  const history = r.ctx.sessionManager.getEntries();
  expect(history.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect(history.filter(e => e.customType === "ce-lifecycle-blocked")).toHaveLength(1);
  expect(r.ctx.sessionManager.getBranch().some(e => e.customType === "ce-mapping" || e.customType === "ce-lifecycle-blocked")).toBe(false);
  await r.current.start();
  const mapping = r.ctx.sessionManager.getEntries().findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  expect(mapping.sessionId).not.toBe(r.old.sessionId);
  expect(mapping).toMatchObject({ endpointId: r.old.endpointId, participantId: r.old.participantId, exchangeId: r.old.exchangeId });
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "synthetic automatic restore", idempotencyKey: "native-auto" })).isError).not.toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
  const owner = r.store.database.prepare("SELECT * FROM participant_ownership WHERE participant_id = ?").get(mapping.participantId)!;
  expect(owner.session_id).toBe(mapping.sessionId);
  expect(Number(owner.fencing_token)).toBeGreaterThan(Number(r.oldFence));
  const chat = new CeEndpointHost(r.store, { adapter: "chatgpt", exchangeNamespace: "hooks-v2-pi", exchangeIdempotencyKey: "test",
    allowlist: [{ endpointId: "chatgpt/main" }], recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true } });
  chat.beginSession("chatgpt/main");
  try {
    const sent = chat.send("chatgpt/main", { to: "pi/A", text: "synthetic automatic inbound", idempotencyKey: "native-auto-inbound" });
    const inbox = await r.current.tool("ce_inbox_list", {});
    expect(inbox.isError).not.toBe(true);
    expect(JSON.stringify(inbox.details)).toContain(sent.messageId);
    const payload = await r.current.tool("ce_read_payload", { messageId: sent.messageId });
    expect(payload.isError).not.toBe(true);
    expect(payload.content).toContainEqual({ type: "text", text: "synthetic automatic inbound" });
    const ack = await r.current.tool("ce_ack", { messageId: sent.messageId, payloadDigest: payload.details.payloadDigest,
      payloadLength: payload.details.payloadLength, messageCreatedAuditSequence: payload.details.auditSequence });
    expect(ack.isError).not.toBe(true);
    expect(r.store.database.prepare("SELECT ack_session_id FROM delivery_ack_receipt WHERE message_id = ?").get(sent.messageId))
      .toMatchObject({ ack_session_id: mapping.sessionId });
  } finally { chat.end("chatgpt/main"); }
  const full = r.ctx.sessionManager.getEntries();
  expect(full.some(e => e.customType === "ce-recovery-attempt")).toBe(true);
  expect(full.some(e => e.customType === "ce-recovery-resolved")).toBe(true);
  expect(full.filter(e => e.customType === "ce-lifecycle-blocked")).toHaveLength(1);
  expect(fs.readFileSync(r.nativeFile, "utf8")).not.toContain("synthetic automatic inbound");
  await r.current.stop("reload"); r.reopen(); r.replace(); await r.current.start("reload");
  const resumed = r.ctx.sessionManager.getEntries().findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  expect(resumed).toEqual(mapping);
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "after reload", idempotencyKey: "native-auto-reload" })).isError).not.toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("native auto: normal quit and fresh factory restart preserve identity with a new durable Session", async () => {
  const r = await rig({ realSession: true });
  await r.current.start();
  const restored = r.ctx.sessionManager.getEntries().findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  expect(restored.sessionId).not.toBe(r.old.sessionId);
  await r.current.stop("quit");
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  r.reopen(); r.replace(); await r.current.start();
  const restarted = r.ctx.sessionManager.getEntries().findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  expect(restarted.sessionId).not.toBe(restored.sessionId);
  expect(restarted).toMatchObject({ endpointId: restored.endpointId, participantId: restored.participantId, exchangeId: restored.exchangeId });
  expect(r.ctx.sessionManager.getSessionId()).toBe(r.nativeId);
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "after quit", idempotencyKey: "native-auto-quit" })).isError).not.toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("native auto: explicit deactivation remains detached after restart", async () => {
  const r = await rig({ realSession: true });
  await r.current.start();
  const restored = r.ctx.sessionManager.getEntries().findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  expect(restored.sessionId).not.toBe(r.old.sessionId);
  await r.current.command("deactivate");
  expect(r.ctx.sessionManager.getEntries().some(e => e.customType === "ce-messaging-released")).toBe(true);
  await r.current.stop("quit");
  r.reopen(); r.replace();
  r.ctx.ui.confirm.mockClear(); // Explicit Deactivate has its own ordinary confirmation.
  const before = r.ctx.sessionManager.getEntries();
  await r.current.start();
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  expect(r.ctx.sessionManager.getEntries().filter(e => e.customType === "ce-recovery-attempt" || e.customType === "ce-mapping"))
    .toEqual(before.filter(e => e.customType === "ce-recovery-attempt" || e.customType === "ce-mapping"));
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it.each([false, true])("native auto: uncleared Owner refuses before attempt and preserves Owner, expired=%s", async expired => {
  const r = await rig({ realSession: true, owner: true });
  if (expired) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 180_000); }
  const before = r.store.database.prepare("SELECT * FROM participant_ownership").all();
  await r.current.start();
  const warnings = r.ctx.ui.notify.mock.calls.map(([message]) => String(message)).join("\n");
  expect(warnings).toContain(expired ? "CE_HOST_AUTHORITY_ABSENT / EXPIRED" : "CE_HOST_AUTHORITY_ABSENT / OWNERSHIP_HELD");
  if (expired) expect(warnings).toContain("stale-ownership recovery");
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toEqual(before);
  expect(r.ctx.sessionManager.getEntries().some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(r.ctx.sessionManager.getEntries().filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("native auto: held process mutex refuses before attempt and preserves mutex Owner", async () => {
  const r = await rig({ realSession: true });
  const mutex = acquireSessionProcessMutex({ store: { directory: r.dir, file: "ce.sqlite" }, endpointId: "pi/A", runtimeSessionId: r.nativeId });
  const before = fs.readFileSync(mutex.markerPath);
  try {
    await r.current.start();
    expect(fs.readFileSync(mutex.markerPath)).toEqual(before);
    expect(r.ctx.sessionManager.getEntries().some(e => e.customType === "ce-recovery-attempt")).toBe(false);
    expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
    expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
    expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
  } finally { mutex.closeAdmission(); await mutex.drain(); mutex.release({ released: true, detached: true }); }
});

it.each(["policy-exchange", "membership", "participant"])("native auto: prewrite %s mismatch refuses without new authority or attempt", async mismatch => {
  const r = await rig({ realSession: true, policyExchangeKey: mismatch === "policy-exchange" ? "different-exchange" : mismatch === "membership" ? "other" : "test",
    ...(mismatch === "membership" || mismatch === "participant" ? { missingIdentity: mismatch } : {}) });
  if (mismatch === "membership") expect(r.store.database.prepare("SELECT * FROM exchange_membership WHERE participant_id = ? AND exchange_id = ?").get(r.old.participantId, r.old.exchangeId)).toBeUndefined();
  if (mismatch === "participant") expect(r.store.database.prepare("SELECT * FROM participant WHERE participant_id = ?").get(r.old.participantId)).toBeUndefined();
  const snapshots = [
    r.store.database.prepare("SELECT * FROM participant"), r.store.database.prepare("SELECT * FROM exchange"),
    r.store.database.prepare("SELECT * FROM exchange_membership"), r.store.database.prepare("SELECT * FROM participant_session"),
    r.store.database.prepare("SELECT * FROM participant_ownership"), r.store.database.prepare("SELECT * FROM participant_fencing_high_water"),
  ];
  const before = snapshots.map(query => query.all());
  await r.current.start();
  expect(snapshots.map(query => query.all())).toEqual(before);
  expect(r.ctx.sessionManager.getEntries().some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(r.ctx.sessionManager.getEntries().filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

function child(r: Awaited<ReturnType<typeof rig>>, mode: string) {
  return spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./recovery-child-loader.mjs", import.meta.url)),
    fileURLToPath(new URL("./recovery-child.mjs", import.meta.url)), r.nativeFile, mode], { encoding: "utf8", timeout: 20_000, env: process.env });
}

function reconcileDeadChildMutex(r: Awaited<ReturnType<typeof rig>>) {
  const scope = createHash("sha256").update(JSON.stringify([r.dir, "ce.sqlite", "pi/A", r.nativeId])).digest("hex");
  const slot = join(r.dir, ".ce-session-process-mutex", scope, "1"); const marker = join(slot, "owner.json");
  const bytes = fs.readFileSync(marker); const owner = JSON.parse(bytes.toString());
  const values: Record<string, string> = { "store-dir": r.dir, "store-file": "ce.sqlite", endpoint: "pi/A", "runtime-session": r.nativeId, slot: "1",
    "owner-version": String(owner.version), "owner-scope": owner.scope, "owner-pid": String(owner.pid), "owner-birth": owner.birth,
    "owner-process-token": owner.processToken, "owner-handle-token": owner.handleToken, "owner-sha256": createHash("sha256").update(bytes).digest("hex") };
  for (const [name, path] of [["store", join(r.dir, "ce.sqlite")], ["slot", slot], ["owner", marker]] as const) {
    const stat = fs.lstatSync(path); values[`${name}-dev`] = String(stat.dev); values[`${name}-ino`] = String(stat.ino);
  }
  const result = spawnSync(process.execPath, ["scripts/reconcile-session-process-mutex.mjs",
    ...Object.entries(values).flatMap(([key, value]) => [`--expect-${key}`, value]), "--offline-window-confirmed", "--owner-death-evidence", "isolated child exited and reaped"],
    { encoding: "utf8", timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
}

it.each(["visible", "tail", "fsync"].flatMap(fault => ["success", "fail"].flatMap(marker =>
  ["ce-recovery-attempt", "ce-mapping", "ce-recovery-resolved"].map(stage => ({ fault, marker, stage })))))(
  "fresh process handles $stage $fault failure with later marker=$marker using ordinary authority only", { timeout: 25_000 }, async ({ fault, marker, stage }) => {
    const r = await rig();
    const writer = child(r, `write-fail:${stage}:${fault}:${marker}`);
    expect(writer.status, writer.stderr + writer.stdout).toBe(0);
    const written = JSON.parse(writer.stdout.trim()); expect(written.isError).toBe(true);
    expect(written.messages.some((text: string) => text.includes("recovery committed"))).toBe(false);
    const complete = stage === "ce-recovery-resolved";
    if (stage !== "ce-recovery-attempt") {
      // A committed journal is not mutex authority: before offline reconciliation
      // even the complete commit must refuse ordinary admission.
      const before = child(r, "probe"); expect(before.status, before.stderr).toBe(0);
      expect(JSON.parse(before.stdout.trim()).isError).toBe(true);
      reconcileDeadChildMutex(r);
    }
    const restart = child(r, "probe"); expect(restart.status, restart.stderr + restart.stdout).toBe(0);
    expect(JSON.parse(restart.stdout.trim()).isError).toBe(!(complete && marker === "fail"));
    expect(JSON.parse(restart.stdout.trim()).mappings).toBe(complete && marker === "fail" ? 3 : stage === "ce-recovery-attempt" ? 1 : 2);
  });

it("refuses a selected live v1 policy without attempting recovery", async () => {
  const r = await rig({ v1: true }); await r.current.start();
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("recovery refuses the native-session process latch from another Endpoint and Store without clearing it", async () => {
  const first = await rig();
  first.current.appender.mockImplementation(() => { throw new Error("all persistence unavailable"); });
  await first.current.start();
  const second = await rig({ nativeId: first.nativeId, endpointId: "pi/B" }); await second.current.start();
  expect(second.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(second.ctx.ui.confirm).not.toHaveBeenCalled();
});

it("refuses a read-only global runtime failure without writing an attempt", async () => {
  const r = await rig(); const loaded = readLivePolicy(r.ref);
  const runtime = new PiMultiSessionRuntime(loaded, r.nativeId, () => r.nativeId, false, undefined); runtime.fail();
  await r.current.start();
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
});

it("never bypasses an unreconciled ordinary session-process mutex", async () => {
  const r = await rig(); const mutex = acquireSessionProcessMutex({ store: { directory: r.dir, file: "ce.sqlite" }, endpointId: "pi/A", runtimeSessionId: r.nativeId });
  try {
    await r.current.start();
    expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
    expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(false);
    expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
    expect(fs.existsSync(mutex.markerPath)).toBe(true);
    // A preflight refusal must permit later ordinary startup after maintenance.
    mutex.closeAdmission(); await mutex.drain(); mutex.release({ released: true, detached: true });
    r.replace(); await r.current.start();
    expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(true);
  } finally { mutex.closeAdmission(); }
});

it("abrupt child exit after persistent attempt denies restart before any mutex or Host writes", async () => {
  const r = await rig();
  const crashed = child(r, "crash-attempt"); expect(crashed.status, crashed.stderr + crashed.stdout).toBe(73);
  expect(fs.readFileSync(r.nativeFile, "utf8")).toContain("ce-recovery-attempt");
  const restart = child(r, "probe"); expect(restart.status, restart.stderr + restart.stdout).toBe(0);
  expect(JSON.parse(restart.stdout.trim()).isError).toBe(true);
  expect(JSON.parse(restart.stdout.trim()).mappings).toBe(1);
  // Local admission precedes the attempt; a crash retains its mutex marker.
  expect(fs.existsSync(join(r.dir, ".ce-session-process-mutex"))).toBe(true);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
});

it("later lifecycle failure after automatic commit cannot trigger another repair", async () => {
  const r = await rig(); await r.current.start();
  r.append("ce-lifecycle-blocked", { piSessionId: r.nativeId, endpointId: "pi/A", code: "CE_HOST_UNCERTAIN" });
  await r.current.stop("reload"); r.replace(); await r.current.start("reload");
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "fixture", idempotencyKey: "blocked" })).isError).toBe(true);
  await r.current.command("activate");
  expect(r.entries.filter(e => e.customType === "ce-recovery-attempt")).toHaveLength(1);
  expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(2);
});

it("automatic startup preserves original registration and commits a fresh ACTIVE durable session", async () => {
  const r = await rig(); await r.current.start();
  const mapping = r.entries.findLast(e => e.customType === "ce-mapping")?.data as typeof r.old;
  expect(mapping.sessionId).not.toBe(r.old.sessionId);
  expect(mapping).toMatchObject({ endpointId: r.old.endpointId, participantId: r.old.participantId, exchangeId: r.old.exchangeId });
  expect(r.entries.filter(e => e.customType === "ce-recovery-attempt")).toHaveLength(1);
  expect(r.entries.filter(e => e.customType === "ce-recovery-resolved")).toHaveLength(1);
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "fixture", idempotencyKey: "recovered" })).isError).not.toBe(true);
  const owner = r.store.database.prepare("SELECT session_id, fencing_token FROM participant_ownership").get()!;
  expect(owner.session_id).toBe(mapping.sessionId); expect(Number(owner.fencing_token)).toBeGreaterThan(Number(r.oldFence));
  const chat = new CeEndpointHost(r.store, { adapter: "chatgpt", exchangeNamespace: "hooks-v2-pi", exchangeIdempotencyKey: "test",
    allowlist: [{ endpointId: "chatgpt/main" }], recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true } });
  chat.beginSession("chatgpt/main");
  try {
    const sent = chat.send("chatgpt/main", { to: "pi/A", text: "recovery payload", idempotencyKey: "inbound" });
    const inbox = await r.current.tool("ce_inbox_list", {}); expect(inbox.isError).not.toBe(true);
    expect(JSON.stringify(inbox.details)).toContain(sent.messageId);
    const payload = await r.current.tool("ce_read_payload", { messageId: sent.messageId }); expect(payload.isError).not.toBe(true);
    expect(payload.content).toContainEqual({ type: "text", text: "recovery payload" });
    const ack = await r.current.tool("ce_ack", { messageId: sent.messageId, payloadDigest: payload.details.payloadDigest,
      payloadLength: payload.details.payloadLength, messageCreatedAuditSequence: payload.details.auditSequence }); expect(ack.isError).not.toBe(true);
  } finally { chat.end("chatgpt/main"); }
  expect(r.diagnostics()).toEqual({ invalid: false, failures: [] });
  expect(fs.readFileSync(r.nativeFile, "utf8")).not.toContain("recovery payload");
  await r.current.stop("reload"); r.replace(); await r.current.start("reload");
  expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "fixture", idempotencyKey: "resumed" })).isError).not.toBe(true);
  await r.current.stop(); expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
});

it("recovery permits ordinary deactivate/activate and subsequent reload with a new durable Session", async () => {
  const r = await rig(); await r.current.start();
  const recovered = r.entries.findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
  await r.current.command("deactivate");
  expect(r.entries.some(e => e.customType === "ce-messaging-released" && (e.data as typeof r.old).sessionId === recovered.sessionId)).toBe(true);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  const { createTuiHarness } = await import("@narumitw/pi-tui-kit/testing");
  const tui = createTuiHarness({ width: 100, rows: 40 });
  r.ctx.ui.custom.mockImplementation(tui.custom);
  const activation = r.current.command("activate");
  try {
    await tui.waitForOpen(); tui.press("tui.select.down"); tui.press("tui.select.confirm"); await activation;
    const reactivated = r.entries.findLast(e => e.customType === "ce-mapping")!.data as typeof r.old;
    expect(reactivated.sessionId, JSON.stringify(r.ctx.ui.notify.mock.calls)).not.toBe(recovered.sessionId);
    expect(r.diagnostics()).toEqual({ invalid: false, failures: [] });
    expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "fixture", idempotencyKey: "reactivated" })).isError).not.toBe(true);
    await r.current.stop("reload"); r.replace(); await r.current.start("reload");
    expect((await r.current.tool("ce_send", { to: "chatgpt/main", text: "fixture", idempotencyKey: "reactivated-reload" })).isError).not.toBe(true);
    r.append("ce-lifecycle-blocked", { piSessionId: r.nativeId, endpointId: "pi/A", code: "CE_HOST_UNCERTAIN" });
    expect(r.diagnostics().failures).toHaveLength(1);
  } finally { tui.dispose(); await activation; }
});

it.each([false, true])("refuses uncleared Owner through ordinary requireUnowned, expired=%s", async expired => {
  const r = await rig({ owner: true });
  if (expired) { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 180_000); }
  const before = r.store.database.prepare("SELECT * FROM participant_ownership").all();
  await r.current.start();
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toEqual(before);
  expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
  expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(false);
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(r.diagnostics().invalid).toBe(false);
});

it("characterizes expired mapping WITHOUT a marker: startup latches, recovery remains manual escalation", async () => {
  const r = await rig({ owner: true, marker: false });
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 180_000);
  await r.current.start();
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  r.replace(); await r.current.start();
  expect(r.entries.filter(e => e.customType === "ce-mapping")).toHaveLength(1);
});

it.each(["session", "branch", "history", "environment", "policy", "profile", "file"])("automatic journal fences %s changes before Host writes", async change => {
  const r = await rig();
  r.current.appender.mockImplementation((kind: string, data: unknown) => {
    r.append(kind, data);
    if (kind !== "ce-recovery-attempt") return;
    if (change === "session") r.ctx.sessionManager.getSessionId = () => "00000000-0000-0000-0000-000000000000";
    if (change === "branch") { const before = r.ctx.sessionManager.getBranch(); r.ctx.sessionManager.getBranch = () => before.slice(0, 1); }
    if (change === "history") r.append("unrelated", {});
    if (change === "environment") vi.stubEnv("CE_LEASE_TTL_SECONDS", "90");
    if (change === "policy") r.api.setPiHooks({ expectedDigest: readLivePolicy(r.ref).digest, runtimeSessionId: r.nativeId, endpointId: "pi/A", epoch: 1, hooks: [] });
    if (change === "profile") fs.appendFileSync(r.profilePath, "\n# changed\n");
    if (change === "file") r.ctx.sessionManager.getSessionFile = () => undefined;
  });
  await r.current.start();
  expect(r.entries.some(e => e.customType === "ce-recovery-attempt")).toBe(true);
  expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(false);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
});

it.each(["missing-file", "missing-ids", "missing-history", "missing-mapping", "other-endpoint", "legacy"])("refuses unsupported %s before attempt", async reason => {
  const r = await rig();
  const originalHistory = r.ctx.sessionManager.getEntries;
  if (reason === "missing-file") r.ctx.sessionManager.getSessionFile = () => undefined;
  if (reason === "missing-ids") { const broken = structuredClone(originalHistory()); delete broken[1]!.id; r.ctx.sessionManager.getEntries = () => broken; }
  if (reason === "missing-history") Object.assign(r.ctx.sessionManager, { getEntries: undefined });
  if (reason === "missing-mapping") { const broken = originalHistory().filter(e => e.customType !== "ce-mapping"); r.ctx.sessionManager.getEntries = () => broken; }
  if (reason === "other-endpoint") r.append("ce-lifecycle-blocked", { piSessionId: r.nativeId, endpointId: "pi/other", code: "CE_HOST_UNCERTAIN" });
  if (reason === "legacy") { vi.stubEnv("CE_ALLOWLIST", join(r.dir, "legacy.json")); r.replace(); }
  await r.current.start();
  expect(originalHistory().some(e => e.customType === "ce-recovery-attempt")).toBe(false);
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
});

it.each(["rpc", "headless"])("automatic startup needs no confirmation in %s mode and shutdown releases its binding", async mode => {
  const r = await rig();
  r.ctx.mode = mode === "rpc" ? "rpc" : "tui"; r.ctx.hasUI = mode !== "headless";
  await r.current.start();
  expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(true);
  expect(r.ctx.ui.confirm).not.toHaveBeenCalled();
  await r.current.stop();
  expect(r.store.database.prepare("SELECT * FROM participant_ownership").all()).toHaveLength(0);
});

it.each(["ce-recovery-attempt", "ce-mapping", "ce-recovery-resolved"])("%s append failure latches this process and a new factory, no retry", async stage => {
  const r = await rig();
  r.current.appender.mockImplementation((kind: string, data: unknown) => { if (kind === stage) throw new Error("injected append failure"); r.append(kind, data); });
  await r.current.start();
  const after = r.entries.length;
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  await r.current.start(); expect(r.entries).toHaveLength(after);
  r.replace(); await r.current.start(); await r.current.command("activate");
  expect(r.entries).toHaveLength(after);
  expect(r.entries.some(e => e.customType === "ce-recovery-resolved")).toBe(false);
});

it.each(["ce-recovery-attempt", "ce-mapping", "ce-recovery-resolved"])("visible-then-throw at %s stays latched and preserves exact visible records", async stage => {
  const r = await rig();
  r.current.appender.mockImplementation((kind: string, data: unknown) => { r.append(kind, data); if (kind === stage) throw new Error("visible append failure"); });
  await r.current.start();
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
  expect(r.entries.some(e => e.customType === stage)).toBe(true);
  expect(r.entries.filter(e => e.customType === "ce-lifecycle-blocked")).toHaveLength(2);
  const diagnostics = r.diagnostics();
  if (stage === "ce-recovery-resolved") { expect(diagnostics.invalid).toBe(false); expect(diagnostics.failures).toHaveLength(1); }
  else expect(diagnostics.invalid).toBe(true);
});

it("branch rollback preserves the native commit; later or other Endpoint failure never discharges", async () => {
  const r = await rig(); await r.current.start();
  const committed = r.entries.findLast(e => e.customType === "ce-mapping")!.data;
  r.branchToRoot();
  expect(r.ctx.sessionManager.getBranch().some(e => e.customType === "ce-recovery-resolved")).toBe(false);
  expect(r.diagnostics()).toEqual({ invalid: false, failures: [] });
  await r.current.stop("reload"); r.replace(); await r.current.start("reload");
  expect(r.entries.findLast(e => e.customType === "ce-mapping")!.data).toEqual(committed);
  expect((await r.current.tool("ce_inbox_list", {})).isError).not.toBe(true);
  r.append("ce-lifecycle-blocked", { piSessionId: r.nativeId, endpointId: "pi/A", code: "CE_HOST_UNCERTAIN" });
  expect(r.diagnostics()).toMatchObject({ invalid: false, failures: [expect.objectContaining({ data: expect.objectContaining({ endpointId: "pi/A" }) })] });
  r.append("ce-lifecycle-blocked", { piSessionId: r.nativeId, endpointId: "pi/other", code: "CE_HOST_UNCERTAIN" });
  expect(r.diagnostics().invalid).toBe(true);
  expect(r.diagnostics().failures).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ endpointId: "pi/other" }) }));
  await r.current.stop("reload"); r.replace(); await r.current.start("reload");
  expect((await r.current.tool("ce_inbox_list", {})).isError).toBe(true);
});
