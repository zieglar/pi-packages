import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, type DurableStore } from "../../src/storage/store.js";

/** S4-1 only: simultaneous failures, not new product precedence rules.
 * Accepted order: normalization -> BEGIN -> durable replay validation -> digest
 * comparison -> admission. A separate reader supplies every durable assertion.
 * Raw mutation and exec counters below are privileged TEST authority only. */
const BUSY_MS = 100;
const WORKER_MS = 25_000;
const TEST_MS = 30_000;
const TABLES = ["message", "idempotency_record", "audit_event", "exchange", "disposition"] as const;
const key = "precedence-key";
const from = { adapter: "pi", endpointId: "SENSITIVE_PRODUCER" };
const to = { adapter: "pi", endpointId: "SENSITIVE_CONSUMER" };
const closedAt = "2026-10-09T22:00:00.000Z";
const unsafeRevision = "9223372036854775807";
const closeScript = fileURLToPath(new URL("./support/close-fixture.mjs", import.meta.url));
const fixtures: Fixture[] = [];
const workers: Worker[] = [];

interface Fixture {
  root: string;
  directory: string;
  path: string;
  store: DurableStore;
  raw: DatabaseSync;
  reader: DatabaseSync;
  exchangeId: string;
}
interface WorkerReport {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}
interface Worker {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<void>;
  done: Promise<WorkerReport>;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s4-1-"));
  const directory = join(root, "db");
  const path = join(directory, "store.sqlite");
  let store: DurableStore | undefined;
  let raw: DatabaseSync | undefined;
  let reader: DatabaseSync | undefined;
  try {
    store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: BUSY_MS });
    const exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" }).exchange.exchangeId;
    raw = openStorageConnection({ directory, filename: "store.sqlite", busyTimeoutMs: BUSY_MS });
    reader = new DatabaseSync(path, { readOnly: true, defensive: true });
    const result = { root, directory, path, store, raw, reader, exchangeId };
    fixtures.push(result);
    return result;
  } catch (error) {
    reader?.close(); raw?.close(); store?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
const request = (active: Fixture) => ({
  exchangeId: active.exchangeId, from, to, payload: new Uint8Array([1, 2, 3, 4]), idempotencyKey: key,
});
const namespace = (active: Fixture) => JSON.stringify(["message.create", active.exchangeId]);

/** CAST quote() to TEXT for every cell, including every SQLite INTEGER: no
 * JavaScript Number decoding, unsafe integer rounding, or quote() type assumption.
 * Names come only from the fixed table list and that table's SQLite metadata. */
function snapshot(reader: DatabaseSync) {
  reader.exec("BEGIN");
  try {
    return TABLES.map((table) => {
      const columns = reader.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
      const projections = columns.map((name) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        return `CAST(quote(${quoted}) AS TEXT) AS ${quoted}`;
      });
      return reader.prepare(`SELECT CAST(rowid AS TEXT) AS _rowid, ${projections.join(", ")} FROM "${table}" ORDER BY rowid`).all();
    });
  } finally { reader.exec("ROLLBACK"); }
}

function evidence(active: Fixture, state: "OPEN" | "CLOSED", audits: number) {
  const { reader } = active;
  const count = (table: typeof TABLES[number]) =>
    reader.prepare(`SELECT CAST(count(*) AS TEXT) AS n FROM "${table}"`).get()!.n;
  expect(TABLES.map(count)).toEqual(["1", "2", String(audits), "1", "0"]);
  expect(reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state, closed_at: state === "CLOSED" ? closedAt : null });
  expect(reader.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(reader.prepare("SELECT CAST(sequence AS TEXT) AS n, kind FROM audit_event ORDER BY sequence").all())
    .toEqual([
      { n: "1", kind: "exchange_opened" }, { n: "2", kind: "message_created" },
      ...(audits === 3 ? [{ n: "3", kind: "exchange_closed" }] : []),
    ]);
  const message = reader.prepare(
    "SELECT message_id, CAST(payload_length AS TEXT) AS length, CAST(private_revision AS TEXT) AS revision FROM message",
  ).get()!;
  expect(message).toMatchObject({ length: "4", revision: "1" });
  expect(reader.prepare(
    "SELECT entity_id, CAST(private_revision AS TEXT) AS revision FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
  ).get(namespace(active), key)).toMatchObject({ entity_id: message.message_id });
  return message.message_id;
}

