// Test-only independent-process crash worker for S3-B2 / S4-3.
// Existing private seams and worker-local instrumentation preserve K1–K6.
// Only mode, transaction state and decimal-text counts leave this process.
// No payload bytes, endpoint values, paths, SQL or exception details are emitted.
import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function blockForever() {
  // Only the parent's real OS-process SIGKILL releases a reached boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
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

let config, store, createMessage;
try {
  config = JSON.parse(process.argv[2]);
  const { openStore } = await import(config.storeUrl);
  ({ createMessage } = await import(config.creationUrl));
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
} catch {
  // An open failure is infrastructure failure, never a reached crash boundary.
  // Do not read the exception, including its code, stack or cause.
  emit({ event: "result", stage: "open", code: "CRASH_WORKER_OPEN_FAILED" });
  process.exitCode = 2;
}

if (store !== undefined) {
  try {
    const modes = ["k1-before-begin", "k2-after-begin", "k3-after-message-insert",
      "k4-after-idempotency-insert", "k5-after-audit-insert", "k6-after-commit"];
    if (!modes.includes(config.mode)) throw new Error("invalid fixture mode");
    const db = store.database;
    const boundaryReached = () => {
      // These reads observe this worker's own uncommitted writes. They do not
      // alter the transaction, add a production hook or expose row contents.
      const count = (sql, ...parameters) => db.prepare(sql).get(...parameters).n;
      const evidence = {
        mode: config.mode,
        transaction: db.isTransaction,
        messages: count("SELECT CAST(count(*) AS TEXT) AS n FROM message"),
        records: count("SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record WHERE namespace=?",
          JSON.stringify(["message.create", config.request.exchangeId])),
        created: count("SELECT CAST(count(*) AS TEXT) AS n FROM audit_event WHERE kind='message_created'"),
        audits: count("SELECT CAST(count(*) AS TEXT) AS n FROM audit_event"),
      };
      // Publish evidence first; exact-mode marker is the final boundary signal.
      // Exclusive creation rejects stale artifacts instead of overwriting them.
      writeFileSync(config.evidencePath, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
      // Creating the final file before writing exposes a transient empty marker.
      // Same-directory link publishes completed content atomically and refuses
      // an existing destination; unlike rename it cannot overwrite stale state.
      const pendingMarker = `${config.markerPath}.pending`;
      writeFileSync(pendingMarker, config.mode, { flag: "wx", mode: 0o600 });
      linkSync(pendingMarker, config.markerPath);
      unlinkSync(pendingMarker);
      blockForever();
    };

    // K2 has no seam: instrument only this worker's privileged raw connection,
    // immediately after the accepted helper executes BEGIN IMMEDIATE.
    if (config.mode === "k2-after-begin") {
      const originalExec = db.exec.bind(db);
      let instrumentedBegin = false;
      db.exec = (sql) => {
        const result = originalExec(sql);
        if (!instrumentedBegin && sql === "BEGIN IMMEDIATE") {
          instrumentedBegin = true;
          boundaryReached();
        }
        return result;
      };
    }
    writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
    emit({ event: "ready", tag: config.tag, mode: config.mode });
    if (!waitForBarrier(config.releasePath, config.waitMs)) {
      emit({ event: "result", stage: "release", code: "CRASH_WORKER_BARRIER_TIMEOUT" });
      process.exitCode = 3;
    } else {
      const seams = {
        "k1-before-begin": { now: boundaryReached },
        "k3-after-message-insert": { afterMessageInsert: boundaryReached },
        "k4-after-idempotency-insert": { afterIdempotencyInsert: boundaryReached },
        "k5-after-audit-insert": { afterAuditInsert: boundaryReached },
      }[config.mode];
      createMessage(store, {
        exchangeId: config.request.exchangeId, from: config.request.from, to: config.request.to,
        payload: Uint8Array.from(config.request.payload), idempotencyKey: config.request.idempotencyKey,
      }, seams ?? {});
      // K6 is AFTER normal return: COMMIT is complete, result is NOT delivered.
      // This is not an exact kill window between COMMIT and helper return.
      if (config.mode === "k6-after-commit") boundaryReached();
      throw new Error("fixture missed crash boundary");
    }
  } catch {
    emit({ event: "result", stage: "create", code: "CRASH_WORKER_BOUNDARY_FAILED" });
    process.exitCode = 4;
  } finally {
    try { store.close(); } catch { process.exitCode = 4; }
  }
}
