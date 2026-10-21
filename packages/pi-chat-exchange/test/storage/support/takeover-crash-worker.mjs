// Test-only independent-process crash worker for CE-0002-B3-P2B takeover.
// The worker performs exactly one takeoverOwnership call against a real
// file-backed store and is terminated by the parent's SIGKILL at a proven
// boundary: "before-commit" parks inside the owned transaction (after the
// ownership write, before COMMIT) via the accepted private hook seam;
// "after-commit" instruments only this worker's own raw connection so the
// marker is written after a successful COMMIT. Only mode, transaction state,
// and decimal-text counts leave this process; no capability, SQL text, or
// error detail is ever emitted.
import { linkSync, unlinkSync, writeFileSync } from "node:fs";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function blockForever() {
  // Only the parent's real OS-process SIGKILL releases a reached boundary.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("unreachable");
}

let config, store, takeoverOwnership;
try {
  config = JSON.parse(process.argv[2]);
  const { openStore } = await import(config.storeUrl);
  ({ takeoverOwnership } = await import(config.ownershipUrl));
  store = openStore({ directory: config.directory, filename: config.filename, busyTimeoutMs: config.busyTimeoutMs });
} catch {
  // An open failure is infrastructure failure, never a reached crash boundary.
  emit({ event: "result", stage: "open", code: "CRASH_WORKER_OPEN_FAILED" });
  process.exitCode = 2;
}

if (store !== undefined) {
  const db = store.database;
  const boundaryReached = () => {
    // These reads observe this worker's own uncommitted writes. They do not
    // alter the transaction, add a production hook, or expose row contents.
    const evidence = {
      mode: config.mode,
      transaction: db.isTransaction,
      ownership: String(db.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM participant_ownership").get().n),
      ownerToken: String(
        db.prepare("SELECT CAST(fencing_token AS TEXT) AS n FROM participant_ownership WHERE participant_id = ?").get(config.participantId)?.n ?? "none",
      ),
    };
    writeFileSync(config.evidencePath, JSON.stringify(evidence), { flag: "wx", mode: 0o600 });
    // Same-directory link publishes completed content atomically and refuses
    // an existing destination; unlike rename it cannot overwrite stale state.
    const pendingMarker = `${config.markerPath}.pending`;
    writeFileSync(pendingMarker, config.mode, { flag: "wx", mode: 0o600 });
    linkSync(pendingMarker, config.markerPath);
    unlinkSync(pendingMarker);
    blockForever();
  };

  try {
    if (config.mode === "before-commit") {
      takeoverOwnership(store, config.request, {
        now: () => config.now,
        afterOwnershipWrite: boundaryReached,
      });
      emit({ event: "result", stage: "op", code: "CRASH_WORKER_UNEXPECTED_RETURN" });
    } else if (config.mode === "after-commit") {
      const originalExec = db.exec.bind(db);
      let instrumented = false;
      db.exec = (sql) => {
        const result = originalExec(sql);
        if (!instrumented && sql === "COMMIT") {
          instrumented = true;
          boundaryReached();
        }
        return result;
      };
      takeoverOwnership(store, config.request, { now: () => config.now });
      emit({ event: "result", stage: "op", code: "CRASH_WORKER_UNEXPECTED_RETURN" });
    } else {
      emit({ event: "result", stage: "config", code: "CRASH_WORKER_BAD_MODE" });
      process.exitCode = 3;
    }
  } catch (error) {
    emit({ event: "result", stage: "op", code: error?.code ?? "UNKNOWN_OPERATION_FAILURE" });
  } finally {
    try { store.close(); } catch { /* an invalidated connection is already closed */ }
  }
}