function capturedError(action: () => unknown): Error & { code?: string; outcome?: string; retryable?: boolean } {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error & { code?: string; outcome?: string; retryable?: boolean };
  expect(Object.hasOwn(error, "cause")).toBe(false);
  const diagnostic = String(error.stack) + JSON.stringify(error);
  for (const secret of [from.endpointId, to.endpointId, "SELECT", "INSERT", "payload_body"]) {
    expect(diagnostic.includes(secret)).toBe(false);
  }
  return error;
}

/** Instrument only the tested connection and restore even if an assertion fails.
 * The real exec still runs; BUSY is generated by SQLite, never synthesized. */
function countControls(store: DurableStore) {
  const original = store.database.exec;
  const originalPrepare = store.database.prepare;
  const controls: string[] = [];
  let execs = 0, prepares = 0;
  store.database.exec = (sql) => {
    execs++;
    if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(sql)) controls.push(sql);
    return original.call(store.database, sql);
  };
  store.database.prepare = (sql) => {
    prepares++;
    return originalPrepare.call(store.database, sql);
  };
  return {
    controls, calls: () => ({ execs, prepares }),
    restore: () => { store.database.exec = original; store.database.prepare = originalPrepare; },
  };
}

function corruptRecord(active: Fixture) {
  expect(active.raw.prepare(
    "UPDATE idempotency_record SET private_revision=CAST(? AS INTEGER) WHERE namespace=? AND idempotency_key=?",
  ).run(unsafeRevision, namespace(active), key).changes).toBe(1);
}
function recordRevision(active: Fixture) {
  return active.reader.prepare(
    "SELECT CAST(private_revision AS TEXT) AS revision, typeof(private_revision) AS storage_type FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
  ).get(namespace(active), key);
}

/** Finite readiness and lifetime, early-exit rejection, line-framed readiness,
 * and no raw worker diagnostic in thrown errors. Cleanup awaits actual close. */
function launch(args: string[]): Worker {
  const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "", pending = "";
  let announce: () => void = () => undefined;
  const readyEvent = new Promise<void>((resolve) => { announce = resolve; });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk; pending += chunk;
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line === '{"event":"ready","transaction":true}') announce();
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, WORKER_MS);
  const done = new Promise<WorkerReport>((resolve, reject) => {
    child.once("error", () => { clearTimeout(timer); reject(new Error("precedence worker launch failed")); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("precedence worker exceeded bounded lifetime"));
      else resolve({ status, signal, stdout, stderr });
    });
  });
  const ready = Promise.race([
    readyEvent,
    done.then(() => { throw new Error("precedence worker exited before transactional readiness"); }),
  ]);
  // launch is also used for the close fixture (which does not need lock readiness).
  // Observe both promises immediately so later finally cleanup cannot leave a rejection unhandled.
  void ready.catch(() => undefined);
  void done.catch(() => undefined);
  const worker = { child, ready, done };
  workers.push(worker);
  return worker;
}
function cleanExit(report: WorkerReport) {
  expect(report.status).toBe(0);
  expect(report.signal).toBeNull();
  expect(report.stderr.length).toBe(0);
  for (const secret of [from.endpointId, to.endpointId, "SELECT", "INSERT", "payload_body"]) {
    expect(report.stdout.includes(secret)).toBe(false);
  }
}
async function closeExchange(active: Fixture) {
  // Reuse the accepted S3 privileged close fixture, with a pre-created explicit
  // release barrier. It updates CLOSED + appends sequence 3 atomically.
  const { writeFileSync } = await import("node:fs");
  const releasePath = join(active.root, "close.release");
  writeFileSync(releasePath, "");
  const worker = launch([closeScript, JSON.stringify({
    tag: "precedence-close", directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_MS, waitMs: WORKER_MS,
    readyPath: join(active.root, "close.ready"), releasePath, exchangeId: active.exchangeId,
    closedAt, eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  })]);
  const report = await worker.done;
  cleanExit(report);
  const lines = report.stdout.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines).toEqual([
    { event: "ready", tag: "precedence-close" },
    { event: "result", stage: "close", tag: "precedence-close", closedRows: 1, auditRows: 1, sequence: 3 },
  ]);
}

