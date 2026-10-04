import { FilesystemDurableTaskStore } from "../../dist/durable/filesystem-task-store.js";

const [root, rawTaskId, nowText, ttlText] = process.argv.slice(2);
if (!root || !rawTaskId || !nowText || !ttlText || typeof process.send !== "function") {
  throw new Error("durable-store-child requires root, task id, clock, ttl, and IPC");
}

const store = new FilesystemDurableTaskStore(root, { now: () => Number(nowText) });
process.send({ type: "ready" });
process.once("message", async (message) => {
  if (message !== "go") return;
  const result = await store.acquireLease(rawTaskId, Number(ttlText));
  process.send?.({ type: "result", result });
  process.disconnect();
});
