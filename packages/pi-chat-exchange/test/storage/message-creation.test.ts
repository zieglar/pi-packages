import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { afterEach, expect, it } from "vitest";
import { EventSchema, MessageSchema } from "../../src/protocol/entities.js";
import { canonicalDigest } from "../../src/protocol/idempotency.js";
import { EVENT_ID_PATTERN, MESSAGE_ID_PATTERN } from "../../src/protocol/identity.js";
import { initializeStore, type DurableStore } from "../../src/storage/store.js";
import {
  MAX_CREATION_PAYLOAD_BYTES, copyCapturedMessagePayloadForPersistence,
  normalizeCreateMessageRequest,
} from "../../src/storage/creation-request.js";
import { createExchange, createMessage, type MessageCreation } from "../../src/storage/creation.js";
import { ConditionalMutationError } from "../../src/storage/transaction.js";

const exchangeTime = "2026-10-08T20:00:00.000Z";
const timestamp = "2026-10-08T21:00:00.000Z";
const from = { adapter: "pi", endpointId: "producer-1" };
const to = { adapter: "pi", endpointId: "consumer-1" };
const bytes = () => new Uint8Array([1, 2, 3, 4, 5]);
const sha256 = (input: Uint8Array) => createHash("sha256").update(input).digest("hex");
const namespaceOf = (exchangeId: string) => JSON.stringify(["message.create", exchangeId]);
const digestOf = (exchangeId: string, payload: Uint8Array = bytes(), endpoints = { from, to }) =>
  canonicalDigest({
    op: "chat-exchange/message.create", v: 1, exchangeId, from: endpoints.from, to: endpoints.to,
    payloadDigest: sha256(payload), payloadLength: payload.byteLength,
  });

interface Fixture { root: string; store: DurableStore; reader: DatabaseSync; exchangeId: string }
const fixtures: Fixture[] = [];
function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s3-"));
  const directory = join(root, "db");
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: 25 });
  const reader = new DatabaseSync(join(directory, "store.sqlite"), { readOnly: true });
  const exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" },
    { now: () => exchangeTime }).exchange.exchangeId;
  const result = { root, store, reader, exchangeId };
  fixtures.push(result);
  return result;
}
const request = (exchangeId: string, overrides: Record<string, unknown> = {}) =>
  ({ exchangeId, from, to, payload: bytes(), idempotencyKey: "message-key", ...overrides });
function snapshot(db: DatabaseSync) {
  return ["message", "idempotency_record", "audit_event", "exchange"].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) => ({ ...row })));
}
function changes(db: DatabaseSync) { return db.prepare("SELECT total_changes() AS n").get()!.n; }
function failed(action: () => unknown, code: string, outcome = "ROLLED_BACK", retryable = false) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({ code, outcome, retryable });
  expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  expect(String((caught as Error).stack)).not.toContain("SENSITIVE_SECRET");
  expect(JSON.stringify(caught)).not.toContain("SENSITIVE_SECRET");
  return caught;
}
function rejectedRequest(action: () => unknown) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toMatchObject({ code: "STORAGE_CREATE_REQUEST_INVALID", retryable: false });
  expect(Object.hasOwn(caught as object, "cause")).toBe(false);
  expect(JSON.stringify(caught)).not.toContain("SENSITIVE_SECRET");
  return caught;
}
/** Privileged raw fixture only: the FK chain for a disposition is out of S3-A scope. */
function recordDisposition(store: DurableStore, exchangeId: string) {
  store.database.exec("PRAGMA foreign_keys=OFF");
  store.database.prepare(
    "INSERT INTO disposition(exchange_id, status, owner_id, recorded_at, reason, reconciliation_id, unresolved_json) VALUES (?, 'ABANDONED_UNRESOLVED', 'owner', ?, 'operator abandoned', ?, '[]')",
  ).run(exchangeId, timestamp, `rec_${exchangeId}`);
  store.database.exec("PRAGMA foreign_keys=ON");
}
function closeExchangeRaw(store: DurableStore, exchangeId: string) {
  store.database.prepare("UPDATE exchange SET state='CLOSED', closed_at=? WHERE exchange_id=?")
    .run("2026-10-09T20:00:00.000Z", exchangeId);
}
afterEach(() => {
  for (const { root, store, reader } of fixtures.splice(0)) {
    reader.close();
    try { store.close(); } catch { /* intentionally invalidated connection */ }
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- snapshot bridge

it("SB1 returns a fresh persistence copy of the authoritative snapshot", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  const copy = copyCapturedMessagePayloadForPersistence(normalized);
  expect(copy).toBeInstanceOf(Uint8Array);
  expect([...copy]).toEqual([...bytes()]);
  expect(sha256(copy)).toBe(normalized.payloadDigest);
  expect(copy.byteLength).toBe(normalized.payloadLength);
});

it("SB2 rejects a structurally identical plain-object lookalike", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  const lookalike = { ...normalized };
  rejectedRequest(() => copyCapturedMessagePayloadForPersistence(lookalike));
});

it("SB3 rejects an object forged on the genuine prototype", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  const forged = Object.create(
    Object.getPrototypeOf(normalized) as object,
    Object.getOwnPropertyDescriptors(normalized),
  ) as typeof normalized;
  rejectedRequest(() => copyCapturedMessagePayloadForPersistence(forged));
});