// Inline .mjs-equivalent worker because S4-1 authorizes exactly one new file.
// No TS registration needed: this process uses raw SQLite, not application code.
// Ready is emitted ONLY after a successful real BEGIN and active-state check.
const lockWorker = `
  import { DatabaseSync } from "node:sqlite";
  let db;
  try {
    db = new DatabaseSync(process.argv[1], { defensive: true, timeout: 100 });
    db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL");
    db.exec("BEGIN IMMEDIATE");
    if (!db.isTransaction) throw new Error("inactive lock fixture");
    process.stdout.write('{"event":"ready","transaction":true}\\n');
    process.stdin.setEncoding("utf8");
    let input = "";
    const timer = setTimeout(() => finish(false), 20000);
    function finish(released) {
      clearTimeout(timer);
      try {
        if (db.isTransaction) db.exec("ROLLBACK");
        if (db.isTransaction) throw new Error("lock fixture still active");
        db.close();
        process.stdout.write(JSON.stringify({event:"result",released,transaction:false})+"\\n");
        process.exit(released ? 0 : 3);
      } catch {
        try { db.close(); } catch {}
        process.stdout.write('{"event":"failure","code":"LOCK_RELEASE_FAILED"}\\n');
        process.exit(4);
      }
    }
    process.stdin.on("data", chunk => {
      input += chunk;
      if (input === "release\\n") finish(true);
    });
    process.stdin.on("end", () => finish(false));
  } catch {
    try { if (db.isTransaction) db.exec("ROLLBACK"); db.close(); } catch {}
    process.stdout.write('{"event":"failure","code":"LOCK_FIXTURE_FAILED"}\\n');
    process.exit(2);
  }
`;

afterEach(async () => {
  const completed = await Promise.all(workers.splice(0).map(async (worker) => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    return worker.done.catch(() => undefined);
  }));
  for (const { root, reader, raw, store } of fixtures.splice(0)) {
    reader.close(); raw.close(); store.close();
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
  // A signalled cleanup means a test did not release its worker normally.
  for (const report of completed) if (report !== undefined) expect(report.signal).toBeNull();
});

it("P1: invalid input wins over an existing key before any transaction starts", () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  const before = snapshot(active.reader);
  const counter = countControls(active.store);
  try {
    let published: unknown;
    const error = capturedError(() => {
      published = createMessage(active.store, { ...request(active), payload: [1, 2, 3, 4] });
    });
    expect(error).toMatchObject({ code: "STORAGE_CREATE_REQUEST_INVALID", retryable: false });
    expect(error.outcome).toBeUndefined(); // normalization has no transaction outcome
    expect(published).toBeUndefined(); // neither REPLAYED nor conflict
    expect(counter.controls).toEqual([]);
    expect(counter.calls()).toEqual({ execs: 0, prepares: 0 });
    expect(active.store.database.isTransaction).toBe(false);
    expect(snapshot(active.reader)).toEqual(before);
    expect(evidence(active, "OPEN", 2)).toBe(original.message.messageId);
  } finally { counter.restore(); }
});

it("P2: accepted unsafe record revision wins over a conflicting valid request", () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  // Establish that the different, valid request really conflicts before corruption.
  const different = { ...request(active), payload: new Uint8Array([4, 3, 2, 1]) };
  expect(capturedError(() => createMessage(active.store, different)))
    .toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", outcome: "ROLLED_BACK", retryable: false });
  corruptRecord(active); // S3-A accepted R1 shape, exact signed 64-bit INTEGER
  const before = snapshot(active.reader);
  const error = capturedError(() => createMessage(active.store, different));
  expect(error).toMatchObject({ code: "STORAGE_IDEMPOTENCY_CORRUPT", outcome: "ROLLED_BACK", retryable: false });
  expect(snapshot(active.reader)).toEqual(before);
  expect(recordRevision(active)).toEqual({ revision: unsafeRevision, storage_type: "integer" });
  expect(evidence(active, "OPEN", 2)).toBe(original.message.messageId);
  expect(active.store.database.isTransaction).toBe(false);
});

