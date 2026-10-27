import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Value } from "@sinclair/typebox/value";
import { afterEach, expect, it } from "vitest";
import { ExchangeSchema, EventSchema } from "../../src/protocol/entities.js";
import { canonicalDigest } from "../../src/protocol/idempotency.js";
import { EXCHANGE_ID_PATTERN, EVENT_ID_PATTERN } from "../../src/protocol/identity.js";
import { initializeStore, type DurableStore } from "../../src/storage/store.js";
import { createExchange, type ExchangeCreation } from "../../src/storage/creation.js";
import { ConditionalMutationError } from "../../src/storage/transaction.js";

const timestamp = "2026-10-08T20:00:00.000Z";
const namespace = JSON.stringify(["exchange.create", "owner"]);
const digest = canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 });
const request = () => ({ namespace: "owner", idempotencyKey: "key" });
const fixtures: { root: string; store: DurableStore; reader: DatabaseSync }[] = [];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s2-"));
  const directory = join(root, "db");
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: 25 });
  const reader = new DatabaseSync(join(directory, "store.sqlite"), { readOnly: true });
  const result = { root, store, reader };
  fixtures.push(result);
  return result;
}
function snapshot(db: DatabaseSync) {
  return ["exchange", "idempotency_record", "audit_event", "message"].map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
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
afterEach(() => {
  for (const { root, store, reader } of fixtures.splice(0)) {
    reader.close();
    try { store.close(); } catch { /* intentionally invalidated connection */ }
    rmSync(root, { recursive: true, force: true });
  }
});

it("creates one schema-valid Exchange, record and sequence-1 audit visible independently", () => {
  const { store, reader } = fixture();
  const result = createExchange(store, request(), { now: () => timestamp });
  expect(result.disposition).toBe("CREATED");
  expect(result.exchange).toEqual({ exchangeId: expect.stringMatching(EXCHANGE_ID_PATTERN), state: "OPEN", createdAt: timestamp });
  expect(Value.Check(ExchangeSchema, result.exchange)).toBe(true);
  expect(result.record).toEqual({ entityId: result.exchange.exchangeId, requestDigest: digest, createdAt: timestamp });
  expect(reader.prepare("SELECT * FROM exchange").all()).toEqual([{ exchange_id: result.exchange.exchangeId, state: "OPEN", created_at: timestamp, closed_at: null, private_revision: 1 }]);
  expect(reader.prepare("SELECT * FROM idempotency_record").all()).toEqual([{ namespace, idempotency_key: "key", request_digest: digest, entity_id: result.exchange.exchangeId, created_at: timestamp, private_revision: 1 }]);
  const audit = reader.prepare("SELECT * FROM audit_event").all();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toEqual({ event_id: expect.stringMatching(EVENT_ID_PATTERN), exchange_id: result.exchange.exchangeId, sequence: 1, kind: "exchange_opened", subject_id: result.exchange.exchangeId, created_at: timestamp, digest: null, length: null, outcome: null, private_revision: 1 });
  expect(Value.Check(EventSchema, { eventId: audit[0]!.event_id, exchangeId: audit[0]!.exchange_id, sequence: 1, kind: "exchange_opened", subjectId: audit[0]!.subject_id, createdAt: timestamp })).toBe(true);
  expect(reader.prepare("SELECT count(*) AS n FROM message").get()).toEqual({ n: 0 });
  expect(store.database.isTransaction).toBe(false);
});

it("replays original identity and timestamp with zero writes or hooks", () => {
  const { store, reader } = fixture();
  const first = createExchange(store, request(), { now: () => timestamp });
  const before = snapshot(reader), count = changes(store.database);
  const unexpected = () => { throw Error("replay wrote"); };
  const replay = createExchange(store, request(), { now: () => "2026-10-09T20:00:00.000Z", afterExchangeInsert: unexpected, afterIdempotencyInsert: unexpected, afterAuditInsert: unexpected });
  expect(replay).toEqual({ ...first, disposition: "REPLAYED" });
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("separates logical namespaces without altering their spelling", () => {
  const { store, reader } = fixture();
  const a = createExchange(store, request());
  const b = createExchange(store, { namespace: " owner ", idempotencyKey: "key" });
  expect(a.exchange.exchangeId).not.toBe(b.exchange.exchangeId);
  expect(reader.prepare("SELECT namespace FROM idempotency_record ORDER BY namespace").all()).toEqual([
    { namespace: JSON.stringify(["exchange.create", " owner "]) }, { namespace },
  ]);
});

it("returns frozen fresh objects and omits absent closedAt", () => {
  const { store } = fixture();
  const first = createExchange(store, request());
  for (const value of [first, first.exchange, first.record]) expect(Object.isFrozen(value)).toBe(true);
  expect(Object.hasOwn(first.exchange, "closedAt")).toBe(false);
  expect(() => Reflect.set(first.exchange, "state", "CLOSED")).not.toThrow();
  expect(first.exchange.state).toBe("OPEN");
  const replay = createExchange(store, request());
  expect(replay.exchange).not.toBe(first.exchange);
  expect(replay.record).not.toBe(first.record);
  expect(Object.isFrozen(replay.exchange)).toBe(true);
  expect(Object.isFrozen(replay.record)).toBe(true);
});

it("valid CLOSED replay preserves current stored state without rewriting creation metadata", () => {
  const { store, reader } = fixture();
  createExchange(store, request(), { now: () => timestamp });
  store.database.prepare("UPDATE exchange SET state='CLOSED', closed_at=? WHERE exchange_id=(SELECT entity_id FROM idempotency_record)").run("2026-10-09T20:00:00.000Z");
  const before = snapshot(reader), count = changes(store.database);
  const replay = createExchange(store, request());
  expect(replay.disposition).toBe("REPLAYED");
  expect(replay.exchange).toMatchObject({ state: "CLOSED", createdAt: timestamp, closedAt: "2026-10-09T20:00:00.000Z" });
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it.each([
  ["malformed digest", "UPDATE idempotency_record SET request_digest=?", "g".repeat(64)],
  ["different well-formed digest is corruption for constant Exchange identity", "UPDATE idempotency_record SET request_digest=?", "a".repeat(64)],
  ["wrong kind", "UPDATE idempotency_record SET entity_id=?", "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ["missing entity", "UPDATE idempotency_record SET entity_id=?", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"],
  ["invalid identity", "UPDATE idempotency_record SET entity_id=?", "SENSITIVE_SECRET"],
  ["record timestamp mismatch", "UPDATE idempotency_record SET created_at=?", "2026-10-09T20:00:00.000Z"],
  ["record malformed timestamp", "UPDATE idempotency_record SET created_at=?", "SENSITIVE_SECRET"],
  ["record unsupported revision", "UPDATE idempotency_record SET private_revision=?", 2],
  ["entity unsupported revision", "UPDATE exchange SET private_revision=?", 2],
  ["entity malformed timestamp", "UPDATE exchange SET created_at=?", "SENSITIVE_SECRET"],
])("refuses %s without repair or conflict classification", (_name, sql, value) => {
  const { store, reader } = fixture();
  createExchange(store, request(), { now: () => timestamp });
  store.database.prepare(sql).run(value);
  const before = snapshot(reader), count = changes(store.database);
  failed(() => createExchange(store, request()), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
  expect(changes(store.database)).toBe(count);
});

it("refuses malformed CLOSED entity schema", () => {
  const { store, reader } = fixture();
  createExchange(store, request());
  store.database.exec("UPDATE exchange SET state='CLOSED', closed_at='SENSITIVE_SECRET'");
  const before = snapshot(reader);
  failed(() => createExchange(store, request()), "STORAGE_IDEMPOTENCY_CORRUPT");
  expect(snapshot(reader)).toEqual(before);
});

it.each(["afterExchangeInsert", "afterIdempotencyInsert", "afterAuditInsert"] as const)("atomically rolls back after %s and hides hook exceptions", (hook) => {
  const { store, reader } = fixture();
  const before = snapshot(reader);
  failed(() => createExchange(store, request(), { [hook]: () => { throw new Proxy(Error("SENSITIVE_SECRET"), { get() { throw Error("must not inspect attacker error"); } }); } }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual(before);
  expect(store.database.isTransaction).toBe(false);
  expect(createExchange(store, request()).disposition).toBe("CREATED");
});

it("bounded private hooks receive no capability, bytes or result arguments", () => {
  const { store } = fixture();
  const calls: unknown[][] = [];
  const hook = (...args: unknown[]) => { calls.push(args); };
  createExchange(store, request(), { afterExchangeInsert: hook, afterIdempotencyInsert: hook, afterAuditInsert: hook });
  expect(calls).toEqual([[], [], []]);
});

it("rejects non-undefined hook results without reading then or Proxy fields", () => {
  const { store, reader } = fixture();
  const hostile = new Proxy({}, { get() { throw Error("SENSITIVE_SECRET"); } });
  failed(() => createExchange(store, request(), { afterExchangeInsert: () => hostile }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("publishes nothing on injected commit failure with proven rollback", () => {
  const { store, reader } = fixture();
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "COMMIT") throw Error("SENSITIVE_SECRET"); original(sql); };
  failed(() => createExchange(store, request()), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
  expect(store.database.isTransaction).toBe(false);
  store.database.exec = original;
  expect(createExchange(store, request()).disposition).toBe("CREATED");
});

it("INDETERMINATE takes precedence over corruption and invalidates the connection", () => {
  const { store } = fixture();
  createExchange(store, request());
  store.database.exec("UPDATE idempotency_record SET request_digest='gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg'");
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "ROLLBACK") throw Error("SENSITIVE_SECRET"); original(sql); };
  failed(() => createExchange(store, request()), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(() => store.database.prepare("SELECT 1")).toThrow();
  failed(() => createExchange(store, request()), "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
});

it("committed-then-failed COMMIT does not expose a captured success or retry", () => {
  const { store, reader } = fixture();
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { original(sql); if (sql === "COMMIT") throw Error("SENSITIVE_SECRET"); };
  let published: ExchangeCreation | undefined;
  failed(() => { published = createExchange(store, request()); }, "STORAGE_TRANSACTION_FAILED", "INDETERMINATE");
  expect(published).toBeUndefined();
  expect(snapshot(reader).map(rows => rows.length)).toEqual([1, 1, 1, 0]);
  expect(() => store.database.prepare("SELECT 1")).toThrow();
});

it("BUSY remains bounded and is never automatically retried", () => {
  const { store, reader, root } = fixture();
  const blocker = new DatabaseSync(join(root, "db", "store.sqlite"));
  let begins = 0;
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { if (sql === "BEGIN IMMEDIATE") begins++; original(sql); };
  try {
    blocker.exec("BEGIN IMMEDIATE");
    failed(() => createExchange(store, request()), "STORAGE_TRANSACTION_BUSY", "ROLLED_BACK", true);
    expect(begins).toBe(1);
    expect(snapshot(reader)).toEqual([[], [], [], []]);
  } finally { blocker.exec("ROLLBACK"); blocker.close(); }
});

it("lookup occurs only while BEGIN IMMEDIATE owns the transaction", () => {
  const { store } = fixture();
  const original = store.database.prepare.bind(store.database);
  let lookups = 0;
  store.database.prepare = (sql) => {
    if (sql.includes("FROM idempotency_record")) { expect(store.database.isTransaction).toBe(true); lookups++; }
    return original(sql);
  };
  createExchange(store, request());
  createExchange(store, request());
  expect(lookups).toBe(2);
});

it("unexpected insert change counts roll back as conditional mutation failure", () => {
  const { store, reader } = fixture();
  // Inject the unexpected driver result after a real insert; all writes must roll back.
  const original = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = original(sql);
    if (sql.startsWith("INSERT INTO idempotency_record")) {
      const run = statement.run.bind(statement);
      statement.run = ((...args: Parameters<typeof run>) => ({ ...run(...args), changes: 0 })) as typeof statement.run;
    }
    return statement;
  };
  failed(() => createExchange(store, request()), "STORAGE_CONDITIONAL_MUTATION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("invalid caller input is normalized before any transaction and sanitized", () => {
  const { store, reader } = fixture();
  let begins = 0;
  const original = store.database.exec.bind(store.database);
  store.database.exec = (sql) => { begins++; original(sql); };
  expect(() => createExchange(store, { get namespace() { throw Error("SENSITIVE_SECRET"); }, idempotencyKey: "key" })).toThrowError(expect.objectContaining({ code: "STORAGE_CREATE_REQUEST_INVALID" }));
  expect(begins).toBe(0);
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("bound SQL accepts punctuation without injection and preserves exact keys", () => {
  const { store, reader } = fixture();
  const input = { namespace: "owner'); DROP TABLE exchange; --", idempotencyKey: " key'😀 " };
  const a = createExchange(store, input);
  expect(createExchange(store, input)).toEqual({ ...a, disposition: "REPLAYED" });
  expect(reader.prepare("SELECT namespace, idempotency_key FROM idempotency_record").get()).toEqual({ namespace: JSON.stringify(["exchange.create", input.namespace]), idempotency_key: input.idempotencyKey });
});

it("has no public creation export, Message creation or payload accessor", () => {
  const barrel = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../src/storage/creation.ts", import.meta.url), "utf8");
  expect(barrel).not.toMatch(/storage|creation/);
  // S3-A supersedes the Message-INSERT and createMessage clauses; premature
  // resolution implementation remains refused here.
  expect(source).not.toMatch(/export\s+function\s+resolve\w+Creation/i);
  expect(source).not.toContain("#payload");
});

it.each(["SENSITIVE_SECRET", "2026-02-30T20:00:00.000Z", "2026-10-08T20:00:00.000+01:00"])("rejects invalid private clock %s without writes", (time) => {
  const { store, reader } = fixture();
  failed(() => createExchange(store, request(), { now: () => time }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("sanitizes hostile private clock exceptions without inspecting them", () => {
  const { store, reader } = fixture();
  failed(() => createExchange(store, request(), { now: () => { throw new Proxy(Error("SENSITIVE_SECRET"), { get() { throw Error("must not inspect"); } }); } }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("generic SQLite failure never becomes an idempotency race and leaks no values", () => {
  const { store, reader } = fixture();
  const original = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    if (sql.startsWith("INSERT INTO audit_event")) throw Object.assign(Error("SENSITIVE_SECRET"), { errcode: 2067 });
    return original(sql);
  };
  failed(() => createExchange(store, { namespace: "SENSITIVE_SECRET", idempotencyKey: "SENSITIVE_SECRET" }), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("does not unwrap a caller-owned conditional error from a seam accessor", () => {
  const { store, reader } = fixture();
  const seams = Object.defineProperty({}, "afterExchangeInsert", { get() {
    throw new ConditionalMutationError("SENSITIVE_SECRET");
  } });
  failed(() => createExchange(store, request(), seams), "STORAGE_TRANSACTION_FAILED");
  expect(snapshot(reader)).toEqual([[], [], [], []]);
});

it("runs source creation and replay in an independent pinned Node subprocess", () => {
  const { root, reader } = fixture();
  const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
  const storeSource = new URL("../../src/storage/store.ts", import.meta.url).href;
  const creationSource = new URL("../../src/storage/creation.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--import", register, "--input-type=module", "-e", `
    const { openStore } = await import(${JSON.stringify(storeSource)});
    const { createExchange } = await import(${JSON.stringify(creationSource)});
    const store = openStore(${JSON.stringify({ directory: join(root, "db"), filename: "store.sqlite" })});
    try {
      const request = { namespace: 'child', idempotencyKey: 'key' };
      const created = createExchange(store, request);
      const replayed = createExchange(store, request);
      console.log(JSON.stringify({ created, replayed }));
    } finally { store.close(); }
  `], { encoding: "utf8", timeout: 10_000 });
  const { created, replayed } = JSON.parse(output) as { created: ExchangeCreation; replayed: ExchangeCreation };
  expect(created.disposition).toBe("CREATED");
  expect(replayed).toEqual({ ...created, disposition: "REPLAYED" });
  expect(snapshot(reader).map(rows => rows.length)).toEqual([1, 1, 1, 0]);
});