it("SB4 ignores caller mutation of the original bytes after normalization", () => {
  const payload = bytes();
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", { payload }));
  payload.fill(255);
  const copy = copyCapturedMessagePayloadForPersistence(normalized);
  expect([...copy]).toEqual([...bytes()]);
});

it("SB5 returns independent copies that cannot affect each other", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  const first = copyCapturedMessagePayloadForPersistence(normalized);
  first.fill(0);
  const second = copyCapturedMessagePayloadForPersistence(normalized);
  expect(first).not.toBe(second);
  expect([...second]).toEqual([...bytes()]);
});

it("SB6 never returns the authoritative snapshot and exposes no payload accessor", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  expect(Reflect.ownKeys(normalized)).not.toContain("payload");
  expect(Object.keys(normalized).sort()).toEqual([
    "exchangeId", "from", "fromEndpointJson", "idempotencyKey", "namespace",
    "payloadDigest", "payloadLength", "requestDigest", "to", "toEndpointJson",
  ]);
  expect(Object.getOwnPropertyNames(Object.getPrototypeOf(normalized) as object)).toEqual(["constructor"]);
  const a = copyCapturedMessagePayloadForPersistence(normalized);
  const b = copyCapturedMessagePayloadForPersistence(normalized);
  expect(a).not.toBe(b);
  a.fill(9);
  expect(sha256(copyCapturedMessagePayloadForPersistence(normalized))).toBe(normalized.payloadDigest);
});

it("SB7 sanitizes provenance failure without caller causes or secret values", () => {
  const error = rejectedRequest(() => copyCapturedMessagePayloadForPersistence(
    { payloadDigest: "SENSITIVE_SECRET" } as never,
  ));
  expect((error as Error).message).not.toContain("SENSITIVE_SECRET");
});

it("SB8 keeps stored bytes after the temporary persistence copy is zeroed", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  const stored = reader.prepare("SELECT payload_body FROM message WHERE message_id=?")
    .get(result.message.messageId)!.payload_body as Uint8Array;
  expect([...stored]).toEqual([...bytes()]);
  expect(sha256(stored)).toBe(result.message.payloadDigest);
});

it("SB9 rejects a Proxy-wrapped genuine request without invoking any trap", () => {
  const normalized = normalizeCreateMessageRequest(request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"));
  const traps: string[] = [];
  const wrapped = new Proxy(normalized, {
    get(target, property, receiver) { traps.push(String(property)); return Reflect.get(target, property, receiver); },
    getOwnPropertyDescriptor(target, property) { traps.push(`descriptor:${String(property)}`); return Reflect.getOwnPropertyDescriptor(target, property); },
  });
  rejectedRequest(() => copyCapturedMessagePayloadForPersistence(wrapped));
  expect(traps).toEqual([]);
  const revocable = Proxy.revocable(normalized, {});
  revocable.revoke();
  rejectedRequest(() => copyCapturedMessagePayloadForPersistence(revocable.proxy));
});

it("SB10 copy cleanup never replaces the transaction failure classification", () => {
  const { store, reader, exchangeId } = fixture();
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "ROLLBACK") throw Error("SENSITIVE_SECRET"); original(sql); };
  failed(() => createMessage(store, request(exchangeId), {
    afterMessageInsert: () => { throw Error("SENSITIVE_SECRET"); },
  }), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(() => store.database.prepare("SELECT 1")).toThrow();
  expect(snapshot(reader).map((rows) => rows.length)).toEqual([0, 1, 1, 1]);
});

// ---------------------------------------------------------------- message creation

