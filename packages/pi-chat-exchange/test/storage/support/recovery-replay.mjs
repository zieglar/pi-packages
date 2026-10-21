// Test-only independent-process replay worker for S5-2 (R4).
// Each worker owns its own accepted Store connection, performs exactly one
// accepted createMessage call with no retry, and reports only the accepted
// public Message/record identity and sanitized classification fields.
// No payload bytes, endpoint values, SQL text, paths, exception messages or
// causes are emitted. Only structured identity facts are published so the
// parent can cross-check them against an independent read-only reader.
import { existsSync, writeFileSync } from "node:fs";

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

let store, createMessage;
try {
  const { openStore } = await import(config.storeUrl);
  ({ createMessage } = await import(config.creationUrl));
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
} catch {
  // Startup failure is infrastructure failure, never a replay outcome.
  emit({ event: "result", stage: "open", code: "RECOVERY_REPLAY_OPEN_FAILED" });
  process.exitCode = 2;
}

if (store !== undefined) {
  try {
    writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
    emit({ event: "ready", tag: config.tag });
    if (!waitForBarrier(config.releasePath, config.waitMs)) {
      emit({ event: "result", stage: "release", code: "RECOVERY_REPLAY_BARRIER_TIMEOUT" });
      process.exitCode = 3;
    } else {
      const before = Number(store.database.prepare("SELECT total_changes() AS n").get().n);
      try {
        const result = createMessage(store, {
          exchangeId: config.request.exchangeId, from: config.request.from, to: config.request.to,
          payload: Uint8Array.from(config.request.payload), idempotencyKey: config.request.idempotencyKey,
        });
        const writes = Number(store.database.prepare("SELECT total_changes() AS n").get().n) - before;
        // Only accepted public identity and a worker-local write counter are
        // published; the parent independently verifies durable state.
        emit({
          event: "result", stage: "replay", tag: config.tag, disposition: result.disposition,
          messageId: result.message.messageId, createdAt: result.message.createdAt,
          entityId: result.record.entityId, requestDigest: result.record.requestDigest,
          recordCreatedAt: result.record.createdAt, writes,
        });
      } catch (error) {
        emit({
          event: "result", stage: "replay", tag: config.tag,
          code: error?.code ?? "UNKNOWN_REPLAY_FAILURE",
          outcome: error?.outcome ?? null, retryable: error?.retryable ?? null,
        });
      }
    }
  } catch {
    emit({ event: "result", stage: "replay", code: "RECOVERY_REPLAY_FAILED" });
    process.exitCode = 4;
  } finally {
    try { store.close(); } catch { process.exitCode = 4; }
  }
}
