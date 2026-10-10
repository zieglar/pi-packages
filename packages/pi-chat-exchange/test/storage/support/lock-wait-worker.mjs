// Test-only independent-process worker for CE-0002-B3-P2B-R1 lock-wait races.
// It performs exactly one renewLease/takeoverOwnership call against a real
// file-backed store under the REAL wall clock (no injected clock seam). An
// observable initiation marker (its content is the real instant immediately
// before the operation call) lets the parent prove the operation was
// initiated before a deadline while its owned transaction later serialized
// after it, blocked on the SQLite writer lock. Only sanitized structured
// results leave this process: no capability, SQL text, or error detail.
import { writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { openStore } = await import(config.storeUrl);
const ownership = await import(config.ownershipUrl);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const store = openStore({
  directory: config.directory,
  filename: config.filename,
  busyTimeoutMs: config.busyTimeoutMs,
});
try {
  const op = config.op === "renew" ? ownership.renewLease : ownership.takeoverOwnership;
  writeFileSync(config.startedPath, new Date().toISOString(), { flag: "wx", mode: 0o600 });
  const lease = op(store, config.request);
  emit({
    event: "result",
    stage: "op",
    tag: config.tag,
    disposition: config.op === "renew" ? "RENEWED" : "TAKEN_OVER",
    sessionId: lease.sessionId,
    fencingToken: lease.fencingToken,
    leaseStartedAt: lease.leaseStartedAt,
    expiresAt: lease.expiresAt,
  });
} catch (error) {
  emit({
    event: "result",
    stage: "op",
    tag: config.tag,
    code: error?.code ?? "UNKNOWN_OPERATION_FAILURE",
    outcome: error?.outcome ?? null,
    retryable: error?.retryable ?? null,
  });
} finally {
  try {
    store.close();
  } catch {
    /* an invalidated connection is already closed */
  }
}