it("M1 creates one schema-valid CREATED Message", () => {
  const { store, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  expect(result.disposition).toBe("CREATED");
  expect(result.message).toEqual({
    messageId: expect.stringMatching(MESSAGE_ID_PATTERN), exchangeId, from, to, state: "CREATED",
    payloadDigest: sha256(bytes()), payloadLength: 5, createdAt: timestamp, idempotencyKey: "message-key",
  });
  expect(Value.Check(MessageSchema, result.message)).toBe(true);
});

it("M2 generates msg_ and evt_ identities", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  expect(result.message.messageId).toMatch(MESSAGE_ID_PATTERN);
  const events = reader.prepare("SELECT event_id FROM audit_event WHERE kind='message_created'").all();
  expect(events).toHaveLength(1);
  expect(events[0]!.event_id).toMatch(EVENT_ID_PATTERN);
});

it("M3 persists exact endpoints, digest, length, body, key, timestamp and revision", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  expect({ ...reader.prepare("SELECT * FROM message").get() }).toEqual({
    message_id: result.message.messageId, exchange_id: exchangeId,
    from_endpoint_json: JSON.stringify(from), to_endpoint_json: JSON.stringify(to),
    state: "CREATED", payload_digest: sha256(bytes()), payload_length: 5,
    payload_body: bytes(), created_at: timestamp, idempotency_key: "message-key", private_revision: 1,
  });
  expect({ ...reader.prepare("SELECT * FROM idempotency_record WHERE namespace=?").get(namespaceOf(exchangeId))! }).toEqual({
    namespace: namespaceOf(exchangeId), idempotency_key: "message-key", request_digest: digestOf(exchangeId),
    entity_id: result.message.messageId, created_at: timestamp, private_revision: 1,
  });
  expect(result.record).toEqual({ entityId: result.message.messageId, requestDigest: digestOf(exchangeId), createdAt: timestamp });
});

it("M4 never transitions to QUEUED", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  expect(reader.prepare("SELECT state FROM message").all().map((row) => row.state)).toEqual(["CREATED"]);
  expect(reader.prepare("SELECT kind FROM audit_event ORDER BY sequence").all().map((row) => row.kind))
    .toEqual(["exchange_opened", "message_created"]);
});

it("M5 returns deeply frozen fresh results", () => {
  const { store, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId));
  for (const value of [result, result.message, result.record, result.message.from, result.message.to]) {
    expect(Object.isFrozen(value)).toBe(true);
  }
  const replay = createMessage(store, request(exchangeId));
  expect(replay.message).not.toBe(result.message);
  expect(Object.isFrozen(replay.message)).toBe(true);
});

it("M6 commits all three rows visibly to an independent read-only connection", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  expect(snapshot(reader).map((rows) => rows.length)).toEqual([1, 2, 2, 1]);
  expect(store.database.isTransaction).toBe(false);
});

it("M7 persists an empty payload as a zero-length body", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId, { payload: new Uint8Array(0) }));
  expect(result.message.payloadLength).toBe(0);
  expect(result.message.payloadDigest).toBe(sha256(new Uint8Array(0)));
  const row = reader.prepare("SELECT payload_body, payload_length FROM message").get()!;
  expect((row.payload_body as Uint8Array).byteLength).toBe(0);
  expect(row.payload_length).toBe(0);
});

it("M8 accepts the maximum authorized payload size", () => {
  const { store, reader, exchangeId } = fixture();
  const payload = new Uint8Array(MAX_CREATION_PAYLOAD_BYTES).fill(7);
  const result = createMessage(store, request(exchangeId, { payload }));
  expect(result.message.payloadLength).toBe(MAX_CREATION_PAYLOAD_BYTES);
  const stored = reader.prepare("SELECT payload_body FROM message").get()!.payload_body as Uint8Array;
  expect(stored.byteLength).toBe(MAX_CREATION_PAYLOAD_BYTES);
  expect(sha256(stored)).toBe(sha256(payload));
});

it("M9 rejects an oversized payload before any transaction", () => {
  const { store, reader, exchangeId } = fixture();
  let begins = 0;
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { begins++; original(sql); };
  rejectedRequest(() => createMessage(store, request(exchangeId, { payload: new Uint8Array(MAX_CREATION_PAYLOAD_BYTES + 1) })));
  expect(begins).toBe(0);
  expect(snapshot(reader).map((rows) => rows.length)).toEqual([0, 1, 1, 1]);
});

// ---------------------------------------------------------------- idempotency

