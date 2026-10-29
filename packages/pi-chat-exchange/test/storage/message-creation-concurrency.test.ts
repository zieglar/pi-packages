import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSqliteDriver } from "../../src/storage/sqlite-driver-selection.js";
import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, openStore } from "../../src/storage/store.js";

/** S3-B1: independent-process concurrency and Exchange close-race validation.
 * Workers are real OS processes sharing only the canonical database path. The
 * parent owns the database lifecycle, barriers, timeouts, child cleanup, and
 * all durable verification through an independent reader. Accepted B1 BUSY
 * semantics are preserved: BEGIN IMMEDIATE is attempted once and never retried. */

type ConcurrencyChild = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const PARENT_TIMEOUT_MS = 30_000;
const BUSY_TIMEOUT_MS = 5_000;
const TEST_TIMEOUT_MS = 90_000;
const closedAt = "2026-10-09T22:00:00.000Z";

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const workerScript = fileURLToPath(new URL("./support/concurrency-worker.mjs", import.meta.url));
const closeScript = fileURLToPath(new URL("./support/close-fixture.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const creationUrl = new URL("../../src/storage/creation.ts", import.meta.url).href;

const from = { adapter: "pi", endpointId: "producer-1" };
const to = { adapter: "pi", endpointId: "consumer-1" };

interface Scenario {
  readonly root: string;
  readonly directory: string;
  readonly reader: SqliteConnection;
  readonly exchangeId: string;
}
interface WorkerReport {
  readonly tag: string;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lines: readonly Record<string, unknown>[];
  readonly result: Record<string, unknown>;
  readonly stderr: string;
}
interface Launched {
  readonly tag: string;
  readonly child: ConcurrencyChild;
  readonly releasePath: string;
  readonly ready: Promise<void>;
  readonly done: Promise<WorkerReport>;
}

const scenarios: Scenario[] = [];
const children: ConcurrencyChild[] = [];

function scenario(): Scenario {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s3b-"));
  const directory = join(root, "db");
  // The parent writer is closed before any worker opens the store so that an
  // openStore preflight race can never contaminate a concurrency result.
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  let exchangeId: string;
  try {
    exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" }).exchange.exchangeId;
  } finally {
    store.close();
  }
  const reader = resolveSqliteDriver().open(join(directory, "store.sqlite"), { readOnly: true });
  const result = { root, directory, reader, exchangeId };
  scenarios.push(result);
  return result;
}

/** Parent-side seeding uses the same accepted private API through a short-lived
 * writer; no worker is running while it is open. */
function seed(active: Scenario, idempotencyKey: string, payload: readonly number[]) {
  const store = openStore({ directory: active.directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return createMessage(store, {
      exchangeId: active.exchangeId, from, to,
      payload: Uint8Array.from(payload), idempotencyKey,
    });
  } finally {
    store.close();
  }
}

function launch(script: string, active: Scenario, tag: string, extra: Record<string, unknown>): Launched {
  const readyPath = join(active.root, `${tag}.ready`);
  const releasePath = join(active.root, `${tag}.release`);
  const config = {
    tag, storeUrl, creationUrl,
    directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_TIMEOUT_MS, waitMs: WORKER_WAIT_MS,
    readyPath, releasePath, ...extra,
  };
  const child = spawn(process.execPath, ["--import", register, script, JSON.stringify(config)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let stdout = "";
  let stderr = "";
  const lines: Record<string, unknown>[] = [];
  let announceReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { announceReady = resolve; });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    let index = stdout.indexOf("\n");
    while (index >= 0) {
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (line.length > 0) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        lines.push(parsed);
        if (parsed.event === "ready") announceReady();
      }
      index = stdout.indexOf("\n");
    }
  });

  const exited = new Promise<WorkerReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      const results = lines.filter((line) => line.event === "result");
      resolve({ tag, status, signal, lines, stderr, result: results[results.length - 1] ?? {} });
    });
  });
  const done = Promise.race([
    exited,
    new Promise<WorkerReport>((_resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`worker ${tag} exceeded the bounded parent timeout`));
      }, PARENT_TIMEOUT_MS);
      void exited.finally(() => { clearTimeout(timer); });
    }),
  ]);
  return { tag, child, releasePath, ready, done };
}

