// Test-only independent-process worker for CE-0002-B3-P2B-R1 lock-wait races.
// It performs exactly one renewLease/takeoverOwnership/detachSession call
// file-backed store under the REAL wall clock (no injected clock seam). An
// observable initiation marker (its content is the real instant immediately
// before the operation call) lets the parent prove the operation was
// initiated before a deadline while its owned transaction later serialized
// after it, blocked on the SQLite writer lock. Only sanitized structured
// results leave this process: no capability, SQL text, or error detail.
import { renameSync, writeFileSync } from "node:fs";

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
  const op = config.op === "renew" ? ownership.renewLease : config.op === "detach" ? ownership.detachSession : ownership.takeoverOwnership;
  // Atomic publication (CE-0002-B3-P2C-A-R1): write the complete marker to a
  // staging path, close it, then rename into place. A direct write to the
  // marker path has a create-then-fill window on POSIX (the file exists
  // before its content lands), which the parent could read as empty; rename
  // publishes the complete file in one step.
  const initiatedAt = new Date().toISOString();
  const stagingPath = `${config.startedPath}.staging`;
  writeFileSync(stagingPath, initiatedAt, { flag: "wx", mode: 0o600 });
  renameSync(stagingPath, config.startedPath);
  const result = op(store, config.request);
  emit({
    event: "result",
    stage: "op",
    tag: config.tag,
    disposition: config.op === "renew" ? "RENEWED" : config.op === "detach" ? "DETACHED" : "TAKEN_OVER",
    sessionId: result.sessionId,
    ...(config.op === "detach"
      ? { boundAt: result.boundAt, detachedAt: result.detachedAt }
      : { fencingToken: result.fencingToken, leaseStartedAt: result.leaseStartedAt, expiresAt: result.expiresAt }),
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