it("I1 replays the original Message for the same key and request", () => {
  const { store, exchangeId } = fixture();
  const first = createMessage(store, request(exchangeId), { now: () => timestamp });
  const replay = createMessage(store, request(exchangeId), { now: () => "2026-10-09T21:00:00.000Z" });
  expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
});

it("I2 replay preserves creation metadata and current stored state", () => {
  const { store, exchangeId } = fixture();
  const first = createMessage(store, request(exchangeId), { now: () => timestamp });
  store.database.prepare("UPDATE message SET state='QUEUED' WHERE message_id=?").run(first.message.messageId);
  const replay = createMessage(store, request(exchangeId));
  expect(replay.message).toMatchObject({ state: "QUEUED", createdAt: timestamp, messageId: first.message.messageId });
});

it("I3 replay performs zero writes and calls no hook", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  const before = snapshot(reader), count = changes(store.database);
  const unexpected = () => { throw Error("replay wrote"); };
  const replay = createMessage(store, request(exchangeId), {
    afterMessageInsert: unexpected, afterIdempotencyInsert: unexpected, afterAuditInsert: unexpected,
  });
  expect(replay.disposition).toBe("REPLAYED");
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("I4 conflicts when the same key carries a different payload", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId, { payload: new Uint8Array([9, 9]) })), "IDEMPOTENCY_KEY_CONFLICT");
  expect(snapshot(reader)).toEqual(before);
});

it("I5 conflicts when the same key carries a different endpoint", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId, { to: { adapter: "pi", endpointId: "consumer-2" } })), "IDEMPOTENCY_KEY_CONFLICT");
  expect(snapshot(reader)).toEqual(before);
});

it("I6 creates distinct Messages for different keys in one Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  const a = createMessage(store, request(exchangeId));
  const b = createMessage(store, request(exchangeId, { idempotencyKey: "second-key" }));
  expect(a.message.messageId).not.toBe(b.message.messageId);
  expect(reader.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 2 });
});

it("I7 scopes the namespace per Exchange without in-memory state", () => {
  const { store, reader, exchangeId } = fixture();
  const other = createExchange(store, { namespace: "owner", idempotencyKey: "second-exchange" }).exchange.exchangeId;
  createMessage(store, request(exchangeId));
  createMessage(store, request(other));
  expect(reader.prepare("SELECT namespace FROM idempotency_record WHERE namespace LIKE '[\"message.create%' ORDER BY namespace").all()
    .map((row) => row.namespace).sort()).toEqual([namespaceOf(exchangeId), namespaceOf(other)].sort());
});

it("I8 treats a valid different stored request as conflict, not corruption", () => {
  const { store, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  const error = failed(() => createMessage(store, request(exchangeId, { payload: new Uint8Array([7]) })), "IDEMPOTENCY_KEY_CONFLICT");
  expect((error as { code: string }).code).not.toBe("STORAGE_IDEMPOTENCY_CORRUPT");
});

// ---------------------------------------------------------------- admission

it("A1 refuses a Message for a missing Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  const before = snapshot(reader);
  failed(() => createMessage(store, request("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV")), "STORAGE_EXCHANGE_NOT_FOUND");
  expect(snapshot(reader)).toEqual(before);
  expect(createMessage(store, request(exchangeId)).disposition).toBe("CREATED");
});

it.each([
  ["unsupported revision", "UPDATE exchange SET private_revision=2", undefined],
  ["malformed creation timestamp", "UPDATE exchange SET created_at='SENSITIVE_SECRET'", undefined],
])("A2 refuses a malformed durable Exchange (%s)", (_name, sql) => {
  const { store, reader, exchangeId } = fixture();
  store.database.exec(sql);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
});

it("A3 refuses new creation against a CLOSED Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  closeExchangeRaw(store, exchangeId);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId)), "EXCHANGE_DISPOSITION_REJECTED");
  expect(snapshot(reader)).toEqual(before);
});

it("A4 refuses new creation against a dispositioned Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  recordDisposition(store, exchangeId);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId)), "EXCHANGE_DISPOSITION_REJECTED");
  expect(snapshot(reader)).toEqual(before);
});

