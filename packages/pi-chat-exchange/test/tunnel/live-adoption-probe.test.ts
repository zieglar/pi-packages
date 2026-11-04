import fs from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { initializeLivePolicy, readLivePolicy, prepareLivePolicyUpgrade, createLivePolicyRegistration } from "../../src/tunnel/live-session-policy.js";
import { createLiveAdoptionRecorder } from "../../src/tunnel/live-adoption-observation.js";
import { startLiveAdoptionProbe, queryLiveAdoptionProbe } from "../../src/tunnel/live-adoption-probe.js";
const roots: string[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
function probePath(options: ReturnType<typeof fixture>["options"]) {
  const { ref, identity, launchDigest } = options;
  return join(fs.realpathSync("/tmp"), `ce-probe-${process.geteuid!()}`, createHash("sha256").update(JSON.stringify([ref.root, ref.policyId, ref.genesisDigest, identity.pid, identity.startedKey, launchDigest])).digest("hex").slice(0, 40) + ".sock");
}
function fixture(v2 = false) {
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/cep-")); roots.push(base); fs.chmodSync(base, 0o700);
  const root = join(base, "deep-profile-".repeat(12)); fs.mkdirSync(root, { mode: 0o700 });
  const original = initializeLivePolicy({ root, manifest: { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: root, file: "ce.sqlite" }, exchange: { namespace: "ce", idempotencyKey: "exchange" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-private", epoch: 1, status: "active", payloadRead: true, ack: true }] } });
  const ref = v2 ? prepareLivePolicyUpgrade(original, join(base, "tunnel.yaml")) : original;
  if (v2) createLivePolicyRegistration({ ref }).upgrade({ expectedDigest: readLivePolicy(original).digest, actorRuntimeSessionId: "operator", profileRevision: "b".repeat(64), bindingGeneration: "c".repeat(64) });
  const current = readLivePolicy(ref);
  const owner = { endpointId: "chatgpt/main", registered: true, participantId: "participant", sessionId: "session", exchangeId: "exchange", fencingToken: 1, lease: "ACTIVE", leaseExpiresAt: new Date(Date.now() + 60000).toISOString() };
  const identity = { pid: process.pid, startedKey: "exact-start" };
  const options = { ref, launchDigest: "a".repeat(64), identity };
  const query = (extra = {}) => queryLiveAdoptionProbe({ ...options, current, owner, targetEndpointId: "pi/A", ...extra });
  return { root, current, owner, options, query };
}
it("query never creates its directory and refuses insecure or symlink directories", async () => {
  const f = fixture();
  const base = fs.realpathSync(fs.mkdtempSync("/tmp/ce-probe-location-")); roots.push(base); fs.chmodSync(base, 0o700);
  const selected = join(base, `ce-probe-${process.geteuid!()}`);
  // Redirect only this test's /tmp lookup; never chmod or replace the real
  // shared per-UID directory, which may contain another process's sockets.
  const realpath = fs.realpathSync.bind(fs);
  const spy = vi.spyOn(fs, "realpathSync").mockImplementation((path, options) => path === "/tmp" ? base : realpath(path, options));
  try {
    expect(await f.query()).toEqual({ kind: "UNVERIFIED" }); expect(fs.existsSync(selected)).toBe(false);
    fs.mkdirSync(selected, { mode: 0o755 });
    await expect(startLiveAdoptionProbe({ ...f.options, observe: () => { throw Error("unused"); } })).rejects.toThrow();
    fs.rmdirSync(selected); fs.symlinkSync(f.root, selected);
    expect(await f.query()).toEqual({ kind: "UNVERIFIED" });
    await expect(startLiveAdoptionProbe({ ...f.options, observe: () => { throw Error("unused"); } })).rejects.toThrow();
  } finally { spy.mockRestore(); }
});
it.each([false, true])("queries current synchronous bound state even when an older diagnostic remains ACTIVE (v2=%s)", async v2 => {
  const f = fixture(v2); let blocked = false;
  expect(await f.query()).toEqual({ kind: "UNVERIFIED" });
  const server = await startLiveAdoptionProbe({ ...f.options, observe: () => ({ snapshot: f.current, owner: f.owner, bound: { state: blocked ? "WRITE_BLOCKED" : "ACTIVE", renewal: blocked ? "STOPPED" : "RUNNING" } }) }); servers.push(server);
  expect(await f.query()).toEqual({ kind: "OBSERVED" });
  const diagnostic = createLiveAdoptionRecorder(f.options);
  diagnostic.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  blocked = true;
  const failing = createLiveAdoptionRecorder({ ...f.options, now: () => "invalid" });
  expect(() => failing.record(f.current, f.owner, { state: "WRITE_BLOCKED", renewal: "STOPPED" })).toThrow();
  expect(await f.query()).toEqual({ kind: "BLOCKED" });
  expect(await f.query({ identity: { ...f.options.identity, startedKey: "foreign" } })).toEqual({ kind: "UNVERIFIED" });
  expect(await f.query({ launchDigest: "b".repeat(64) })).toEqual({ kind: "UNVERIFIED" });
  await server.close(); expect(await f.query()).toEqual({ kind: "UNVERIFIED" });
});
it("refuses changed target generations, expired Owner and malformed requests", async () => {
  const f = fixture(); let calls = 0;
  servers.push(await startLiveAdoptionProbe({ ...f.options, observe: () => { calls++; return { snapshot: f.current, owner: f.owner, bound: { state: "ACTIVE", renewal: "RUNNING" } }; } }));
  expect(await f.query({ owner: { ...f.owner, lease: "EXPIRED" } })).toEqual({ kind: "BLOCKED" });
  const changed = { ...f.current, sequence: 1, digest: "b".repeat(64), manifest: { ...f.current.manifest, registrations: f.current.manifest.registrations.map(r => ({ ...r, ackGeneration: 1 })) } };
  expect(await f.query({ current: changed })).toEqual({ kind: "UNVERIFIED" });
  const path = probePath(f.options);
  const before = calls;
  await new Promise<void>((resolve, reject) => { const socket = net.connect(path); socket.on("connect", () => socket.end('{"kind":"ce-live-probe-v1","nonce":"bad","extra":true}\n')); socket.on("close", () => resolve()); socket.on("error", reject); });
  expect(calls).toBe(before);
  expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});
it("rejects a replayed response nonce without trusting its operational claims", async () => {
  const f = fixture();
  const first = await startLiveAdoptionProbe({ ...f.options, observe: () => ({ snapshot: f.current, owner: f.owner, bound: { state: "ACTIVE", renewal: "RUNNING" } }) });
  const path = probePath(f.options);
  await first.close();
  const fake = net.createServer(socket => { socket.on("error", () => {}); socket.on("data", () => socket.end(JSON.stringify({ nonce: "0".repeat(64), launchDigest: f.options.launchDigest, identity: f.options.identity, ref: f.options.ref, policy: { sequence: 0, digest: f.current.digest, targets: [] }, owner: f.owner, bound: { state: "ACTIVE", renewal: "RUNNING" }, observedAt: new Date().toISOString() }) + "\n")); });
  await new Promise<void>(resolve => fake.listen(path, resolve)); fs.chmodSync(path, 0o600);
  try { expect(await f.query()).toEqual({ kind: "UNVERIFIED" }); } finally { await new Promise<void>(resolve => fake.close(() => resolve())); }
});
it("does not replace an existing socket or unlink a substituted path on close", async () => {
  const f = fixture(); const first = await startLiveAdoptionProbe({ ...f.options, observe: () => ({ snapshot: f.current, owner: f.owner, bound: { state: "ACTIVE", renewal: "RUNNING" } }) }); servers.push(first);
  await expect(startLiveAdoptionProbe({ ...f.options, observe: () => { throw Error("unused"); } })).rejects.toThrow();
  const path = probePath(f.options);
  const moved = `${path}.moved`; fs.renameSync(path, moved); fs.writeFileSync(path, "substitute", { mode: 0o600 });
  await first.close(); expect(fs.readFileSync(path, "utf8")).toBe("substitute");
  fs.unlinkSync(path); fs.unlinkSync(moved);
});
