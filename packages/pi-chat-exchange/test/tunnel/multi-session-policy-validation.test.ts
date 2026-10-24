import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../dist/tunnel/background-manager.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile, replaceTunnelMcpBindingPath } from "../../dist/tunnel/profile.js";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";
import { publishMessagingPair, publishMessagingGeneration } from "../../dist/tunnel/messaging-config.js";
import { parseMcpBindingConfig } from "../../dist/host/mcp-binding-config.js";
import * as multi from "../../dist/tunnel/multi-session-policy.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-multi-validation-")); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml"); const credentialFile = join(dir, "synthetic-key");
  fs.writeFileSync(credentialFile, "synthetic-never-open-key", { mode: 0o600 });
  const managed = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined, adapter: "chatgpt", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/A" }], capabilities: { payloadRead: true, ack: true } });
  const legacy = publishMessagingPair(profilePath, managed.config, { chatgptEndpoint: managed.config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "real-A", store: managed.config.store, exchangeNamespace: managed.config.exchange.namespace, exchangeIdempotencyKey: managed.config.exchange.idempotencyKey, payloadRead: true, ack: true });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: credentialFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: legacy.bindingPath }) })), { mode: 0o600 });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, listProcesses: async () => ({ kind: "ok", processes: [] }), spawn: () => { throw Error("NO SPAWN"); }, signal: () => { throw Error("NO SIGNAL"); } });
  const api = multi.createMultiSessionRegistration({ profilePath, manager });
  await api.convert({ expectedRevision: api.revision(), confirm: true });
  const loaded = multi.readSelectedMultiSessionPolicy(profilePath);
  const select = (bindingPath: string) => {
    const text = fs.readFileSync(profilePath, "utf8"); const command = parseTunnelProfile(text).mcpCommand!;
    fs.writeFileSync(profilePath, text.replace(command, replaceTunnelMcpBindingPath(command, bindingPath)));
  };
  return { dir, profilePath, credentialFile, manager, api, loaded, select };
}
it("replay registration is idempotent under the stopped-only lock", async () => {
  const f = await fixture(); const before = f.api.revision();
  const result = await f.api.register({ expectedRevision: before, registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
  expect(result.revision).toBe(before);
});
it("provides a complete deny-only MCP policy and pinned loaded-generation reader", async () => {
  const f = await fixture();
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } });
  const pinned = multi.readLoadedMultiSessionPolicy(f.profilePath, f.loaded.bindingPath);
  const current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(multi.intersectMcpPolicy(pinned, current)).toEqual({ recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: true, ack: true });
  expect(() => multi.intersectRegistration(pinned, current, "real-B")).toThrow();
});
it.each(["top-extra", "registration-extra", "epoch-zero", "epoch-fraction", "runtime-duplicate", "endpoint-duplicate", "opt-in-string", "identity-extra"])("strictly rejects %s manifest", async (kind) => {
  const f = await fixture(); const raw = JSON.parse(JSON.stringify(f.loaded.manifest));
  if (kind === "top-extra") raw.extra = true;
  if (kind === "registration-extra") raw.registrations[0].extra = true;
  if (kind === "epoch-zero") raw.registrations[0].epoch = 0;
  if (kind === "epoch-fraction") raw.registrations[0].epoch = 1.5;
  if (kind === "runtime-duplicate") raw.registrations.push({ ...raw.registrations[0], endpointId: "pi/B" });
  if (kind === "endpoint-duplicate") raw.registrations.push({ ...raw.registrations[0], runtimeSessionId: "real-B" });
  if (kind === "opt-in-string") raw.registrations[0].ack = "true";
  if (kind === "identity-extra") raw.identity.extra = true;
  expect(() => multi.parseMultiSessionManifest(raw)).toThrow();
});
it.each(["store", "exchange", "tunnel", "recipients", "global-opt-in", "policy-reference"])("rejects correctly digested but mismatched %s pair", async (kind) => {
  const f = await fixture(); const document = JSON.parse(JSON.stringify(f.loaded.manifest));
  const config = { ...f.loaded.config };
  if (kind === "store") document.store.file = "other.sqlite";
  if (kind === "exchange") document.exchange.namespace = "other";
  if (kind === "tunnel") document.identity.tunnelId = "tunnel_ijklmnop123456";
  if (kind === "recipients") document.registrations[0].status = "revoked";
  if (kind === "global-opt-in") document.mcp.ack = false;
  if (kind === "policy-reference") config.admissionPolicy = { kind: "ce-multi-session-v1", profilePath: join(f.dir, "other.yaml") };
  const pair = publishMessagingGeneration(f.profilePath, config, document, { credentialFile: f.credentialFile }); f.select(pair.bindingPath);
  expect(() => multi.readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
});
it.each(["digest", "missing-sidecar", "mode", "special-mode", "symlink", "hardlink-key", "directory-symlink"])("fails closed on %s filesystem state", async (kind) => {
  const f = await fixture(); const path = `${f.loaded.bindingPath}.pi-allowlist.json`;
  if (kind === "digest") fs.writeFileSync(path, "{}");
  if (kind === "missing-sidecar") fs.unlinkSync(path);
  if (kind === "mode") fs.chmodSync(path, 0o644);
  if (kind === "special-mode") {
    // macOS strips setgid (0o2000) from a wheel-group file for a non-root caller,
    // silently leaving a valid 0o600 sidecar; setuid survives for the owner, so
    // prove the special bits are actually present before asserting the rejection.
    fs.chmodSync(path, 0o4600);
    expect(fs.statSync(path).mode & 0o7777).toBe(0o4600);
  }
  if (kind === "symlink") { const renamed = `${path}.old`; fs.renameSync(path, renamed); fs.symlinkSync(renamed, path); }
  if (kind === "hardlink-key") { fs.unlinkSync(path); fs.linkSync(f.credentialFile, path); }
  if (kind === "directory-symlink") { const dir = join(f.dir, ".ce-bindings"); fs.renameSync(dir, `${dir}.old`); fs.symlinkSync(`${dir}.old`, dir); }
  expect(() => multi.readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
});
it("accepts a sidecar whose real mode is exactly private 0o600", async () => {
  const f = await fixture(); const path = `${f.loaded.bindingPath}.pi-allowlist.json`;
  fs.chmodSync(path, 0o600);
  expect(fs.statSync(path).mode & 0o7777).toBe(0o600);
  expect(multi.readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(1);
});
it.skipIf(process.geteuid?.() !== 0)("refuses wrong file owner (requires chown authority)", async () => {
  const f = await fixture(); fs.chownSync(`${f.loaded.bindingPath}.pi-allowlist.json`, 12345, 12345);
  expect(() => multi.readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
});
it("policy reference validates closed fields without granting recipients or read/ACK", () => {
  const base = { version: 1, store: { directory: "/tmp/synthetic-store" }, exchange: { namespace: "test", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [] };
  const config = parseMcpBindingConfig({ ...base, admissionPolicy: { kind: "ce-multi-session-v1", profilePath: "/tmp/synthetic-profile.yaml" } });
  expect(config.recipients).toEqual([]); expect(config.payloadRead.enabled).toBe(false); expect(config.ack.enabled).toBe(false);
  for (const admissionPolicy of [{ kind: "ce-multi-session-v1", profilePath: "relative" }, { kind: "ce-multi-session-v1", profilePath: "/tmp/a", grant: true }, { kind: "other", profilePath: "/tmp/a" }, { kind: "ce-multi-session-v1", profilePath: "/tmp/a\n" }]) expect(() => parseMcpBindingConfig({ ...base, admissionPolicy })).toThrow();
});
it.each(["partial-pair", "candidate-fsync", "profile-rename", "commit-fsync"])("retains immutable candidates and reports %s publication outcome honestly", async (kind) => {
  const f = await fixture(); const before = fs.readFileSync(f.profilePath); let renamed = false;
  const io = {
    linkSync: ((from: fs.PathLike, to: fs.PathLike) => { if (kind === "partial-pair" && String(to).endsWith(".pi-allowlist.json")) throw Error("synthetic"); fs.linkSync(from, to); }) as typeof fs.linkSync,
    renameSync: ((from: fs.PathLike, to: fs.PathLike) => { if (kind === "profile-rename") throw Error("synthetic"); fs.renameSync(from, to); renamed = true; }) as typeof fs.renameSync,
    fsyncSync: ((fd: number) => { if ((kind === "candidate-fsync" && fs.fstatSync(fd).isDirectory()) || (kind === "commit-fsync" && renamed)) throw Error("synthetic"); fs.fsyncSync(fd); }) as typeof fs.fsyncSync,
  };
  const api = multi.createMultiSessionRegistration({ profilePath: f.profilePath, manager: f.manager, io });
  const operation = api.register({ expectedRevision: api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: false } });
  if (kind === "commit-fsync") {
    await expect(operation).resolves.toMatchObject({ durability: "uncertain" });
    expect(multi.readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(2);
  } else {
    await expect(operation).rejects.toThrow(); expect(fs.readFileSync(f.profilePath)).toEqual(before);
    expect(multi.readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(1);
  }
  expect(fs.existsSync(f.loaded.bindingPath)).toBe(true);
});
it("adds C independently and intersects opt-ins without granting newly enabled rights", async () => {
  const f = await fixture();
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: false } });
  const loaded = multi.readSelectedMultiSessionPolicy(f.profilePath);
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } });
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  const current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(multi.intersectRegistration(loaded, current, "real-B")).toMatchObject({ payloadRead: false, ack: false });
  expect(multi.intersectMcpRecipients(loaded, current)).toEqual([{ adapter: "pi", endpointId: "pi/B" }]);
  expect(() => multi.intersectRegistration(loaded, current, "real-C")).toThrow();
});
it.each(["store", "exchange", "identity"])("valid current %s identity changes deny an old loaded snapshot", async (kind) => {
  const f = await fixture(); const document = JSON.parse(JSON.stringify(f.loaded.manifest));
  let config = f.loaded.config;
  if (kind === "store") { document.store.file = "changed.sqlite"; config = { ...config, store: document.store }; }
  if (kind === "exchange") { document.exchange.namespace = "changed"; config = { ...config, exchange: document.exchange }; }
  if (kind === "identity") document.identity.tunnelId = "tunnel_ijklmnop123456";
  const pair = publishMessagingGeneration(f.profilePath, config, document, { credentialFile: f.credentialFile }); f.select(pair.bindingPath);
  if (kind === "identity") fs.writeFileSync(f.profilePath, fs.readFileSync(f.profilePath, "utf8").replace("tunnel_abcdefgh123456", "tunnel_ijklmnop123456"));
  const current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(() => multi.intersectRegistration(f.loaded, current, "real-A")).toThrow();
  expect(() => multi.intersectMcpPolicy(f.loaded, current)).toThrow();
});
it("managed metadata is provenance-only, never a substitute for registration identity", async () => {
  const f = await fixture();
  const config = { ...f.loaded.config, managed: { tunnelId: "tunnel_ijklmnop123456", adapter: "pi" } };
  const pair = publishMessagingGeneration(f.profilePath, config, { ...f.loaded.manifest }, { credentialFile: f.credentialFile }); f.select(pair.bindingPath);
  expect(multi.intersectRegistration(f.loaded, multi.readSelectedMultiSessionPolicy(f.profilePath), "real-A")).toMatchObject({ endpointId: "pi/A" });
});
it("never opens credentials, even when an immutable binding is a hardlink alias", async () => {
  const f = await fixture(); fs.unlinkSync(f.loaded.bindingPath); fs.linkSync(f.credentialFile, f.loaded.bindingPath);
  const open = vi.spyOn(fs, "openSync"); const read = vi.spyOn(fs, "readSync");
  expect(() => multi.readSelectedMultiSessionPolicy(f.profilePath)).toThrow();
  expect(open.mock.calls.some(([path]) => path === f.credentialFile || path === f.loaded.bindingPath)).toBe(false);
  expect(read).toHaveBeenCalled(); // actual profile snapshot, not a mocked reader
});
it("refuses ambiguous legacy conversion without modifying the selected pointer", async () => {
  const f = await fixture();
  const config = { ...f.loaded.config }; delete config.admissionPolicy;
  const document = { exchangeNamespace: config.exchange.namespace, exchangeIdempotencyKey: config.exchange.idempotencyKey,
    leaseTtlSeconds: 120, payloadRead: { enabled: true }, ack: { enabled: true }, store: config.store,
    recipients: [config.endpoint], sessions: { "real-A": { endpointId: "pi/A" }, "ambiguous-runtime": { endpointId: "pi/A" } },
    managedBy: { kind: "ce-tunnel-messaging-v1", profilePath: f.profilePath } };
  const pair = publishMessagingGeneration(f.profilePath, config, document, { credentialFile: f.credentialFile }); f.select(pair.bindingPath);
  const before = fs.readFileSync(f.profilePath);
  await expect(f.api.convert({ expectedRevision: f.api.revision(), confirm: true })).rejects.toThrow();
  expect(fs.readFileSync(f.profilePath)).toEqual(before);
});
it("refuses a non-private temporary profile before activation", async () => {
  const f = await fixture(); const before = fs.readFileSync(f.profilePath);
  const api = multi.createMultiSessionRegistration({ profilePath: f.profilePath, manager: f.manager, io: {
    openSync: ((path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      const fd = fs.openSync(path, flags, mode);
      if (String(path).startsWith(`${f.profilePath}.`) && String(path).endsWith(".tmp")) fs.fchmodSync(fd, 0o640);
      return fd;
    }) as typeof fs.openSync,
  } });
  await expect(api.revoke({ expectedRevision: api.revision(), endpointId: "pi/A" })).rejects.toThrow();
  expect(fs.readFileSync(f.profilePath)).toEqual(before);
});
it("reports rename-effect uncertainty distinctly and retains the selected generation", async () => {
  const f = await fixture();
  const api = multi.createMultiSessionRegistration({ profilePath: f.profilePath, manager: f.manager, io: {
    renameSync: (from, to) => { fs.renameSync(from, to); throw Error("synthetic-after-effect"); },
  } });
  await expect(api.revoke({ expectedRevision: api.revision(), endpointId: "pi/A" })).rejects.toMatchObject({ field: "messaging.multiSession.commitUncertain" });
  expect(multi.readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations[0]?.status).toBe("revoked");
  expect(fs.existsSync(f.loaded.bindingPath)).toBe(true);
});
