import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { createLiveMcpComposition, projectEndpointDiscovery, discoverLiveEndpoints, observeLiveMcpRuntime } from "../../src/tunnel/live-mcp-composition.js";
import { observeSessionDeparture, observeSessionArrival } from "../../src/tunnel/session-switch-observation.js";
import { initializeLivePolicy, createLivePolicyRegistration, readLivePolicy } from "../../src/tunnel/live-session-policy.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CeBoundEndpoint } from "../../src/host/bound-endpoint.js";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";
import { callEndpointDiscovery } from "../../src/control/mcp/endpoint-discovery.js";
import { createCurrentRuntimeObserver, discoverCurrentRuntimes } from "../../src/tunnel/current-runtime-binding.js";

afterEach(cleanupFixtures);
function setup(timers?: import("../../src/host/bound-endpoint.js").TimerSeams) {
  const f = fixture("live-composition-");
  const root = join(f.directory, "live-policy");
  fs.mkdirSync(root, { mode: 0o700 });
  const configBase = { version: 1, store: { directory: f.directory, file: f.filename },
    exchange: { namespace: "live", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true } };
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store: configBase.store, exchange: configBase.exchange, chatgptEndpoint: configBase.endpoint, mcp: { payloadRead: true, ack: true },
    registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1, status: "active" as const, payloadRead: true, ack: true }] };
  const ref = initializeLivePolicy({ root, manifest });
  const config = parseMcpBindingConfig({ ...configBase, admissionPolicy: ref });
  const api = createLivePolicyRegistration({ ref });
  const composition = createLiveMcpComposition(config);
  const host = new CeEndpointHost(f.store, { adapter: "chatgpt", allowlist: [config.endpoint], recipients: config.recipients, liveRecipients: composition.recipients,
    exchangeNamespace: "live", exchangeIdempotencyKey: "test", payloadRead: { enabled: true }, ack: { enabled: true } });
  const bound = CeBoundEndpoint.start(host, "chatgpt/main", { admission: composition.admission, renewIntervalMs: 100000, ...(timers === undefined ? {} : { timers }) });
  return { ...f, ref, api, config, composition, host, bound };
}

it("keeps one Host and Owner while dynamically authorizing B, with truthful prejoin refusal", async () => {
  const f = setup();
  try {
    const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }, { endpointId: "pi/B" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test", payloadRead: { enabled: true }, ack: { enabled: true } });
    pi.beginSession("pi/A");
    const before = f.host.status("chatgpt/main");
    f.bound.send({ to: "pi/A", text: "A before", idempotencyKey: "a-before" });
    const next = f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
    const changes = f.store.database.prepare("SELECT total_changes() AS n").get();
    expect(() => f.bound.send({ to: "pi/B", text: "before join", idempotencyKey: "b-pre" })).toThrow();
    expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    pi.beginSession("pi/B");
    const b = f.bound.send({ to: "pi/B", text: "B hello", idempotencyKey: "b" });
    expect(pi.readPayload("pi/B", { messageId: b.messageId }).payloadText).toBe("B hello");
    f.bound.send({ to: "pi/A", text: "A after", idempotencyKey: "a-after" });
    expect(f.host.status("chatgpt/main")).toEqual(before);
    expect(f.bound.operationalStatus().state).toBe("ACTIVE");
    const discovery = projectEndpointDiscovery(f.bound.discover());
    expect(discovery.targets.find(t => t.endpointId === "pi/B")).toMatchObject({ active: "unknown", reachable: "unknown", reason: "PRESENCE_WITHHELD" });
    expect(callEndpointDiscovery({ discover: () => discovery }, {}).isError).toBe(false);
    f.api.revoke({ expectedDigest: next.snapshot.digest, endpointId: "pi/B" });
    expect(() => f.bound.send({ to: "pi/B", text: "revoked", idempotencyKey: "denied" })).toThrow();
    f.bound.send({ to: "pi/A", text: "A retained", idempotencyKey: "a-retained" });
    pi.end("pi/A"); pi.end("pi/B");
  } finally { await f.bound.shutdown(); }
});

it("observes the exact bound Owner without writes and reflects shutdown immediately", async () => {
  const f = setup();
  try {
    const before = f.store.database.prepare("SELECT total_changes() AS n").get();
    const observed = observeLiveMcpRuntime(f.composition, f.host, f.bound, f.store, f.config.endpoint.endpointId);
    expect(observed.owner).toEqual(f.host.status("chatgpt/main"));
    expect(observed.bound).toEqual({ state: "ACTIVE", renewal: "RUNNING" });
    expect(observed.snapshot).toEqual(f.composition.loaded);
    expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(before);
    await f.bound.shutdown();
    const closed = observeLiveMcpRuntime(f.composition, f.host, f.bound, f.store, f.config.endpoint.endpointId);
    expect(closed.bound).toEqual({ state: "CLOSED", renewal: "STOPPED" });
    expect(closed.owner.lease).not.toBe("ACTIVE");
  } finally { await f.bound.shutdown(); }
});

