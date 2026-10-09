import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, openStore, type DurableStore } from "../../src/storage/store.js";

/** S6-1 only: public-surface privacy regression. Every public result object
 * and public error produced by the accepted creation API is swept for
 * unintended disclosure of payload bytes, secret endpoints, credentials,
 * database paths, raw SQL, internal exception causes and secret-bearing
 * stack traces. Unique sentinels make any leak detectable. No production
 * code, hook or error semantic is changed; durable state is verified with an
 * independent read-only connection. */

const PAYLOAD = [7, 8, 9, 10];
const SECRET_ENDPOINT = "PRIVACY_ENDPOINT_3f8d2a1c";
const SECRET_CREDENTIAL = "PRIVACY_CREDENTIAL_9e4b07d6";
const SECRET_INJECTION = "PRIVACY_INJECTED_5c1f83ab";
const SECRETS = [
  SECRET_CREDENTIAL, SECRET_INJECTION,
  "0708090a", "7, 8, 9, 10", "payload_body", "from_endpoint_json", "to_endpoint_json",
] as const;
// Endpoint identities are accepted PUBLIC Message fields (M3); sentinel
// strings prove the sweep works, not that endpoints are hidden.
const ENDPOINT_SENTINEL = SECRET_ENDPOINT;
const KEY = "privacy-key";
const from = { adapter: "pi", endpointId: SECRET_ENDPOINT };
const to = { adapter: "pi", endpointId: "consumer-1" };

interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly store: DurableStore;
  readonly reader: DatabaseSync;
  readonly exchangeId: string;
}
const fixtures: Fixture[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s6-1-"));
  const directory = join(root, "db");
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: 1_000 });
  const exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" }).exchange.exchangeId;
  const reader = new DatabaseSync(join(directory, "store.sqlite"), { readOnly: true, defensive: true });
  const active = { root, directory, store, reader, exchangeId };
  fixtures.push(active);
  return active;
}
const request = (active: Fixture, idempotencyKey = KEY) => ({
  exchangeId: active.exchangeId, from, to, payload: Uint8Array.from(PAYLOAD), idempotencyKey,
});

