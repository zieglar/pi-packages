import fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";
import { initializeLivePolicy, readLivePolicy, createLivePolicyRegistration } from "../../src/tunnel/live-session-policy.js";
import { createCurrentRuntimeObserver } from "../../src/tunnel/current-runtime-binding.js";
import { createEndpointRuntimeBinding } from "../../src/tunnel/endpoint-runtime-binding.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";

import { createLiveMcpComposition, discoverLiveEndpoints } from "../../src/tunnel/live-mcp-composition.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CeBoundEndpoint } from "../../src/host/bound-endpoint.js";
import { callEndpointDiscovery } from "../../src/control/mcp/endpoint-discovery.js";

afterEach(() => {vi.restoreAllMocks();cleanupFixtures();});
function setup() {
  const f = fixture("endpoint-runtime-");
  const root = join(f.directory, "policy");fs.mkdirSync(root, {mode: 0o700});
  const manifest = {kind: "ce-multi-session-v1" as const, version: 1 as const, identity: {tunnelId: "tunnel_abcdefgh123456", organizationId: null},
    store: {directory: f.directory, file: f.filename}, exchange: {namespace: "explicit", idempotencyKey: "test"},
    chatgptEndpoint: {adapter: "chatgpt", endpointId: "chatgpt/main"}, mcp: {payloadRead: true, ack: true},
    registrations: [{runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, status: "active" as const, payloadRead: false, ack: false}] };
  const ref = initializeLivePolicy({root, manifest});
  createLivePolicyRegistration({ref}).register({expectedDigest: readLivePolicy(ref).digest, registration: {runtimeSessionId: "A", endpointId: "pi/A", payloadRead: false, ack: false, presenceDisclosure: true}});
  const config = parseMcpBindingConfig({version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint,
    recipients: [{adapter: "pi", endpointId: "pi/A"}], payloadRead: {enabled: true}, ack: {enabled: true}, admissionPolicy: ref});
  const path = join(f.directory, "binding.json");fs.writeFileSync(path, JSON.stringify({version: 1, ...config}), {mode: 0o600});
  const binding = createEndpointRuntimeBinding(path, config);
  const observer = createCurrentRuntimeObserver(ref, "runtime-a");observer.observe("A");
  const set = (runtimeId: string | null, expectedRevision?: string) => {
    const current = binding.read();
    const result = binding.update({runtimeId, expectedRevision: expectedRevision ?? (current.status === "unavailable" ? "unavailable" : current.revision), acceptEndpointScope: true});
    assert(result.status !== "unavailable");return result;
  };
  return {...f, ref, config, path, binding, observer, set};
}
it("records explicit Endpoint scope, CAS rebind and durable revoke without granting permissions", () => {
  const f = setup();expect(f.binding.read()).toEqual({scope: "ce-endpoint", status: "unbound", revision: "unbound"});
  const policyBefore = readLivePolicy(f.ref);
  const first = f.set("runtime-a");expect(first).toMatchObject({scope: "ce-endpoint", status: "bound", runtimeId: "runtime-a"});
  expect(first.revision).toMatch(/^[a-f0-9]{64}$/);
  expect(() => f.set(null, "unbound")).toThrow("CE_RUNTIME_BINDING_CONFLICT");
  const next = f.set("runtime-a", first.revision);expect(next.revision).not.toBe(first.revision);
  expect(() => f.set(null, first.revision)).toThrow("CE_RUNTIME_BINDING_CONFLICT");
  const revoked = f.set(null, next.revision);expect(revoked.status).toBe("unbound");expect(revoked.revision).not.toBe("unbound");
  expect(readLivePolicy(f.ref)).toEqual(policyBefore);
});
it("refuses unknown, ambiguous or undisclosed runtime and requires scope acceptance", () => {
  const f = setup();expect(() => f.set("missing-runtime")).toThrow("CE_RUNTIME_BINDING_RUNTIME_UNAVAILABLE");
  expect(() => f.binding.update({runtimeId: "runtime-a", expectedRevision: "unbound", acceptEndpointScope: false})).toThrow();
  const api = createLivePolicyRegistration({ref: f.ref});
  api.register({expectedDigest: readLivePolicy(f.ref).digest, registration: {runtimeSessionId: "B", endpointId: "pi/B", payloadRead: false, ack: false, presenceDisclosure: true}});
  const rival = createCurrentRuntimeObserver(f.ref, "runtime-a");rival.observe("B");
  expect(() => f.set("runtime-a")).toThrow("CE_RUNTIME_BINDING_RUNTIME_UNAVAILABLE");rival.stop();
  api.register({expectedDigest: readLivePolicy(f.ref).digest, registration: {runtimeSessionId: "A", endpointId: "pi/A", payloadRead: false, ack: false, presenceDisclosure: false}});
  expect(() => f.set("runtime-a")).toThrow("CE_RUNTIME_BINDING_RUNTIME_UNAVAILABLE");
});
it("fails closed on lock, malformed state, wrong launch identity and unsafe sidecar", () => {
  const f = setup();const sidecar = f.path + ".runtime-binding.json", lock = sidecar + ".lock";
  f.set("runtime-a");const bytes = fs.readFileSync(sidecar);
  fs.mkdirSync(lock, {mode: 0o700});expect(f.binding.read().status).toBe("unavailable");expect(() => f.set(null)).toThrow();fs.rmdirSync(lock);
  fs.writeFileSync(sidecar, "{");expect(f.binding.read().status).toBe("unavailable");expect(() => f.set(null, "unbound")).toThrow();
  fs.writeFileSync(sidecar, bytes);fs.chmodSync(sidecar, 0o644);expect(f.binding.read().status).toBe("unavailable");fs.chmodSync(sidecar, 0o600);
  const otherPath = join(f.directory, "other.json");fs.writeFileSync(otherPath, JSON.stringify({version: 1, ...f.config, exchange: {...f.config.exchange, namespace: "other"}}), {mode: 0o600});
  fs.copyFileSync(sidecar, otherPath + ".runtime-binding.json");fs.chmodSync(otherPath + ".runtime-binding.json", 0o600);
  const other = createEndpointRuntimeBinding(otherPath, {...f.config, exchange: {...f.config.exchange, namespace: "other"}});expect(other.read().status).toBe("unavailable");
  fs.unlinkSync(sidecar);fs.symlinkSync(otherPath, sidecar);expect(f.binding.read().status).toBe("unavailable");
});
it("survives process-local reader recreation and does not cache current Session", () => {
  const f = setup();const record = f.set("runtime-a");
  f.observer.observe("ungranted-new-session");expect(createEndpointRuntimeBinding(f.path, f.config).read()).toEqual(record);
  f.observer.stop();expect(f.binding.read()).toEqual(record);
});

