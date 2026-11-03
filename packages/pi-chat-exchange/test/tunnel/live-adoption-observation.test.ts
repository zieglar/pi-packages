import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeLivePolicy, readLivePolicy } from "../../src/tunnel/live-session-policy.js";
import { createLiveAdoptionRecorder, readLiveAdoptionObservation } from "../../src/tunnel/live-adoption-observation.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-observation-"))); roots.push(root); fs.chmodSync(root, 0o700);
  const ref = initializeLivePolicy({ root, manifest: { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: root, file: "ce.sqlite" }, exchange: { namespace: "ce", idempotencyKey: "exchange" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "private-native", epoch: 1, status: "active", payloadRead: true, ack: true }] } });
  const current = readLivePolicy(ref);
  const identity = { pid: 12345, startedKey: "exact-process-start" };
  const launchDigest = "a".repeat(64);
  const now = () => "2026-11-03T00:00:00.000Z";
  const owner = { endpointId: "chatgpt/main", registered: true, participantId: "participant", sessionId: "session", exchangeId: "exchange", fencingToken: 1, lease: "ACTIVE" as const, leaseExpiresAt: "2026-11-03T00:10:00.000Z" };
  const options = { ref, launchDigest, identity, now };
  const read = (extra = {}) => readLiveAdoptionObservation({ ...options, current, targetEndpointId: "pi/A", owner, verifyBound: () => true, ...extra });
  return { root, current, owner, options, read };
}
it("writes a private minimal record and verifies exact run, launch, owner and target", () => {
  const f = fixture(); expect(f.read()).toEqual({ kind: "UNVERIFIED" });
  const recorder = createLiveAdoptionRecorder(f.options);
  recorder.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  expect(f.read()).toEqual({ kind: "OBSERVED" });
  const file = join(f.root, fs.readdirSync(f.root).find(name => name.startsWith(".live-observation-"))!);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const bytes = fs.readFileSync(file, "utf8");
  expect(bytes).not.toContain("private-native"); expect(bytes).not.toContain("presenceDisclosure");
  expect(f.read({ launchDigest: "b".repeat(64) })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ identity: { ...f.options.identity, startedKey: "different" } })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ owner: { ...f.owner, sessionId: "another" } })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ owner: { ...f.owner, lease: "EXPIRED" } })).toEqual({ kind: "BLOCKED" });
  expect(f.read({ now: () => "2026-11-03T00:00:06.000Z" })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ now: () => "2026-11-02T23:59:59.000Z" })).toEqual({ kind: "UNVERIFIED" });
});
it("never trusts a stale ACTIVE file without a fresh bound verification after terminal write failure", () => {
  const f = fixture(); let broken = false;
  const recorder = createLiveAdoptionRecorder({ ...f.options, now: () => broken ? "invalid" : f.options.now() });
  recorder.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  broken = true;
  expect(() => recorder.record(f.current, f.owner, { state: "WRITE_BLOCKED", renewal: "STOPPED" })).toThrow();
  expect(f.read({ verifyBound: undefined })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ verifyBound: () => false })).toEqual({ kind: "UNVERIFIED" });
});
it("records CLOSED after ownership has been dropped", () => {
  const f = fixture();
  createLiveAdoptionRecorder(f.options).record(f.current, { ...f.owner, registered: false, participantId: undefined, sessionId: undefined, exchangeId: undefined, fencingToken: undefined, lease: "ABSENT", leaseExpiresAt: undefined }, { state: "CLOSED", renewal: "STOPPED" });
  expect(f.read()).toEqual({ kind: "BLOCKED" });
});
it("terminal writes supersede ACTIVE and cannot revive", () => {
  const f = fixture(); const recorder = createLiveAdoptionRecorder(f.options);
  recorder.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  recorder.record(f.current, f.owner, { state: "WRITE_BLOCKED", renewal: "STOPPED" });
  expect(f.read()).toEqual({ kind: "BLOCKED" });
  expect(() => recorder.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" })).toThrow();
  expect(f.read()).toEqual({ kind: "BLOCKED" });
});
it("allows a successor with unchanged target generations but refuses changed or revoked target", () => {
  const f = fixture(); createLiveAdoptionRecorder(f.options).record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  const successor = { ...f.current, sequence: 1, digest: "b".repeat(64) };
  expect(f.read({ current: successor })).toEqual({ kind: "OBSERVED" });
  expect(f.read({ current: { ...f.current, digest: "b".repeat(64) } })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ current: { ...successor, manifest: { ...successor.manifest, registrations: successor.manifest.registrations.map(r => ({ ...r, ackGeneration: 1 })) } } })).toEqual({ kind: "UNVERIFIED" });
  expect(f.read({ targetEndpointId: "pi/absent" })).toEqual({ kind: "UNVERIFIED" });
});
it("allows only forward terminal transitions and fails closed after a write failure", () => {
  const f = fixture(); const recorder = createLiveAdoptionRecorder({ ...f.options, now: () => "not-an-instant" });
  expect(() => recorder.record(f.current, f.owner, { state: "CLOSING", renewal: "STOPPED" })).toThrow();
  expect(f.read()).toEqual({ kind: "UNVERIFIED" });
  expect(() => recorder.record(f.current, f.owner, { state: "CLOSED", renewal: "STOPPED" })).toThrow();
  const healthy = createLiveAdoptionRecorder(f.options);
  healthy.record(f.current, f.owner, { state: "CLOSING", renewal: "STOPPED" });
  healthy.record(f.current, f.owner, { state: "CLOSED", renewal: "STOPPED" });
  expect(f.read()).toEqual({ kind: "BLOCKED" });
});
it("refuses symlink and credential aliases without successful observation", () => {
  const f = fixture(); const recorder = createLiveAdoptionRecorder(f.options);
  recorder.record(f.current, f.owner, { state: "ACTIVE", renewal: "RUNNING" });
  const file = join(f.root, fs.readdirSync(f.root).find(name => name.startsWith(".live-observation-"))!);
  const credentialFile = join(f.root, "credential"); fs.renameSync(file, credentialFile); fs.symlinkSync(credentialFile, file);
  expect(f.read()).toEqual({ kind: "UNVERIFIED" });
  expect(() => recorder.record(f.current, f.owner, { state: "CLOSED", renewal: "STOPPED" })).toThrow();
});
