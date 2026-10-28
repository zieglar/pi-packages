import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";
import { createHash } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, type DurableStore } from "../../src/storage/store.js";

/** S4-2 only: every durable decision must come from the CURRENT transaction.
 * One long-lived Store handle is never reopened, while real independent OS
 * processes commit schema-valid changes between its calls. F4/F5 are schema
 * characterizations, not product guarantees. Raw mutation below is privileged
 * TEST authority; a separate read-only reader supplies every assertion. */
const BUSY_MS = 5_000;
const WORKER_MS = 20_000;
const TEST_MS = 90_000;
const TABLES = ["message", "idempotency_record", "audit_event", "exchange", "disposition"] as const;
const DISPOSITION_TABLES = [...TABLES, "attempt", "evidence_envelope", "reconciliation"] as const;
const dispositionIds = {
  attemptId: "att_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  envelopeId: "env_fresh-disposition",
  reconciliationId: "rec_fresh-disposition",
} as const;
const dispositionEvidenceJson = JSON.stringify({ observation: "test-only administrative fixture" });
const dispositionEvidenceDigest = createHash("sha256").update(dispositionEvidenceJson).digest("hex");
const SECRETS = ["SENSITIVE_PRODUCER", "SENSITIVE_CONSUMER", "SELECT", "INSERT", "payload_body"] as const;
const key = "fresh-state-key";
const from = { adapter: "pi", endpointId: "SENSITIVE_PRODUCER" };
const to = { adapter: "pi", endpointId: "SENSITIVE_CONSUMER" };
const payload = [7, 8, 9, 10] as const;
const closedAt = "2026-10-09T22:00:00.000Z";
const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const closeScript = fileURLToPath(new URL("./support/close-fixture.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/concurrency-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const creationUrl = new URL("../../src/storage/creation.ts", import.meta.url).href;
const fixtures: Fixture[] = [];
const workers: Worker[] = [];

interface Fixture {
  root: string;
  directory: string;
  path: string;
  store: DurableStore;
  raw: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec" | "close">;
  reader: DatabaseSync;
  exchangeId: string;
}
interface WorkerReport {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  lines: Record<string, unknown>[];
}
interface Worker {
  child: ChildProcessByStdio<null, Readable, Readable>;
  releasePath: string;
  ready: Promise<void>;
  done: Promise<WorkerReport>;
}

/** The Store handle created here is opened exactly once per scenario and is
 * never closed or reopened before the scenario's final assertion. */
function fixture(): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s4-2-"));
  const directory = join(root, "db");
  const path = join(directory, "store.sqlite");
  let store: DurableStore | undefined;
  let raw: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec" | "close"> | undefined;
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
  exchangeId: active.exchangeId, from, to, payload: Uint8Array.from(payload), idempotencyKey: key,
});
const namespace = (active: Fixture) => JSON.stringify(["message.create", active.exchangeId]);

/** CAST quote() to TEXT for every cell, including every SQLite INTEGER: no
 * JavaScript Number decoding, unsafe integer rounding, or quote() type
 * assumption. Names come only from the fixed table list and SQLite metadata. */
function snapshot(reader: DatabaseSync, tables: readonly (typeof DISPOSITION_TABLES)[number][] = TABLES) {
  reader.exec("BEGIN");
  try {
    return tables.map((table) => {
      const columns = reader.prepare(`PRAGMA table_info("${table}")`).all().map((row) => String(row.name));
      const projections = columns.map((name) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        return `CAST(quote(${quoted}) AS TEXT) AS ${quoted}`;
      });
      return reader.prepare(`SELECT CAST(rowid AS TEXT) AS _rowid, ${projections.join(", ")} FROM "${table}" ORDER BY rowid`).all();
    });
  } finally { reader.exec("ROLLBACK"); }
}

/** Independent durable forensics: row counts, Message/record ownership, audit
 * sequence contiguity, Exchange state, and physical integrity. */