it("A5 allows zero-write replay after the Exchange is CLOSED", () => {
  const { store, reader, exchangeId } = fixture();
  const first = createMessage(store, request(exchangeId), { now: () => timestamp });
  closeExchangeRaw(store, exchangeId);
  const before = snapshot(reader), count = changes(store.database);
  expect(createMessage(store, request(exchangeId))).toEqual({ ...first, disposition: "REPLAYED" });
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("A6 allows zero-write replay after a disposition is recorded", () => {
  const { store, reader, exchangeId } = fixture();
  const first = createMessage(store, request(exchangeId), { now: () => timestamp });
  recordDisposition(store, exchangeId);
  const before = snapshot(reader), count = changes(store.database);
  expect(createMessage(store, request(exchangeId))).toEqual({ ...first, disposition: "REPLAYED" });
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("A7 keeps conflict classification after CLOSED without consulting admission", () => {
  const { store, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  closeExchangeRaw(store, exchangeId);
  failed(() => createMessage(store, request(exchangeId, { payload: new Uint8Array([4]) })), "IDEMPOTENCY_KEY_CONFLICT");
});

it("A8 refuses an orphan Message holding the same Exchange-scoped key", () => {
  const { store, reader, exchangeId } = fixture();
  store.database.prepare(
    "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, 'message-key', 1)",
  ).run("msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", exchangeId, JSON.stringify(from), JSON.stringify(to), sha256(bytes()), 5, bytes(), timestamp);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
});

// ---------------------------------------------------------------- durable corruption

it.each([
  ["malformed record digest", "UPDATE idempotency_record SET request_digest='gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg' WHERE idempotency_key='message-key'"],
  ["well-formed but inconsistent record digest", "UPDATE idempotency_record SET request_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE idempotency_key='message-key'"],
  ["wrong entity kind", "UPDATE idempotency_record SET entity_id='ho_01ARZ3NDEKTSV4RRFFQ69G5FAV' WHERE idempotency_key='message-key'"],
  ["missing referenced Message", "UPDATE idempotency_record SET entity_id='msg_01ARZ3NDEKTSV4RRFFQ69G5FAV' WHERE idempotency_key='message-key'"],
  ["invalid entity identity", "UPDATE idempotency_record SET entity_id='SENSITIVE_SECRET' WHERE idempotency_key='message-key'"],
  ["record timestamp mismatch", "UPDATE idempotency_record SET created_at='2026-10-09T21:00:00.000Z' WHERE idempotency_key='message-key'"],
  ["record unsupported revision", "UPDATE idempotency_record SET private_revision=2 WHERE idempotency_key='message-key'"],
  ["Message unsupported revision", "UPDATE message SET private_revision=2"],
  ["Message key mismatch", "UPDATE message SET idempotency_key='other-key'"],
  ["null payload body", "UPDATE message SET payload_body=NULL"],
  ["payload body hash mismatch", "UPDATE message SET payload_body=x'00'"],
  ["payload length mismatch", "UPDATE message SET payload_length=4"],
  ["malformed payload digest", "UPDATE message SET payload_digest='gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg'"],
  ["payload digest mismatch", "UPDATE message SET payload_digest='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'"],
  ["malformed Message timestamp", "UPDATE message SET created_at='SENSITIVE_SECRET'"],
  ["schema-invalid endpoint JSON", `UPDATE message SET from_endpoint_json='{"adapter":"pi"}'`],
  ["inconsistent endpoint JSON", `UPDATE message SET from_endpoint_json='{"adapter":"pi","endpointId":"other"}'`],
  ["foreign endpoint field", `UPDATE message SET to_endpoint_json='{"adapter":"pi","endpointId":"consumer-1","secret":"SENSITIVE_SECRET"}'`],
])("refuses corrupt durable creation state: %s", (_name, sql) => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  store.database.exec(sql);
  const before = snapshot(reader), count = changes(store.database);
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("refuses a Message relocated to a foreign Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  const other = createExchange(store, { namespace: "owner", idempotencyKey: "second-exchange" }).exchange.exchangeId;
  const created = createMessage(store, request(exchangeId), { now: () => timestamp });
  store.database.prepare("UPDATE idempotency_record SET namespace=? WHERE entity_id=?").run(namespaceOf(other), created.message.messageId);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(other)), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
});

// ---------------------------------------------------------------- atomicity

it.each(["afterMessageInsert", "afterIdempotencyInsert", "afterAuditInsert"] as const)(
  "T1-T3 rolls back every row after %s fails", (hook) => {
    const { store, reader, exchangeId } = fixture();
    const before = snapshot(reader);
    failed(() => createMessage(store, request(exchangeId), {
      [hook]: () => { throw new Proxy(Error("SENSITIVE_SECRET"), { get() { throw Error("must not inspect"); } }); },
    }), "STORAGE_TRANSACTION_FAILED");
    expect(snapshot(reader)).toEqual(before);
    expect(store.database.isTransaction).toBe(false);
    expect(createMessage(store, request(exchangeId)).disposition).toBe("CREATED");
  });

it("T4 preserves conditional-mutation classification on unexpected change counts", () => {
  const { store, reader, exchangeId } = fixture();
  const before = snapshot(reader);
  const original = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = original(sql);
    if (sql.startsWith("INSERT INTO message")) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => ({ ...run(...args), changes: 0 })) as typeof statement.run;
    }
    return statement;
  };
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_CONDITIONAL_MUTATION_FAILED");
  expect(snapshot(reader)).toEqual(before);
});

it("T5 preserves domain errors on proven rollback", () => {
  const { store, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  store.database.exec("UPDATE message SET payload_length=99");
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_IDEMPOTENCY_CORRUPT");
});

it("T6 lets rollback uncertainty override corruption classification", () => {
  const { store, exchangeId } = fixture();
  createMessage(store, request(exchangeId), { now: () => timestamp });
  store.database.exec("UPDATE message SET payload_length=99");
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "ROLLBACK") throw Error("SENSITIVE_SECRET"); original(sql); };
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(() => store.database.prepare("SELECT 1")).toThrow();
});