it("does not trust a stale Host status lease after its actual Owner is released", async () => {
  const f = setup();
  const mapping = f.host.status("chatgpt/main");
  try {
    await f.bound.shutdown();
    const status = vi.spyOn(f.host, "status").mockReturnValue(mapping);
    try {
      const observed = observeLiveMcpRuntime(f.composition, f.host, f.bound, f.store, "chatgpt/main");
      expect(observed.owner.lease).toBe("ABSENT");
      expect(observed.owner.leaseExpiresAt).toBeUndefined();
      expect(observed.bound.state).toBe("CLOSED");
    } finally { status.mockRestore(); }
  } finally { await f.bound.shutdown(); }
});

it("last-recipient revoke denies every operation and renewal blocks permanently despite adding B", async () => {
  let tick: (() => void) | undefined;
  const cleared = vi.fn();
  const f = setup({ setInterval: callback => { tick = callback; return 1; }, clearInterval: cleared });
  try {
    const renew = vi.spyOn(f.host, "renew");
    const before = f.host.status("chatgpt/main");
    f.api.revoke({ expectedDigest: readLivePolicy(f.ref).digest, endpointId: "pi/A" });
    const changes = f.store.database.prepare("SELECT total_changes() AS n").get();
    const prepared = f.composition.recipients.snapshot();
    expect(prepared.recipients).toEqual([]);
    for (const operation of [{ kind: "begin" }, { kind: "renew" }, { kind: "inbox" }, { kind: "readPayload" }, { kind: "ack" }, { kind: "discover" }, { kind: "send", to: "pi/A" }] as const) {
      expect(() => f.composition.admission(operation, prepared)).toThrow();
    }
    expect(() => f.bound.listInbox({})).toThrow();
    expect(() => f.bound.discover()).toThrow();
    tick!();
    expect(renew).not.toHaveBeenCalled();
    expect(f.bound.operationalStatus()).toEqual({ state: "WRITE_BLOCKED", renewal: "STOPPED" });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(f.host.status("chatgpt/main")).toEqual(before);
    expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
    tick!();
    expect(renew).not.toHaveBeenCalled();
    expect(() => f.bound.send({ to: "pi/B", text: "blocked", idempotencyKey: "blocked" })).toThrow();
    expect(f.bound.operationalStatus()).toEqual({ state: "WRITE_BLOCKED", renewal: "STOPPED" });
    expect(await f.bound.shutdown()).toMatchObject({ released: true, detached: true });
    expect(f.bound.operationalStatus()).toEqual({ state: "CLOSED", renewal: "STOPPED" });
  } finally { await f.bound.shutdown(); }
}, 30_000);

it("rejects mismatched global launch ceilings before creating any binding", async () => {
  const f = setup();
  try { expect(() => createLiveMcpComposition({ ...f.config, payloadRead: { enabled: false } })).toThrow(); }
  finally { await f.bound.shutdown(); }
});