function evidence(active: Fixture, expected: {
  state: "OPEN" | "CLOSED";
  closed: boolean;
  messages: number;
  kinds: readonly string[];
}) {
  const { reader } = active;
  const count = (table: typeof TABLES[number]) =>
    reader.prepare(`SELECT CAST(count(*) AS TEXT) AS n FROM "${table}"`).get()!.n;
  expect(count("message")).toBe(String(expected.messages));
  expect(count("idempotency_record")).toBe(String(expected.messages + 1));
  expect(count("disposition")).toBe("0");
  expect(reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: expected.state, closed_at: expected.closed ? closedAt : null });
  expect(reader.prepare("SELECT CAST(sequence AS TEXT) AS n, kind FROM audit_event WHERE exchange_id=? ORDER BY sequence")
    .all(active.exchangeId))
    .toEqual(expected.kinds.map((kind, index) => ({ n: String(index + 1), kind })));
  expect(reader.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  // Every stored Message is owned by exactly one idempotency record, and no
  // record points at a missing Message: no orphan durable state either way.
  expect(reader.prepare(
    "SELECT CAST(count(*) AS TEXT) AS n FROM message m JOIN idempotency_record r ON r.entity_id=m.message_id AND r.namespace=? AND r.idempotency_key=m.idempotency_key",
  ).get(namespace(active))!.n).toBe(String(expected.messages));
  expect(reader.prepare(
    "SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record r WHERE r.namespace=? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.message_id=r.entity_id)",
  ).get(namespace(active))!.n).toBe("0");
  return reader.prepare(
    "SELECT message_id, CAST(payload_length AS TEXT) AS length, CAST(private_revision AS TEXT) AS revision FROM message ORDER BY rowid",
  ).all();
}

function capturedError(action: () => unknown): Error & { code?: string; outcome?: string; retryable?: boolean } {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error & { code?: string; outcome?: string; retryable?: boolean };
  expect(Object.hasOwn(error, "cause")).toBe(false);
  const diagnostic = String(error.stack) + JSON.stringify(error);
  for (const secret of SECRETS) expect(diagnostic.includes(secret)).toBe(false);
  return error;
}

/** Finite readiness and lifetime, early-exit rejection, line-framed readiness.
 * Correctness comes from the explicit release barrier, never elapsed time. */
function launch(script: string | readonly string[], active: Fixture, tag: string, extra: Record<string, unknown>): Worker {
  const releasePath = join(active.root, `${tag}.release`);
  const config = {
    tag, storeUrl, creationUrl, directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_MS, waitMs: WORKER_MS,
    readyPath: join(active.root, `${tag}.ready`), releasePath, ...extra,
  };
  const child = spawn(process.execPath, ["--import", register, ...(typeof script === "string" ? [script] : script), JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", pending = "";
  const lines: Record<string, unknown>[] = [];
  let announce: () => void = () => undefined;
  const readyEvent = new Promise<void>((resolve) => { announce = resolve; });
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk; pending += chunk;
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line.length === 0) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      lines.push(parsed);
      if (parsed.event === "ready") announce();
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, WORKER_MS);
  const done = new Promise<WorkerReport>((resolve, reject) => {
    child.once("error", () => { clearTimeout(timer); reject(new Error("fresh-state worker launch failed")); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error("fresh-state worker exceeded bounded lifetime"));
      else resolve({ status, signal, stdout, stderr, lines });
    });
  });
  const ready = Promise.race([
    readyEvent,
    done.then(() => { throw new Error("fresh-state worker exited before readiness"); }),
  ]);
  void ready.catch(() => undefined);
  void done.catch(() => undefined);
  const worker = { child, releasePath, ready, done };
  workers.push(worker);
  return worker;
}

/** Clean termination plus privacy: no payload bytes, endpoint values, SQL text
 * or exception causes in worker stdout/stderr, and barrier markers carry no
 * diagnostic content at all. */
function cleanExit(report: WorkerReport, active: Fixture, tag: string) {
  expect({ status: report.status, signal: report.signal, stderr: report.stderr })
    .toEqual({ status: 0, signal: null, stderr: "" });
  for (const secret of SECRETS) expect(report.stdout.includes(secret)).toBe(false);
  for (const marker of [`${tag}.ready`, `${tag}.release`]) {
    const file = join(active.root, marker);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("");
  }
}

