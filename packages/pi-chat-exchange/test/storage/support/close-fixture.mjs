// Test-only privileged Exchange-close fixture for S3-B1 close-race scenarios.
// This is raw SQLite test authority in an independent process; it is NOT a
// product close API, it is never exported, and production code is untouched.
// It respects schema constraints (state/closed_at CHECK, audit uniqueness,
// immutable audit rows) and emits sanitized structured results only.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const config = JSON.parse(process.argv[2]);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function waitForBarrier(path, waitMs) {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    Atomics.wait(idle, 0, 0, 5);
  }
  return true;
}

const db = new DatabaseSync(join(config.directory, config.filename));
db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${config.busyTimeoutMs}`);

writeFileSync(config.readyPath, "");
emit({ event: "ready", tag: config.tag });

if (!waitForBarrier(config.releasePath, config.waitMs)) {
  emit({ event: "result", stage: "release", tag: config.tag, code: "CLOSE_BARRIER_TIMEOUT" });
  db.close();
  process.exit(3);
}

try {
  db.exec("BEGIN IMMEDIATE");
  const closed = db.prepare(
    "UPDATE exchange SET state='CLOSED', closed_at=? WHERE exchange_id=? AND state='OPEN'",
  ).run(config.closedAt, config.exchangeId);
  if (Number(closed.changes) !== 1) {
    throw new Error("exchange close precondition failed: expected exactly one OPEN Exchange");
  }
  const sequence = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM audit_event WHERE exchange_id=?",
  ).get(config.exchangeId).next;
  const appended = db.prepare(
    "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision)" +
    " VALUES (?, ?, ?, 'exchange_closed', ?, ?, 1)",
  ).run(config.eventId, config.exchangeId, sequence, config.exchangeId, config.closedAt);
  db.exec("COMMIT");
  emit({
    event: "result", stage: "close", tag: config.tag,
    closedRows: Number(closed.changes), auditRows: Number(appended.changes), sequence: Number(sequence),
  });
} catch (error) {
  try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* reported as a failed fixture */ }
  emit({ event: "result", stage: "close", tag: config.tag, code: error?.code ?? "UNKNOWN_CLOSE_FAILURE" });
  db.close();
  process.exit(4);
}
db.close();