it("returns its committed revision when a stale competitor acquires the lock immediately after unlock", () => {
  const f = setup(), lock = f.path + ".runtime-binding.json.lock", remove = fs.rmdirSync;
  const before = f.binding.read();assert(before.status !== "unavailable");
  // Deterministically pause B after it acquires the lock, before its stale CAS
  // check. A must return its own successful commit rather than rereading B's lock.
  vi.spyOn(fs, "rmdirSync").mockImplementationOnce(path => {remove(path);fs.mkdirSync(lock, {mode: 0o700});});
  const committed = f.set("runtime-a", before.revision);
  expect(committed.status).toBe("bound");expect(committed.revision).not.toBe(before.revision);
  expect(f.binding.read().status).toBe("unavailable");
  vi.restoreAllMocks();remove(lock);
  expect(() => f.set(null, before.revision)).toThrow("CE_RUNTIME_BINDING_CONFLICT");
  expect(f.binding.read()).toEqual(committed);
});

it.each(["write", "file-fsync", "rename", "directory-fsync"])("retains a blocking lock after uncertain %s failure", phase => {
  const f = setup();const lock = f.path + ".runtime-binding.json.lock";
  const fail = () => {throw new Error("synthetic IO failure");};
  if (phase === "write") vi.spyOn(fs, "writeFileSync").mockImplementationOnce(fail);
  if (phase === "rename") vi.spyOn(fs, "renameSync").mockImplementationOnce(fail);
  if (phase === "file-fsync") vi.spyOn(fs, "fsyncSync").mockImplementationOnce(fail);
  if (phase === "directory-fsync") {const original = fs.fsyncSync;vi.spyOn(fs, "fsyncSync").mockImplementationOnce(fd => original(fd)).mockImplementationOnce(fail);}
  expect(() => f.set("runtime-a")).toThrow("CE_RUNTIME_BINDING_WRITE_UNCERTAIN");
  vi.restoreAllMocks();expect(fs.existsSync(lock)).toBe(true);expect(f.binding.read().status).toBe("unavailable");
  expect(() => f.set(null, "unbound")).toThrow("CE_RUNTIME_BINDING_CONFLICT");
});