/** External, independently committed Exchange close through the accepted S3
 * privileged fixture: its own OS process and its own SQLite connection. */
async function closeExternally(active: Fixture, sequence: number) {
  const worker = launch(closeScript, active, "fresh-close", {
    exchangeId: active.exchangeId, closedAt, eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  await worker.ready;
  expect(worker.child.pid).not.toBe(process.pid);
  writeFileSync(worker.releasePath, "");
  const report = await worker.done;
  cleanExit(report, active, "fresh-close");
  expect(report.lines).toEqual([
    { event: "ready", tag: "fresh-close" },
    { event: "result", stage: "close", tag: "fresh-close", closedRows: 1, auditRows: 1, sequence },
  ]);
  // The external COMMIT is confirmed by an independent reader, not by stdout.
  expect(active.reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "CLOSED", closed_at: closedAt });
}

/** Inline solely to keep R1's authorized diff in this file. This is privileged
 * schema-v1 fixture construction, not attempt/evidence/reconciliation product
 * behavior. The accepted Store opener retains every connection security check. */
const dispositionWorkerSource = String.raw`
import { existsSync, writeFileSync } from "node:fs";
let store;
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
try {
  const config = JSON.parse(process.argv[1]);
  const { openStore } = await import(config.storeUrl);
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
  const db = store.database;
  const policy = {
    foreignKeys: db.prepare("PRAGMA foreign_keys").get().foreign_keys,
    trustedSchema: db.prepare("PRAGMA trusted_schema").get().trusted_schema,
    recursiveTriggers: db.prepare("PRAGMA recursive_triggers").get().recursive_triggers,
  };
  if (policy.foreignKeys !== 1 || policy.trustedSchema !== 0 || policy.recursiveTriggers !== 1) {
    throw new Error("fixture connection policy rejected");
  }
  writeFileSync(config.readyPath, "", { flag: "wx" });
  emit({ event: "ready", tag: config.tag });
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + config.waitMs;
  while (!existsSync(config.releasePath)) {
    if (Date.now() > deadline) throw new Error("fixture release barrier expired");
    Atomics.wait(idle, 0, 0, 5);
  }
  db.exec("BEGIN IMMEDIATE");
  const single = (result) => {
    if (result.changes !== 1 && result.changes !== 1n) throw new Error("fixture insert refused");
  };
  // schema.ts: attempt.message_id owns the existing Message. Its composite
  // (message_id, attempt_id) key is referenced by both evidence and reconciliation.
  single(db.prepare(
    "INSERT INTO attempt(attempt_id, message_id, endpoint_json, consumer_id, instance_id, fencing_token, lease_expires_at, dispatch, transport, created_at, private_revision) VALUES (?, ?, ?, 'fixture-consumer', 'fixture-instance', 1, ?, 'not_attempted', 'pending', ?, 1)",
  ).run(config.attemptId, config.messageId, config.endpointJson, config.recordedAt, config.recordedAt));
  // Both composite FKs must agree; JSON/digest and observation time are fixture data.
  single(db.prepare(
    "INSERT INTO evidence_envelope(envelope_id, exchange_id, message_id, attempt_id, evidence_kind, evidence_digest, evidence_json, observed_at, private_revision) VALUES (?, ?, ?, ?, 'fixture-observation', ?, ?, ?, 1)",
  ).run(config.envelopeId, config.exchangeId, config.messageId, config.attemptId, config.evidenceDigest, config.evidenceJson, config.recordedAt));
  // No evidence_application or result is required by this accepted schema FK chain.
  single(db.prepare(
    "INSERT INTO reconciliation(reconciliation_id, exchange_id, message_id, attempt_id, evidence_envelope_id, basis, resolved_at, private_revision) VALUES (?, ?, ?, ?, ?, 'test-only administrative fixture', ?, 1)",
  ).run(config.reconciliationId, config.exchangeId, config.messageId, config.attemptId, config.envelopeId, config.recordedAt));
  single(db.prepare(
    "INSERT INTO disposition(exchange_id, status, owner_id, recorded_at, reason, reconciliation_id, unresolved_json, private_revision) VALUES (?, 'ABANDONED_UNRESOLVED', 'owner', ?, 'test-only administrative fixture', ?, '[]', 1)",
  ).run(config.exchangeId, config.recordedAt, config.reconciliationId));
  db.exec("COMMIT");
  store.close();
  store = undefined;
  emit({ event: "result", stage: "disposition", tag: config.tag, committed: true, policy });
} catch {
  // Never inspect, retain, serialize, or rethrow SQL/endpoint values or causes.
  try { if (store?.database.isTransaction) store.database.exec("ROLLBACK"); } catch {}
  process.exitCode = 4;
  emit({ event: "result", stage: "disposition", code: "DISPOSITION_FIXTURE_FAILED" });
} finally {
  try { store?.close(); } catch { process.exitCode = 4; }
}
`;

/** Read-only confirmation of every administrative row, its ownership and INTEGER
 * fields, alongside all five B1 tables. Not a product resolution assertion. */
function dispositionEvidence(active: Fixture, original: ReturnType<typeof createMessage>) {
  const { reader } = active;
  const messageId = original.message.messageId;
  expect(DISPOSITION_TABLES.map((table) =>
    reader.prepare(`SELECT CAST(count(*) AS TEXT) AS n FROM "${table}"`).get()!.n,
  )).toEqual(["1", "2", "2", "1", "1", "1", "1", "1"]);
  expect(reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "OPEN", closed_at: null });
  expect(reader.prepare(
    "SELECT d.exchange_id, d.status, d.owner_id, d.recorded_at, d.reason, d.reconciliation_id, d.unresolved_json," +
    " CAST(d.private_revision AS TEXT) AS disposition_revision, r.message_id, r.attempt_id, r.evidence_envelope_id," +
    " r.basis, r.resolved_at, CAST(r.private_revision AS TEXT) AS reconciliation_revision," +
    " e.exchange_id AS evidence_exchange, e.message_id AS evidence_message, e.attempt_id AS evidence_attempt," +
    " e.evidence_kind, e.evidence_digest, e.evidence_json, e.observed_at, CAST(e.private_revision AS TEXT) AS evidence_revision," +
    " a.endpoint_json, a.consumer_id, a.instance_id, CAST(a.fencing_token AS TEXT) AS token," +
    " a.lease_expires_at, a.dispatch, a.transport, a.created_at, CAST(a.private_revision AS TEXT) AS attempt_revision" +
    " FROM disposition d JOIN reconciliation r ON r.reconciliation_id=d.reconciliation_id AND r.exchange_id=d.exchange_id" +
    " JOIN evidence_envelope e ON e.envelope_id=r.evidence_envelope_id AND e.exchange_id=r.exchange_id" +
    " AND e.message_id=r.message_id AND e.attempt_id=r.attempt_id" +
    " JOIN attempt a ON a.attempt_id=r.attempt_id AND a.message_id=r.message_id" +
    " JOIN message m ON m.message_id=a.message_id AND m.exchange_id=d.exchange_id WHERE d.exchange_id=?",
  ).all(active.exchangeId)).toEqual([{
    exchange_id: active.exchangeId, status: "ABANDONED_UNRESOLVED", owner_id: "owner",
    recorded_at: closedAt, reason: "test-only administrative fixture",
    reconciliation_id: dispositionIds.reconciliationId, unresolved_json: "[]", disposition_revision: "1",
    message_id: messageId, attempt_id: dispositionIds.attemptId, evidence_envelope_id: dispositionIds.envelopeId,
    basis: "test-only administrative fixture", resolved_at: closedAt, reconciliation_revision: "1",
    evidence_exchange: active.exchangeId, evidence_message: messageId, evidence_attempt: dispositionIds.attemptId,
    evidence_kind: "fixture-observation", evidence_digest: dispositionEvidenceDigest,
    evidence_json: dispositionEvidenceJson, observed_at: closedAt, evidence_revision: "1",
    endpoint_json: JSON.stringify(to), consumer_id: "fixture-consumer", instance_id: "fixture-instance",
    token: "1", lease_expires_at: closedAt, dispatch: "not_attempted", transport: "pending",
    created_at: closedAt, attempt_revision: "1",
  }]);
  expect(reader.prepare(
    "SELECT m.message_id, CAST(m.payload_length AS TEXT) AS length, CAST(m.private_revision AS TEXT) AS revision, r.entity_id, r.idempotency_key, r.request_digest, r.created_at, CAST(r.private_revision AS TEXT) AS record_revision FROM message m JOIN idempotency_record r ON r.entity_id=m.message_id AND r.namespace=? AND r.idempotency_key=m.idempotency_key AND r.created_at=m.created_at",
  ).all(namespace(active))).toEqual([{
    message_id: messageId, length: "4", revision: "1", entity_id: messageId, idempotency_key: key,
    request_digest: original.record.requestDigest, created_at: original.record.createdAt,
    record_revision: "1",
  }]);
  expect(reader.prepare(
    "SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record r WHERE r.namespace=? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.message_id=r.entity_id AND m.idempotency_key=r.idempotency_key)",
  ).get(namespace(active))!.n).toBe("0");
  expect(reader.prepare(
    "SELECT CAST(sequence AS TEXT) AS n, kind, subject_id FROM audit_event WHERE exchange_id=? ORDER BY sequence",
  ).all(active.exchangeId)).toEqual([
    { n: "1", kind: "exchange_opened", subject_id: active.exchangeId },
    { n: "2", kind: "message_created", subject_id: messageId },
  ]);
  expect(reader.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
}

afterEach(async () => {
  const completed = await Promise.all(workers.splice(0).map(async (worker) => {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    return worker.done.catch(() => undefined);
  }));
  for (const { root, reader, raw, store } of fixtures.splice(0)) {
    reader.close(); raw.close();
    try { store.close(); } catch { /* an invalidated connection is already closed */ }
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
  // A signalled cleanup means a test did not release its worker normally.
  for (const report of completed) if (report !== undefined) expect(report.signal).toBeNull();
});

it("F2-A: an externally committed Exchange CLOSE is observed without reopening the Store", async () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  const uuid = active.store.storeUuid;
  await closeExternally(active, 3);
  const before = snapshot(active.reader);

  // Same never-reopened handle: new creation must read the CURRENT row state.
  expect(capturedError(() => createMessage(active.store, { ...request(active), idempotencyKey: "post-close-key" })))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  // Historical replay precedence survives the Exchange close.
  const replay = createMessage(active.store, request(active));
  expect(replay.disposition).toBe("REPLAYED");
  expect(replay.message).toEqual(original.message);
  expect(replay.record).toEqual(original.record);
  expect(snapshot(active.reader)).toEqual(before); // replay performed no writes
  expect(active.store.storeUuid).toBe(uuid); // the same handle, never reopened
  expect(evidence(active, {
    state: "CLOSED", closed: true, messages: 1,
    kinds: ["exchange_opened", "message_created", "exchange_closed"],
  })).toEqual([{ message_id: original.message.messageId, length: "4", revision: "1" }]);

  // A missing reconciliation is rejected by the disposition FK (787). This
  // negative fixture is not disposition-row freshness evidence: F2-B below
  // commits the complete schema-valid test-only dependency chain instead.
  expect(capturedError(() => active.raw.prepare(
    "INSERT INTO disposition(exchange_id, status, owner_id, recorded_at, reason, reconciliation_id, unresolved_json) VALUES (?, 'ABANDONED_UNRESOLVED', 'owner', ?, 'characterization', 'rec_missing', '[]')",
  ).run(active.exchangeId, closedAt))).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 787 });
  expect(snapshot(active.reader)).toEqual(before);
}, TEST_MS);