it("T7 publishes nothing when the commit outcome is uncertain", () => {
  const { store, reader, exchangeId } = fixture();
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { original(sql); if (sql === "COMMIT") throw Error("SENSITIVE_SECRET"); };
  let published: MessageCreation | undefined;
  failed(() => { published = createMessage(store, request(exchangeId)); }, "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(published).toBeUndefined();
  expect(snapshot(reader).map((rows) => rows.length)).toEqual([1, 2, 2, 1]);
  expect(() => store.database.prepare("SELECT 1")).toThrow();
});

it("T8 attempts BEGIN IMMEDIATE exactly once when BUSY", () => {
  const { store, reader, root, exchangeId } = fixture();
  const blocker = new DatabaseSync(join(root, "db", "store.sqlite"));
  let begins = 0;
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "BEGIN IMMEDIATE") begins++; original(sql); };
  try {
    blocker.exec("BEGIN IMMEDIATE");
    failed(() => createMessage(store, request(exchangeId)), "STORAGE_TRANSACTION_BUSY", "ROLLED_BACK", true);
    expect(begins).toBe(1);
    expect(snapshot(reader).map((rows) => rows.length)).toEqual([0, 1, 1, 1]);
  } finally { blocker.exec("ROLLBACK"); blocker.close(); }
});

it("T9 rejects non-undefined hook results without reading hostile fields", () => {
  const { store, reader, exchangeId } = fixture();
  const before = snapshot(reader);
  const hostile = new Proxy({}, { get() { throw Error("SENSITIVE_SECRET"); } });
  failed(() => createMessage(store, request(exchangeId), { afterMessageInsert: () => hostile }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual(before);
});

it("T10 private hooks receive no capability, bytes or result arguments", () => {
  const { store, exchangeId } = fixture();
  const calls: unknown[][] = [];
  const hook = (...args: unknown[]) => { calls.push(args); };
  createMessage(store, request(exchangeId), { afterMessageInsert: hook, afterIdempotencyInsert: hook, afterAuditInsert: hook });
  expect(calls).toEqual([[], [], []]);
});

it("does not unwrap a caller-owned conditional error from a seam accessor", () => {
  const { store, reader, exchangeId } = fixture();
  const seams = Object.defineProperty({}, "afterMessageInsert", {
    get() { throw new ConditionalMutationError("SENSITIVE_SECRET"); },
  });
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId), seams), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual(before);
});

// ---------------------------------------------------------------- audit

it("AU1 appends sequence 2 for the first Message of an Exchange", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  const events = reader.prepare("SELECT * FROM audit_event ORDER BY sequence").all().map((row) => ({ ...row }));
  expect(events[1]).toMatchObject({ sequence: 2, kind: "message_created", subject_id: result.message.messageId });
});

it("AU2 assigns monotonically increasing unique sequences", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId));
  createMessage(store, request(exchangeId, { idempotencyKey: "second-key" }));
  expect(reader.prepare("SELECT sequence, kind FROM audit_event ORDER BY sequence").all().map((row) => row.sequence))
    .toEqual([1, 2, 3]);
});