function queryHost(f: ReturnType<typeof setup>) {
  const live = createLiveMcpComposition(f.config, undefined, {bindingPath: f.path});
  const host = new CeEndpointHost(f.store, {adapter: "chatgpt", allowlist: [f.config.endpoint], recipients: f.config.recipients, liveRecipients: live.recipients,
    exchangeNamespace: f.config.exchange.namespace, exchangeIdempotencyKey: f.config.exchange.idempotencyKey, payloadRead: {enabled: true}, ack: {enabled: true}});
  const bound = CeBoundEndpoint.start(host, f.config.endpoint.endpointId, {admission: live.admission, renewIntervalMs: 100000});
  const query = () => discoverLiveEndpoints(live, bound, undefined, undefined, true);
  return {live, bound, query};
}
it("requires explicit opt-in and resolves current on each bound query without permission inheritance", async () => {
  const f = setup(), h = queryHost(f);
  try {
    expect(h.query()).toMatchObject({targets: [], runtimeSelection: {scope: "ce-endpoint", status: "unbound"}});
    const selected = f.set("runtime-a");expect(h.query()).toMatchObject({runtimeSelection: selected, currentBinding: {status: "verified", endpointId: "pi/A"}});
    expect(discoverLiveEndpoints(h.live, h.bound).runtimeSelection).toBeUndefined();
    expect(discoverLiveEndpoints(h.live, h.bound).currentBinding).toBeUndefined();
    expect(discoverLiveEndpoints(h.live, h.bound, undefined, "runtime-a").currentBinding?.status).toBe("verified");
    const port = {discover: (previous?: string, runtimeId?: string, useRuntimeBinding?: true) => discoverLiveEndpoints(h.live, h.bound, previous, runtimeId, useRuntimeBinding)};
    expect(callEndpointDiscovery(port, {useRuntimeBinding: true}).isError).toBe(false);
    expect(() => callEndpointDiscovery(port, {useRuntimeBinding: true, runtimeId: "runtime-a"})).toThrow();
    f.observer.observe("ungranted-new");expect(h.query()).toMatchObject({targets: [], currentBinding: {status: "unknown"}, runtimeSelection: selected});
    f.observer.observe("A");expect(h.query().targets.map(t => t.endpointId)).toEqual(["pi/A"]);
    f.set(null);expect(h.query()).toMatchObject({targets: [], runtimeSelection: {status: "unbound"}});expect(h.query().currentBinding).toBeUndefined();
  } finally {await h.bound.shutdown();}
});
it.each(["revoke", "rebind", "locked"])("omits stale verified current when %s occurs during query", async action => {
  const f = setup(), h = queryHost(f);f.set("runtime-a");
  try {
    const original = h.bound.discover.bind(h.bound);
    vi.spyOn(h.bound, "discover").mockImplementationOnce(() => {
      const result = original();
      if (action === "locked") fs.mkdirSync(f.path + ".runtime-binding.json.lock", {mode: 0o700});
      else f.set(action === "revoke" ? null : "runtime-a");
      return result;
    });
    const result = h.query();expect(result.targets).toEqual([]);expect(result.currentBinding).toBeUndefined();
    expect(result.runtimeSelection).toEqual({scope: "ce-endpoint", status: "unavailable"});
  } finally {await h.bound.shutdown();}
});

