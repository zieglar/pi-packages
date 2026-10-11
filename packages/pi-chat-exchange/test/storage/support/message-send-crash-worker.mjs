// Test-only real-process SIGKILL worker for B3-P3A authorized send.
// Boundary evidence contains counts only; credentials, endpoints, payloads,
// paths, SQL, and exception text never leave this process.
import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs";

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

function blockForever() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

let config;
let store;
let sendMessage;
try {
  config = JSON.parse(process.argv[2]);
  const storage = await import(config.storeUrl);
  ({ sendMessage } = await import(config.messagingUrl));
  store = storage.openStore({
    directory: config.directory,
    filename: config.filename,
    busyTimeoutMs: config.busyTimeoutMs,
  });
} catch {
  emit({ event: "result", stage: "open", code: "CRASH_WORKER_OPEN_FAILED" });
  process.exitCode = 2;
}

if (store !== undefined) {
  try {
    const modes = [
      "after-begin",
      "after-message-insert",
      "after-idempotency-insert",
      "after-audit-insert",
      "after-commit",
    ];
    if (!modes.includes(config.mode)) throw new Error("invalid mode");
    const database = store.database;
    const boundaryReached = () => {
      const scalar = (sql, ...parameters) => database.prepare(sql).get(...parameters).n;
      const evidence = {
        mode: config.mode,
        transaction: database.isTransaction,
        messages: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM message WHERE exchange_id=?", config.exchangeId),
        records: scalar(
          "SELECT CAST(count(*) AS TEXT) AS n FROM idempotency_record WHERE namespace=?",
          JSON.stringify(["message.create", config.exchangeId]),
        ),
        created: scalar(
          "SELECT CAST(count(*) AS TEXT) AS n FROM audit_event WHERE exchange_id=? AND kind='message_created'",
          config.exchangeId,
        ),
        cursor: scalar("SELECT CAST(count(*) AS TEXT) AS n FROM delivery_cursor"),
      };
      writeFileSync(config.evidencePath, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
      const pending = `${config.markerPath}.pending`;
      writeFileSync(pending, config.mode, { flag: "wx", mode: 0o600 });
      linkSync(pending, config.markerPath);
      unlinkSync(pending);
      blockForever();
    };

    writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
    emit({ event: "ready", tag: config.mode, mode: config.mode });
    if (!waitForBarrier(config.releasePath, config.waitMs)) {
      emit({ event: "result", stage: "release", code: "CRASH_WORKER_BARRIER_TIMEOUT" });
      process.exitCode = 3;
    } else {
      const seams = {
        "after-begin": { now: boundaryReached },
        "after-message-insert": { now: () => config.now, afterMessageInsert: boundaryReached },
        "after-idempotency-insert": { now: () => config.now, afterIdempotencyInsert: boundaryReached },
        "after-audit-insert": { now: () => config.now, afterAuditInsert: boundaryReached },
        "after-commit": { now: () => config.now },
      }[config.mode];
      sendMessage(
        store,
        {
          ...config.request,
          message: { ...config.request.message, payload: Uint8Array.from(config.request.message.payload) },
        },
        seams,
      );
      if (config.mode === "after-commit") boundaryReached();
      throw new Error("boundary not reached");
    }
  } catch {
    emit({ event: "result", stage: "send", code: "CRASH_WORKER_BOUNDARY_FAILED" });
    process.exitCode = 4;
  } finally {
    try {
      store.close();
    } catch {
      process.exitCode = 4;
    }
  }
}
