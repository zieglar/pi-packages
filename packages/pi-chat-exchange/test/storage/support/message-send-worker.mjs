// Test-only independent-process worker for B3-P3A serialization scenarios.
// It emits only sanitized operation outcomes; capability tokens, endpoints,
// payload bytes, SQL, paths, and exception text never leave the worker.
import { existsSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.argv[2]);
const { openStore } = await import(config.storeUrl);
const { sendMessage } = await import(config.messagingUrl);
const { releaseOwnership, takeoverOwnership } = await import(config.ownershipUrl);

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

let store;
try {
  store = openStore({
    directory: config.directory,
    filename: config.filename,
    busyTimeoutMs: config.busyTimeoutMs,
  });
} catch (error) {
  emit({ event: "result", stage: "open", tag: config.tag, code: error?.code ?? "UNKNOWN_OPEN_FAILURE" });
  process.exit(2);
}

writeFileSync(config.readyPath, "", { flag: "wx", mode: 0o600 });
emit({ event: "ready", tag: config.tag });

if (!waitForBarrier(config.releasePath, config.waitMs)) {
  emit({ event: "result", stage: "release", tag: config.tag, code: "WORKER_BARRIER_TIMEOUT" });
  store.close();
  process.exit(3);
}

try {
  let result;
  if (config.operation === "send") {
    result = sendMessage(
      store,
      {
        ...config.request,
        message: { ...config.request.message, payload: Uint8Array.from(config.request.message.payload) },
      },
      { now: () => config.now },
    );
    emit({
      event: "result",
      stage: "send",
      tag: config.tag,
      disposition: result.disposition,
      messageId: result.message.messageId,
      auditSequence: result.auditSequence,
    });
  } else if (config.operation === "release") {
    result = releaseOwnership(store, config.request, { now: () => config.now });
    emit({ event: "result", stage: "release-owner", tag: config.tag, released: true, fencingToken: result.fencingToken });
  } else if (config.operation === "takeover") {
    result = takeoverOwnership(store, config.request, { now: () => config.now });
    emit({
      event: "result",
      stage: "takeover",
      tag: config.tag,
      sessionId: result.sessionId,
      fencingToken: result.fencingToken,
    });
  } else {
    throw new Error("unsupported operation");
  }
} catch (error) {
  emit({
    event: "result",
    stage: config.operation,
    tag: config.tag,
    code: error?.code ?? "UNKNOWN_OPERATION_FAILURE",
    outcome: error?.outcome ?? null,
    retryable: error?.retryable ?? null,
  });
} finally {
  try {
    store.close();
  } catch {
    // An INDETERMINATE outcome already invalidated the connection.
  }
}
