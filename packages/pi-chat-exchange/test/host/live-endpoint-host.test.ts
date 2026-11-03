import { afterEach, expect, it } from "vitest";
import { CeBoundEndpoint } from "../../src/host/bound-endpoint.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { readEndpointObservations } from "../../src/storage/ownership.js";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";
afterEach(cleanupFixtures);
it("an expired caller cannot distinguish joined from absent targets", () => {
  const { store } = fixture("live-expired-caller-");
  let instant = "2026-10-10T00:00:00.000Z";
  const host = new CeEndpointHost(store, { adapter: "chatgpt", allowlist: [{ endpointId: "chatgpt/main" }],
    exchangeNamespace: "live", exchangeIdempotencyKey: "x", leaseTtlSeconds: 120, now: () => instant,
    liveRecipients: { snapshot: () => ({ recipients: [{ adapter: "pi", endpointId: "pi/joined" }, { adapter: "pi", endpointId: "pi/absent" }], presence: [], viewDigest: "private" }) } });
  host.beginSession("chatgpt/main");
  const pi = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: "pi/joined" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now: () => instant });
  pi.beginSession("pi/joined");
  instant = "2026-10-10T00:02:00.000Z";
  const before = store.database.prepare("SELECT total_changes() AS n").get();
  for (const to of ["pi/joined", "pi/absent"]) {
    try { host.send("chatgpt/main", { to, text: "no authority", idempotencyKey: to }); throw Error("unexpected send"); }
    catch (error) { expect(error).toMatchObject({ code: "CE_HOST_AUTHORITY_ABSENT", reason: "EXPIRED" }); }
    expect(() => host.discover("chatgpt/main")).toThrowError(expect.objectContaining({ code: "CE_HOST_AUTHORITY_ABSENT", reason: "EXPIRED" }));
  }
  expect(store.database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});
