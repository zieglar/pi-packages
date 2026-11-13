import fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration } from "../../src/tunnel/live-session-policy.js";
import { observeSessionDeparture, observeSessionArrival, discoverSessionSwitch } from "../../src/tunnel/session-switch-observation.js";

// These records only observe lifecycle. Registration remains an independent act.
afterEach(cleanupFixtures);
function setup() {
  const f = fixture("session-switch-");
  const root = join(f.directory, "policy");
  fs.mkdirSync(root, { mode: 0o700 });
  const ref = initializeLivePolicy({ root, manifest: {
    kind: "ce-multi-session-v1", version: 1,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store: { directory: f.directory, file: f.filename }, exchange: { namespace: "switch", idempotencyKey: "test" },
    chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true },
    registrations: [{ runtimeSessionId: "seed", endpointId: "pi/seed", epoch: 1, status: "revoked", payloadRead: false, ack: false }],
  } });
  const api = createLivePolicyRegistration({ ref });
  api.register({ expectedDigest: readLivePolicy(ref).digest, registration: { runtimeSessionId: "native-A", endpointId: "pi/A", payloadRead: true, ack: true, presenceDisclosure: true } });
  const departure = { runtimeSessionId: "native-A", endpointId: "pi/A", epoch: 1, sessionFile: join(f.directory, "old.jsonl"), targetSessionFile: join(f.directory, "new.jsonl") };
  const arrival = { runtimeSessionId: "native-B", previousSessionFile: departure.sessionFile, sessionFile: departure.targetSessionFile };
  const snapshot = () => readLivePolicy(ref);
  const register = (runtimeSessionId = "native-B", endpointId = "pi/B", presenceDisclosure = true) => api.register({ expectedDigest: snapshot().digest, registration: { runtimeSessionId, endpointId, payloadRead: false, ack: false, presenceDisclosure } });
  const query = (visible = ["pi/A", "pi/B"], previous = "pi/A") => discoverSessionSwitch(snapshot(), previous, visible);
  return { ...f, ref, api, departure, arrival, snapshot, register, query };
}

