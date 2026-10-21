import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, openStore } from "../../src/storage/store.js";

/** S5-1 only: cross-process write-lock recovery after a real SIGKILL, and
 * reader-transaction isolation across that death. No product recovery API,
 * retry, scheduler or production instrumentation exists or is implied. The
 * accepted S3/S4 crash and concurrency fixtures are reused unmodified; every
 * durable assertion comes from an independent read-only connection. */
const WORKER_WAIT_MS = 20_000;
const MARKER_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const BUSY_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 100;
const PAYLOAD = [7, 8, 9, 10];
const KEY = "recovery-key";
const BASELINE_KEY = "recovery-baseline-key";
const CONTENTION = "begin-immediate";
const SECRETS = ["producer-1", "consumer-1", "SELECT", "INSERT", "payload_body", "SENSITIVE"] as const;
const TABLES = ["message", "idempotency_record", "audit_event", "exchange", "disposition"] as const;

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const crashScript = fileURLToPath(new URL("./support/crash-worker.mjs", import.meta.url));
const creatorScript = fileURLToPath(new URL("./support/concurrency-worker.mjs", import.meta.url));
const contenderScript = fileURLToPath(new URL("./support/recovery-contender.mjs", import.meta.url));
const replayScript = fileURLToPath(new URL("./support/recovery-replay.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const creationUrl = new URL("../../src/storage/creation.ts", import.meta.url).href;
const from = { adapter: "pi", endpointId: "producer-1" };
const to = { adapter: "pi", endpointId: "consumer-1" };

type RecoveryChild = ChildProcessByStdio<null, Readable, Readable>;
interface Scenario {
  readonly root: string;
  readonly directory: string;
  readonly reader: DatabaseSync;
  readonly exchangeId: string;
}
interface Report {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lines: readonly Record<string, unknown>[];
  readonly results: readonly Record<string, unknown>[];
  readonly stderr: string;
}
interface Worker {
  readonly child: RecoveryChild;
  readonly tag: string;
  readonly ready: Promise<void>;
  readonly done: Promise<Report>;
  readonly lines: Record<string, unknown>[];
}

class RecoveryInfrastructureError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RecoveryInfrastructureError"; }
}
const infrastructure = (code: string): never => { throw new RecoveryInfrastructureError(code); };

const scenarios: Scenario[] = [];
const children: RecoveryChild[] = [];
const completions: Promise<unknown>[] = [];

function scenario(baseline = false): Scenario {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s5-1-"));
  const directory = join(root, "db");
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  let exchangeId: string;
  try {
    exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" }).exchange.exchangeId;
    if (baseline) {
      // A committed historical Message makes the reader-isolation baseline
      // non-trivial: the WAL already holds committed content.
      createMessage(store, { exchangeId, from, to, payload: Uint8Array.from(PAYLOAD), idempotencyKey: BASELINE_KEY });
    }
  } finally {
    store.close();
  }
  const reader = new DatabaseSync(join(directory, "store.sqlite"), { readOnly: true, defensive: true });
  const active = { root, directory, reader, exchangeId };
  scenarios.push(active);
  return active;
}

/** Complete durable snapshot: every cell and rowid is SQLite TEXT, including
 * quote(INTEGER), so no JavaScript Number decoding can round forensic data. */
function readTables(db: DatabaseSync) {
  return Object.fromEntries(TABLES.map((name) => {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map((row) => {
      const column = `"${String(row.name).replaceAll('"', '""')}"`;
      return `CAST(quote(${column}) AS TEXT) AS ${column}`;
    });
    return [name, db.prepare(`SELECT CAST(rowid AS TEXT) AS _rowid, ${columns.join(", ")} FROM "${name}" ORDER BY rowid`).all()];
  }));
}
function snapshot(active: Scenario) {
  active.reader.exec("BEGIN");
  try { return readTables(active.reader); } finally { active.reader.exec("ROLLBACK"); }
}
function counts(active: Scenario) {
  const scalar = (sql: string, ...parameters: string[]) => active.reader.prepare(sql).get(...parameters)!.n;
  return {
    messages: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM message"),
    records: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record WHERE namespace=?",
      JSON.stringify(["message.create", active.exchangeId])),
    created: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM audit_event WHERE kind='message_created'"),
    audits: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM audit_event"),
  };
}
function losslessIntegers(active: Scenario) {
  return active.reader.prepare(
    "SELECT message_id, CAST(private_revision AS TEXT) AS revision, CAST(payload_length AS TEXT) AS length FROM message ORDER BY rowid",
  ).all();
}
function assertDurableConsistency(active: Scenario): void {
  expect(active.reader.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(active.reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const sequences = active.reader
    .prepare("SELECT CAST(sequence AS TEXT) AS sequence FROM audit_event WHERE exchange_id=? ORDER BY sequence")
    .all(active.exchangeId).map((row) => row.sequence);
  expect(sequences).toEqual([...Array(sequences.length).keys()].map((index) => String(index + 1)));
  const namespace = JSON.stringify(["message.create", active.exchangeId]);
  const owned = active.reader.prepare(
    "SELECT CAST(count(*) AS TEXT) AS n FROM message m JOIN idempotency_record r ON r.entity_id=m.message_id AND r.namespace=? AND r.idempotency_key=m.idempotency_key AND r.created_at=m.created_at",
  ).get(namespace)!.n;
  expect(owned).toBe(active.reader.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM message").get()!.n);
  expect(active.reader.prepare(
    "SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record r WHERE r.namespace=? AND NOT EXISTS (SELECT 1 FROM message m WHERE m.message_id=r.entity_id AND m.idempotency_key=r.idempotency_key)",
  ).get(namespace)!.n).toBe("0");
  expect(active.reader.prepare(
    "SELECT subject_id FROM audit_event WHERE kind='message_created' AND exchange_id=? ORDER BY sequence",
  ).all(active.exchangeId)).toEqual(active.reader.prepare("SELECT message_id AS subject_id FROM message ORDER BY rowid").all());
}
function assertNoSecretLeak(report: Report): void {
  const text = JSON.stringify(report.lines) + report.stderr;
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

/** Privileged TEST probe on an independent connection: does the write lock
 * exist right now? Bounded busy timeout, exactly one BEGIN attempt, and no
 * production code path is involved. */
function writeLockHeld(active: Scenario): boolean {
  const probe = new DatabaseSync(join(active.directory, "store.sqlite"), { timeout: PROBE_TIMEOUT_MS });
  try {
    try {
      probe.exec("BEGIN IMMEDIATE");
    } catch (error) {
      expect(Number((error as { errcode?: number }).errcode) % 256).toBe(5); // SQLITE_BUSY family
      expect(probe.isTransaction).toBe(false);
      return true;
    }
    probe.exec("ROLLBACK");
    return false;
  } finally { probe.close(); }
}

function launch(active: Scenario, tag: string, options: {
  readonly script?: readonly string[];
  readonly extra?: Record<string, unknown>;
  readonly waitMs?: number;
} = {}): Worker {
  const paths = {
    readyPath: join(active.root, `${tag}.ready`), releasePath: join(active.root, `${tag}.release`),
    markerPath: join(active.root, `${tag}.marker`), evidencePath: join(active.root, `${tag}.evidence`),
    contentionPath: join(active.root, `${tag}.contention`),
  };
  for (const path of Object.values(paths)) {
    if (existsSync(path) || existsSync(`${path}.pending`)) infrastructure("RECOVERY_STALE_ARTIFACT");
  }
  const config = {
    tag, storeUrl, creationUrl, directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_TIMEOUT_MS, waitMs: options.waitMs ?? WORKER_WAIT_MS, ...paths,
    request: { exchangeId: active.exchangeId, from, to, payload: PAYLOAD, idempotencyKey: KEY },
    ...options.extra,
  };
  const child = spawn(process.execPath,
    ["--import", register, ...(options.script ?? [contenderScript]), JSON.stringify(config)],
    { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "", stderr = "";
  const lines: Record<string, unknown>[] = [];
  let announceReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const readyEvent = new Promise<void>((resolve, reject) => { announceReady = resolve; rejectReady = reject; });
  let framingFailed = false;
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const index = stdout.indexOf("\n");
      const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        lines.push(parsed);
        if (parsed.event === "ready") announceReady();
      } catch {
        framingFailed = true;
        rejectReady(new RecoveryInfrastructureError("RECOVERY_WORKER_INVALID_OUTPUT"));
      }
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MARKER_TIMEOUT_MS + WORKER_WAIT_MS);
  const done = new Promise<Report>((resolve, reject) => {
    child.once("error", () => { clearTimeout(timer); reject(new RecoveryInfrastructureError("RECOVERY_WORKER_LAUNCH_FAILED")); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new RecoveryInfrastructureError("RECOVERY_WORKER_LIFETIME_EXCEEDED"));
      else if (framingFailed || stdout !== "") reject(new RecoveryInfrastructureError("RECOVERY_WORKER_INVALID_OUTPUT"));
      else resolve({ status, signal, lines, stderr, results: lines.filter((line) => line.event === "result") });
    });
  });
  const ready = Promise.race([readyEvent, done.then(() => infrastructure("RECOVERY_WORKER_INFRASTRUCTURE_FAILURE"))]);
  void ready.catch(() => undefined); void done.catch(() => undefined);
  completions.push(done.catch(() => undefined));
  return { child, tag, ready, done, lines };
}

/** Exact content, never arbitrary existence, establishes a worker milestone.
 * Early exit and premature results are observed while waiting. */
async function waitForContent(path: string, expected: string, worker: Worker, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) infrastructure("RECOVERY_WORKER_EARLY_EXIT");
    if (worker.lines.some((line) => line.event === "result")) infrastructure("RECOVERY_WORKER_PREMATURE_RESULT");
    if (existsSync(path)) {
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { return infrastructure("RECOVERY_MARKER_UNREADABLE"); }
      if (content !== expected) infrastructure("RECOVERY_MARKER_MISMATCH");
      return;
    }
    if (Date.now() >= deadline) infrastructure("RECOVERY_MARKER_MISSING");
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
      worker.done.then(() => infrastructure("RECOVERY_WORKER_EARLY_EXIT")),
    ]);
  }
}

