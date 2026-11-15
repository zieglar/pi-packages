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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer } from "../../src/control/mcp/server.js";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

afterEach(cleanupFixtures);
function setup(timers?: import("../../src/host/bound-endpoint.js").TimerSeams, now?: () => string) {
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
    exchangeNamespace: "live", exchangeIdempotencyKey: "test", payloadRead: { enabled: true }, ack: { enabled: true }, ...(now ? { now } : {}) });
  const bound = CeBoundEndpoint.start(host, "chatgpt/main", { admission: composition.admission, renewIntervalMs: 100000, ...(timers === undefined ? {} : { timers }) });
  return { ...f, ref, api, config, composition, host, bound };
}

it("routes a versioned shared selection through the real MCP server", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }, { endpointId: "pi/B" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test", payloadRead: { enabled: true } });
  pi.beginSession("pi/A");
  pi.bindNativeSession("pi/A", "native-A", 1);
  f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: true } });
  const first = f.api.selectTarget({ expectedDigest: readLivePolicy(f.ref).digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 });
  f.host.bindSelectedSession("chatgpt/main", { endpointId: "pi/A", policyId: f.ref.policyId, selectionVersion: first.snapshot.sequence, runtimeSessionId: "native-A", bindingEpoch: 1 });
  const server = createExchangeMcpServer("test", { port: f.bound, selectedTarget: f.composition.selectedTarget, discovery: { discover: (previous) => discoverLiveEndpoints(f.composition, f.bound, previous) } });
  const client = new Client({ name: "selection-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const send = (selectionVersion: number, key: string) => client.callTool({ name: "ce_send", arguments: { selectionVersion, text: "selected task", idempotencyKey: key } });
    const sent = await send(first.snapshot.sequence, "selection-a");
    expect(sent.isError).not.toBe(true);
    const messageId = (sent.structuredContent as { messageId: string }).messageId;
    expect(pi.readPayload("pi/A", { messageId }).payloadText).toBe("selected task");
    const incoming = pi.send("pi/A", { to: "chatgpt/main", text: "request", idempotencyKey: "pi-request" });
    const selectedReply = await client.callTool({ name: "ce_send", arguments: { selectionVersion: first.snapshot.sequence, text: "reply", idempotencyKey: "selected-reply", replyTo: incoming.messageId } });
    expect(selectedReply.isError).toBe(true);
    expect(pi.findReplies("pi/A", { requestMessageId: incoming.messageId }).replies).toEqual([]);
    const explicitReply = await client.callTool({ name: "ce_send", arguments: { to: "pi/A", text: "reply", idempotencyKey: "explicit-reply", replyTo: incoming.messageId } });
    expect(explicitReply.isError).not.toBe(true);
    expect(pi.findReplies("pi/A", { requestMessageId: incoming.messageId }).replies).toContainEqual({ messageId: (explicitReply.structuredContent as { messageId: string }).messageId });
    const second = f.api.register({ expectedDigest: first.snapshot.digest, registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: true } });
    pi.beginSession("pi/B");
    pi.bindNativeSession("pi/B", "native-B", 1);
    const changed = f.api.selectTarget({ expectedDigest: second.snapshot.digest, actorRuntimeSessionId: "native-A", endpointId: "pi/B", epoch: 1 });
    f.host.bindSelectedSession("chatgpt/main", { endpointId: "pi/B", policyId: f.ref.policyId, selectionVersion: changed.snapshot.sequence, runtimeSessionId: "native-B", bindingEpoch: 1 });
    expect(() => f.api.selectTarget({ expectedDigest: second.snapshot.digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 })).toThrow();
    expect((await client.callTool({ name: "ce_endpoints", arguments: {} })).structuredContent).toMatchObject({ selectedTarget: { endpointId: "pi/B", generation: changed.snapshot.sequence, scope: "shared-mcp-endpoint" } });
    expect((await send(first.snapshot.sequence, "stale")).isError).toBe(true);
    expect((await send(changed.snapshot.sequence, "selection-a")).isError).toBe(true);
    const sentB = await send(changed.snapshot.sequence, "selection-b");
    expect(sentB.isError).not.toBe(true);
    const messageB = (sentB.structuredContent as { messageId: string }).messageId;
    expect(pi.readPayload("pi/B", { messageId: messageB }).payloadText).toBe("selected task");
    expect(() => pi.readPayload("pi/A", { messageId: messageB })).toThrow();
    expect(pi.readPayload("pi/A", { messageId }).payloadText).toBe("selected task");
    const reply = pi.send("pi/A", { to: "chatgpt/main", text: "result A", idempotencyKey: "reply-a", replyTo: messageId });
    expect(() => pi.send("pi/B", { to: "chatgpt/main", text: "wrong sender", idempotencyKey: "reply-wrong", replyTo: messageId })).toThrow();
    const found = await client.callTool({ name: "ce_find_replies", arguments: { requestMessageId: messageId } });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent).toMatchObject({ requestMessageId: messageId, selectionVersion: first.snapshot.sequence, target: "pi/A", replies: [{ messageId: reply.messageId }] });
    expect((await client.callTool({ name: "ce_send", arguments: { to: "pi/A", text: "explicit", idempotencyKey: "explicit-a" } })).isError).not.toBe(true);
    const ambiguous = await client.callTool({ name: "ce_send", arguments: { to: "pi/A", selectionVersion: changed.snapshot.sequence, text: "ambiguous", idempotencyKey: "ambiguous" } });
    expect(ambiguous.isError).toBe(true);
    pi.end("pi/B");
    expect((await send(changed.snapshot.sequence, "offline")).isError).toBe(true);
    f.api.revoke({ expectedDigest: changed.snapshot.digest, endpointId: "pi/B" });
    expect((await send(changed.snapshot.sequence, "revoked")).isError).toBe(true);
  } finally { await client.close(); await server.close(); await f.bound.shutdown(); pi.end("pi/A"); }
}, 15000);