it("AU3 records digest, length, subject and timestamp without body or endpoints", () => {
  const { store, reader, exchangeId } = fixture();
  const result = createMessage(store, request(exchangeId), { now: () => timestamp });
  const event = { ...reader.prepare("SELECT * FROM audit_event WHERE kind='message_created'").get()! };
  expect(event).toEqual({
    event_id: expect.stringMatching(EVENT_ID_PATTERN), exchange_id: exchangeId, sequence: 2,
    kind: "message_created", subject_id: result.message.messageId, created_at: timestamp,
    digest: sha256(bytes()), length: 5, outcome: null, private_revision: 1,
  });
  expect(Value.Check(EventSchema, {
    eventId: event.event_id, exchangeId, sequence: 2, kind: "message_created",
    subjectId: result.message.messageId, createdAt: timestamp, digest: sha256(bytes()), length: 5,
  })).toBe(true);
  expect(JSON.stringify(event)).not.toContain("producer-1");
});

it("AU4 appends no event on replay", () => {
  const { store, reader, exchangeId } = fixture();
  createMessage(store, request(exchangeId));
  createMessage(store, request(exchangeId));
  expect(reader.prepare("SELECT count(*) AS n FROM audit_event").get()).toEqual({ n: 2 });
});

it("AU5 refuses an unsafe next audit sequence without partial writes", () => {
  const { store, reader, exchangeId } = fixture();
  store.database.prepare(
    "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, 9007199254740991, 'message_created', ?, ?, 1)",
  ).run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", exchangeId, exchangeId, timestamp);
  const before = snapshot(reader);
  failed(() => createMessage(store, request(exchangeId)), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
});

it("AU6 never relabels an audit uniqueness failure as an idempotency race", () => {
  const { store, reader, exchangeId } = fixture();
  store.database.prepare(
    "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, 2, 'message_created', ?, ?, 1)",
  ).run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", exchangeId, exchangeId, timestamp);
  // Force a stale sequence allocation so the UNIQUE(exchange_id, sequence)
  // backstop fires on a sequence the occupied row already owns.
  const original = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = original(sql);
    if (sql.includes("MAX(sequence)")) {
      return Object.assign(statement, { get: () => ({ maximum: 1 }) }) as typeof statement;
    }
    return statement;
  };
  const before = snapshot(reader);
  const error = failed(() => createMessage(store, request(exchangeId)), "STORAGE_TRANSACTION_FAILED");
  expect((error as { code: string }).code).not.toBe("STORAGE_IDEMPOTENCY_RACE");
  expect(snapshot(reader)).toEqual(before);
});

// ---------------------------------------------------------------- architecture

it("keeps Message creation private with no premature resolution or payload access", () => {
  const barrel = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const creation = readFileSync(new URL("../../src/storage/creation.ts", import.meta.url), "utf8");
  const normalizer = readFileSync(new URL("../../src/storage/creation-request.ts", import.meta.url), "utf8");
  expect(barrel).not.toMatch(/storage|creation|createMessage/);
  expect(creation).not.toMatch(/export\s+function\s+resolve\w+Creation/i);
  expect(creation).not.toContain("#payload");
  expect(creation).toMatch(/export function createMessage/);
  expect(creation).not.toMatch(/UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|ON\s+CONFLICT/i);
  expect(creation).not.toMatch(/'QUEUED'|"QUEUED"/);
  expect(normalizer).not.toMatch(/node:sqlite|transaction\.js|DatabaseSync/);
  expect(normalizer).not.toMatch(/export\s+(?:class|const)\s+CapturedMessage/);
});

it("normalizes invalid Message input before any transaction", () => {
  const { store, reader, exchangeId } = fixture();
  let begins = 0;
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { begins++; original(sql); };
  rejectedRequest(() => createMessage(store, { ...request(exchangeId), get from() { throw Error("SENSITIVE_SECRET"); } }));
  expect(begins).toBe(0);
  expect(snapshot(reader).map((rows) => rows.length)).toEqual([0, 1, 1, 1]);
});

it("accepts bound SQL punctuation without injection", () => {
  const { store, reader, exchangeId } = fixture();
  const input = request(exchangeId, { idempotencyKey: "key'); DROP TABLE message; --" });
  const created = createMessage(store, input);
  expect(createMessage(store, input)).toEqual({ ...created, disposition: "REPLAYED" });
  expect(reader.prepare("SELECT idempotency_key FROM message").get()).toEqual({ idempotency_key: "key'); DROP TABLE message; --" });
});

