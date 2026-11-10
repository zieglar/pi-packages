import fs from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration } from "../../dist/tunnel/live-session-policy.js";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture(withHooks = false) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-live-policy-"))); dirs.push(root); fs.chmodSync(root, 0o700);
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: root, file: "ce.sqlite" },
    exchange: { namespace: "ce", idempotencyKey: "exchange" }, chatgptEndpoint: { adapter: "chatgpt" as const, endpointId: "chatgpt/main" },
    mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "A", epoch: 1, status: "active" as const, payloadRead: true, ack: true, ...(withHooks ? { hooks: [{ id: "retained", event: "ce.message.committed.v1" as const, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: false }] } : {}) }] };
  const ref = initializeLivePolicy({ root, manifest }); return { root, ref, api: createLivePolicyRegistration({ ref }) };
}
it("refuses missing committed locator rather than guessing recovery", () => {
  const { root, ref, api } = fixture();
  api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B });
  for (const name of fs.readdirSync(root).filter(n => n.startsWith(".live-intent-"))) fs.unlinkSync(join(root, name));
  expect(() => api.reconcile({ runtimeSessionId: "B" })).toThrow();
});
it("does not link a policy before locator directory fsync succeeds", () => {
  const { root, ref } = fixture();
  const api = createLivePolicyRegistration({ ref, io: { fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory()) throw Error("injected"); fs.fsyncSync(fd); } } });
  expect(() => api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B })).toThrow();
  expect(fs.existsSync(join(root, "000001.json"))).toBe(false);
  expect(api.reconcile({ runtimeSessionId: "B" })[0]?.outcome).toBe("NOT_OBSERVED");
});
it("reports postlink fsync uncertainty and reconciles without repeating publication", () => {
  const { ref } = fixture(); let linked = false;
  const api = createLivePolicyRegistration({ ref, io: {
    linkSync(a, b) { fs.linkSync(a, b); if (String(b).endsWith("000001.json")) linked = true; },
    fsyncSync(fd) { if (linked && fs.fstatSync(fd).isDirectory()) throw Error("injected"); fs.fsyncSync(fd); },
  } });
  const result = api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B });
  expect(result.durability).toBe("uncertain");
  expect(api.reconcile({ runtimeSessionId: "B" })[0]?.outcome).toBe("PUBLISHED");
});
it("validates a contiguous append between absent read and enumeration", () => {
  const { ref, api } = fixture(); const a = readLivePolicy(ref); let once = false;
  const b = readLivePolicy(ref, { seam: { afterMissingSlot() { if (!once) { once = true; api.register({ expectedDigest: a.digest, registration: B }); } } } });
  expect(b.sequence).toBe(1);
  expect(() => api.register({ expectedDigest: a.digest, registration: { ...B, endpointId: "pi/C", runtimeSessionId: "C" } })).toThrow();
});
it("retains integrity failure for a real chain hole", () => {
  const { root, ref, api } = fixture();
  const b = api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B });
  api.revoke({ expectedDigest: b.snapshot.digest, endpointId: "pi/A" });
  fs.unlinkSync(join(root, "000001.json")); expect(() => readLivePolicy(ref)).toThrow();
});
it("reconciles link-success-then-throw after an unrelated later commit", () => {
  const { ref } = fixture();
  const api = createLivePolicyRegistration({ ref, io: { linkSync(a, b) { fs.linkSync(a, b); if (String(b).endsWith("000001.json")) throw Error("lost response"); } } });
  expect(() => api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B, operationId: "lost-response" })).toThrow();
  const fresh = createLivePolicyRegistration({ ref }); fresh.revoke({ expectedDigest: readLivePolicy(ref).digest, endpointId: "pi/A" });
  expect(fresh.reconcile({ runtimeSessionId: "B" })[0]).toMatchObject({ outcome: "PUBLISHED", operationId: "lost-response", sequence: 1 });
});
it.each(["generation", "identity", "hooks", "unknown"])("rejects forged %s even with recomputed envelope digests", kind => {
  const { root, ref, api } = fixture(); api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B });
  const path = join(root, "000001.json"); const e = JSON.parse(fs.readFileSync(path, "utf8"));
  if (kind === "generation") e.manifest.registrations[1].ackGeneration = 0;
  if (kind === "identity") e.manifest.exchange.namespace = "foreign";
  if (kind === "hooks") e.manifest.registrations[0].hooks = [];
  if (kind === "unknown") e.extra = true;
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  e.manifestDigest = hash(e.manifest); const { registrations: _, ...fixed } = e.manifest; e.identityDigest = hash(fixed);
  fs.writeFileSync(path, JSON.stringify(e)); expect(() => readLivePolicy(ref)).toThrow();
});
it.each(["symlink", "hardlink"])("excludes credential %s aliases before content reads", kind => {
  const { root, ref } = fixture(); const credential = join(root, "credential"); const path = join(root, "000000.json");
  fs.renameSync(path, credential); if (kind === "symlink") fs.symlinkSync(credential, path); else fs.linkSync(credential, path);
  const spy = vi.spyOn(fs, "readSync");
  try { expect(() => readLivePolicy(ref, { credentialFile: credential })).toThrow(); expect(spy).not.toHaveBeenCalled(); } finally { spy.mockRestore(); }
});
it("rejects broad root modes and root symlink aliases", () => {
  const { root, ref } = fixture(); fs.chmodSync(root, 0o755); expect(() => readLivePolicy(ref)).toThrow(); fs.chmodSync(root, 0o700);
  const alias = join(root, "alias"); fs.symlinkSync(root, alias); expect(() => readLivePolicy({ ...ref, root: alias })).toThrow();
});
it("allows exactly 128 registrations and refuses overflow without publication", () => {
  const { root, ref } = fixture(); const base = readLivePolicy(ref).manifest;
  const other = join(root, "bounded"); fs.mkdirSync(other, { mode: 0o700 });
  const registrations = Array.from({ length: 128 }, (_, i) => ({ endpointId: `pi/${i}`, runtimeSessionId: `s${i}`, epoch: 1, status: "active" as const, payloadRead: false, ack: false }));
  const bounded = initializeLivePolicy({ root: other, manifest: { ...base, registrations } });
  expect(readLivePolicy(bounded).manifest.registrations).toHaveLength(128);
  expect(() => createLivePolicyRegistration({ ref: bounded }).register({ expectedDigest: readLivePolicy(bounded).digest, registration: B })).toThrow();
  expect(fs.existsSync(join(other, "000001.json"))).toBe(false);
});
it("refuses an oversized genesis envelope before linking it", () => {
  const { root, ref } = fixture(); const base = readLivePolicy(ref).manifest;
  const other = join(root, "oversized"); fs.mkdirSync(other, { mode: 0o700 });
  const registrations = Array.from({ length: 128 }, (_, i) => ({ endpointId: `pi/${i}/${"e".repeat(240)}`, runtimeSessionId: `s${i}/${"s".repeat(240)}`, epoch: 1, status: "active" as const, payloadRead: false, ack: false }));
  expect(() => initializeLivePolicy({ root: other, manifest: { ...base, registrations } })).toThrow();
  expect(fs.existsSync(join(other, "000000.json"))).toBe(false);
});
it.runIf(process.platform === "darwin")("rejects a private root with a Darwin allow ACL", () => {
  const { root, ref } = fixture();
  execFileSync("/bin/chmod", ["+a", `user:${userInfo().username} allow read,write,execute`, root]);
  try { expect(() => readLivePolicy(ref)).toThrow(); } finally { execFileSync("/bin/chmod", ["-N", root]); }
});
it("real Node24 writers sharing a parent elect one winner without rebase", async () => {
  const { ref } = fixture(); const expectedDigest = readLivePolicy(ref).digest;
  const module = new URL("../../dist/tunnel/live-session-policy.js", import.meta.url).href;
  const code = `import {createLivePolicyRegistration} from ${JSON.stringify(module)}; const input=JSON.parse(process.argv[1]); process.stdout.write('READY\\n'); process.stdin.once('data',()=>{try{const r=createLivePolicyRegistration({ref:input.ref}).register({expectedDigest:input.expectedDigest,registration:input.registration}); console.log(JSON.stringify({ok:true,seq:r.snapshot.sequence}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}});`;
  const children = ["B", "C"].map(id => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ ref, expectedDigest, registration: { ...B, endpointId: `pi/${id}`, runtimeSessionId: id } })], { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let errors = "";
    child.stderr.on("data", b => { errors += b; });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", status => reject(Error(`writer exited before READY (${status}): ${errors}`)));
      child.stdout.on("data", b => { output += b; if (output.includes("READY")) resolve(); });
    });
    const done = new Promise<{ ok: boolean; seq?: number; code?: string }>((resolve, reject) => { child.on("error", reject); child.on("exit", status => { if (status !== 0) reject(Error(errors)); else { try { resolve(JSON.parse(output.trim().split("\n").at(-1)!)); } catch (e) { reject(e); } } }); });
    // Observe startup failures even while the test is awaiting both READY signals.
    void done.catch(() => {});
    return { child, ready, done };
  });
  try {
    await Promise.all(children.map(c => c.ready)); children.forEach(c => c.child.stdin.end("go"));
    const results = await Promise.all(children.map(c => c.done)); expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.find(r => !r.ok)?.code).toBe("CE_TUNNEL_CONFIG_CONFLICT");
    expect(readLivePolicy(ref).sequence).toBe(1); expect(readLivePolicy(ref).manifest.registrations).toHaveLength(2);
  } finally { children.forEach(c => c.child.kill()); }
}, 20000);
const B = { endpointId: "pi/B", runtimeSessionId: "B", payloadRead: false, ack: true, presenceDisclosure: false };
it("publishes full snapshots, preserves A and refuses stale consent and tombstone revival", () => {
  const { ref, api } = fixture(); const a = readLivePolicy(ref);
  const b = api.register({ expectedDigest: a.digest, registration: B });
  expect(b.durability).toBe("synced"); expect(b.snapshot.sequence).toBe(1);
  expect(b.snapshot.manifest.registrations[0]).toEqual(a.manifest.registrations[0]);
  expect(b.snapshot.manifest.registrations[1]).toMatchObject({ payloadReadGeneration: 1, ackGeneration: 1 });
  expect(() => api.register({ expectedDigest: a.digest, registration: B })).toThrow();
  const c = api.revoke({ expectedDigest: b.snapshot.digest, endpointId: B.endpointId });
  expect(() => api.register({ expectedDigest: c.snapshot.digest, registration: B })).toThrow();
});
it("stamps each bit transition independently, including true false true", () => {
  const { ref, api } = fixture(); const a = readLivePolicy(ref);
  const registration = { endpointId: "pi/A", runtimeSessionId: "A", payloadRead: false, ack: true, presenceDisclosure: false };
  const b = api.register({ expectedDigest: a.digest, registration }).snapshot;
  const c = api.register({ expectedDigest: b.digest, registration: { ...registration, payloadRead: true } }).snapshot;
  expect(c.manifest.registrations[0]).toMatchObject({ payloadReadGeneration: 2, ackGeneration: 0, epoch: 1 });
});
it("detects suffix rollback with reader watermark and refuses holes", () => {
  const { root, ref, api } = fixture(); const watermark = {};
  const a = readLivePolicy(ref, { watermark }); api.register({ expectedDigest: a.digest, registration: B });
  readLivePolicy(ref, { watermark }); fs.unlinkSync(join(root, "000001.json"));
  expect(() => readLivePolicy(ref, { watermark })).toThrow();
});
it("reconciles exact operation after later publications without writes", () => {
  const { root, ref, api } = fixture(); const a = readLivePolicy(ref);
  const b = api.register({ expectedDigest: a.digest, registration: B, operationId: "operation-B" });
  api.revoke({ expectedDigest: b.snapshot.digest, endpointId: "pi/A" });
  const before = fs.readdirSync(root);
  expect(api.reconcile({ runtimeSessionId: "B" })[0]).toMatchObject({ outcome: "PUBLISHED", operationId: "operation-B" });
  expect(fs.readdirSync(root)).toEqual(before);
});
it("explicit reauthorization alone restores exact tombstone at a fresh epoch and generations", () => {
  const { root, ref, api } = fixture(true);
  const loaded = readLivePolicy(ref);
  const tombstone = api.revoke({ expectedDigest: loaded.digest, endpointId: "pi/A" }).snapshot;
  const registration = { endpointId: "pi/A", runtimeSessionId: "A", payloadRead: true, ack: true, presenceDisclosure: true };
  expect(() => api.register({ expectedDigest: tombstone.digest, registration })).toThrow();
  const unchanged = fs.readdirSync(root);
  for (const candidate of [{ ...registration, runtimeSessionId: "wrong" }, { ...registration, endpointId: "pi/missing" }]) {
    expect(() => api.reauthorize({ expectedDigest: tombstone.digest, registration: candidate })).toThrow();
  }
  expect(fs.readdirSync(root)).toEqual(unchanged);
  const restored = api.reauthorize({ expectedDigest: tombstone.digest, registration }).snapshot;
  expect(restored.manifest.registrations[0]).toMatchObject({ epoch: 2, status: "active", payloadReadGeneration: 2, ackGeneration: 2 });
  expect(loaded.manifest.registrations[0]!.epoch).not.toBe(restored.manifest.registrations[0]!.epoch);
  expect(restored.manifest.registrations[0]!.hooks).toEqual(loaded.manifest.registrations[0]!.hooks);
  expect(JSON.stringify(restored.manifest.registrations[0]!.hooks)).toBe(JSON.stringify(loaded.manifest.registrations[0]!.hooks));
  expect(readLivePolicy(ref)).toEqual(restored);
  const before = fs.readdirSync(root);
  for (const candidate of [registration, { ...registration, endpointId: "pi/missing" }, { ...registration, runtimeSessionId: "wrong" }]) {
    expect(() => api.reauthorize({ expectedDigest: restored.digest, registration: candidate })).toThrow();
  }
  expect(fs.readdirSync(root)).toEqual(before);
});
it("reauthorization lost response reconciles exact operation after unrelated successor", () => {
  const { ref, api } = fixture();
  const added = api.register({ expectedDigest: readLivePolicy(ref).digest, registration: B }).snapshot;
  const revoked = api.revoke({ expectedDigest: added.digest, endpointId: "pi/B" }).snapshot;
  const uncertain = createLivePolicyRegistration({ ref, io: { linkSync(a, b) { fs.linkSync(a, b); if (String(b).endsWith("000003.json")) throw Error("lost response"); } } });
  expect(() => uncertain.reauthorize({ expectedDigest: revoked.digest, registration: B, operationId: "restore-B" })).toThrow();
  const restored = readLivePolicy(ref);
  expect(restored.manifest.registrations[1]).toMatchObject({ epoch: 2, payloadRead: false, payloadReadGeneration: 3, ackGeneration: 3 });
  api.revoke({ expectedDigest: restored.digest, endpointId: "pi/A" });
  expect(api.reconcile({ runtimeSessionId: "B" })).toContainEqual({ operationId: "restore-B", sequence: 3, outcome: "PUBLISHED" });
});