it("accepts a reply from the original request recipient", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }, { endpointId: "pi/B" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test", payloadRead: { enabled: true } });
  pi.beginSession("pi/A");
  try {
    const request = f.bound.send({ to: "pi/A", text: "task", idempotencyKey: "correlation-request" });
    const reply = pi.send("pi/A", { to: "chatgpt/main", text: "result", idempotencyKey: "correlation-reply", replyTo: request.messageId });
    expect(f.host.readPayload("chatgpt/main", { messageId: reply.messageId }).payloadText).toBe("result");
    expect(() => pi.send("pi/A", { to: "chatgpt/main", text: "changed", idempotencyKey: "correlation-reply", replyTo: request.messageId })).toThrow();
  } finally { await f.bound.shutdown(); pi.end("pi/A"); }
});

it("does not transfer an existing request when its target Endpoint is rebound", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  pi.beginSession("pi/A");
  try {
    const request = f.bound.send({ to: "pi/A", text: "task before rebind", idempotencyKey: "rebind-request" });
    pi.end("pi/A");
    pi.beginSession("pi/A");
    expect(pi.verifyTaskTarget("pi/A", request.messageId)).toBe(false);
    expect(() => pi.send("pi/A", { to: "chatgpt/main", text: "wrong session", idempotencyKey: "rebind-reply", replyTo: request.messageId })).toThrow();
    expect(f.bound.findReplies({ requestMessageId: request.messageId }).replies).toEqual([]);
  } finally { await f.bound.shutdown(); pi.end("pi/A"); }
});

it("retains request ownership after recovering the same live Session", async () => {
  const f = setup();
  const policy = { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" };
  const oldHost = new CeEndpointHost(f.store, policy);
  const mapping = oldHost.beginSession("pi/A");
  const recovered = new CeEndpointHost(f.store, policy);
  try {
    const request = f.bound.send({ to: "pi/A", text: "resume task", idempotencyKey: "resume-request" });
    recovered.resume("pi/A", mapping);
    const reply = recovered.send("pi/A", { to: "chatgpt/main", text: "recovered", idempotencyKey: "resume-reply", replyTo: request.messageId });
    expect(f.bound.findReplies({ requestMessageId: request.messageId }).replies).toEqual([{ messageId: reply.messageId }]);
  } finally { await f.bound.shutdown(); recovered.end("pi/A"); }
});

it("does not invent native identity for an explicit endpoint without a verified owner binding", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  const mapping = pi.beginSession("pi/A");
  try {
    const request = f.bound.send({ to: "pi/A", text: "task", idempotencyKey: "explicit-target-identity" });
    const link = f.store.database.prepare("SELECT target_runtime_session_id, binding_epoch, target_owner_session_id FROM message_association WHERE message_id=?").get(request.messageId);
    expect(link).toMatchObject({ target_runtime_session_id: null, binding_epoch: null, target_owner_session_id: mapping.sessionId });
    pi.bindNativeSession("pi/A", "native-A", 1);
    const verified = f.bound.send({ to: "pi/A", text: "verified task", idempotencyKey: "explicit-verified-identity" });
    expect(f.store.database.prepare("SELECT target_runtime_session_id, binding_epoch, target_owner_session_id FROM message_association WHERE message_id=?").get(verified.messageId)).toMatchObject({ target_runtime_session_id: "native-A", binding_epoch: 1, target_owner_session_id: mapping.sessionId });
    pi.end("pi/A");
    pi.beginSession("pi/A");
    const replay = f.bound.send({ to: "pi/A", text: "verified task", idempotencyKey: "explicit-verified-identity" });
    expect(replay.messageId).toBe(verified.messageId);
    expect(f.store.database.prepare("SELECT target_owner_session_id FROM message_association WHERE message_id=?").get(verified.messageId)).toMatchObject({ target_owner_session_id: mapping.sessionId });
  } finally { await f.bound.shutdown(); pi.end("pi/A"); }
});

