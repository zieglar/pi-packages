import { acquireSessionProcessMutex } from "../../../dist/tunnel/session-process-mutex.js";
import { CeEndpointHost } from "../../../dist/host/endpoint-host.js";
import { openStore } from "../../../dist/storage/store.js";
const options = JSON.parse(process.argv[2]);
let handle;
try {
  handle = acquireSessionProcessMutex(options);
} catch {
  console.log("REFUSED"); process.exit(2);
}
const store = openStore({ directory: options.store.directory, filename: options.store.file });
const host = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: options.endpointId }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: "mutex-process-test", exchangeIdempotencyKey: "exchange", leaseTtlSeconds: 300 });
handle.run(() => host.beginSession(options.endpointId, { requireUnowned: true }));
const heartbeat = setInterval(() => handle.run(() => host.renew(options.endpointId)), 50);
console.log("ACQUIRED");
process.stdin.resume();
process.stdin.on("end", async () => {
  handle.closeAdmission();
  clearInterval(heartbeat);
  await handle.drain();
  const cleanup = host.end(options.endpointId);
  handle.release(cleanup);
  store.close();
});
