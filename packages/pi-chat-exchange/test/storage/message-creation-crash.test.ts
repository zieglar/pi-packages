import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createExchange, createMessage } from "../../src/storage/creation.js";
import { initializeStore, openStore } from "../../src/storage/store.js";

/** S3-B2 (C6): independent-process crash and recovery validation for durable
 * Message creation. Each boundary is reached deterministically (an existing
 * private seam, or worker-local instrumentation of the worker's own raw
 * connection for the one boundary with no seam), proven by a sanitized
 * marker file, and terminated by the parent's SIGKILL. No sleep-based
 * progress guessing: correctness evidence is marker + durable forensics. */

type CrashChild = ChildProcessByStdio<null, Readable, Readable>;

const WORKER_WAIT_MS = 20_000;
const MARKER_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const BUSY_TIMEOUT_MS = 5_000;
const PAYLOAD = [7, 8, 9, 10];
const KEY = "crash-key";

const register = fileURLToPath(new URL("./support/register-ts.mjs", import.meta.url));
const crashScript = fileURLToPath(new URL("./support/crash-worker.mjs", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const creationUrl = new URL("../../src/storage/creation.ts", import.meta.url).href;
const from = { adapter: "pi", endpointId: "producer-1" };
const to = { adapter: "pi", endpointId: "consumer-1" };

interface Scenario {
  readonly root: string;
  readonly directory: string;
  readonly reader: DatabaseSync;
  readonly exchangeId: string;
}
interface CrashReport {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly lines: readonly Record<string, unknown>[];
  readonly stderr: string;
  readonly results: readonly Record<string, unknown>[];
}

const scenarios: Scenario[] = [];
const children: CrashChild[] = [];

function scenario(): Scenario {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-s3b2-"));
  const directory = join(root, "db");
  const store = initializeStore({ directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  let exchangeId: string;
  try {
    exchangeId = createExchange(store, { namespace: "owner", idempotencyKey: "exchange-key" }).exchange.exchangeId;
  } finally {
    store.close();
  }
  const reader = new DatabaseSync(join(directory, "store.sqlite"), { readOnly: true });
  const result = { root, directory, reader, exchangeId };
  scenarios.push(result);
  return result;
}

class CrashInfrastructureError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CrashInfrastructureError"; }
}
interface CrashWorker {
  readonly child: CrashChild;
  readonly ready: Promise<void>;
  readonly done: Promise<CrashReport>;
  readonly lines: Record<string, unknown>[];
}
const completions: Promise<unknown>[] = [];
const infrastructure = (code: string): never => { throw new CrashInfrastructureError(code); };

/** Exact content, not arbitrary existence, establishes readiness. Yield to the
 * event loop so early exit and premature results are observed while waiting. */
async function waitForMarker(path: string, mode: string, worker: CrashWorker, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) infrastructure("CRASH_WORKER_EARLY_EXIT");
    if (worker.lines.some((line) => line.event === "result")) infrastructure("CRASH_WORKER_PREMATURE_RESULT");
    if (existsSync(path)) {
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { return infrastructure("CRASH_MARKER_UNREADABLE"); }
      if (content !== mode) infrastructure("CRASH_MARKER_MISMATCH");
      return;
    }
    if (Date.now() >= deadline) infrastructure("CRASH_MARKER_MISSING");
    await Promise.race([
      new Promise<void>((resolve) => setTimeout(resolve, 10)),
      worker.done.then(() => infrastructure("CRASH_WORKER_EARLY_EXIT")),
    ]);
  }
}

function launchCrash(active: Scenario, mode: string, options: {
  readonly script?: readonly string[];
  readonly directory?: string;
} = {}): CrashWorker {
  const readyPath = join(active.root, `${mode}.ready`);
  const releasePath = join(active.root, `${mode}.release`);
  const markerPath = join(active.root, `${mode}.marker`);
  const evidencePath = join(active.root, `${mode}.evidence`);
  for (const path of [readyPath, releasePath, markerPath, `${markerPath}.pending`, evidencePath]) {
    if (existsSync(path)) infrastructure("CRASH_STALE_ARTIFACT");
  }
  const config = {
    tag: mode, mode, storeUrl, creationUrl,
    directory: options.directory ?? active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_TIMEOUT_MS, waitMs: WORKER_WAIT_MS,
    readyPath, releasePath, markerPath, evidencePath,
    request: { exchangeId: active.exchangeId, from, to, payload: PAYLOAD, idempotencyKey: KEY },
  };
  const child = spawn(process.execPath,
    ["--import", register, ...(options.script ?? [crashScript]), JSON.stringify(config)],
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
        if (parsed.event === "ready") {
          if (JSON.stringify(parsed) !== JSON.stringify({ event: "ready", tag: mode, mode })) throw new Error();
          announceReady();
        }
      } catch {
        framingFailed = true;
        rejectReady(new CrashInfrastructureError("CRASH_WORKER_INVALID_OUTPUT"));
      }
    }
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, MARKER_TIMEOUT_MS + WORKER_WAIT_MS);
  const done = new Promise<CrashReport>((resolve, reject) => {
    child.once("error", () => { clearTimeout(timer); reject(new CrashInfrastructureError("CRASH_WORKER_LAUNCH_FAILED")); });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new CrashInfrastructureError("CRASH_WORKER_LIFETIME_EXCEEDED"));
      else if (framingFailed || stdout !== "") reject(new CrashInfrastructureError("CRASH_WORKER_INVALID_OUTPUT"));
      else resolve({ status, signal, lines, stderr, results: lines.filter((line) => line.event === "result") });
    });
  });
  const ready = Promise.race([readyEvent, done.then(() => infrastructure("CRASH_WORKER_INFRASTRUCTURE_FAILURE"))]);
  void ready.catch(() => undefined); void done.catch(() => undefined);
  completions.push(done.catch(() => undefined));
  return { child, ready, done, lines };
}