it("allows historical reply lookup after the sender Endpoint receives a new Owner", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  pi.beginSession("pi/A");
  try {
    const request = f.bound.send({ to: "pi/A", text: "task", idempotencyKey: "sender-owner-request" });
    const reply = pi.send("pi/A", { to: "chatgpt/main", text: "reply", idempotencyKey: "sender-owner-reply", replyTo: request.messageId });
    await f.bound.shutdown();
    f.host.beginSession("chatgpt/main");
    const before = f.store.database.prepare("SELECT * FROM message_association WHERE message_id=?").get(request.messageId);
    const changes = f.store.database.prepare("SELECT total_changes() AS n").get();
    expect(f.host.findReplies("chatgpt/main", { requestMessageId: request.messageId }).replies).toEqual([{ messageId: reply.messageId }]);
    expect(f.store.database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    expect(f.store.database.prepare("SELECT * FROM message_association WHERE message_id=?").get(request.messageId)).toEqual(before);
  } finally { f.host.end("chatgpt/main"); pi.end("pi/A"); }
});

it("pages replies in creation order and rejects a cursor from another request", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  pi.beginSession("pi/A");
  try {
    const first = f.bound.send({ to: "pi/A", text: "first", idempotencyKey: "page-request-1" });
    const second = f.bound.send({ to: "pi/A", text: "second", idempotencyKey: "page-request-2" });
    const ids: string[] = [];
    for (let i = 0; i < 51; i++) ids.push(pi.send("pi/A", { to: "chatgpt/main", text: `reply ${i}`, idempotencyKey: `page-reply-${i}`, replyTo: first.messageId }).messageId);
    const page = f.bound.findReplies({ requestMessageId: first.messageId });
    expect(page.replies.map(r => r.messageId)).toEqual(ids.slice(0, 50));
    expect(page.hasMore).toBe(true);
    expect(f.bound.findReplies({ requestMessageId: first.messageId, afterMessageId: ids[49]! }).replies).toEqual([{ messageId: ids[50] }]);
    expect(() => f.bound.findReplies({ requestMessageId: second.messageId, afterMessageId: ids[0]! })).toThrow();
  } finally { await f.bound.shutdown(); pi.end("pi/A"); }
}, 30000);