afterEach(() => {
  for (const { root, store, reader } of fixtures.splice(0)) {
    try { store.close(); } catch { /* invalidated connections are already closed */ }
    reader.close();
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

/** Deep sweep of one public value: every own and nested enumerable property,
 * including symbol-free serialized representation, must not disclose any
 * sentinel, secret payload encoding, SQL text, or fixture filesystem path. */
function assertClean(value: unknown, root: string, label: string): void {
  const seen = new Set<unknown>();
  const walk = (current: unknown): string[] => {
    // Byte collections are detected before generic object traversal: numeric
    // index enumeration would hide the byte sequence, and serialized output
    // must not be reduced to a length alone. Buffer is covered through its
    // Uint8Array relationship.
    if (current instanceof Uint8Array) return [
      Buffer.from(current).toString("hex"),
      Array.from(current).join(", "),
    ];
    if (current === null || typeof current !== "object") {
      return [typeof current === "string" || typeof current === "number" ? String(current) : ""];
    }
    if (seen.has(current)) return [];
    seen.add(current);
    const parts = Object.entries(current as Record<string, unknown>).flatMap(([key, nested]) => [key, ...walk(nested)]);
    return parts;
  };
  const corpus = walk(value).join(" ") + " " + JSON.stringify(value, (_key, nested) =>
    nested instanceof Uint8Array
      ? `BYTES:${nested.length}:${Buffer.from(nested).toString("hex")}:${Array.from(nested).join(", ")}`
      : nested);
  for (const secret of SECRETS) expect(corpus, `${label}: leaked ${secret}`).not.toContain(secret);
  expect(corpus, `${label}: leaked database path`).not.toContain(root);
  expect(corpus, `${label}: leaked SQL`).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
}

/** A public error must be an Error with fixed vocabulary, no own cause, no
 * secrets anywhere (message, name, enumerable fields, stack), and no path. */
function assertCleanError(error: unknown, root: string, label: string): void {
  expect(error, label).toBeInstanceOf(Error);
  const err = error as Error & Record<string, unknown>;
  expect(Object.hasOwn(err, "cause"), `${label}: leaked cause`).toBe(false);
  assertClean(error, root, label);
  for (const secret of SECRETS) {
    expect(String(err.message), `${label}: message leaked ${secret}`).not.toContain(secret);
    expect(String(err.stack ?? ""), `${label}: stack leaked ${secret}`).not.toContain(secret);
  }
  expect(String(err.message)).not.toContain(root);
  expect(String(err.stack ?? "")).not.toContain(root);
}

function counts(active: Fixture) {
  const scalar = (sql: string, ...parameters: string[]) => active.reader.prepare(sql).get(...parameters)!.n;
  return {
    messages: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM message"),
    records: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record"),
    audits: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM audit_event"),
  };
}

it("public success and replay results carry only legitimate identity and metadata", () => {
  const active = fixture();
  const created = createMessage(active.store, request(active));
  expect(created.disposition).toBe("CREATED");
  assertClean(created, active.root, "created Message result");
  // Accepted contract (M3): endpoint identities are PUBLIC fields of the
  // persisted Message, alongside ids, digest, length, timestamp and state.
  expect(created.message.from).toEqual(from);
  expect(created.message.to).toEqual(to);
  expect(created.message.payloadLength).toBe(PAYLOAD.length);
  expect(created.message.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(created.record.entityId).toBe(created.message.messageId);
  expect(Object.isFrozen(created.message)).toBe(true);
  expect(Object.isFrozen(created.record)).toBe(true);

  const replay = createMessage(active.store, request(active));
  expect(replay.disposition).toBe("REPLAYED");
  assertClean(replay, active.root, "replayed Message result");
  expect(replay.message).toEqual(created.message);
  expect(replay.record).toEqual(created.record);

  const exchangeReplay = createExchange(active.store, { namespace: "owner", idempotencyKey: "exchange-key" });
  expect(exchangeReplay.disposition).toBe("REPLAYED");
  assertClean(exchangeReplay, active.root, "replayed Exchange result");
  expect(counts(active)).toEqual({ messages: "1", records: "2", audits: "2" });
});

it("idempotency conflict errors disclose no stored or incoming secrets", () => {
  const active = fixture();
  createMessage(active.store, request(active));
  let caught: unknown;
  try {
    createMessage(active.store, {
      ...request(active), payload: Uint8Array.from([11, 12, 13]), // different request, same key
    });
  } catch (error) { caught = error; }
  assertCleanError(caught, active.root, "idempotency conflict");
  expect((caught as Error).message).toMatch(/^creation idempotency key conflicts/);
  expect(counts(active)).toEqual({ messages: "1", records: "2", audits: "2" });
});

it("invalid request rejection happens before any transaction and discloses nothing", () => {
  const active = fixture();
  let caught: unknown;
  try {
    createMessage(active.store, { exchangeId: active.exchangeId, from, to, payload: new Proxy({}, {
      get() { throw new Error(SECRET_INJECTION); },
    }), idempotencyKey: "proxy-key" });
  } catch (error) { caught = error; }
  assertCleanError(caught, active.root, "invalid request");
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

it("admission rejection errors are fixed vocabulary with no cause", () => {
  const active = fixture();
  let caught: unknown;
  try { createMessage(active.store, { ...request(active), exchangeId: "ex_missing" }); } catch (error) { caught = error; }
  assertCleanError(caught, active.root, "missing Exchange admission");
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

it("BUSY classification errors stay sanitized with correct outcome and retryable", () => {
  const active = fixture();
  const holder = new DatabaseSync(join(active.directory, "store.sqlite"));
  holder.exec("BEGIN IMMEDIATE");
  try {
    let caught: unknown;
    try { createMessage(active.store, request(active)); } catch (error) { caught = error; }
    assertCleanError(caught, active.root, "BUSY");
    expect(caught).toMatchObject({ code: "STORAGE_TRANSACTION_BUSY", outcome: "ROLLED_BACK", retryable: true });
  } finally {
    holder.exec("ROLLBACK");
    holder.close();
  }
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

it("injected COMMIT failure with proven rollback discloses no SQLite detail", () => {
  const active = fixture();
  const original = active.store.database.exec.bind(active.store.database);
  active.store.database.exec = (sql: string) => {
    if (sql === "COMMIT") throw new Error(`${SECRET_INJECTION} at ${active.root} SELECT payload_body`);
    original(sql);
  };
  let caught: unknown;
  let published: unknown;
  try { published = createMessage(active.store, request(active)); } catch (error) { caught = error; }
  active.store.database.exec = original;
  assertCleanError(caught, active.root, "commit failure");
  expect(published).toBeUndefined(); // no fabricated success
  expect((caught as { outcome?: string }).outcome).toBe("ROLLED_BACK");
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

it("uncertain rollback errors disclose nothing and invalidate the connection", () => {
  const active = fixture();
  const original = active.store.database.exec.bind(active.store.database);
  active.store.database.exec = (sql: string) => {
    if (sql === "ROLLBACK") throw new Error(`${SECRET_INJECTION} ${active.root}`);
    original(sql);
  };
  let caught: unknown;
  try {
    // The hook failure forces the owned rollback; the rollback itself then
    // fails, producing the accepted INDETERMINATE classification.
    createMessage(active.store, request(active), {
      afterMessageInsert: () => { throw new Error(SECRET_INJECTION); },
    });
  } catch (error) { caught = error; }
  assertCleanError(caught, active.root, "uncertain rollback");
  expect(caught).toMatchObject({ code: "STORAGE_TRANSACTION_FAILED", outcome: "INDETERMINATE", retryable: false });
  // The connection is invalidated; the follow-up repeats the same sanitized
  // classification without exposing anything further.
  let second: unknown;
  try { createMessage(active.store, request(active)); } catch (error) { second = error; }
  assertCleanError(second, active.root, "uncertain rollback follow-up");
  expect(second).toMatchObject({ code: "STORAGE_TRANSACTION_FAILED", outcome: "INDETERMINATE", retryable: false });
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

it("hook seam failures are swallowed without leaking hook internals", () => {
  const active = fixture();
  let caught: unknown;
  try {
    createMessage(active.store, request(active), {
      afterMessageInsert: () => { throw new Error(`${SECRET_INJECTION} ${SECRET_ENDPOINT}`); },
    });
  } catch (error) { caught = error; }
  assertCleanError(caught, active.root, "hook failure");
  expect(counts(active)).toEqual({ messages: "0", records: "1", audits: "1" });
});

/** Negative controls: the sweep helpers themselves must catch each sentinel
 * class, so a passing suite cannot be a vacuous assertion. These use
 * synthetic test-local objects; no repository source is mutated. */
it("control: the sweep detects a leaked payload sentinel", () => {
  const poisoned = { message: { note: "0708090a" } };
  expect(() => assertClean(poisoned, "/tmp/none", "control")).toThrow();
});

it("control: the sweep detects secret-class values wherever they appear", () => {
  // Public-by-contract endpoint identity is visible in the corpus (proves
  // the corpus is not vacuous), while secret-class sentinels are always
  // caught, in results and in errors alike.
  expect(JSON.stringify({ from: { endpointId: ENDPOINT_SENTINEL } })).toContain(ENDPOINT_SENTINEL);
  expect(() => assertClean({ note: SECRET_CREDENTIAL }, "/tmp/none", "control")).toThrow();
  expect(() => assertClean({ nested: { deep: SECRET_INJECTION } }, "/tmp/none", "control")).toThrow();
});

it("control: the sweep detects a leaked database path", () => {
  expect(() => assertClean({ detail: "/private/var/folders/secret-db/store.sqlite" }, "/private/var/folders", "control")).toThrow();
});

it("control: the sweep detects a leaked internal error cause", () => {
  const poisoned = new Error("creation failed");
  Object.defineProperty(poisoned, "cause", { value: new Error(SECRET_INJECTION), enumerable: true });
  expect(() => assertCleanError(poisoned, "/tmp/none", "control")).toThrow();
});

it("control: the sweep detects secrets in a stack trace", () => {
  const poisoned = new Error("creation failed");
  poisoned.stack = `Error: creation failed\n    at secret (${SECRET_INJECTION}/file.ts:1:1)`;
  expect(() => assertCleanError(poisoned, "/tmp/none", "control")).toThrow();
});

it("control A: raw Uint8Array payload leak is rejected", () => {
  // The exact shape the previous sweep missed.
  const poisoned = { message: { payload: Uint8Array.from(PAYLOAD) } };
  expect(() => assertClean(poisoned, "/tmp/none", "control A")).toThrow();
});

it("control B: raw Buffer payload leak is rejected", () => {
  // Buffer is covered through its Uint8Array relationship.
  const poisoned = { message: { payload: Buffer.from(PAYLOAD) } };
  expect(() => assertClean(poisoned, "/tmp/none", "control B")).toThrow();
});

it("control C: hexadecimal payload leak is rejected", () => {
  const poisoned = { message: { payloadHex: "0708090a" } };
  expect(() => assertClean(poisoned, "/tmp/none", "control C")).toThrow();
});

it("control D: decimal byte-sequence leak is rejected", () => {
  const poisoned = { message: { note: "7, 8, 9, 10" } };
  expect(() => assertClean(poisoned, "/tmp/none", "control D")).toThrow();
});

it("control: legitimate public fields are not false positives", () => {
  // A public digest is hexadecimal; payloadLength is a number. Neither is a
  // leak, and neither endpoint identity is classified as a secret (M3).
  const publicShape = {
    messageId: "m1", exchangeId: "x1", from, to,
    payloadDigest: "deadbeef".repeat(8), payloadLength: PAYLOAD.length,
    createdAt: "2026-10-09T00:00:00Z", state: "OPEN", disposition: "CREATED",
  };
  expect(() => assertClean(publicShape, "/tmp/none", "control public")).not.toThrow();
});