/** Quote every SQL value as text so corrupt int64 values remain observable. */
function losslessSnapshot(db: DatabaseSync) {
  return ["message", "idempotency_record", "exchange", "audit_event"].map((table) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => {
      const name = String(row.name).replaceAll('"', '""');
      return `quote("${name}") AS "${name}"`;
    });
    return db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid`).all();
  });
}

const unsafeIntegerMutations = [
  ["payload length", "UPDATE message SET payload_length=9007199254740992", false],
  ["Message revision", "UPDATE message SET private_revision=9007199254740992", false],
  ["record revision", "UPDATE idempotency_record SET private_revision=9007199254740992 WHERE idempotency_key='m'", false],
  ["Exchange revision", "UPDATE exchange SET private_revision=9007199254740992", true],
] as const;

it.each(unsafeIntegerMutations)("R1 classifies unsafe %s as corruption without writes", (_name, sql, newKey) => {
  const { store, reader, exchangeId } = fixture();
  const input = request(exchangeId, { idempotencyKey: "m" });
  createMessage(store, input);
  store.database.exec(sql);
  const before = losslessSnapshot(reader), count = changes(store.database);
  failed(() => createMessage(store, { ...input, idempotencyKey: newKey ? "new" : "m" }), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(losslessSnapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
  expect(store.database.isTransaction).toBe(false);
});

it.each(unsafeIntegerMutations)("R1 uncertain rollback overrides unsafe %s corruption", (_name, sql, newKey) => {
  const { store, reader, exchangeId } = fixture();
  const input = request(exchangeId, { idempotencyKey: "m" });
  createMessage(store, input);
  store.database.exec(sql);
  const before = losslessSnapshot(reader);
  const original = store.database.exec.bind(store.database);
  store.database.exec = (statement) => {
    if (statement === "ROLLBACK") throw Error("SENSITIVE_SECRET");
    original(statement);
  };
  failed(() => createMessage(store, { ...input, idempotencyKey: newKey ? "new" : "m" }), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(losslessSnapshot(reader)).toEqual(before);
  expect(() => store.database.prepare("SELECT 1")).toThrow();
  failed(() => createMessage(store, input), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
});

it("N1 contains an actual copy-cleanup failure without masking the primary error", () => {
  const { store, reader, exchangeId } = fixture();
  const before = snapshot(reader);
  const original = store.database.prepare.bind(store.database);
  let cleanupCalls = 0, insertCalls = 0;
  store.database.prepare = (sql) => {
    const statement = original(sql);
    if (sql.startsWith("INSERT INTO message")) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => {
        insertCalls++;
        const copy = args[6] as Uint8Array;
        Object.defineProperty(copy, "fill", { value: () => {
          cleanupCalls++;
          throw Error("SENSITIVE_SECRET cleanup");
        } });
        run(...args); // Real INSERT, followed by an injected primary failure.
        throw new ConditionalMutationError("primary Message insert failure");
      }) as unknown as typeof statement.run;
    }
    return statement;
  };
  let published: MessageCreation | undefined;
  const error = failed(() => { published = createMessage(store, request(exchangeId)); }, "STORAGE_CONDITIONAL_MUTATION_FAILED");
  expect((error as Error).message).toBe("primary Message insert failure");
  expect(cleanupCalls).toBe(1);
  expect(insertCalls).toBe(1);
  expect(published).toBeUndefined();
  expect(snapshot(reader)).toEqual(before);
});

it.each(["9007199254740991", "9223372036854775807", "-9223372036854775808"])("R1 refuses invalid payload length %s losslessly", (integer) => {
  const { store, reader, exchangeId } = fixture();
  const input = request(exchangeId, { idempotencyKey: "m" });
  createMessage(store, input);
  // Privileged negative boundary fixture bypasses only the length CHECK.
  store.database.exec(`PRAGMA ignore_check_constraints=ON; UPDATE message SET payload_length=${integer}; PRAGMA ignore_check_constraints=OFF`);
  const before = losslessSnapshot(reader);
  failed(() => createMessage(store, input), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(losslessSnapshot(reader)).toEqual(before);
});

it("R1 leaves arbitrary driver decoding exceptions as transaction failures", () => {
  const { store, reader, exchangeId } = fixture();
  const input = request(exchangeId);
  createMessage(store, input);
  const before = snapshot(reader);
  const original = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = original(sql);
    if (sql.includes("FROM message WHERE message_id")) {
      statement.get = (() => {
        throw Object.assign(new RangeError("SENSITIVE_SECRET driver error"), { code: "ERR_OUT_OF_RANGE" });
      }) as typeof statement.get;
    }
    return statement;
  };
  failed(() => createMessage(store, input), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual(before);
});
