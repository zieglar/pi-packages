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
  raw: DatabaseSync;
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
  exchangeId: active.exchangeId, from, to, payload: Uint8Array.from(payload), idempotencyKey: key,
});
const namespace = (active: Fixture) => JSON.stringify(["message.create", active.exchangeId]);

/** CAST quote() to TEXT for every cell, including every SQLite INTEGER: no
 * JavaScript Number decoding, unsafe integer rounding, or quote() type
 * assumption. Names come only from the fixed table list and SQLite metadata. */
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
function launch(script: string, active: Fixture, tag: string, extra: Record<string, unknown>): Worker {
  const releasePath = join(active.root, `${tag}.release`);
  const config = {
    tag, storeUrl, creationUrl, directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_MS, waitMs: WORKER_MS,
    readyPath: join(active.root, `${tag}.ready`), releasePath, ...extra,
  };
  const child = spawn(process.execPath, ["--import", register, script, JSON.stringify(config)], {
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

it("F2: an externally committed disposition change is observed without reopening the Store", async () => {
  const active = fixture();
  const original = createMessage(active.store, request(active));
  const uuid = active.store.storeUuid;
  await closeExternally(active, 3);
  const before = snapshot(active.reader);

  // Same never-reopened handle: new creation must read the CURRENT row state.
  expect(capturedError(() => createMessage(active.store, { ...request(active), idempotencyKey: "post-close-key" })))
    .toMatchObject({ code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false });
  // Historical replay precedence survives the disposition change.
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

  // Schema restriction, recorded rather than worked around: an administrative
  // `disposition` row requires an existing reconciliation (ON DELETE RESTRICT
  // foreign key), whose attempt/evidence chain is outside S4-2 authority.
  expect(capturedError(() => active.raw.prepare(
    "INSERT INTO disposition(exchange_id, status, owner_id, recorded_at, reason, reconciliation_id, unresolved_json) VALUES (?, 'ABANDONED_UNRESOLVED', 'owner', ?, 'characterization', 'rec_missing', '[]')",
  ).run(active.exchangeId, closedAt))).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 787 });
  expect(snapshot(active.reader)).toEqual(before);
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