/** Complete, consistent durable snapshot: every cell and rowid is SQLite TEXT,
 * including quote(INTEGER), so no JS Number decoding can round forensic data. */
function losslessSnapshot(active: Scenario) {
  const table = (name: string) => {
    const columns = active.reader.prepare(`PRAGMA table_info("${name}")`).all().map((row) => {
      const column = `"${String(row.name).replaceAll('"', '""')}"`;
      return `CAST(quote(${column}) AS TEXT) AS ${column}`;
    });
    return active.reader.prepare(`SELECT CAST(rowid AS TEXT) AS _rowid, ${columns.join(", ")} FROM "${name}" ORDER BY rowid`).all();
  };
  active.reader.exec("BEGIN");
  try {
    return {
      message: table("message"), records: table("idempotency_record"),
      audit: table("audit_event"), exchange: table("exchange"), disposition: table("disposition"),
    };
  } finally { active.reader.exec("ROLLBACK"); }
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

/** Lossless integer evidence mirrors production's decimal-text projection. */
function losslessIntegers(active: Scenario) {
  const message = active.reader.prepare(
    "SELECT CAST(private_revision AS TEXT) AS revision, CAST(payload_length AS TEXT) AS length FROM message",
  ).get()!;
  const record = active.reader.prepare(
    "SELECT CAST(private_revision AS TEXT) AS revision FROM idempotency_record WHERE namespace=?",
  ).get(JSON.stringify(["message.create", active.exchangeId]))!;
  return { message, record };
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

function assertNoSecretLeak(report: CrashReport): void {
  const text = JSON.stringify(report.lines) + report.stderr;
  for (const secret of ["producer-1", "consumer-1", "SELECT", "INSERT", "payload_body", "SENSITIVE"]) {
    expect(text).not.toContain(secret);
  }
}

/** The durable baseline before any crash attempt: only the Exchange and its
 * exchange_opened audit exist; the Exchange remains OPEN. */
function assertPreCrashBaseline(active: Scenario): void {
  expect(counts(active)).toEqual({ messages: "0", records: "0", created: "0", audits: "1" });
  expect(active.reader.prepare("SELECT state FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "OPEN" });
  expect(active.reader.prepare("SELECT kind, CAST(sequence AS TEXT) AS sequence FROM audit_event").all())
    .toEqual([{ kind: "exchange_opened", sequence: "1" }]);
  assertDurableConsistency(active);
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

/**
 * Run one crash boundary: release the worker, wait for its boundary marker,
 * verify it is still alive and has published no success, kill it, and verify
 * the database outcome. For K1-K5 the transaction must be fully absent; for
 * K6 the transaction must be fully committed.
 */
async function runCrashBoundary(active: Scenario, mode: string, committed: boolean): Promise<{
  readonly report: CrashReport;
  readonly committedRows: ReturnType<typeof losslessSnapshot>;
}> {
  const baseline = losslessSnapshot(active);
  const worker = launchCrash(active, mode);
  const { child, ready, done } = worker;
  const markerPath = join(active.root, `${mode}.marker`);
  await ready;
  expect(readFileSync(join(active.root, `${mode}.ready`), "utf8")).toBe("");
  writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx", mode: 0o600 });
  await waitForMarker(markerPath, mode, worker, MARKER_TIMEOUT_MS);
  expect(readFileSync(markerPath, "utf8")).toBe(mode);
  const boundary = JSON.parse(readFileSync(join(active.root, `${mode}.evidence`), "utf8"));
  const inserted = ["k3-after-message-insert", "k4-after-idempotency-insert", "k5-after-audit-insert", "k6-after-commit"].includes(mode);
  const recorded = ["k4-after-idempotency-insert", "k5-after-audit-insert", "k6-after-commit"].includes(mode);
  const audited = ["k5-after-audit-insert", "k6-after-commit"].includes(mode);
  expect(boundary).toEqual({
    mode, transaction: mode !== "k1-before-begin" && mode !== "k6-after-commit",
    messages: inserted ? "1" : "0", records: recorded ? "1" : "0",
    created: audited ? "1" : "0", audits: audited ? "2" : "1",
  });

  // Boundary evidence exists: the worker must now be parked there, with no
  // success result published, and must still be alive for the parent's kill.
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const partial = await Promise.race([
    done.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  expect(partial).toBe(false);

  expect(worker.lines).toEqual([{ event: "ready", tag: mode, mode }]);
  expect(child.pid).toBeTypeOf("number");
  expect(child.pid).not.toBe(process.pid);
  expect(() => process.kill(child.pid!, 0)).not.toThrow();
  expect(child.kill("SIGKILL")).toBe(true);
  const report = await done;
  expect(report.signal).toBe("SIGKILL");
  expect(report.status).toBeNull();
  // No success result was delivered by the crashed worker.
  expect(report.results).toEqual([]);
  expect(report.stderr).toBe("");
  expect(readFileSync(join(active.root, `${mode}.release`), "utf8")).toBe("");
  assertNoSecretLeak(report);

  if (!committed) {
    // Pre-commit crash: nothing durable from the attempt; no leftover
    // rollback journal; the prior durable state is byte-identical.
    assertPreCrashBaseline(active);
    expect(losslessSnapshot(active)).toEqual(baseline);
    expect(existsSync(join(active.directory, "store.sqlite-journal"))).toBe(false);
  }
  assertDurableConsistency(active);
  return { report, committedRows: losslessSnapshot(active) };
}

function retryRequest(active: Scenario) {
  const store = openStore({ directory: active.directory, filename: "store.sqlite", busyTimeoutMs: BUSY_TIMEOUT_MS });
  try {
    return createMessage(store, {
      exchangeId: active.exchangeId, from, to, payload: Uint8Array.from(PAYLOAD), idempotencyKey: KEY,
    });
  } finally {
    store.close();
  }
}

const PRE_COMMIT = [
  ["k1-before-begin", "K1"],
  ["k2-after-begin", "K2"],
  ["k3-after-message-insert", "K3"],
  ["k4-after-idempotency-insert", "K4"],
  ["k5-after-audit-insert", "K5"],
] as const;

for (const [mode, label] of PRE_COMMIT) {
  it(`${label}: SIGKILL after the verifiable boundary leaves no partial durable state`, async () => {
    const active = scenario();
    assertPreCrashBaseline(active);
    await runCrashBoundary(active, mode, false);

    // Reopen and retry the identical request: exactly one clean creation.
    const created = retryRequest(active);
    expect(created.disposition).toBe("CREATED");
    const replay = retryRequest(active);
    expect(replay.disposition).toBe("REPLAYED");
    expect(replay.message).toEqual(created.message);
    expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
    expect(active.reader.prepare("SELECT state FROM exchange WHERE exchange_id=?").get(active.exchangeId))
      .toEqual({ state: "OPEN" });
    assertDurableConsistency(active);
    // Lossless integer evidence: revision/length projected as exact text.
    const integers = losslessIntegers(active);
    expect(integers.message).toEqual({ revision: "1", length: String(PAYLOAD.length) });
    expect(integers.record).toEqual({ revision: "1" });
  }, TEST_TIMEOUT_MS);
}

it("K6: SIGKILL after a proven COMMIT keeps the durable result; retry replays it", async () => {
  const active = scenario();
  assertPreCrashBaseline(active);
  const { committedRows } = await runCrashBoundary(active, "k6-after-commit", true);

  // COMMIT completed before the kill: the full durable triple must exist.
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(active.reader.prepare("SELECT state FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "OPEN" });
  expect(committedRows.message).toHaveLength(1);
  expect(committedRows.records).toHaveLength(2); // Exchange record + Message record
  expect(committedRows.audit.map((row) => row.kind)).toEqual(["'exchange_opened'", "'message_created'"]);
  assertDurableConsistency(active);

  // The terminated worker's outcome stays unknown: the retry is the durable
  // arbiter, and it proves the original transaction committed by replaying it.
  const replay = retryRequest(active);
  expect(replay.disposition).toBe("REPLAYED");
  expect(counts(active)).toEqual({ messages: "1", records: "1", created: "1", audits: "2" });
  expect(replay.message.createdAt).toBe(
    active.reader.prepare("SELECT created_at FROM message").get()!.created_at);
  assertDurableConsistency(active);
  expect(replay.message.messageId).toBe(active.reader.prepare("SELECT message_id FROM message").get()!.message_id);
  expect(replay.record.entityId).toBe(replay.message.messageId);
  const finalSnapshot = losslessSnapshot(active);
  expect(finalSnapshot).toEqual(committedRows);
  const integers = losslessIntegers(active);
  expect(integers.message).toEqual({ revision: "1", length: String(PAYLOAD.length) });
  expect(integers.record).toEqual({ revision: "1" });
}, TEST_TIMEOUT_MS);

it("keeps crash validation test-only with no production crash hooks", () => {
  const worker = readFileSync(new URL("./support/crash-worker.mjs", import.meta.url), "utf8");
  expect(worker).toContain("SIGKILL");
  const creation = readFileSync(new URL("../../src/storage/creation.ts", import.meta.url), "utf8");
  expect(creation).not.toMatch(/crash|SIGKILL|process\.kill/i);
  const transaction = readFileSync(new URL("../../src/storage/transaction.ts", import.meta.url), "utf8");
  expect(transaction).not.toMatch(/crash|SIGKILL|process\.kill/i);
});

it("H1: openStore failure is a sanitized nonzero infrastructure failure", async () => {
  const active = scenario();
  const mode = "k1-before-begin";
  const before = losslessSnapshot(active);
  const worker = launchCrash(active, mode, { directory: join(active.root, "missing-private-directory") });
  await expect(worker.ready).rejects.toThrow("CRASH_WORKER_INFRASTRUCTURE_FAILURE");
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, stderr: report.stderr })
    .toEqual({ status: 2, signal: null, stderr: "" });
  expect(report.lines).toEqual([{ event: "result", stage: "open", code: "CRASH_WORKER_OPEN_FAILED" }]);
  assertNoSecretLeak(report);
  expect(JSON.stringify(report.lines)).not.toContain(active.root);
  for (const suffix of ["ready", "marker", "evidence"]) expect(existsSync(join(active.root, `${mode}.${suffix}`))).toBe(false);
  expect(losslessSnapshot(active)).toEqual(before);
  assertPreCrashBaseline(active);
}, TEST_TIMEOUT_MS);

/** Deliberately broken OS workers exercise the real parent observer, not mocks.
 * No SQLite writer or product code runs in these infrastructure controls. */
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

for (const [label, content] of [
  ["wrong mode", "k2-after-begin"], ["prefix", "k1-before-begin-extra"],
  ["partial", "k1-before"], ["empty", ""], ["newline suffix", "k1-before-begin\n"],
] as const) {
  it(`H2: rejects ${label} crash marker as infrastructure failure`, async () => {
    const active = scenario();
    const mode = "k1-before-begin";
    const before = losslessSnapshot(active);
    const worker = launchCrash(active, mode, {
      script: controlScript(`writeFileSync(config.markerPath, ${JSON.stringify(content)}, { flag: "wx", mode: 0o600 });`),
    });
    await worker.ready;
    writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx" });
    await expect(waitForMarker(join(active.root, `${mode}.marker`), mode, worker, MARKER_TIMEOUT_MS))
      .rejects.toThrow("CRASH_MARKER_MISMATCH");
    expect(worker.child.kill("SIGKILL")).toBe(true);
    const report = await worker.done;
    expect(report.signal).toBe("SIGKILL");
    expect(report.results).toEqual([]); expect(report.stderr).toBe("");
    assertNoSecretLeak(report);
    expect(losslessSnapshot(active)).toEqual(before);
    assertPreCrashBaseline(active);
  }, TEST_TIMEOUT_MS);
}

for (const suffix of ["marker", "marker.pending"] as const) {
  it(`H2: rejects a stale exact-mode ${suffix} before launching any worker`, () => {
    const active = scenario();
    const mode = "k1-before-begin";
    writeFileSync(join(active.root, `${mode}.${suffix}`), mode, { flag: "wx" });
    const count = children.length;
    expect(() => launchCrash(active, mode)).toThrow("CRASH_STALE_ARTIFACT");
    expect(children).toHaveLength(count);
    assertPreCrashBaseline(active);
  });
}

it("H2: rejects a missing marker within a bounded observer budget", async () => {
  const active = scenario();
  const mode = "k1-before-begin";
  const worker = launchCrash(active, mode, { script: controlScript("") });
  await worker.ready;
  writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx" });
  await expect(waitForMarker(join(active.root, `${mode}.marker`), mode, worker, 100))
    .rejects.toThrow("CRASH_MARKER_MISSING");
  expect(existsSync(join(active.root, `${mode}.marker`))).toBe(false);
  expect(worker.child.kill("SIGKILL")).toBe(true);
  const report = await worker.done;
  expect(report.signal).toBe("SIGKILL"); expect(report.results).toEqual([]); expect(report.stderr).toBe("");
  assertNoSecretLeak(report); assertPreCrashBaseline(active);
}, TEST_TIMEOUT_MS);

it("H2: rejects worker exit before readiness as infrastructure failure", async () => {
  const active = scenario();
  const worker = launchCrash(active, "k1-before-begin", { script: ["--input-type=module", "--eval", "process.exit(7)"] });
  await expect(worker.ready).rejects.toThrow("CRASH_WORKER_INFRASTRUCTURE_FAILURE");
  const report = await worker.done;
  expect({ status: report.status, signal: report.signal, lines: report.lines, stderr: report.stderr })
    .toEqual({ status: 7, signal: null, lines: [], stderr: "" });
  assertPreCrashBaseline(active);
}, TEST_TIMEOUT_MS);

it("H2: rejects worker exit after readiness but before boundary", async () => {
  const active = scenario();
  const mode = "k1-before-begin";
  const worker = launchCrash(active, mode, { script: controlScript("process.exit(7);") });
  await worker.ready;
  writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx" });
  await expect(waitForMarker(join(active.root, `${mode}.marker`), mode, worker, MARKER_TIMEOUT_MS))
    .rejects.toThrow("CRASH_WORKER_EARLY_EXIT");
  const report = await worker.done;
  expect(report.status).toBe(7); expect(report.signal).toBeNull();
  expect(report.stderr).toBe(""); expect(report.results).toEqual([]);
  assertPreCrashBaseline(active);
}, TEST_TIMEOUT_MS);

it("H2: rejects a result delivered before SIGKILL", async () => {
  const active = scenario();
  const mode = "k1-before-begin";
  const worker = launchCrash(active, mode, { script: controlScript(
    'process.stdout.write(JSON.stringify({ event: "result", stage: "control", code: "PREMATURE_RESULT" }) + "\\n");',
  ) });
  await worker.ready;
  writeFileSync(join(active.root, `${mode}.release`), "", { flag: "wx" });
  await expect(waitForMarker(join(active.root, `${mode}.marker`), mode, worker, MARKER_TIMEOUT_MS))
    .rejects.toThrow("CRASH_WORKER_PREMATURE_RESULT");
  expect(worker.child.kill("SIGKILL")).toBe(true);
  const report = await worker.done;
  expect(report.signal).toBe("SIGKILL"); expect(report.stderr).toBe("");
  expect(report.results).toEqual([{ event: "result", stage: "control", code: "PREMATURE_RESULT" }]);
  assertNoSecretLeak(report); assertPreCrashBaseline(active);
}, TEST_TIMEOUT_MS);