function groupWrite(f: ReturnType<typeof setup>, action: "bind" | "rebind" | "revoke" | "rename", group: string, nextName?: string, expectedRevision?: string) {
  const before = f.binding.read();assert(before.status !== "unavailable");
  return f.binding.updateGroup({action, group, ...(nextName === undefined ? {} : {nextName}),
    ...(["bind", "rebind"].includes(action) ? {runtimeId: "runtime-a"} : {}),
    expectedRevision: expectedRevision ?? before.revision, acceptEndpointScope: true});
}
it("normalizes unique names, preserves legacy selection, and atomically renames with shared CAS", () => {
  const f = setup();f.set("runtime-a");const original = readLivePolicy(f.ref);
  const first = groupWrite(f, "bind", "ＷＯＲＫ");expect(first).toMatchObject({group: "work", status: "bound", runtimeId: "runtime-a"});
  assert(first.status !== "unavailable");
  expect(f.binding.read().status).toBe("bound");
  expect(() => groupWrite(f, "bind", "Work")).toThrow("GROUP_EXISTS");
  groupWrite(f, "bind", "review");
  expect(() => groupWrite(f, "rename", "work", "REVIEW")).toThrow("GROUP_EXISTS");
  expect(() => groupWrite(f, "rename", "work", "build", first.revision)).toThrow("CONFLICT");
  groupWrite(f, "rename", "work", "build");
  expect(f.binding.readGroup("work").status).toBe("unbound");
  expect(f.binding.readGroup("BUILD")).toMatchObject({group: "build", status: "bound"});
  expect(f.binding.listGroups().map(g => g.group)).toEqual(["build", "review"]);
  groupWrite(f, "revoke", "build");expect(f.binding.readGroup("build").status).toBe("unbound");
  expect(() => groupWrite(f, "rebind", "missing")).toThrow("GROUP_UNBOUND");
  expect(() => groupWrite(f, "bind", "../escape")).toThrow("INVALID");
  expect(() => groupWrite(f, "bind", "a".repeat(65))).toThrow("INVALID");
  expect(readLivePolicy(f.ref)).toEqual(original);
});
it("named queries select only their Runtime and follow independently authorized Session changes", async () => {
  const f = setup(), h = queryHost(f);
  const port = {discover: (previous?: string, runtimeId?: string, selected?: true, group?: string) => discoverLiveEndpoints(h.live, h.bound, previous, runtimeId, selected, group)};
  const query = (group: string) => callEndpointDiscovery(port, {group}).structuredContent as ReturnType<typeof discoverLiveEndpoints>;
  try {
    expect(query("missing")).toMatchObject({targets: [], runtimeSelection: {group: "missing", status: "unbound"}});
    groupWrite(f, "bind", "work");groupWrite(f, "bind", "review");
    const revision = f.binding.readGroup("work");
    expect(query("WORK")).toMatchObject({runtimeSelection: {group: "work"}, currentBinding: {endpointId: "pi/A"}});
    for (const mixed of [{runtimeId: "runtime-a"}, {previousEndpointId: "pi/A"}, {useRuntimeBinding: true}]) {
      expect(() => callEndpointDiscovery(port, {group: "work", ...mixed})).toThrow();
    }
    f.observer.observe("new");expect(query("work").targets).toEqual([]);
    createLivePolicyRegistration({ref: f.ref}).register({expectedDigest: readLivePolicy(f.ref).digest, registration: {runtimeSessionId: "new", endpointId: "pi/new", payloadRead: false, ack: false, presenceDisclosure: true}});
    f.observer.observe("new");expect(query("work").currentBinding).toMatchObject({status: "verified", endpointId: "pi/new"});
    expect(f.binding.readGroup("work")).toEqual(revision);
    groupWrite(f, "rename", "work", "build");expect(query("work").targets).toEqual([]);
    groupWrite(f, "revoke", "build");expect(query("build").targets).toEqual([]);
    const discover = h.bound.discover.bind(h.bound);
    vi.spyOn(h.bound, "discover").mockImplementationOnce(() => {const result = discover();groupWrite(f, "rebind", "review");return result;});
    expect(query("review")).toMatchObject({targets: [], runtimeSelection: {group: "review", status: "unavailable"}});
  } finally {await h.bound.shutdown();}
});
it.each(["expired", "ambiguous", "withheld", "locked", "duplicate-name"])("named discovery fails closed for %s evidence", async failure => {
  const f = setup(), h = queryHost(f);groupWrite(f, "bind", "work");
  try {
    if (failure === "expired") vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    if (failure === "ambiguous") {
      createLivePolicyRegistration({ref: f.ref}).register({expectedDigest: readLivePolicy(f.ref).digest, registration: {runtimeSessionId: "B", endpointId: "pi/B", payloadRead: false, ack: false, presenceDisclosure: true}});
      createCurrentRuntimeObserver(f.ref, "runtime-a").observe("B");
    }
    if (failure === "withheld") createLivePolicyRegistration({ref: f.ref}).register({expectedDigest: readLivePolicy(f.ref).digest, registration: {runtimeSessionId: "A", endpointId: "pi/A", payloadRead: false, ack: false, presenceDisclosure: false}});
    if (failure === "locked") fs.mkdirSync(f.path + ".runtime-binding.json.lock", {mode: 0o700});
    if (failure === "duplicate-name") {
      const path = f.path + ".runtime-binding.json", catalog = JSON.parse(fs.readFileSync(path, "utf8"));
      catalog.groups.push({...catalog.groups[0]});fs.writeFileSync(path, JSON.stringify(catalog));
    }
    const result = discoverLiveEndpoints(h.live, h.bound, undefined, undefined, undefined, "work");
    expect(result.targets).toEqual([]);expect(result.currentBinding?.status).not.toBe("verified");
  } finally {vi.restoreAllMocks();await h.bound.shutdown();}
});
it("keeps named catalogs isolated across caller launches and rejects unknown query fields", async () => {
  const f = setup();groupWrite(f, "bind", "work");
  const otherPath = join(f.directory, "another-launch.json");fs.copyFileSync(f.path, otherPath);fs.chmodSync(otherPath, 0o600);
  expect(createEndpointRuntimeBinding(otherPath, f.config).readGroup("work").status).toBe("unbound");
  const h = queryHost(f);
  try {
    const port = {discover: () => h.query()};
    for (const args of [{group: "../work"}, {group: "work", endpoint: "pi/A"}, {group: ""}]) expect(() => callEndpointDiscovery(port, args)).toThrow();
  } finally {await h.bound.shutdown();}
});
