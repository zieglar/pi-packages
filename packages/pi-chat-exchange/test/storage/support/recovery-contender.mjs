// Test-only independent-process write-lock contender for S5-1 (R1-B).
// It owns one SQLite connection, opens the store before announcing readiness,
// waits for an explicit release barrier, and performs exactly one accepted
// createMessage call with no retry. Worker-local instrumentation of this
// process's own raw connection publishes an exact-content contention marker
// immediately BEFORE the accepted helper's single BEGIN IMMEDIATE executes,
// so contention is observable evidence rather than an assumption.
// Only fixed vocabulary leaves this process: no payload bytes, endpoint
// values, SQL text, paths, exception messages or causes.
import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs";

const CONTENTION = "begin-immediate";

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
/** Publish completed content atomically: staging is written in full, then a
 * same-directory link publishes it and refuses an existing destination. */
function publish(path, content) {
  const pending = `${path}.pending`;
  writeFileSync(pending, content, { flag: "wx", mode: 0o600 });
  linkSync(pending, path);
  unlinkSync(pending);
}

let config, store, createMessage;
try {
  config = JSON.parse(process.argv[2]);
  const { openStore } = await import(config.storeUrl);
  ({ createMessage } = await import(config.creationUrl));
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
} catch {
  // Startup failure is infrastructure failure, never a contention outcome.
  // The exception is never inspected, serialized or rethrown.
  emit({ event: "result", stage: "open", code: "RECOVERY_CONTENDER_OPEN_FAILED" });
  process.exitCode = 2;
}

if (store !== undefined) {
  try {
    const db = store.database;
    const originalExec = db.exec.bind(db);
    let announced = false;
    db.exec = (sql) => {
      // The marker is published before acquisition, so the parent observes a
      // contender that has entered BEGIN IMMEDIATE and not yet acquired.
      if (!announced && sql === "BEGIN IMMEDIATE") {
        announced = true;
        publish(config.contentionPath, CONTENTION);
      }
      return originalExec(sql);
    };
    writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
    emit({ event: "ready", tag: config.tag });
    if (!waitForBarrier(config.releasePath, config.waitMs)) {
      emit({ event: "result", stage: "release", code: "RECOVERY_CONTENDER_BARRIER_TIMEOUT" });
      process.exitCode = 3;
    } else {
      try {
        const result = createMessage(store, {
          exchangeId: config.request.exchangeId, from: config.request.from, to: config.request.to,
          payload: Uint8Array.from(config.request.payload), idempotencyKey: config.request.idempotencyKey,
        });
        emit({
          event: "result", stage: "create", tag: config.tag, disposition: result.disposition,
          messageId: result.message.messageId, createdAt: result.message.createdAt,
          payloadLength: result.message.payloadLength, entityId: result.record.entityId,
          contended: announced,
        });
      } catch (error) {
        // Only the accepted private classification vocabulary is published.
        emit({
          event: "result", stage: "create", tag: config.tag,
          code: error?.code ?? "UNKNOWN_CREATE_FAILURE",
          outcome: error?.outcome ?? null, retryable: error?.retryable ?? null,
          contended: announced,
        });
      }
    }
  } catch {
    emit({ event: "result", stage: "contend", code: "RECOVERY_CONTENDER_FAILED" });
    process.exitCode = 4;
  } finally {
    try { store.close(); } catch { process.exitCode = 4; }
  }
}
