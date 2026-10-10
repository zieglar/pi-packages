// Test-only independent-process worker for CE-0002-B3-P2A acquisition races.
// It owns one SQLite connection, opens the store BEFORE announcing readiness,
// waits for an explicit release barrier, performs exactly one acquireOwnership
// call, and emits sanitized structured results only: no capability, digest,
// secret, SQL text, or error message is ever emitted.
import { existsSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { openStore } = await import(config.storeUrl);
const { acquireOwnership, renewLease } = await import(config.ownershipUrl);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Bounded barrier wait. Correctness comes from the parent's explicit
 * release, never from elapsed time. */
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
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
} catch (error) {
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
  const op = config.op === "renew" ? renewLease : acquireOwnership;
  const lease = op(store, config.request, { now: () => config.now });
  emit({
    event: "result", stage: "acquire", tag: config.tag,
    disposition: config.op === "renew" ? "RENEWED" : "ACQUIRED",
    sessionId: lease.sessionId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt,
  });
} catch (error) {
  emit({
    event: "result", stage: "acquire", tag: config.tag,
    code: error?.code ?? "UNKNOWN_ACQUIRE_FAILURE",
    outcome: error?.outcome ?? null,
    retryable: error?.retryable ?? null,
  });
} finally {
  try { store.close(); } catch { /* an invalidated connection is already closed */ }
}
