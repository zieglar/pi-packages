import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnelProfileSetup, readGeneratedPiAllowlist, type TunnelSetupMessaging, type TunnelSetupSaveInput, type SetupFileOperations } from "../../dist/tunnel/setup.js";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../dist/tunnel/background-manager.js";
import { isMessagingBinding, piAllowlistPath } from "../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, parseTunnelMcpCommand, serializeTunnelProfile } from "../../dist/tunnel/profile.js";
const ID = "tunnel_abcdefgh123456";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function manager(profilePath: string) {
  return createBackgroundTunnelManager({ env: {}, profilePath,
    inspectProcess: async (pid) => ({ kind: "present", identity: { pid, command: "synthetic", startedKey: "self" } }),
    listProcesses: async () => ({ kind: "ok", processes: [] }),
    spawn: () => { throw new Error("MUST NOT SPAWN"); }, signal: () => { throw new Error("MUST NOT SIGNAL"); } });
}
function harness() {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-setup-messaging-")); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml"); const key = join(dir, "old-key");
  fs.writeFileSync(key, "old-test-credential", { mode: 0o600 });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: ID, organizationId: "org-old", keyFile: key,
    healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: join(dir, "old-binding.json") }) })), { mode: 0o600 });
  const fresh = (io?: Partial<SetupFileOperations>) => createTunnelProfileSetup({ env: {}, profilePath, manager: manager(profilePath), nodePath: "/abs/node", ...(io === undefined ? {} : { io }) });
  return { dir, key, profilePath, fresh, setup: fresh() };
}
const MESSAGING: TunnelSetupMessaging = { chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: "session-current-1", payloadRead: true, ack: true, replaceExisting: false };
function input(h: ReturnType<typeof harness>, messaging = MESSAGING): TunnelSetupSaveInput {
  return { expectedRevision: h.setup.inspect().revision, tunnelId: ID, organizationId: "org-old", credential: { kind: "keep" },
    binding: { kind: "managed", endpointId: messaging.chatgptEndpointId, recipients: [{ adapter: "pi", endpointId: messaging.piEndpointId }], capabilities: { payloadRead: messaging.payloadRead, ack: messaging.ack } }, messaging };
}
function selected(h: ReturnType<typeof harness>) {
  const facts = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8"));
  const binding = parseTunnelMcpCommand(facts.mcpCommand!).bindingPath!;
  return { facts, binding, allowlist: piAllowlistPath(h.profilePath, isMessagingBinding(binding) ? binding : undefined) };
}
describe("Setup immutable messaging pair integration", () => {
  it("does not label a legacy Pi-side managed endpoint as ChatGPT", async () => {
    const h = harness();
    await h.setup.save({ expectedRevision: h.setup.inspect().revision, tunnelId: ID, organizationId: "org-old", credential: { kind: "keep" }, binding: { kind: "managed" } });
    expect(h.setup.inspect().messaging?.chatgptEndpoint).toBeUndefined();
    expect(h.setup.inspect().messaging?.configured).toBe(false);
  });
  it("publishes matching ChatGPT binding and current-session Pi allowlist, preserving credential metadata", async () => {
    const h = harness(); const keyBefore = fs.lstatSync(h.key);
    expect(await h.setup.save(input(h))).toMatchObject({ kind: "saved", durability: "synced" });
    const s = selected(h); const binding = JSON.parse(fs.readFileSync(s.binding, "utf8")); const pi = JSON.parse(fs.readFileSync(s.allowlist, "utf8"));
    expect(binding.managed).toEqual({ tunnelId: ID, organizationId: "org-old", adapter: "chatgpt" });
    expect(binding.endpoint).toEqual({ adapter: "chatgpt", endpointId: "chatgpt/main" });
    expect(binding.recipients).toEqual([{ adapter: "pi", endpointId: "pi/main" }]);
    expect(pi.sessions).toEqual({ "session-current-1": { endpointId: "pi/main" } });
    expect(pi.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
    expect(pi.store).toEqual(binding.store); expect(pi.exchangeNamespace).toBe(binding.exchange.namespace);
    expect(pi.exchangeIdempotencyKey).toBe(binding.exchange.idempotencyKey);
    expect(pi.payloadRead).toEqual(binding.payloadRead); expect(pi.ack).toEqual(binding.ack);
    expect(binding.debugExecutionGuard).toEqual({ enabled: false });
    expect(s.facts.keyFile).toBe(h.key); expect(fs.readFileSync(h.key, "utf8")).toBe("old-test-credential");
    const keyAfter = fs.lstatSync(h.key); expect([keyAfter.dev, keyAfter.ino, keyAfter.mtimeMs]).toEqual([keyBefore.dev, keyBefore.ino, keyBefore.mtimeMs]);
    expect(h.setup.inspect().messaging).toMatchObject({ configured: true, piSessionId: MESSAGING.piSessionId, storeFile: "ce-store.sqlite" });
    expect((readGeneratedPiAllowlist(h.profilePath) as { store: unknown }).store).toEqual(binding.store);
    expect(fs.existsSync(join(binding.store.directory, binding.store.file))).toBe(false);
  });
  it.each(["store-file", "exchange-key", "recipient-adapter"])("inspection and generated loader refuse a skewed %s", async (kind) => {
    const h = harness(); await h.setup.save(input(h)); const path = selected(h).allowlist;
    const doc = JSON.parse(fs.readFileSync(path, "utf8"));
    if (kind === "store-file") doc.store.file = "other.sqlite";
    if (kind === "exchange-key") doc.exchangeIdempotencyKey = "other";
    if (kind === "recipient-adapter") doc.recipients[0].adapter = "other";
    fs.writeFileSync(path, JSON.stringify(doc));
    expect(h.setup.inspect().messaging?.configured).toBe(false); expect(() => readGeneratedPiAllowlist(h.profilePath)).toThrow();
  });
  it("reauthorizing a session selects a new immutable pair and leaves the old pair unchanged", async () => {
    const h = harness(); await h.setup.save(input(h)); const old = selected(h); const bytes = fs.readFileSync(old.allowlist);
    await h.setup.save(input(h, { ...MESSAGING, piSessionId: "session-new", replaceExisting: true }));
    expect(selected(h).binding).not.toBe(old.binding); expect(fs.readFileSync(old.allowlist)).toEqual(bytes);
    expect(h.setup.inspect().messaging?.piSessionId).toBe("session-new");
  });
  it("a different selected session requires explicit replacement consent", async () => {
    const h = harness(); await h.setup.save(input(h)); const profile = fs.readFileSync(h.profilePath);
    await expect(h.setup.save(input(h, { ...MESSAGING, piSessionId: "other" }))).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(fs.readFileSync(h.profilePath)).toEqual(profile);
  });
  it("repeating an identical save reuses the same pair", async () => {
    const h = harness(); await h.setup.save(input(h)); const old = selected(h); const ino = fs.lstatSync(old.allowlist).ino;
    await h.setup.save(input(h)); expect(selected(h).binding).toBe(old.binding); expect(fs.lstatSync(old.allowlist).ino).toBe(ino);
  });
  it.each(["identity", "recipient"])("existing messaging requires reauthorization before %s edit", async (kind) => {
    const h = harness(); await h.setup.save(input(h)); const before = fs.readFileSync(h.profilePath);
    await expect(h.setup.save({ expectedRevision: h.setup.inspect().revision, tunnelId: kind === "identity" ? `${ID}new` : ID, organizationId: "org-old", credential: { kind: "keep" },
      ...(kind === "recipient" ? { binding: { kind: "managed" as const, recipients: [] } } : {}) })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(fs.readFileSync(h.profilePath)).toEqual(before);
  });
  it.each(["endpoint", "recipient", "read", "ack"])("refuses skewed %s before any generation write", async (kind) => {
    const h = harness(); const original = input(h);
    const bad = { ...MESSAGING, ...(kind === "endpoint" ? { chatgptEndpointId: "other" } : kind === "recipient" ? { piEndpointId: "other" } : kind === "read" ? { payloadRead: false } : { ack: false }) };
    await expect(h.setup.save({ ...original, messaging: bad })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(fs.existsSync(join(h.dir, ".ce-bindings"))).toBe(false);
  });
  it("does not overwrite an unrelated user allowlist at the legacy basename", async () => {
    const h = harness(); const path = piAllowlistPath(h.profilePath); const bytes = Buffer.from([0xff, 0xfe]); fs.writeFileSync(path, bytes, { mode: 0o600 });
    await h.setup.save(input(h)); expect(fs.readFileSync(path)).toEqual(bytes); expect(selected(h).allowlist).not.toBe(path);
  });
  it.each([false, true])("profile-commit failure leaves original active pair and bytes untouched (existing=%s)", async (existing) => {
    const h = harness(); if (existing) await h.setup.save(input(h)); const old = selected(h); const profile = fs.readFileSync(h.profilePath);
    const oldBytes = existing ? fs.readFileSync(old.allowlist) : undefined;
    const broken = h.fresh({ renameSync: (from, to) => { if (to === h.profilePath) throw new Error("commit-fail"); fs.renameSync(from, to); } });
    await expect(broken.save(input(h, { ...MESSAGING, piSessionId: "new", replaceExisting: existing }))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(fs.readFileSync(h.profilePath)).toEqual(profile); expect(selected(h).binding).toBe(old.binding);
    if (existing) expect(fs.readFileSync(old.allowlist)).toEqual(oldBytes);
    expect(fs.readdirSync(join(h.dir, ".ce-bindings")).some((n) => n.endsWith(".pi-allowlist.json"))).toBe(true); // Unreferenced, never activated/deleted.
    await h.setup.save(input(h, { ...MESSAGING, piSessionId: "new", replaceExisting: existing }));
    expect(h.setup.inspect().messaging?.configured).toBe(true);
  });
  it.each([false, true])("post-link directory sync failure cannot switch the active profile (existing=%s)", async (existing) => {
    const h = harness(); if (existing) await h.setup.save(input(h)); const old = selected(h); const profile = fs.readFileSync(h.profilePath); let linked = false;
    const broken = h.fresh({ linkSync: (from, to) => { fs.linkSync(from, to); if (String(to).endsWith(".pi-allowlist.json")) linked = true; },
      fsyncSync: (fd) => { if (linked && fs.fstatSync(fd).isDirectory()) throw new Error("dir-sync-fail"); fs.fsyncSync(fd); } });
    await expect(broken.save(input(h, { ...MESSAGING, piSessionId: "new", replaceExisting: existing }))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(linked).toBe(true); expect(fs.readFileSync(h.profilePath)).toEqual(profile); expect(selected(h).binding).toBe(old.binding);
  });
  it.each(["same-path", "hardlink"])("inspect/loader/save never read credential bytes aliased as selected allowlist: %s", async (kind) => {
    const h = harness(); await h.setup.save(input(h)); const path = selected(h).allowlist;
    fs.unlinkSync(path);
    if (kind === "same-path") { fs.renameSync(h.key, path); fs.writeFileSync(h.profilePath, fs.readFileSync(h.profilePath, "utf8").replace(`file:${h.key}`, `file:${path}`)); }
    else fs.linkSync(h.key, path);
    const key = kind === "same-path" ? path : h.key; const identity = fs.lstatSync(key); let secretReads = 0; const read = fs.readSync;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => { const s = fs.fstatSync(args[0]); if (s.ino === identity.ino && s.dev === identity.dev) secretReads++; return read(...args); });
    expect(h.setup.inspect().messaging?.configured).toBe(false); expect(() => readGeneratedPiAllowlist(h.profilePath)).toThrow();
    await expect(h.setup.save(input(h, { ...MESSAGING, replaceExisting: true }))).rejects.toBeDefined(); expect(secretReads).toBe(0);
  });
  it("fresh manager/setup over the same profile recovers full selected configuration without Store work", async () => {
    const h = harness(); await h.setup.save(input(h)); const s = selected(h); const profile = fs.readFileSync(h.profilePath); const allowlist = fs.readFileSync(s.allowlist);
    expect(h.fresh().inspect().messaging).toEqual(h.setup.inspect().messaging);
    expect(h.fresh().inspect().messaging).toMatchObject({ configured: true, piSessionId: MESSAGING.piSessionId, piEndpointId: "pi/main", payloadRead: true, ack: true,
      storeDirectory: join(h.dir, ".ce-bindings"), storeFile: "ce-store.sqlite" });
    expect(fs.readFileSync(h.profilePath)).toEqual(profile); expect(fs.readFileSync(s.allowlist)).toEqual(allowlist);
  });
});
