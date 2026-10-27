import { existsSync } from "node:fs";

let serializedConfig = "";
for await (const chunk of process.stdin) serializedConfig += chunk;
const config = JSON.parse(serializedConfig);
const deadline = Date.now() + config.waitMs;
process.stdout.write(`${JSON.stringify({ event: "ready", stage: config.tag })}\n`);
while (!existsSync(config.releasePath)) {
  if (Date.now() >= deadline) throw new Error("release gate timed out");
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const waitArray = new Int32Array(new SharedArrayBuffer(4));
function holdAfterBegin() {
  if (config.transactionReleasePath === undefined) return;
  process.stdout.write(`${JSON.stringify({ event: "locked", stage: config.tag })}\n`);
  while (!existsSync(config.transactionReleasePath)) {
    if (Date.now() >= deadline) throw new Error("transaction release gate timed out");
    Atomics.wait(waitArray, 0, 0, 5);
  }
}

const { openStore } = await import(config.storeUrl);
const { discoverInboxMessages } = await import(config.inboxUrl);
const { sendMessage } = await import(config.messagingUrl);
const { releaseOwnership } = await import(config.ownershipUrl);
const { revokeCapability } = await import(config.participantUrl);

let store;
try {
  store = openStore({
    directory: config.directory,
    filename: config.filename,
    busyTimeoutMs: config.busyTimeoutMs,
  });
  if (config.operation === "list") {
    const result = discoverInboxMessages(store, config.request, {
      now: () => config.now,
      afterBegin: holdAfterBegin,
    });
    process.stdout.write(`${JSON.stringify({
      event: "result",
      stage: config.tag,
      status: "LISTED",
      messageIds: result.messages.map((item) => item.message.messageId),
      continuationAuditSequence: result.continuationAuditSequence,
      scanBudgetExhausted: result.scanBudgetExhausted,
    })}\n`);
  } else if (config.operation === "send") {
    const result = sendMessage(
      store,
      {
        ...config.request,
        message: { ...config.request.message, payload: Uint8Array.from(config.request.message.payload) },
      },
      { now: () => config.now },
    );
    process.stdout.write(`${JSON.stringify({
      event: "result",
      stage: config.tag,
      status: result.disposition,
      messageId: result.message.messageId,
    })}\n`);
  } else if (config.operation === "release") {
    const result = releaseOwnership(store, config.request, { now: () => config.now });
    process.stdout.write(`${JSON.stringify({
      event: "result",
      stage: config.tag,
      status: "RELEASED",
      fencingToken: result.fencingToken,
    })}\n`);
  } else if (config.operation === "revoke") {
    revokeCapability(store, config.request, { now: () => config.now });
    process.stdout.write(`${JSON.stringify({ event: "result", stage: config.tag, status: "REVOKED" })}\n`);
  } else {
    throw new Error("unsupported worker operation");
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    event: "result",
    stage: config.tag,
    code: error?.code ?? "UNEXPECTED",
    outcome: error?.outcome,
    retryable: error?.retryable,
  })}\n`);
} finally {
  try { store?.close(); } catch {}
}