it("refuses selected-task routing after an Endpoint is rebound without a verified native binding", async () => {
  const f = setup();
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  pi.beginSession("pi/A");
  pi.bindNativeSession("pi/A", "native-A", 1);
  f.api.register({ expectedDigest: readLivePolicy(f.ref).digest, registration: { endpointId: "pi/A", runtimeSessionId: "native-A", payloadRead: true, ack: true, presenceDisclosure: true } });
  const selected = f.api.selectTarget({ expectedDigest: readLivePolicy(f.ref).digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 });
  f.host.bindSelectedSession("chatgpt/main", { endpointId: "pi/A", policyId: f.ref.policyId, selectionVersion: selected.snapshot.sequence, runtimeSessionId: "native-A", bindingEpoch: 1 });
  const original = f.bound.send({ to: "pi/A", text: "original task", idempotencyKey: "rebind-original" }, { policyId: f.ref.policyId, selectionVersion: selected.snapshot.sequence, targetRuntimeSessionId: "native-A", bindingEpoch: 1 });
  expect(pi.verifyTaskTarget("pi/A", original.messageId)).toBe(true);
  pi.end("pi/A");
  pi.beginSession("pi/A");
  expect(pi.verifyTaskTarget("pi/A", original.messageId)).toBe(false);
  const server = createExchangeMcpServer("test", { port: f.bound, selectedTarget: f.composition.selectedTarget, discovery: { discover: (previous) => discoverLiveEndpoints(f.composition, f.bound, previous) } });
  const client = new Client({ name: "rebound-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const result = await client.callTool({ name: "ce_send", arguments: { selectionVersion: selected.snapshot.sequence, text: "must not misroute", idempotencyKey: "unverified-rebound" } });
    expect(result.isError).toBe(true);
    pi.bindNativeSession("pi/A", "native-A", 1);
    const stillStale = await client.callTool({ name: "ce_send", arguments: { selectionVersion: selected.snapshot.sequence, text: "old selection", idempotencyKey: "rebound-old-selection" } });
    expect(stillStale.isError).toBe(true);
    const reselected = f.api.selectTarget({ expectedDigest: readLivePolicy(f.ref).digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 });
    f.host.bindSelectedSession("chatgpt/main", { endpointId: "pi/A", policyId: f.ref.policyId, selectionVersion: reselected.snapshot.sequence, runtimeSessionId: "native-A", bindingEpoch: 1 });
    const fresh = await client.callTool({ name: "ce_send", arguments: { selectionVersion: reselected.snapshot.sequence, text: "new selection", idempotencyKey: "verified-rebound" } });
    expect(fresh.isError).not.toBe(true);
  } finally { await client.close(); await server.close(); await f.bound.shutdown(); pi.end("pi/A"); }
}, 15000);

it("holds the SQLite writer fence while capturing the selected target", async () => {
  let attempt: (() => void) | undefined;
  const f = setup(undefined, () => { attempt?.(); return new Date().toISOString(); });
  const pi = new CeEndpointHost(f.store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "live", exchangeIdempotencyKey: "test" });
  const owner = pi.beginSession("pi/A");
  pi.bindNativeSession("pi/A", "native-A", 1);
  const selected = f.api.selectTarget({ expectedDigest: readLivePolicy(f.ref).digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 });
  f.host.bindSelectedSession("chatgpt/main", { endpointId: "pi/A", policyId: f.ref.policyId, selectionVersion: selected.snapshot.sequence, runtimeSessionId: "native-A", bindingEpoch: 1 });
  const concurrent = new DatabaseSync(f.databasePath, { timeout: 0 });
  let blocked = false;
  attempt = () => {
    try { concurrent.exec("BEGIN IMMEDIATE"); concurrent.exec("ROLLBACK"); } catch { blocked = true; attempt = undefined; }
  };
  try {
    const sent = f.bound.send({ to: "pi/A", text: "concurrent selection", idempotencyKey: "selection-lock" }, { policyId: f.ref.policyId, selectionVersion: selected.snapshot.sequence, targetRuntimeSessionId: "native-A", bindingEpoch: 1 });
    expect(blocked).toBe(true);
    expect(f.store.database.prepare("SELECT target_owner_session_id,target_runtime_session_id,binding_epoch FROM message_association WHERE message_id=?").get(sent.messageId)).toMatchObject({ target_owner_session_id: owner.sessionId, target_runtime_session_id: "native-A", binding_epoch: 1 });
    pi.end("pi/A");
    pi.beginSession("pi/A");
    expect(f.store.database.prepare("SELECT target_owner_session_id,target_runtime_session_id,binding_epoch FROM message_association WHERE message_id=?").get(sent.messageId)).toMatchObject({ target_owner_session_id: owner.sessionId, target_runtime_session_id: "native-A", binding_epoch: 1 });
    expect(pi.verifyTaskTarget("pi/A", sent.messageId)).toBe(false);
  } finally { concurrent.close(); await f.bound.shutdown(); pi.end("pi/A"); }
}, 15000);

it("old live-policy reader refuses a new selection instead of choosing a target", async () => {
  const f = setup();
  const legacyPath = join(process.cwd(), "dist/tunnel", `.legacy-selection-${randomUUID()}.mjs`);
  const source = execFileSync("git", ["show", "e4c95586803476ed48ee9bfd3cb6e6d1f02ae58b:packages/pi-chat-exchange/src/tunnel/live-session-policy.ts"], { encoding: "utf8" });
  fs.writeFileSync(legacyPath, ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText, { mode: 0o600 });
  const probe = (expected: "accepted" | "refused") => execFileSync(process.execPath, ["--input-type=module", "-e",
    "const [moduleUrl, refJson, expected] = process.argv.slice(1); const m = await import(moduleUrl); let outcome; try { m.readLivePolicy(JSON.parse(refJson)); outcome = 'accepted'; } catch { outcome = 'refused'; } if (outcome !== expected) process.exitCode = 1;",
    pathToFileURL(legacyPath).href, JSON.stringify(f.ref), expected], { stdio: "pipe", timeout: 15000 });
  try {
    probe("accepted");
    f.api.selectTarget({ expectedDigest: readLivePolicy(f.ref).digest, actorRuntimeSessionId: "native-A", endpointId: "pi/A", epoch: 1 });
    probe("refused");
    expect(readLivePolicy(f.ref).manifest.selectedTarget?.endpointId).toBe("pi/A");
  } finally { fs.rmSync(legacyPath, { force: true }); await f.bound.shutdown(); }
}, 20000);

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