it("exposes a witnessed replacement through the MCP port without changing old messages or ACKs", async () => {
  const f = setup();
  const register = (id: string) => f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { runtimeSessionId: `native-${id}`, endpointId: `pi/${id}`, payloadRead: false, ack: false, presenceDisclosure: true } });
  register("B");
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/B" }], recipients: [f.config.endpoint], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  pi.beginSession("pi/B");
  try {
    const message = f.bound.send({ to: "pi/B", text: "pending old work", idempotencyKey: "old-work" });
    const before = f.store.database.prepare("SELECT * FROM message").all();
    const receipts = f.store.database.prepare("SELECT * FROM delivery_ack_receipt").all();
    pi.end("pi/B");
    observeSessionDeparture(f.ref, { runtimeSessionId: "native-B", endpointId: "pi/B", epoch: 1, sessionFile: join(f.directory, "old.jsonl"), targetSessionFile: join(f.directory, "new.jsonl") });
    observeSessionArrival(f.ref, { runtimeSessionId: "native-C", previousSessionFile: join(f.directory, "old.jsonl"), sessionFile: join(f.directory, "new.jsonl") });
    const query = () => callEndpointDiscovery({ discover: previous => discoverLiveEndpoints(f.composition, f.bound, previous) }, { previousEndpointId: "pi/B" });
    expect(query().structuredContent).toMatchObject({ sessionSwitch: { status: "unknown" } });
    expect(() => f.bound.send({ to: "pi/C", text: "not authorized", idempotencyKey: "denied" })).toThrow();
    register("C");
    const writes = f.store.database.prepare("SELECT total_changes() AS n").get();
    expect(query().structuredContent).toMatchObject({ sessionSwitch: { status: "verified", previousEndpointId: "pi/B", successorEndpointId: "pi/C" }, targets: expect.arrayContaining([expect.objectContaining({ endpointId: "pi/C", registered: true, authorized: { send: true }, reachable: "unknown" })]) });
    expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(writes);
    expect(f.store.database.prepare("SELECT * FROM message").all()).toEqual(before);
    expect(f.store.database.prepare("SELECT * FROM delivery_ack_receipt").all()).toEqual(receipts);
    expect(message.disposition).toBe("CREATED");
    // Independently authorized addressing still does not prove that Pi has joined.
    expect(() => f.bound.send({ to: "pi/C", text: "not joined", idempotencyKey: "not-joined" })).toThrow();
  } finally { pi.drop("pi/B"); await f.bound.shutdown(); }
});

it("requires caller authorization, presence and active policy for current Runtime discovery", async () => {
  const f = setup(), observer = createCurrentRuntimeObserver(f.ref, "workbench"); observer.observe("native-A");
  f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: true } });
  try {
    const read = () => discoverLiveEndpoints(f.composition, f.bound, undefined, "workbench");
    expect(read()).toMatchObject({ currentBinding: { status: "verified", endpointId: "pi/A" } });
    f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: false } });
    expect(read()).toMatchObject({ currentBinding: { status: "unknown" }, runtimes: [] });
    f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: true } });
    f.api.revoke({ expectedDigest: readLivePolicy(f.ref).digest, endpointId: "pi/A" });
    expect(discoverCurrentRuntimes(readLivePolicy(f.ref), ["pi/A"], "workbench").currentBinding?.status).toBe("unknown");
    // No active registration means bound.discover itself cannot grant a target.
    expect(() => read()).toThrow(); observer.stop();
  } finally { await f.bound.shutdown(); }
});
it("limits caller targets to the selected Runtime's current Session and exposes no stale fallback", async () => {
  const f = setup(), observer = createCurrentRuntimeObserver(f.ref, "workbench"); observer.observe("native-A");
  f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: true } });
  try {
    f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: false, ack: false, presenceDisclosure: true } });
    const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/B" }], recipients: [f.config.endpoint], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
    pi.beginSession("pi/B");
    try {
      const read = () => discoverLiveEndpoints(f.composition, f.bound, undefined, "workbench");
      expect(read().targets.map(t => t.endpointId)).toEqual(["pi/A"]);
      observer.observe("native-B"); expect(read().targets.map(t => t.endpointId)).toEqual(["pi/B"]);
      observer.stop(); expect(read()).toMatchObject({ targets: [], currentBinding: { status: "unknown" } });
    } finally { pi.end("pi/B"); }
  } finally { await f.bound.shutdown(); }
});



it("fails the complete current Runtime relation closed on a mid-query policy tip change", async () => {
  const f = setup(); createCurrentRuntimeObserver(f.ref, "workbench").observe("native-A");
  try {
    const discover = f.bound.discover.bind(f.bound);
    const port = { discover: () => { const result = discover(); f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: false, ack: false, presenceDisclosure: true } }); return result; } } as CeBoundEndpoint;
    const result = discoverLiveEndpoints(f.composition, port, undefined, "workbench");
    expect(result.runtimes).toEqual([]); expect(result.currentBinding).toEqual({ status: "unknown", runtimeId: "workbench" });
  } finally { await f.bound.shutdown(); }
});


it("returns unknown if policy changes during caller-bound discovery", async () => {
  const f = setup();
  try {
    const discover = f.bound.discover.bind(f.bound);
    const changed = { ...f.composition, snapshot: vi.fn(f.composition.snapshot) };
    const port = { discover: () => { const result = discover(); f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: false, ack: false, presenceDisclosure: false } }); return result; } } as CeBoundEndpoint;
    expect(discoverLiveEndpoints(changed, port, "pi/A").sessionSwitch).toEqual({ status: "unknown", previousEndpointId: "pi/A" });
    expect(changed.snapshot).toHaveBeenCalledTimes(2);
  } finally { await f.bound.shutdown(); }
});