it("requires both reciprocal /new observations and independent successor authorization", () => {
  const f = setup();
  const before = f.snapshot();
  const writes = f.store.database.prepare("SELECT total_changes() AS n").get();
  expect(f.query()).toEqual({ status: "unknown", previousEndpointId: "pi/A" });
  expect(observeSessionDeparture(f.ref, f.departure)).toBe(true);
  expect(f.query()).toEqual({ status: "unknown", previousEndpointId: "pi/A" });
  expect(observeSessionArrival(f.ref, f.arrival)).toBe(true);
  expect(f.query()).toEqual({ status: "unknown", previousEndpointId: "pi/A" });
  expect(f.snapshot()).toEqual(before);
  expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(writes);
  f.register();
  expect(f.query()).toMatchObject({ status: "verified", previousEndpointId: "pi/A", successorEndpointId: "pi/B", source: "pi.new.lifecycle" });
  const result = f.query();
  if (result.status !== "verified") throw new Error("expected verified relationship");
  expect(result.observedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  expect(f.snapshot().manifest.registrations.find(r => r.endpointId === "pi/B")).toMatchObject({ payloadRead: false, ack: false });
});

it("does not guess continuity from recent registrations or unrelated file paths", () => {
  const f = setup();
  f.register();
  expect(observeSessionArrival(f.ref, f.arrival)).toBe(false);
  expect(f.query().status).toBe("unknown");
  expect(observeSessionDeparture(f.ref, f.departure)).toBe(true);
  expect(observeSessionArrival(f.ref, { ...f.arrival, previousSessionFile: join(f.directory, "other.jsonl") })).toBe(false);
  expect(observeSessionArrival(f.ref, { ...f.arrival, sessionFile: join(f.directory, "unrelated.jsonl") })).toBe(false);
  expect(f.query().status).toBe("unknown");
});

it("refuses a mismatched departing registration and an unchanged runtime", () => {
  const f = setup();
  expect(observeSessionDeparture(f.ref, { ...f.departure, runtimeSessionId: "someone-else" })).toBe(false);
  expect(observeSessionDeparture(f.ref, { ...f.departure, targetSessionFile: f.departure.sessionFile })).toBe(false);
  expect(observeSessionDeparture(f.ref, f.departure)).toBe(true);
  expect(observeSessionArrival(f.ref, { ...f.arrival, runtimeSessionId: "native-A" })).toBe(false);
  expect(f.query().status).toBe("unknown");
});

it("keeps multiple Sessions separate and returns unknown for multiple successors", () => {
  const f = setup();
  f.register(); f.register("native-C", "pi/C");
  expect(observeSessionDeparture(f.ref, f.departure)).toBe(true);
  expect(observeSessionArrival(f.ref, f.arrival)).toBe(true);
  expect(f.query(["pi/A", "pi/B", "pi/C"])).toMatchObject({ successorEndpointId: "pi/B" });
  const secondFile = join(f.directory, "another-new.jsonl");
  expect(observeSessionDeparture(f.ref, { ...f.departure, targetSessionFile: secondFile })).toBe(true);
  // Even an unconfirmed competing departure makes selection ambiguous.
  expect(f.query(["pi/A", "pi/B", "pi/C"]).status).toBe("unknown");
  expect(observeSessionArrival(f.ref, { ...f.arrival, runtimeSessionId: "native-C", sessionFile: secondFile })).toBe(true);
  expect(f.query(["pi/A", "pi/B", "pi/C"]).status).toBe("unknown");
});

it("does not expose a relationship when either Endpoint is invisible or presence is withheld", () => {
  const f = setup();
  f.register("native-B", "pi/B", false);
  observeSessionDeparture(f.ref, f.departure); observeSessionArrival(f.ref, f.arrival);
  expect(f.query().status).toBe("unknown");
  expect(f.query(["pi/A"]).status).toBe("unknown");
  expect(f.query(["pi/B"]).status).toBe("unknown");
  expect(f.query([], "not-authorized")).toEqual({ status: "unknown", previousEndpointId: "not-authorized" });
});

it("does not let successor reauthorization reuse the first-incarnation confirmation", () => {
  const f = setup();
  f.register(); observeSessionDeparture(f.ref, f.departure); observeSessionArrival(f.ref, f.arrival);
  expect(f.query().status).toBe("verified");
  f.api.revoke({ expectedDigest: f.snapshot().digest, endpointId: "pi/B" });
  expect(f.query().status).toBe("unknown");
  f.api.reauthorize({ expectedDigest: f.snapshot().digest, registration: { runtimeSessionId: "native-B", endpointId: "pi/B", payloadRead: false, ack: false, presenceDisclosure: true } });
  expect(f.query().status).toBe("unknown");
});

it("rejects a successor reauthorized before the first discovery query", () => {
  const f = setup();
  f.register(); observeSessionDeparture(f.ref, f.departure); observeSessionArrival(f.ref, f.arrival);
  f.api.revoke({ expectedDigest: f.snapshot().digest, endpointId: "pi/B" });
  f.api.reauthorize({ expectedDigest: f.snapshot().digest, registration: { runtimeSessionId: "native-B", endpointId: "pi/B", payloadRead: false, ack: false, presenceDisclosure: true } });
  expect(f.query().status).toBe("unknown");
});

it("is idempotent without overwriting conflicts or disclosing native identities and paths", () => {
  const f = setup();
  f.register(); observeSessionDeparture(f.ref, f.departure); observeSessionArrival(f.ref, f.arrival);
  const first = f.query();
  expect(observeSessionDeparture(f.ref, f.departure)).toBe(true);
  expect(observeSessionArrival(f.ref, f.arrival)).toBe(true);
  expect(f.query()).toEqual(first);
  expect(JSON.stringify(first)).not.toMatch(/native-A|native-B|jsonl|policy|epoch|participant/);
  expect(observeSessionArrival(f.ref, { ...f.arrival, runtimeSessionId: "native-C" })).toBe(false);
  expect(f.query()).toEqual({ status: "unknown", previousEndpointId: "pi/A" });
  expect(observeSessionArrival(f.ref, f.arrival)).toBe(false);
});

it("returns unknown for in-memory or unregistered lifecycle participants", () => {
  const f = setup();
  expect(observeSessionDeparture(f.ref, { ...f.departure, sessionFile: undefined })).toBe(false);
  expect(observeSessionDeparture(f.ref, { ...f.departure, targetSessionFile: undefined })).toBe(false);
  expect(observeSessionDeparture(f.ref, { ...f.departure, epoch: 2 })).toBe(false);
  expect(observeSessionArrival(f.ref, { ...f.arrival, sessionFile: undefined })).toBe(false);
  expect(f.query().status).toBe("unknown");
});

it("fails closed on a corrupt half or unsafe observation directory", () => {
  const f = setup();
  f.register(); observeSessionDeparture(f.ref, f.departure); observeSessionArrival(f.ref, f.arrival);
  const directory = join(f.ref.root, "session-switches");
  const file = fs.readdirSync(directory).find(name => name.endsWith(".arrival.json"))!;
  fs.writeFileSync(join(directory, file), "{}", { mode: 0o600 });
  expect(f.query().status).toBe("unknown");
  const g = setup();
  fs.symlinkSync(f.directory, join(g.ref.root, "session-switches"));
  expect(observeSessionDeparture(g.ref, g.departure)).toBe(false);
  expect(g.query().status).toBe("unknown");
});