it("shares one snapshot with admission, rejects reentry and clears scope after failure", async () => {
  const { store } = fixture("live-prepared-");
  let reads = 0;
  let enabled = true;
  let narrow = false;
  const host = new CeEndpointHost(store, { adapter: "chatgpt", allowlist: [{ endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", payloadRead: { enabled: true }, ack: { enabled: true }, now, liveRecipients: { snapshot: () => { reads++; return { recipients: enabled ? [{ adapter: "pi", endpointId: "pi/a" }] : [], presence: [], viewDigest: "private", ownPolicy: { payloadRead: !narrow, ack: !narrow } }; } } });
  const bound = CeBoundEndpoint.start(host, "chatgpt/main", { renewIntervalMs: 10, timers: { setInterval: () => 1, clearInterval: () => {} }, admission: (operation, snapshot) => { if (operation.kind === "discover") { expect(snapshot?.recipients).toHaveLength(1); enabled = false; } } });
  reads = 0;
  expect(bound.discover().targets).toHaveLength(1);
  expect(reads).toBe(1);
  expect(host.discover("chatgpt/main").targets).toHaveLength(0);
  expect(() => host.runWithRecipientSnapshot(() => { host.runWithRecipientSnapshot(() => {}, () => {}); }, () => {})).toThrow();
  expect(host.runWithRecipientSnapshot(() => {}, () => 42)).toBe(42);
  narrow = true;
  expect(host.discover("chatgpt/main").self.effective).toMatchObject({ readPayload: false, ack: false });
  await bound.shutdown();
});
const now = () => "2026-10-10T00:00:00.000Z";
it("masks presence across joins and bound terminal state cannot revive", async () => {
  const { store } = fixture("live-bound-");
  let disclose = false;
  let denied = false;
  let tick = () => {};
  const host = new CeEndpointHost(store, { adapter: "chatgpt", allowlist: [{ endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now, liveRecipients: { snapshot: () => ({ recipients: [{ adapter: "pi", endpointId: "pi/a" }], viewDigest: "hidden", presence: [{ endpointId: "pi/a", disclose }] }) } });
  const bound = CeBoundEndpoint.start(host, "chatgpt/main", { renewIntervalMs: 10, admission: () => { if (denied) throw new Error("deny"); }, timers: { setInterval: cb => { tick = cb; return 1; }, clearInterval: () => {} } });
  expect(bound.operationalStatus()).toEqual({ state: "ACTIVE", renewal: "RUNNING" });
  const initial = bound.discover();
  expect(initial.targets[0]).toMatchObject({ active: "UNKNOWN", reachable: "UNKNOWN", reason: "PRESENCE_WITHHELD" });
  const pi = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: "pi/a" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now });
  pi.beginSession("pi/a");
  expect(bound.discover().viewDigest).toBe(initial.viewDigest);
  disclose = true;
  expect(bound.discover().targets[0]?.reachable).toBe("TRUE");
  denied = true; tick(); denied = false;
  expect(bound.operationalStatus()).toEqual({ state: "WRITE_BLOCKED", renewal: "STOPPED" });
  expect(bound.discover().targets[0]).toMatchObject({ reachable: "FALSE", reason: "PORT_BLOCKED" });
  disclose = false;
  expect(bound.discover().targets[0]).toMatchObject({ active: "UNKNOWN", reachable: "UNKNOWN", reason: "PRESENCE_WITHHELD" });
  tick(); expect(bound.state).toBe("WRITE_BLOCKED");
  await bound.shutdown();
  expect(() => bound.discover()).toThrow();
});
it("observes all selected recipients at one clock instant without writes", () => {
  const { store } = fixture("live-observation-");
  const host = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: "pi/a" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now });
  const mapping = host.beginSession("pi/a");
  const before = store.database.prepare("SELECT total_changes() AS n").get();
  let clocks = 0;
  const result = readEndpointObservations(store, mapping.exchangeId, [{ adapter: "pi", endpointId: "pi/a" }, { adapter: "pi", endpointId: "pi/absent" }], { now: () => { clocks++; return now(); } });
  expect(clocks).toBe(1);
  expect(result.targets).toEqual([{ adapter: "pi", endpointId: "pi/a", joined: true, active: "TRUE" }, { adapter: "pi", endpointId: "pi/absent", joined: false, active: "FALSE" }]);
  expect(store.database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  const selected = [{ adapter: "pi", endpointId: "pi/a" }];
  expect(readEndpointObservations(store, mapping.exchangeId, selected, { now: () => "2026-10-09T23:59:59.000Z" }).targets[0]).toMatchObject({ joined: true, active: "UNKNOWN" });
  expect(readEndpointObservations(store, mapping.exchangeId, selected, { now: () => "2026-10-10T00:20:00.000Z" }).targets[0]).toMatchObject({ joined: true, active: "FALSE" });
  host.end("pi/a");
  expect(readEndpointObservations(store, mapping.exchangeId, [{ adapter: "pi", endpointId: "pi/a" }]).targets).toMatchObject([{ joined: true, active: "FALSE" }]);
  const expired = readEndpointObservations(store, mapping.exchangeId, [{ adapter: "pi", endpointId: "pi/a" }], { now: () => "2026-10-10T00:20:00.000Z" });
  expect(expired.observedAt).toBe("2026-10-10T00:20:00.000Z");
  expect(expired.targets[0]).toMatchObject({ joined: true, active: "FALSE" });
});
it("admits a newly joined recipient using one fresh policy snapshot and retains its owner", () => {
  const { store } = fixture("live-host-");
  let recipients: readonly { adapter: string; endpointId: string }[] = [];
  let reads = 0;
  const host = new CeEndpointHost(store, { adapter: "chatgpt", allowlist: [{ endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now, liveRecipients: { snapshot: () => { reads++; return { recipients, viewDigest: "private", presence: recipients.map(r => ({ endpointId: r.endpointId, disclose: true })) }; } } });
  host.beginSession("chatgpt/main");
  const owner = host.status("chatgpt/main");
  recipients = [{ adapter: "pi", endpointId: "pi/a" }];
  const before = store.database.prepare("SELECT total_changes() AS n").get();
  expect(() => host.send("chatgpt/main", { to: "pi/a", text: "hello", idempotencyKey: "one" })).toThrow();
  expect(reads).toBe(1);
  expect(store.database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  const pi = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: "pi/a" }], exchangeNamespace: "live", exchangeIdempotencyKey: "x", now });
  pi.beginSession("pi/a");
  expect(host.send("chatgpt/main", { to: "pi/a", text: "hello", idempotencyKey: "one" }).disposition).toBe("CREATED");
  expect(reads).toBe(2);
  expect(host.status("chatgpt/main")).toEqual(owner);
  expect(host.discover("chatgpt/main").targets).toMatchObject([{ endpointId: "pi/a", registered: true, authorized: { send: true }, active: "TRUE", reachable: "TRUE" }]);
  recipients = [];
  const afterRevoke = store.database.prepare("SELECT total_changes() AS n").get();
  expect(host.discover("chatgpt/main").targets).toEqual([]);
  expect(() => host.send("chatgpt/main", { to: "pi/a", text: "revoked", idempotencyKey: "two" })).toThrow();
  expect(store.database.prepare("SELECT total_changes() AS n").get()).toEqual(afterRevoke);
  recipients = [{ adapter: "pi", endpointId: "chatgpt/main" }];
  expect(() => host.discover("chatgpt/main")).toThrow();
});