const release = (worker: Launched) => { writeFileSync(worker.releasePath, ""); };

async function readyAll(workers: readonly Launched[]): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      // Fail fast: a worker that exits before readiness is an infrastructure
      // failure, never a scenario outcome.
      Promise.all(workers.map((worker) => Promise.race([
        worker.ready,
        worker.done.then((report) => {
          throw new Error(`worker ${worker.tag} exited before readiness: ${JSON.stringify(report.result)}`);
        }),
      ]))),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("workers did not become ready within the bounded timeout")), PARENT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Every worker must exit cleanly; open-stage and barrier failures are explicit
 * infrastructure diagnostics, never scenario outcomes. */
function completed(report: WorkerReport): Record<string, unknown> {
  expect({ tag: report.tag, status: report.status, signal: report.signal, stderr: report.stderr })
    .toEqual({ tag: report.tag, status: 0, signal: null, stderr: "" });
  expect(report.result.stage).toBe("create");
  return report.result;
}

function outcomeOf(result: Record<string, unknown>): string {
  return (result.disposition ?? result.code) as string;
}

function counts(active: Scenario) {
  const scalar = (sql: string, ...parameters: string[]) =>
    Number(active.reader.prepare(sql).get(...parameters)!.n);
  return {
    messages: scalar("SELECT count(*) AS n FROM message"),
    records: scalar("SELECT count(*) AS n FROM idempotency_record WHERE namespace=?",
      JSON.stringify(["message.create", active.exchangeId])),
    created: scalar("SELECT count(*) AS n FROM audit_event WHERE kind='message_created'"),
    audits: scalar("SELECT count(*) AS n FROM audit_event"),
  };
}

function auditSequences(active: Scenario): number[] {
  return active.reader.prepare("SELECT sequence FROM audit_event WHERE exchange_id=? ORDER BY sequence")
    .all(active.exchangeId).map((row) => Number(row.sequence));
}

function exchangeState(active: Scenario) {
  const row = active.reader.prepare("SELECT state, closed_at FROM exchange WHERE exchange_id=?")
    .get(active.exchangeId)!;
  return { state: row.state, closed: row.closed_at !== null };
}

/** Independent structural verification: identity uniqueness, referential
 * consistency between Message/record/audit, and physical integrity. */