it("P3: historical corruption wins over CLOSED Exchange admission without repair", async () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  await closeExchange(active);
  // Independently establish the admission refusal before corrupting the key.
  expect(capturedError(() => createMessage(active.store, { ...request(active), idempotencyKey: "new-key" })))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  corruptRecord(active);
  const before = snapshot(active.reader);
  expect(capturedError(() => createMessage(active.store, request(active))))
    .toMatchObject({ code: "STORAGE_IDEMPOTENCY_CORRUPT", outcome: "ROLLED_BACK", retryable: false });
  expect(snapshot(active.reader)).toEqual(before);
  expect(recordRevision(active)).toEqual({ revision: unsafeRevision, storage_type: "integer" });
  expect(evidence(active, "CLOSED", 3)).toBe(original.message.messageId);
  expect(active.store.database.isTransaction).toBe(false);
}, TEST_MS);

it("P4: SCHEMA_V1_UNAUTHENTICATED_STATE_CHARACTERIZATION — deleted Exchange fixture is constrained (CE-STORAGE-IMMUTABILITY-V2)", () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  const before = snapshot(active.reader);
  expect(active.raw.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(active.raw.prepare("PRAGMA trusted_schema").get()).toEqual({ trusted_schema: 0 });
  expect(active.raw.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
  let deletionFailure: unknown;
  try { active.raw.prepare("DELETE FROM exchange WHERE exchange_id=?").run(active.exchangeId); }
  catch (error) { deletionFailure = error; }
  // Message and audit_event both use ON DELETE RESTRICT. Do not turn off FKs,
  // drop triggers, delete replay rows, or otherwise force a dangling replay state.
  // Consequently REPLAYED with a DELETED Exchange cannot be observed here.
  expect(deletionFailure).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1811 });
  expect(snapshot(active.reader)).toEqual(before);
  expect(evidence(active, "OPEN", 2)).toBe(original.message.messageId);
  expect(active.raw.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  // Characterization only: no new product guarantee about unauthenticated raw
  // state or deleted-Exchange replay. Deferred: CE-STORAGE-IMMUTABILITY-V2.
});

it("P5: cross-process BUSY wins over CLOSED admission with exactly one BEGIN attempt", async () => {
  const active = fixture();
  createMessage(active.store, request(active));
  await closeExchange(active);
  const newRequest = { ...request(active), idempotencyKey: "new-key" };
  // Prove this same request would produce the domain error without contention.
  expect(capturedError(() => createMessage(active.store, newRequest)))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  const before = snapshot(active.reader);
  const holder = launch(["--input-type=module", "-e", lockWorker, active.path]);
  await holder.ready; // held transaction, not an arbitrary elapsed sleep
  expect(holder.child.pid).not.toBe(process.pid);
  expect(holder.child.exitCode).toBeNull();
  const counter = countControls(active.store);
  try {
    expect(capturedError(() => createMessage(active.store, newRequest)))
      .toMatchObject({ code: "STORAGE_TRANSACTION_BUSY", outcome: "ROLLED_BACK", retryable: true, stage: "begin" });
    expect(counter.controls).toEqual(["BEGIN IMMEDIATE"]); // no retry, callback, COMMIT, or ROLLBACK
    expect(counter.calls()).toEqual({ execs: 1, prepares: 0 }); // domain lookup never ran
    expect(active.store.database.isTransaction).toBe(false);
    expect(snapshot(active.reader)).toEqual(before);
    evidence(active, "CLOSED", 3);
  } finally {
    counter.restore();
    holder.child.stdin.end("release\n");
    const report = await holder.done;
    cleanExit(report);
    expect(report.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { event: "ready", transaction: true }, { event: "result", released: true, transaction: false },
    ]);
  }
  expect(snapshot(active.reader)).toEqual(before); // holder made no durable writes
  evidence(active, "CLOSED", 3);
  expect(capturedError(() => createMessage(active.store, newRequest)))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  expect(snapshot(active.reader)).toEqual(before);
}, TEST_MS);