/** Park an accepted crash worker at an exact uncommitted boundary and prove
 * its boundary evidence, aliveness and silence before any kill. */
async function parkWriter(active: Scenario, mode: string, inserted: {
  readonly messages: string; readonly records: string; readonly created: string; readonly audits: string;
}, options: { readonly script?: readonly string[] } = {}): Promise<Worker> {
  const worker = launch(active, mode, { script: options.script ?? [crashScript], extra: { mode } });
  await worker.ready;
  expect(readFileSync(join(active.root, `${mode}.ready`), "utf8")).toBe("");
  writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx", mode: 0o600 });
  await waitForContent(join(active.root, `${mode}.marker`), mode, worker, MARKER_TIMEOUT_MS);
  expect(JSON.parse(readFileSync(join(active.root, `${mode}.evidence`), "utf8")))
    .toEqual({ mode, transaction: true, ...inserted });
  expect(worker.child.exitCode).toBeNull();
  expect(worker.child.signalCode).toBeNull();
  expect(worker.lines).toEqual([{ event: "ready", tag: mode, mode }]);
  return worker;
}

async function sigkill(worker: Worker): Promise<Report> {
  expect(worker.child.pid).toBeTypeOf("number");
  expect(worker.child.pid).not.toBe(process.pid);
  expect(() => process.kill(worker.child.pid!, 0)).not.toThrow();
  expect(worker.child.kill("SIGKILL")).toBe(true);
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, stderr: report.stderr, results: report.results })
    .toEqual({ status: null, signal: "SIGKILL", stderr: "", results: [] });
  assertNoSecretLeak(report);
  return report;
}

