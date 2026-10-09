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

/** Bounded marker wait. Polling is liveness only: the marker is the boundary
 * evidence, and every assertion below is database forensics. */
function waitForMarker(path: string, budgetMs: number): void {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + budgetMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`crash boundary marker never appeared: ${path}`);
    Atomics.wait(idle, 0, 0, 10);
  }
}

function launchCrash(active: Scenario, mode: string): {
  readonly child: CrashChild;
  readonly ready: Promise<void>;
  readonly done: Promise<CrashReport>;
} {
  const readyPath = join(active.root, `${mode}.ready`);
  const releasePath = join(active.root, `${mode}.release`);
  const markerPath = join(active.root, `${mode}.marker`);
  const config = {
    tag: mode, mode, storeUrl, creationUrl,
    directory: active.directory, filename: "store.sqlite",
    busyTimeoutMs: BUSY_TIMEOUT_MS, waitMs: WORKER_WAIT_MS,
    readyPath, releasePath, markerPath,
    request: { exchangeId: active.exchangeId, from, to, payload: PAYLOAD, idempotencyKey: KEY },
  };
  const child = spawn(process.execPath,
    ["--import", register, crashScript, JSON.stringify(config)],
    { stdio: ["ignore", "pipe", "pipe"] });
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

  const done = new Promise<CrashReport>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, lines, stderr, results: lines.filter((line) => line.event === "result") });
    });
  });
  return { child, ready, done };
}

/** Exact durable snapshot: SQLite quote() preserves values exactly (integers stay integers, blobs render as x'..'). Equality of before/after snapshots is the no-partial-write evidence. */
function losslessSnapshot(active: Scenario) {
  const table = (name: string) => {
    const columns = active.reader.prepare(`PRAGMA table_info(${name})`).all()
      .map((row) => `quote("${String(row.name)}") AS "${String(row.name)}"`);
    return active.reader.prepare(`SELECT ${columns.join(", ")} FROM ${name} ORDER BY rowid`).all();
  };
  return {
    message: table("message"),
    records: table("idempotency_record"),
    audit: table("audit_event"),
    exchange: table("exchange"),
  };
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
  expect(active.reader.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(active.reader.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  const sequences = active.reader
    .prepare("SELECT sequence FROM audit_event WHERE exchange_id=? ORDER BY sequence")
    .all(active.exchangeId).map((row) => Number(row.sequence));
  expect(sequences).toEqual([...Array(sequences.length).keys()].map((index) => index + 1));
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
  expect(counts(active)).toEqual({ messages: 0, records: 0, created: 0, audits: 1 });
  expect(active.reader.prepare("SELECT state FROM exchange WHERE exchange_id=?").get(active.exchangeId))
    .toEqual({ state: "OPEN" });
  expect(active.reader.prepare("SELECT kind, sequence FROM audit_event").all())
    .toEqual([{ kind: "exchange_opened", sequence: 1 }]);
  assertDurableConsistency(active);
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
  const { child, ready, done } = launchCrash(active, mode);
  const markerPath = join(active.root, `${mode}.marker`);
  await Promise.race([
    ready,
    done.then((report) => { throw new Error(`crash worker exited before readiness: ${JSON.stringify(report.results[0] ?? report.stderr)}`); }),
  ]);
  writeFileSync(join(active.root, `${mode}.release`), "");
  await waitForMarker(markerPath, MARKER_TIMEOUT_MS);

  // Boundary evidence exists: the worker must now be parked there, with no
  // success result published, and must still be alive for the parent's kill.
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  const partial = await Promise.race([
    done.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  expect(partial).toBe(false);

  child.kill("SIGKILL");
  const report = await done;
  expect(report.signal).toBe("SIGKILL");
  expect(report.status).toBeNull();
  // No success result was delivered by the crashed worker.
  expect(report.results).toEqual([]);
  assertNoSecretLeak(report);

  if (!committed) {
    // Pre-commit crash: nothing durable from the attempt; no leftover
    // rollback journal; the prior durable state is byte-identical.
    assertPreCrashBaseline(active);
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
    expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
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
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
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
  expect(counts(active)).toEqual({ messages: 1, records: 1, created: 1, audits: 2 });
  expect(replay.message.createdAt).toBe(
    active.reader.prepare("SELECT created_at FROM message").get()!.created_at);
  assertDurableConsistency(active);
  const finalSnapshot = losslessSnapshot(active);
  expect(finalSnapshot.message).toEqual(committedRows.message);
  expect(finalSnapshot.audit).toEqual(committedRows.audit);
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
