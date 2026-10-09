// Test-only independent-process worker for S3-B1 concurrency scenarios.
// It owns one SQLite connection, opens the store BEFORE announcing readiness,
// waits for an explicit release barrier, performs exactly one accepted S3-A
// createMessage call, and emits sanitized structured results only.
// No payload bytes, endpoint values, SQL text, or error messages are emitted.
import { existsSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { openStore } = await import(config.storeUrl);
const { createMessage } = await import(config.creationUrl);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Bounded barrier wait. Polling is a liveness detail: correctness comes from
 * the parent's explicit release, never from elapsed time. */
function waitForBarrier(path, waitMs) {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + waitMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) return false;
    Atomics.wait(idle, 0, 0, 5);
  }
  return true;
}

let store;
try {
  store = openStore({
    directory: config.directory,
    filename: config.filename,
    busyTimeoutMs: config.busyTimeoutMs,
  });
} catch (error) {
  // Open-stage failures are reported separately so a preflight race can never
  // be mistaken for a concurrency outcome.
  emit({ event: "result", stage: "open", tag: config.tag, code: error?.code ?? "UNKNOWN_OPEN_FAILURE" });
  process.exit(2);
}

writeFileSync(config.readyPath, "");
emit({ event: "ready", tag: config.tag });

if (!waitForBarrier(config.releasePath, config.waitMs)) {
  emit({ event: "result", stage: "release", tag: config.tag, code: "WORKER_BARRIER_TIMEOUT" });
  store.close();
  process.exit(3);
}

try {
  const result = createMessage(store, {
    exchangeId: config.request.exchangeId,
    from: config.request.from,
    to: config.request.to,
    payload: Uint8Array.from(config.request.payload),
    idempotencyKey: config.request.idempotencyKey,
  });
  emit({
    event: "result", stage: "create", tag: config.tag,
    disposition: result.disposition,
    messageId: result.message.messageId,
    createdAt: result.message.createdAt,
    payloadLength: result.message.payloadLength,
    entityId: result.record.entityId,
  });
} catch (error) {
  emit({
    event: "result", stage: "create", tag: config.tag,
    code: error?.code ?? "UNKNOWN_CREATE_FAILURE",
    outcome: error?.outcome ?? null,
    retryable: error?.retryable ?? null,
  });
} finally {
  try { store.close(); } catch { /* an invalidated connection is already closed */ }
}
