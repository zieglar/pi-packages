// Test-only independent-process crash worker for S3-B2 (C6).
// Each mode reaches a verifiable execution boundary, writes a sanitized
// marker file, and blocks until the parent issues SIGKILL. Production code
// and production crash hooks are untouched; all boundary evidence is a
// marker plus the parent-side durable forensics. No payload bytes, endpoint
// values, SQL text, or error messages are emitted.
import { existsSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { openStore } = await import(config.storeUrl);
const { createMessage } = await import(config.creationUrl);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Block forever. Only the parent's SIGKILL releases this; nothing here can
 * time out into a false "crash happened" conclusion. */
function blockForever() {
  const idle = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(idle, 0, 0); // no timeout: correctness comes from the marker
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

const request = () => ({
  exchangeId: config.request.exchangeId,
  from: config.request.from,
  to: config.request.to,
  payload: Uint8Array.from(config.request.payload),
  idempotencyKey: config.request.idempotencyKey,
});

const store = openStore({
  directory: config.directory,
  filename: config.filename,
  busyTimeoutMs: config.busyTimeoutMs,
});

// The K2 boundary (after BEGIN IMMEDIATE, before any statement) has no
// private seam. The worker instruments only its OWN raw connection object —
// documented privileged test authority, never exported — to mark and block
// immediately after the accepted helper executes BEGIN IMMEDIATE.
let instrumentedBegin = false;
if (config.mode === "k2-after-begin") {
  const originalExec = store.database.exec.bind(store.database);
  store.database.exec = (sql) => {
    const result = originalExec(sql);
    if (!instrumentedBegin && sql === "BEGIN IMMEDIATE") {
      instrumentedBegin = true;
      writeFileSync(config.markerPath, "after-begin");
      blockForever();
    }
    return result;
  };
}

writeFileSync(config.readyPath, "");
emit({ event: "ready", tag: config.tag, mode: config.mode });

if (!waitForBarrier(config.releasePath, config.waitMs)) {
  emit({ event: "result", stage: "release", tag: config.tag, code: "CRASH_WORKER_BARRIER_TIMEOUT" });
  store.close();
  process.exit(3);
}

const boundaryReached = () => {
  writeFileSync(config.markerPath, config.mode);
  blockForever();
};

const seams = {
  "k1-before-begin": { now: boundaryReached },
  "k3-after-message-insert": { afterMessageInsert: boundaryReached },
  "k4-after-idempotency-insert": { afterIdempotencyInsert: boundaryReached },
  "k5-after-audit-insert": { afterAuditInsert: boundaryReached },
}[config.mode];

try {
  // K6: COMMIT completes synchronously inside createMessage; the marker is
  // written only after the accepted helper returns, proving the commit.
  const result = createMessage(store, request(), seams ?? {});
  if (config.mode === "k6-after-commit") {
    writeFileSync(config.markerPath, "after-commit");
    blockForever(); // result intentionally never delivered to the parent
  }
  emit({
    event: "result", stage: "create", tag: config.tag,
    disposition: result.disposition,
    messageId: result.message.messageId,
    createdAt: result.message.createdAt,
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