it("F2-B: an externally committed disposition rejects new creation while Exchange stays OPEN", async () => {
  const active = fixture();
  const originalStore = active.store;
  const originalDatabase = active.store.database;
  const uuid = active.store.storeUuid;
  const original = createMessage(active.store, request(active));
  expect(evidence(active, {
    state: "OPEN", closed: false, messages: 1, kinds: ["exchange_opened", "message_created"],
  })).toEqual([{ message_id: original.message.messageId, length: "4", revision: "1" }]);
  const initial = snapshot(active.reader, DISPOSITION_TABLES);
  expect(initial.slice(4)).toEqual([[], [], [], []]); // no disposition or supporting chain
  const worker = launch(["--input-type=module", "--eval", dispositionWorkerSource], active, "fresh-disposition", {
    exchangeId: active.exchangeId, messageId: original.message.messageId, ...dispositionIds,
    recordedAt: closedAt, endpointJson: JSON.stringify(to),
    evidenceJson: dispositionEvidenceJson, evidenceDigest: dispositionEvidenceDigest,
  });
  await worker.ready;
  expect(worker.child.pid).toBeTypeOf("number");
  expect(worker.child.pid).not.toBe(process.pid);
  // Ready means this process opened its own Store. Nothing is committed before release.
  expect(snapshot(active.reader, DISPOSITION_TABLES)).toEqual(initial);
  writeFileSync(worker.releasePath, "");
  const report = await worker.done;
  cleanExit(report, active, "fresh-disposition");
  expect(report.lines).toEqual([
    { event: "ready", tag: "fresh-disposition" },
    { event: "result", stage: "disposition", tag: "fresh-disposition", committed: true,
      policy: { foreignKeys: 1, trustedSchema: 0, recursiveTriggers: 1 } },
  ]);
  // The independent reader sees the whole committed chain, not merely worker stdout.
  dispositionEvidence(active, original);
  const before = snapshot(active.reader, DISPOSITION_TABLES);
  expect(before.slice(0, 4)).toEqual(initial.slice(0, 4)); // Message/record/audit/OPEN Exchange untouched
  const changes = active.store.database.prepare("SELECT CAST(total_changes() AS TEXT) AS n").get()!.n;

  expect(capturedError(() => createMessage(active.store, { ...request(active), idempotencyKey: "post-disposition-key" })))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  expect(snapshot(active.reader, DISPOSITION_TABLES)).toEqual(before);
  const replay = createMessage(active.store, request(active));
  expect(replay.disposition).toBe("REPLAYED");
  expect(replay.message).toEqual(original.message);
  expect(replay.record).toEqual(original.record);
  expect(snapshot(active.reader, DISPOSITION_TABLES)).toEqual(before);
  expect(active.store.database.prepare("SELECT CAST(total_changes() AS TEXT) AS n").get()!.n).toBe(changes);
  expect(active.store).toBe(originalStore);
  expect(active.store.database).toBe(originalDatabase);
  expect(active.store.storeUuid).toBe(uuid);
  dispositionEvidence(active, original); // OPEN plus disposition isolates its admission branch
}, TEST_MS);

