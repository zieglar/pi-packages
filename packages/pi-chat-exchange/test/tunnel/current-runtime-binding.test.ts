import fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration } from "../../src/tunnel/live-session-policy.js";
import { createCurrentRuntimeObserver, discoverCurrentRuntimes, CURRENT_RUNTIME_TTL_MS } from "../../src/tunnel/current-runtime-binding.js";

afterEach(cleanupFixtures);
function setup() {
  const f = fixture("current-runtime-");
  const root = join(f.directory, "policy"); fs.mkdirSync(root, { mode: 0o700 });
  const ref = initializeLivePolicy({ root, manifest: { kind: "ce-multi-session-v1", version: 1,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: f.directory, file: f.filename },
    exchange: { namespace: "current", idempotencyKey: "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    mcp: { payloadRead: true, ack: true }, registrations: [{ runtimeSessionId: "seed", endpointId: "pi/seed", epoch: 1, status: "revoked", payloadRead: false, ack: false }] } });
  let now = Date.now(); const clock = () => now;
  const api = createLivePolicyRegistration({ ref });
  const register = (sessionId: string, endpointId: string, presenceDisclosure = true) => api.register({ expectedDigest: readLivePolicy(ref).digest,
    registration: { runtimeSessionId: sessionId, endpointId, payloadRead: false, ack: false, presenceDisclosure } });
  register("A", "pi/A"); register("B", "pi/B");
  const observer = (runtimeId = "runtime-one") => createCurrentRuntimeObserver(ref, runtimeId, clock);
  const query = (runtimeId?: string, visible = ["pi/A", "pi/B", "pi/C"]) => discoverCurrentRuntimes(readLivePolicy(ref), visible, runtimeId, now);
  return { ...f, ref, api, observer, query, register, advance: (ms: number) => { now += ms; } };
}

it("uses an explicit Runtime and follows new/resume without guessing a global current", () => {
  const f = setup(), a = f.observer();
  expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  expect(a.observe("A")).toBe(true);
  expect(f.query()).toEqual({ runtimes: [{ runtimeId: "runtime-one" }] });
  expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", runtimeId: "runtime-one", endpointId: "pi/A", source: "pi.runtime.lifecycle" });
  a.stop(); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  a.observe("B"); expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/B" });
  a.observe("A"); expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/A" });
});

it("does not inherit authorization, presence, or Task Ownership from lifecycle evidence", () => {
  const f = setup(), a = f.observer(); a.observe("C");
  const before = readLivePolicy(f.ref), changes = f.store.database.prepare("SELECT total_changes() AS n").get();
  expect(f.query("runtime-one")).toEqual({ runtimes: [], currentBinding: { status: "unknown", runtimeId: "runtime-one" } });
  expect(readLivePolicy(f.ref)).toEqual(before); expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  f.register("C", "pi/C", false); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  f.register("C", "pi/C", true); expect(f.query("runtime-one", ["pi/A"]).currentBinding?.status).toBe("unknown");
  expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/C" });
  f.api.revoke({ expectedDigest: readLivePolicy(f.ref).digest, endpointId: "pi/C" });
  expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
});

it("keeps two Runtimes separate and rejects competing same-scope witnesses", () => {
  const f = setup(), a = f.observer(), b = f.observer("runtime-two"); a.observe("A"); b.observe("B");
  expect(f.query().runtimes).toEqual([{ runtimeId: "runtime-one" }, { runtimeId: "runtime-two" }]);
  expect(f.query("runtime-two").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/B" });
  const collision = f.observer(); collision.observe("B");
  expect(f.query("runtime-one").currentBinding).toEqual({ status: "ambiguous", runtimeId: "runtime-one" });
  expect(f.query("runtime-one", ["pi/A"]).currentBinding?.status).toBe("unknown");
  collision.stop(); expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/A" });
});

it("does not select a valid claim over a future or invalid-lease competitor", () => {
  const f = setup(), a = f.observer(); a.observe("A");
  const root = join(f.ref.root, "current-runtimes"), first = fs.readdirSync(root)[0]!;
  const value = JSON.parse(fs.readFileSync(join(root, first), "utf8"));
  value.observerId = "11111111-1111-4111-8111-111111111111"; value.observedAt += 10000; value.expiresAt += 10000;
  const competitor = join(root, value.observerId + ".json"); fs.writeFileSync(competitor, JSON.stringify(value), {mode: 0o600});
  expect(f.query("runtime-one")).toEqual({runtimes: [], currentBinding: {status: "unknown", runtimeId: "runtime-one"}});
  value.observedAt -= 10000; value.expiresAt -= 9000; fs.writeFileSync(competitor, JSON.stringify(value));
  expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
});


it("expires a crashed observer, rejects future observations, and never falls back to registration", () => {
  const f = setup(), a = f.observer(); a.observe("A");
  f.advance(CURRENT_RUNTIME_TTL_MS + 1); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  a.observe("A"); f.advance(-100); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
});

it("holds the single-threaded write order if a publication blocks and stop follows", () => {
  const f = setup(), a = f.observer(); const write = fs.writeFileSync;
  const hold = new Int32Array(new SharedArrayBuffer(4));
  const refresh = () => { fs.writeFileSync = ((...args: Parameters<typeof write>) => { Atomics.wait(hold, 0, 0, 32); return write(...args); }) as typeof write; try { return a.observe("A"); } finally { fs.writeFileSync = write; } };
  expect(refresh()).toBe(true); a.stop(); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
});


it("uses only synchronous writes so an asynchronous callback cannot overtake stop", () => {
  const f = setup(), a = f.observer(); const asyncNames = ["writeFile", "rename", "open", "close", "unlink"] as const;
  const originals = new Map(asyncNames.map(name => [name, fs[name] as unknown]));
  for (const name of asyncNames) (fs as unknown as Record<string, unknown>)[name] = () => { throw Error("asynchronous filesystem call forbidden in this lifecycle observer"); };
  try { a.observe("A"); a.stop(); a.observe("A"); } finally { for (const [name, value] of originals) (fs as unknown as Record<string, unknown>)[name] = value; }
  expect(f.query("runtime-one").currentBinding).toMatchObject({ status: "verified", endpointId: "pi/A" });
});

it("fails closed on inaccessible evidence and bounds a failed stop publication", () => {
  const f = setup(), a = f.observer(); a.observe("A");
  const rename = fs.renameSync; fs.renameSync = () => { throw Error("injected publish refusal"); };
  try { expect(a.stop()).toBe(false); } finally { fs.renameSync = rename; }
  expect(f.query("runtime-one").currentBinding?.status).toBe("verified");
  f.advance(CURRENT_RUNTIME_TTL_MS + 1); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  a.observe("A"); fs.chmodSync(join(f.ref.root, "current-runtimes"), 0o755);
  expect(f.query("runtime-one")).toEqual({ runtimes: [], currentBinding: { status: "unknown", runtimeId: "runtime-one" } });
});


it("fails closed on malformed, unsafe or foreign policy evidence", () => {
  const f = setup(), a = f.observer(); a.observe("A");
  const directory = join(f.ref.root, "current-runtimes");
  const record = fs.readdirSync(directory).find(n => n.endsWith(".json"))!;
  const path = join(directory, record), original = fs.readFileSync(path);
  fs.writeFileSync(path, "{bad", { mode: 0o600 }); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  fs.writeFileSync(path, original); fs.chmodSync(path, 0o644); expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
  fs.chmodSync(path, 0o600); const value = JSON.parse(original.toString()); value.genesisDigest = "0".repeat(64); fs.writeFileSync(path, JSON.stringify(value));
  expect(f.query("runtime-one").currentBinding?.status).toBe("unknown");
});