function assertDurableConsistency(active: Scenario): void {
  const { reader } = active;
  expect(reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const sequences = auditSequences(active);
  expect(new Set(sequences).size).toBe(sequences.length);
  expect(sequences).toEqual([...Array(sequences.length).keys()].map((index) => index + 1));
  expect(reader.prepare("SELECT count(*) AS n FROM message").get()!.n)
    .toBe(reader.prepare("SELECT count(DISTINCT message_id) AS n FROM message").get()!.n);
  // Every durable Message of this Exchange owns exactly one record and one audit event.
  expect(reader.prepare(
    "SELECT count(*) AS n FROM message m WHERE m.exchange_id=?1 AND (" +
    " (SELECT count(*) FROM idempotency_record r WHERE r.entity_id=m.message_id) <> 1 OR" +
    " (SELECT count(*) FROM audit_event a WHERE a.subject_id=m.message_id AND a.kind='message_created') <> 1)",
  ).get(active.exchangeId)!.n).toBe(0);
  // No orphan Message-scoped record or audit event may exist.
  expect(reader.prepare(
    "SELECT count(*) AS n FROM idempotency_record r WHERE r.namespace=?1" +
    " AND NOT EXISTS (SELECT 1 FROM message m WHERE m.message_id=r.entity_id)",
  ).get(JSON.stringify(["message.create", active.exchangeId]))!.n).toBe(0);
  expect(reader.prepare(
    "SELECT count(*) AS n FROM audit_event a WHERE a.kind='message_created'" +
    " AND NOT EXISTS (SELECT 1 FROM message m WHERE m.message_id=a.subject_id)",
  ).get()!.n).toBe(0);
}

function assertNoSecretLeak(reports: readonly WorkerReport[]): void {
  for (const report of reports) {
    const text = JSON.stringify(report.lines) + report.stderr;
    for (const secret of ["producer-1", "consumer-1", "SELECT", "INSERT", "payload_body"]) {
      expect(text).not.toContain(secret);
    }
  }
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const { root, reader } of scenarios.splice(0)) {
    reader.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function messageWorkers(active: Scenario, specs: readonly { tag: string; key: string; payload: readonly number[] }[]) {
  return specs.map((spec) => launch(workerScript, active, spec.tag, {
    request: { exchangeId: active.exchangeId, from, to, payload: [...spec.payload], idempotencyKey: spec.key },
  }));
}

async function raceOutcomes(active: Scenario, specs: readonly { tag: string; key: string; payload: readonly number[] }[]) {
  const workers = messageWorkers(active, specs);
  await readyAll(workers);
  for (const worker of workers) release(worker);
  const reports = await Promise.all(workers.map((worker) => worker.done));
  return { reports, results: reports.map(completed) };
}

async function serializedOutcomes(
  active: Scenario,
  specs: readonly { tag: string; key: string; payload: readonly number[] }[],
) {
  const workers = messageWorkers(active, specs);
  await readyAll(workers);
  const reports: WorkerReport[] = [];
  // Each worker is released only after the previous worker has fully exited, so
  // the commit order is established explicitly rather than by scheduling luck.
  for (const worker of workers) {
    release(worker);
    reports.push(await worker.done);
  }
  return { reports, results: reports.map(completed) };
}

const BUSY = "STORAGE_TRANSACTION_BUSY";

function assertBusy(result: Record<string, unknown>): void {
  expect(result).toMatchObject({ code: BUSY, outcome: "ROLLED_BACK", retryable: true });
}

// ---------------------------------------------------------------- C1

it("C1 race: two processes with the same key and request never duplicate durable state", async () => {
  const active = scenario();
  const { reports, results } = await raceOutcomes(active, [
    { tag: "a", key: "shared", payload: [1, 2, 3] },
    { tag: "b", key: "shared", payload: [1, 2, 3] },
  ]);
  const outcomes = results.map(outcomeOf).sort();
  expect([["CREATED", "REPLAYED"], [BUSY, "CREATED"]]).toContainEqual(outcomes);
  const busy = results.find((result) => result.code === BUSY);
  if (busy !== undefined) assertBusy(busy);
  const identities = new Set(results.filter((result) => result.messageId !== undefined).map((r) => r.messageId));
  expect(identities.size).toBe(1);
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

it("C1 serialized: the second process replays the first commit with zero writes", async () => {
  const active = scenario();
  const { reports, results } = await serializedOutcomes(active, [
    { tag: "a", key: "shared", payload: [1, 2, 3] },
    { tag: "b", key: "shared", payload: [1, 2, 3] },
  ]);
  expect(results.map(outcomeOf)).toEqual(["CREATED", "REPLAYED"]);
  expect(results[1]!.messageId).toBe(results[0]!.messageId);
  expect(results[1]!.createdAt).toBe(results[0]!.createdAt);
  expect(results[1]!.entityId).toBe(results[0]!.entityId);
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  expect(auditSequences(active)).toEqual([1, 2]);
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

// ---------------------------------------------------------------- C2

it("C2 race: the same key with a different request never replaces the winner", async () => {
  const active = scenario();
  const { reports, results } = await raceOutcomes(active, [
    { tag: "a", key: "shared", payload: [1, 2, 3] },
    { tag: "b", key: "shared", payload: [9, 9] },
  ]);
  const outcomes = results.map(outcomeOf).sort();
  expect([["CREATED", "IDEMPOTENCY_KEY_CONFLICT"], [BUSY, "CREATED"]]).toContainEqual(outcomes);
  const busy = results.find((result) => result.code === BUSY);
  if (busy !== undefined) assertBusy(busy);
  const conflict = results.find((result) => result.code === "IDEMPOTENCY_KEY_CONFLICT");
  if (conflict !== undefined) expect(conflict).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
  const winner = results.find((result) => result.disposition === "CREATED")!;
  const stored = active.reader.prepare("SELECT message_id, payload_length FROM message").get()!;
  expect(stored.message_id).toBe(winner.messageId);
  expect(Number(stored.payload_length)).toBe(winner.payloadLength);
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

it("C2 serialized: the losing different request is a nonretryable conflict with no writes", async () => {
  const active = scenario();
  const { reports, results } = await serializedOutcomes(active, [
    { tag: "a", key: "shared", payload: [1, 2, 3] },
    { tag: "b", key: "shared", payload: [9, 9] },
  ]);
  expect(results.map(outcomeOf)).toEqual(["CREATED", "IDEMPOTENCY_KEY_CONFLICT"]);
  expect(results[1]).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
  expect(results[1]!.messageId).toBeUndefined();
  const stored = active.reader.prepare("SELECT message_id, payload_length FROM message").get()!;
  expect(stored.message_id).toBe(results[0]!.messageId);
  expect(Number(stored.payload_length)).toBe(3);
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  expect(auditSequences(active)).toEqual([1, 2]);
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

// ---------------------------------------------------------------- C3

it("C3 race: different keys in one Exchange never produce partial durable state", async () => {
  const active = scenario();
  const { reports, results } = await raceOutcomes(active, [
    { tag: "a", key: "first", payload: [1] },
    { tag: "b", key: "second", payload: [2, 2] },
  ]);
  const outcomes = results.map(outcomeOf).sort();
  expect([["CREATED", "CREATED"], [BUSY, "CREATED"]]).toContainEqual(outcomes);
  const busy = results.find((result) => result.code === BUSY);
  if (busy === undefined) {
    expect(counts(active)).toEqual({ messages: 2, records: 2, created: 2, audits: 3 });
    expect(auditSequences(active)).toEqual([1, 2, 3]);
    expect(new Set(results.map((result) => result.messageId)).size).toBe(2);
  } else {
    assertBusy(busy);
    expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  }
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

it("C3 serialized: both keys create distinct Messages with unique consecutive audit sequences", async () => {
  const active = scenario();
  const { reports, results } = await serializedOutcomes(active, [
    { tag: "a", key: "first", payload: [1] },
    { tag: "b", key: "second", payload: [2, 2] },
  ]);
  expect(results.map(outcomeOf)).toEqual(["CREATED", "CREATED"]);
  expect(new Set(results.map((result) => result.messageId)).size).toBe(2);
  expect(counts(active)).toEqual({ messages: 2, records: 2, created: 2, audits: 3 });
  expect(auditSequences(active)).toEqual([1, 2, 3]);
  const owners = active.reader
    .prepare("SELECT m.message_id, m.payload_length, r.idempotency_key FROM message m" +
      " JOIN idempotency_record r ON r.entity_id=m.message_id ORDER BY r.idempotency_key").all();
  expect(owners.map((row) => [row.idempotency_key, Number(row.payload_length)]))
    .toEqual([["first", 1], ["second", 2]]);
  expect(owners.map((row) => row.message_id).sort())
    .toEqual(results.map((result) => result.messageId as string).sort());
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

// ---------------------------------------------------------------- C4

it("C4 order A: creation commits first and the later close keeps the Message durable", async () => {
  const active = scenario();
  const creator = messageWorkers(active, [{ tag: "a", key: "race-close", payload: [4, 4] }])[0]!;
  const closer = launch(closeScript, active, "close", {
    exchangeId: active.exchangeId, closedAt, eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  await readyAll([creator, closer]);
  release(creator);
  const creation = completed(await creator.done);
  release(closer);
  const closeReport = await closer.done;

  expect(creation.disposition).toBe("CREATED");
  expect(closeReport).toMatchObject({ status: 0, signal: null, stderr: "" });
  expect(closeReport.result).toMatchObject({ stage: "close", closedRows: 1, auditRows: 1, sequence: 3 });
  expect(exchangeState(active)).toEqual({ state: "CLOSED", closed: true });
  expect(active.reader.prepare("SELECT message_id FROM message").get()!.message_id).toBe(creation.messageId);
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 3 });
  expect(auditSequences(active)).toEqual([1, 2, 3]);
  assertDurableConsistency(active);
  assertNoSecretLeak([await creator.done, closeReport]);
}, TEST_TIMEOUT_MS);

it("C4 order B: a committed close refuses later creation without any durable write", async () => {
  const active = scenario();
  const creator = messageWorkers(active, [{ tag: "a", key: "race-close", payload: [4, 4] }])[0]!;
  const closer = launch(closeScript, active, "close", {
    exchangeId: active.exchangeId, closedAt, eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  await readyAll([creator, closer]);
  release(closer);
  const closeReport = await closer.done;
  expect(closeReport.stderr).toBe("");
  release(creator);
  const creation = completed(await creator.done);

  expect(closeReport.result).toMatchObject({ stage: "close", closedRows: 1, auditRows: 1, sequence: 2 });
  expect(creation).toMatchObject({
    code: "EXCHANGE_DISPOSITION_REJECTED", outcome: "ROLLED_BACK", retryable: false,
  });
  expect(creation.messageId).toBeUndefined();
  expect(exchangeState(active)).toEqual({ state: "CLOSED", closed: true });
  expect(counts(active)).toEqual({ messages: 0, records: 0, created: 0, audits: 2 });
  expect(auditSequences(active)).toEqual([1, 2]);
  assertDurableConsistency(active);
  assertNoSecretLeak([await creator.done, closeReport]);
}, TEST_TIMEOUT_MS);

// ---------------------------------------------------------------- C5

it("C5: concurrent historical replay after close returns REPLAYED with zero new writes", async () => {
  const active = scenario();
  const original = seed(active, "historical", [5, 5, 5]);
  const closer = launch(closeScript, active, "close", {
    exchangeId: active.exchangeId, closedAt, eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  });
  await readyAll([closer]);
  release(closer);
  expect((await closer.done).result).toMatchObject({ stage: "close", closedRows: 1, auditRows: 1 });

  const before = {
    counts: counts(active),
    sequences: auditSequences(active),
    message: { ...active.reader.prepare("SELECT * FROM message").get()! },
    record: { ...active.reader.prepare("SELECT * FROM idempotency_record WHERE idempotency_key='historical'").get()! },
    audit: { ...active.reader.prepare("SELECT * FROM audit_event WHERE kind='message_created'").get()! },
  };

  const { reports, results } = await raceOutcomes(active, [
    { tag: "a", key: "historical", payload: [5, 5, 5] },
    { tag: "b", key: "historical", payload: [5, 5, 5] },
  ]);
  expect(results.map(outcomeOf)).toEqual(["REPLAYED", "REPLAYED"]);
  for (const result of results) {
    expect(result.messageId).toBe(original.message.messageId);
    expect(result.createdAt).toBe(original.message.createdAt);
    expect(result.entityId).toBe(original.record.entityId);
  }
  expect(counts(active)).toEqual(before.counts);
  expect(auditSequences(active)).toEqual(before.sequences);
  expect({ ...active.reader.prepare("SELECT * FROM message").get()! }).toEqual(before.message);
  expect({ ...active.reader.prepare("SELECT * FROM idempotency_record WHERE idempotency_key='historical'").get()! })
    .toEqual(before.record);
  expect({ ...active.reader.prepare("SELECT * FROM audit_event WHERE kind='message_created'").get()! })
    .toEqual(before.audit);
  expect(exchangeState(active)).toEqual({ state: "CLOSED", closed: true });
  assertDurableConsistency(active);
  assertNoSecretLeak(reports);
}, TEST_TIMEOUT_MS);

it("keeps concurrency validation test-only with no production close API", () => {
  const worker = fileURLToPath(new URL("./support/concurrency-worker.mjs", import.meta.url));
  expect(existsSync(worker)).toBe(true);
  const source = readFileSync(new URL("../../src/storage/creation.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/export function close|closeExchange/);
  expect(source).not.toContain("exchange_closed");
});