it("F3: an externally committed Message and record replay through the open Store", async () => {
  const active = fixture();
  const uuid = active.store.storeUuid;
  // The key must be absent before the external commit; established by the
  // independent reader so no product call can create it first.
  expect(active.reader.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record WHERE namespace=? AND idempotency_key=?")
    .get(namespace(active), key)!.n).toBe("0");
  expect(active.reader.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM message").get()!.n).toBe("0");

  // A real independent process with its own openStore connection performs the
  // complete, internally consistent creation: Message, record and audit event.
  const worker = launch(workerScript, active, "fresh-create", {
    request: { exchangeId: active.exchangeId, from, to, payload: [...payload], idempotencyKey: key },
  });
  await worker.ready;
  expect(worker.child.pid).not.toBe(process.pid);
  writeFileSync(worker.releasePath, "");
  const report = await worker.done;
  cleanExit(report, active, "fresh-create");
  const result = report.lines.at(-1)!;
  expect(result).toMatchObject({ event: "result", stage: "create", disposition: "CREATED", payloadLength: 4 });
  const messageId = result.messageId as string;
  expect(result.entityId).toBe(messageId);
  // External COMMIT confirmed durably, not from worker stdout.
  expect(active.reader.prepare("SELECT message_id FROM message").get()).toEqual({ message_id: messageId });
  const before = snapshot(active.reader);

  const replay = createMessage(active.store, request(active));
  expect(replay.disposition).toBe("REPLAYED");
  expect(replay.message.messageId).toBe(messageId);
  expect(replay.record.entityId).toBe(messageId);
  expect(replay.message.createdAt).toBe(result.createdAt);
  expect(snapshot(active.reader)).toEqual(before); // no Message, record or audit written
  expect(active.store.storeUuid).toBe(uuid); // the original Store was never reopened
  expect(evidence(active, {
    state: "OPEN", closed: false, messages: 1,
    kinds: ["exchange_opened", "message_created"],
  })).toEqual([{ message_id: messageId, length: "4", revision: "1" }]);
}, TEST_MS);

it("F4: SCHEMA_V1_UNAUTHENTICATED_STATE_CHARACTERIZATION — privileged CLOSED->OPEN drift (CE-STORAGE-IMMUTABILITY-V2)", async () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  await closeExternally(active, 3);
  expect(capturedError(() => createMessage(active.store, { ...request(active), idempotencyKey: "closed-key" })))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED" });

  // Privileged TEST authority only. No trigger, foreign key or other control is
  // bypassed: the schema-v1 state CHECK permits (OPEN, closed_at IS NULL), and
  // the identity trigger guards only exchange_id. This is NOT a product
  // transition and no reopenExchange API exists or is implied.
  expect(active.raw.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(active.raw.prepare("PRAGMA trusted_schema").get()).toEqual({ trusted_schema: 0 });
  expect(active.raw.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
  const drift = active.raw.prepare("UPDATE exchange SET state='OPEN', closed_at=NULL WHERE exchange_id=? AND state='CLOSED'")
    .run(active.exchangeId);
  // Observed behavior: schema v1 does not authenticate administrative state.
  expect(Number(drift.changes)).toBe(1);
  expect(active.reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "OPEN", closed_at: null });

  // Current-store reads: the never-reopened handle observes the drifted row in
  // its next transaction, with historical replay precedence still first.
  const replay = createMessage(active.store, request(active));
  expect(replay.disposition).toBe("REPLAYED");
  expect(replay.message).toEqual(original.message);
  const admitted = createMessage(active.store, { ...request(active), idempotencyKey: "drift-key" });
  expect(admitted.disposition).toBe("CREATED");
  expect(evidence(active, {
    state: "OPEN", closed: false, messages: 2,
    // The exchange_closed event remains: audit history is append-only and is
    // not rewritten by privileged state drift. Characterization only.
    kinds: ["exchange_opened", "message_created", "exchange_closed", "message_created"],
  }).map((row) => row.revision)).toEqual(["1", "1"]);
}, TEST_MS);

it("F5: SCHEMA_V1_UNAUTHENTICATED_STATE_CHARACTERIZATION — Exchange deletion with dependent rows is refused", () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  const before = snapshot(active.reader);
  expect(active.raw.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  // ON DELETE RESTRICT is enforced; SQLite reports RESTRICT refusals with the
  // extended code 1811. No control is disabled to force a dangling state, so
  // replay against a deleted Exchange is not observable and is not asserted.
  expect(capturedError(() => active.raw.prepare("DELETE FROM exchange WHERE exchange_id=?").run(active.exchangeId)))
    .toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 1811 });
  expect(active.raw.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  expect(snapshot(active.reader)).toEqual(before);
  expect(evidence(active, {
    state: "OPEN", closed: false, messages: 1,
    kinds: ["exchange_opened", "message_created"],
  })).toEqual([{ message_id: original.message.messageId, length: "4", revision: "1" }]);
  // The preserved Exchange still serves historical replay from current state.
  expect(createMessage(active.store, request(active)).message).toEqual(original.message);
  expect(snapshot(active.reader)).toEqual(before);
});