/** A reported creation is only believed when the independent reader shows the
 * matching committed triple: a worker's stdout can never stand alone. */
function assertReportedCreationIsDurable(active: Scenario, result: Record<string, unknown>): void {
  expect(result).toMatchObject({ event: "result", stage: "create", disposition: "CREATED", payloadLength: PAYLOAD.length });
  expect(result.entityId).toBe(result.messageId);
  expect(active.reader.prepare("SELECT message_id, created_at FROM message WHERE idempotency_key=?").get(KEY))
    .toEqual({ message_id: result.messageId, created_at: result.createdAt });
  expect(active.reader.prepare(
    "SELECT entity_id FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
  ).get(JSON.stringify(["message.create", active.exchangeId]), KEY)).toEqual({ entity_id: result.messageId });
  expect(active.reader.prepare(
    "SELECT subject_id FROM audit_event WHERE kind='message_created' AND subject_id=?",
  ).get(result.messageId as string)).toEqual({ subject_id: result.messageId });
}

/** One accepted-API creation in a brand new process, with no retry. */
async function createInFreshProcess(active: Scenario, tag: string): Promise<Record<string, unknown>> {
  const worker = launch(active, tag, { script: [creatorScript] });
  await worker.ready;
  expect(worker.child.pid).not.toBe(process.pid);
  writeFileSync(join(active.root, `${tag}.release`), "", { flag: "wx", mode: 0o600 });
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, stderr: report.stderr }).toEqual({ status: 0, signal: null, stderr: "" });
  assertNoSecretLeak(report);
  expect(report.results).toHaveLength(1);
  return report.results[0]!;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  // Even failed infrastructure controls must terminate before removing SQLite.
  await Promise.all(completions.splice(0));
  for (const { root, reader } of scenarios.splice(0)) {
    reader.close();
    rmSync(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

it("R1-A: a SIGKILLed writer releases its write lock and a later process creates cleanly", async () => {
  const active = scenario();
  const baseline = snapshot(active);
  const writer = await parkWriter(active, "k3-after-message-insert",
    { messages: "1", records: "0", created: "0", audits: "1" });
  // The uncommitted writer genuinely owns the write lock.
  expect(writeLockHeld(active)).toBe(true);
  expect(snapshot(active)).toEqual(baseline);
  await sigkill(writer);
  // Lock release is proven independently, before any product call.
  expect(writeLockHeld(active)).toBe(false);
  expect(snapshot(active)).toEqual(baseline);

  const result = await createInFreshProcess(active, "recovery-creator");
  expect(result.code).toBeUndefined(); // BUSY is not an accepted outcome here
  assertReportedCreationIsDurable(active, result);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(losslessIntegers(active)).toEqual([
    { message_id: result.messageId, revision: "1", length: String(PAYLOAD.length) },
  ]);
  assertDurableConsistency(active);
  expect(writeLockHeld(active)).toBe(false);
}, TEST_TIMEOUT_MS);

it("R1-B: a contender blocked on BEGIN IMMEDIATE resolves safely when the holder dies", async () => {
  const active = scenario();
  const baseline = snapshot(active);
  const writer = await parkWriter(active, "k3-after-message-insert",
    { messages: "1", records: "0", created: "0", audits: "1" });
  expect(writeLockHeld(active)).toBe(true);

  const contender = launch(active, "recovery-contender");
  await contender.ready;
  expect(contender.child.pid).not.toBe(process.pid);
  writeFileSync(join(active.root, "recovery-contender.release"), "", { flag: "wx", mode: 0o600 });
  // Readiness alone is not contention: the contender's own instrumentation
  // publishes this marker only once it has entered BEGIN IMMEDIATE, and the
  // lock is still demonstrably held by the parked writer.
  await waitForContent(join(active.root, "recovery-contender.contention"), CONTENTION, contender, MARKER_TIMEOUT_MS);
  expect(writeLockHeld(active)).toBe(true);
  expect(contender.child.exitCode).toBeNull();
  expect(contender.lines).toEqual([{ event: "ready", tag: "recovery-contender" }]);
  expect(snapshot(active)).toEqual(baseline);

  await sigkill(writer);
  const report = await contender.done;
  expect({ status: report.status, signal: report.signal, stderr: report.stderr }).toEqual({ status: 0, signal: null, stderr: "" });
  assertNoSecretLeak(report);
  expect(report.results).toHaveLength(1);
  const result = report.results[0]!;
  expect(result.contended).toBe(true);

  if (result.disposition === "CREATED") {
    assertReportedCreationIsDurable(active, result);
  } else {
    // The bounded busy wait may expire first; it must be a proven no-write
    // rollback, and recovery still succeeds in a separate fresh process.
    expect(result).toMatchObject({ code: "STORAGE_TRANSACTION_BUSY", outcome: "ROLLED_BACK", retryable: true });
    expect(snapshot(active)).toEqual(baseline);
    expect(writeLockHeld(active)).toBe(false);
    assertReportedCreationIsDurable(active, await createInFreshProcess(active, "recovery-creator"));
  }
  // Exactly one durable triple exists in both branches: no partial or
  // duplicate state from the killed holder or the contender.
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(losslessIntegers(active)).toEqual([
    { message_id: active.reader.prepare("SELECT message_id FROM message").get()!.message_id,
      revision: "1", length: String(PAYLOAD.length) },
  ]);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("R2: an open reader transaction is unaffected by a writer's uncommitted work and SIGKILL", async () => {
  const active = scenario(true);
  const committed = snapshot(active);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });

  // One long-lived read transaction, materialized before the writer starts.
  active.reader.exec("BEGIN");
  const insideBefore = readTables(active.reader);
  expect(insideBefore).toEqual(committed);
  try {
    const writer = await parkWriter(active, "k5-after-audit-insert",
      { messages: "2", records: "2", created: "2", audits: "3" });
    // The writer's uncommitted Message, record and audit are invisible here.
    expect(readTables(active.reader)).toEqual(insideBefore);
    await sigkill(writer);
    expect(readTables(active.reader)).toEqual(insideBefore);
  } finally {
    active.reader.exec("ROLLBACK");
  }

  // A new read transaction proves the uncommitted work never became durable.
  expect(snapshot(active)).toEqual(committed);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(existsSync(join(active.directory, "store.sqlite-journal"))).toBe(false);
  expect(losslessIntegers(active)).toEqual([
    { message_id: active.reader.prepare("SELECT message_id FROM message").get()!.message_id,
      revision: "1", length: String(PAYLOAD.length) },
  ]);
  assertDurableConsistency(active);
  expect(writeLockHeld(active)).toBe(false);
}, TEST_TIMEOUT_MS);

/** Deliberately broken OS workers exercise the real parent observer, not
 * mocks. No product code runs inside these infrastructure controls. */
function controlScript(action: string): readonly string[] {
  return ["--input-type=module", "--eval", String.raw`
    import { existsSync, writeFileSync } from "node:fs";
    const config = JSON.parse(process.argv[1]);
    const idle = new Int32Array(new SharedArrayBuffer(4));
    writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
    process.stdout.write(JSON.stringify({ event: "ready", tag: config.tag, mode: config.mode }) + "\n");
    const deadline = Date.now() + config.waitMs;
    while (!existsSync(config.releasePath)) {
      if (Date.now() >= deadline) process.exit(3);
      Atomics.wait(idle, 0, 0, 5);
    }
    ${action}
    Atomics.wait(idle, 0, 0);
  `];
}

it("control: a writer that exits before its boundary fails as infrastructure failure", async () => {
  const active = scenario();
  await expect(parkWriter(active, "k3-after-message-insert",
    { messages: "1", records: "0", created: "0", audits: "1" },
    { script: controlScript("process.exit(7);") })).rejects.toThrow("RECOVERY_WORKER_EARLY_EXIT");
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a wrong boundary marker fails as infrastructure failure", async () => {
  const active = scenario();
  await expect(parkWriter(active, "k3-after-message-insert",
    { messages: "1", records: "0", created: "0", audits: "1" },
    { script: controlScript('writeFileSync(config.markerPath, "k5-after-audit-insert", { flag: "wx", mode: 0o600 });') }))
    .rejects.toThrow("RECOVERY_MARKER_MISMATCH");
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a contender that exits before readiness fails as infrastructure failure", async () => {
  const active = scenario();
  const worker = launch(active, "recovery-contender", { script: ["--input-type=module", "--eval", "process.exit(7)"] });
  await expect(worker.ready).rejects.toThrow("RECOVERY_WORKER_INFRASTRUCTURE_FAILURE");
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, lines: report.lines, stderr: report.stderr })
    .toEqual({ status: 7, signal: null, lines: [], stderr: "" });
  expect(existsSync(join(active.root, "recovery-contender.contention"))).toBe(false);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a reported creation without a durable COMMIT fails the test", async () => {
  const active = scenario();
  const tag = "recovery-creator";
  const forged = { event: "result", stage: "create", tag, disposition: "CREATED",
    messageId: "msg_forged", createdAt: "2026-10-09T22:00:00.000Z", payloadLength: PAYLOAD.length, entityId: "msg_forged" };
  const worker = launch(active, tag, {
    script: controlScript(`process.stdout.write(JSON.stringify(${JSON.stringify(forged)}) + "\\n");`),
  });
  await worker.ready;
  writeFileSync(join(active.root, `${tag}.release`), "", { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (worker.lines.every((line) => line.event !== "result")) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(() => assertReportedCreationIsDurable(active, worker.lines.at(-1)!)).toThrow();
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  expect(worker.child.kill("SIGKILL")).toBe(true);
  await worker.done;
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a missing release barrier is a bounded nonzero infrastructure failure", async () => {
  const active = scenario();
  const worker = launch(active, "recovery-contender", { waitMs: 200 });
  await worker.ready;
  const report = await worker.done; // never released
  expect({ status: report.status, signal: report.signal, stderr: report.stderr }).toEqual({ status: 3, signal: null, stderr: "" });
  expect(report.results).toEqual([{ event: "result", stage: "release", code: "RECOVERY_CONTENDER_BARRIER_TIMEOUT" }]);
  assertNoSecretLeak(report);
  expect(existsSync(join(active.root, "recovery-contender.contention"))).toBe(false);
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

/** Accepted B2 protection, with the description corrected for B3 (P1B item D):
 * the guarantee this test enforces is that no *Exchange/Message recovery*
 * API, retry loop, scheduler, or kill path exists in production storage. It
 * was originally described as "no production recovery API" at a time when no
 * recovery entry point of any kind existed. The accepted B3-P1A host
 * trust-root recovery (`recoverTrustRoot`) is an explicit operator command in
 * its own module and is deliberately out of this test's scope; the original
 * protection is unchanged and is now additionally enforced over the B3
 * modules, which must not smuggle in message-recovery, retry, or kill paths. */
it("keeps Exchange/Message recovery validation test-only with no production recovery, retry, or kill path", () => {
  const contender = readFileSync(new URL("./support/recovery-contender.mjs", import.meta.url), "utf8");
  expect(contender).toContain("BEGIN IMMEDIATE");
  for (const module of [
    "creation",
    "transaction",
    "store",
    "connection",
    "migration",
    "recovery",
    "participant",
    "capability",
  ]) {
    const source = readFileSync(new URL(`../../src/storage/${module}.ts`, import.meta.url), "utf8");
    // Unchanged original protection: no Exchange/Message recovery API, retry
    // loop, scheduler, or kill path exists in production storage.
    expect(source, module).not.toMatch(
      /SIGKILL|process\.kill|reopenExchange|recoverExchange|recoverStore|scheduleRecovery|setTimeout|setInterval/,
    );
  }
});

/** S5-2: exact lstat-level inventory of the database directory. The main
 * database must be a regular file; optional WAL/SHM are accepted as regular
 * files; the B3-P1A host-secret trust-root artifact is accepted as a regular
 * file; rollback journals, symlinks, unknown artifacts and test markers in
 * the database directory are infrastructure failures. */
function dbArtifacts(active: Scenario) {
  return Object.fromEntries(readdirSync(active.directory).sort().map((name) => {
    if (!/^(store\.sqlite(-wal|-shm)?|host-secret)$/.test(name)) infrastructure("RECOVERY_UNEXPECTED_DB_ARTIFACT");
    const stats = lstatSync(join(active.directory, name));
    if (stats.isSymbolicLink() || !stats.isFile()) infrastructure("RECOVERY_UNEXPECTED_DB_ARTIFACT");
    return [name, { file: true }];
  }));
}
function assertDbArtifacts(active: Scenario): void {
  const inventory = dbArtifacts(active);
  expect(inventory["store.sqlite"]).toEqual({ file: true });
  expect(existsSync(join(active.directory, "store.sqlite-journal"))).toBe(false);
}

it("R3: committed history survives a K5 crash while the uncommitted triple is absent", async () => {
  const active = scenario(true);
  const baseline = snapshot(active);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  assertDbArtifacts(active); // established WAL-backed baseline before the crash

  const writer = await parkWriter(active, "k5-after-audit-insert",
    { messages: "2", records: "2", created: "2", audits: "3" });
  const preKill = dbArtifacts(active); // observable WAL state at the boundary
  expect(preKill["store.sqlite"]).toEqual({ file: true });
  // WAL/SHM are optional; their presence is recorded, never required.

  await sigkill(writer);
  // Before any recovery open: no manual artifact cleanup has occurred.
  assertDbArtifacts(active);
  expect(snapshot(active)).toEqual(baseline);

  // Recovery through the accepted Store opener on a fresh connection.
  const recovered = openStore({ directory: active.directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    expect(snapshot(active)).toEqual(baseline);
    expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  } finally {
    recovered.close();
  }
  assertDbArtifacts(active);
  expect(losslessIntegers(active)).toEqual([
    { message_id: active.reader.prepare("SELECT message_id FROM message").get()!.message_id,
      revision: "1", length: String(PAYLOAD.length) },
  ]);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

/** Independent replay identity facts from the read-only reader: the accepted
 * public Message/record identity plus durable row evidence. */
function replayOracle(active: Scenario) {
  const namespace = JSON.stringify(["message.create", active.exchangeId]);
  return {
    message: active.reader.prepare(
      "SELECT message_id, created_at, CAST(private_revision AS TEXT) AS revision, CAST(payload_length AS TEXT) AS length FROM message",
    ).get()!,
    record: active.reader.prepare(
      "SELECT entity_id, request_digest, created_at, CAST(private_revision AS TEXT) AS revision FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
    ).get(namespace, KEY)!,
  };
}

/** A replay worker's reported identity must match the durable rows exactly;
 * stdout can never substitute for durable evidence. */
function assertReportedReplayIsDurable(active: Scenario, result: Record<string, unknown>): void {
  expect(result).toMatchObject({ event: "result", stage: "replay", disposition: "REPLAYED", writes: 0 });
  const oracle = replayOracle(active);
  expect(result.entityId).toBe(result.messageId);
  expect({ messageId: result.messageId, createdAt: result.createdAt })
    .toEqual({ messageId: oracle.message.message_id, createdAt: oracle.message.created_at });
  expect({ entityId: result.entityId, requestDigest: result.requestDigest, recordCreatedAt: result.recordCreatedAt })
    .toEqual({
      entityId: oracle.record.entity_id, requestDigest: oracle.record.request_digest,
      recordCreatedAt: oracle.record.created_at,
    });
}


it("R4: durable idempotency replays through Store close/reopen and concurrent processes", async () => {
  const active = scenario();
  // One accepted-API creation in this parent, then the authoritative oracle.
  const original = (() => {
    const store = openStore({ directory: active.directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
    try {
      return createMessage(store, {
        exchangeId: active.exchangeId, from, to,
        payload: Uint8Array.from(PAYLOAD), idempotencyKey: KEY,
      });
    } finally {
      store.close();
    }
  })();
  expect(original.disposition).toBe("CREATED");
  const baseline = snapshot(active);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });

  // Explicit close happened above; a brand new connection replays from
  // durable rows only. The parent's replay is also worker-local write-free.
  const reopened = openStore({ directory: active.directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    expect(reopened.database).not.toBeUndefined(); // a brand new Store connection, not a cache
    const changesBefore = reopened.database.prepare("SELECT CAST(total_changes() AS TEXT) AS n").get()!.n;
    const replay = createMessage(reopened, {
      exchangeId: active.exchangeId, from, to,
      payload: Uint8Array.from(PAYLOAD), idempotencyKey: KEY,
    });
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.message).toEqual(original.message);
    expect(replay.record).toEqual(original.record);
    expect(reopened.database.prepare("SELECT CAST(total_changes() AS TEXT) AS n").get()!.n).toBe(changesBefore);
  } finally {
    reopened.close();
  }
  expect(snapshot(active)).toEqual(baseline);

  // Two independent OS processes, each with its own Store connection, replay
  // concurrently. Both must replay the original identity with zero writes.
  const first = launch(active, "replay-one", { script: [replayScript] });
  const second = launch(active, "replay-two", { script: [replayScript] });
  await Promise.all([first.ready, second.ready]);
  writeFileSync(join(active.root, "replay-one.release"), "", { flag: "wx", mode: 0o600 });
  writeFileSync(join(active.root, "replay-two.release"), "", { flag: "wx", mode: 0o600 });
  const [reportOne, reportTwo] = await Promise.all([first.done, second.done]);
  for (const report of [reportOne, reportTwo]) {
    expect({ status: report.status, signal: report.signal, stderr: report.stderr }).toEqual({ status: 0, signal: null, stderr: "" });
    assertNoSecretLeak(report);
    expect(report.results).toHaveLength(1);
  }
  const [resultOne, resultTwo] = [reportOne.results[0]!, reportTwo.results[0]!];
  assertReportedReplayIsDurable(active, resultOne);
  assertReportedReplayIsDurable(active, resultTwo);
  expect(resultOne.messageId).toBe(resultTwo.messageId);
  expect(resultOne.requestDigest).toBe(resultTwo.requestDigest);
  expect(resultOne.messageId).toBe(original.message.messageId);
  expect(resultOne.entityId).toBe(original.record.entityId);

  // The complete durable snapshot is byte-identical to the pre-replay state.
  expect(snapshot(active)).toEqual(baseline);
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(losslessIntegers(active)).toEqual([
    { message_id: original.message.messageId, revision: "1", length: String(PAYLOAD.length) },
  ]);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a writer that exits before K5 fails as infrastructure failure", async () => {
  const active = scenario(true);
  const baseline = snapshot(active);
  await expect(parkWriter(active, "k5-after-audit-insert",
    { messages: "2", records: "2", created: "2", audits: "3" },
    { script: controlScript("process.exit(7);") })).rejects.toThrow("RECOVERY_WORKER_EARLY_EXIT");
  expect(snapshot(active)).toEqual(baseline);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: an incorrect K5 boundary marker fails as infrastructure failure", async () => {
  const active = scenario(true);
  const baseline = snapshot(active);
  await expect(parkWriter(active, "k5-after-audit-insert",
    { messages: "2", records: "2", created: "2", audits: "3" },
    { script: controlScript('writeFileSync(config.markerPath, "k3-after-message-insert", { flag: "wx", mode: 0o600 });') }))
    .rejects.toThrow("RECOVERY_MARKER_MISMATCH");
  expect(snapshot(active)).toEqual(baseline);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a writer that commits no boundary evidence fails as infrastructure failure", async () => {
  const active = scenario(true);
  const baseline = snapshot(active);
  // A worker that parks without publishing marker/evidence never counts as a
  // reached boundary; the bounded observer rejects the missing marker.
  await expect(parkWriter(active, "k5-after-audit-insert",
    { messages: "2", records: "2", created: "2", audits: "3" },
    { script: controlScript("") })).rejects.toThrow("RECOVERY_MARKER_MISSING");
  expect(snapshot(active)).toEqual(baseline);
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a replay worker that exits before readiness fails as infrastructure failure", async () => {
  const active = scenario();
  const worker = launch(active, "replay-one", { script: ["--input-type=module", "--eval", "process.exit(7)"] });
  await expect(worker.ready).rejects.toThrow("RECOVERY_WORKER_INFRASTRUCTURE_FAILURE");
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, lines: report.lines, stderr: report.stderr })
    .toEqual({ status: 7, signal: null, lines: [], stderr: "" });
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: a forged REPLAYED result without matching durable identity fails the test", async () => {
  const active = scenario(true);
  const baseline = snapshot(active);
  const tag = "replay-one";
  const forged = { event: "result", stage: "replay", tag, disposition: "REPLAYED",
    messageId: "msg_forged", createdAt: "2026-10-09T22:00:00.000Z", entityId: "msg_forged",
    requestDigest: "0".repeat(64), recordCreatedAt: "2026-10-09T22:00:00.000Z", writes: 0 };
  const worker = launch(active, tag, {
    script: controlScript(`process.stdout.write(JSON.stringify(${JSON.stringify(forged)}) + "\\n");`),
  });
  await worker.ready;
  writeFileSync(join(active.root, `${tag}.release`), "", { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + MARKER_TIMEOUT_MS;
  while (worker.lines.every((line) => line.event !== "result")) {
    expect(Date.now()).toBeLessThan(deadline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(() => assertReportedReplayIsDurable(active, worker.lines.at(-1)!)).toThrow();
  expect(snapshot(active)).toEqual(baseline);
  expect(worker.child.kill("SIGKILL")).toBe(true);
  await worker.done;
  assertDurableConsistency(active);
}, TEST_TIMEOUT_MS);

it("control: unexpected database artifacts or journals fail the inventory check", () => {
  const active = scenario();
  writeFileSync(join(active.directory, "store.sqlite-journal"), "", { flag: "wx", mode: 0o600 });
  expect(() => dbArtifacts(active)).toThrow("RECOVERY_UNEXPECTED_DB_ARTIFACT");
  rmSync(join(active.directory, "store.sqlite-journal"), { force: true });
  writeFileSync(join(active.directory, "stale.lock"), "", { flag: "wx", mode: 0o600 });
  expect(() => dbArtifacts(active)).toThrow("RECOVERY_UNEXPECTED_DB_ARTIFACT");
  rmSync(join(active.directory, "stale.lock"), { force: true });
  assertDbArtifacts(active);
  assertDurableConsistency(active);
});
