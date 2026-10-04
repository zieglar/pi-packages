import { appendFile } from "node:fs/promises";
import { FilesystemDurableTaskStore } from "../../dist/durable/filesystem-task-store.js";
import { WakeupService } from "../../dist/recovery/wakeup-service.js";
import { invocationId } from "../../dist/types/identity.js";
import { success } from "../../dist/types/result.js";

const [taskRoot, rawTaskId, nowText, marker] = process.argv.slice(2);
if (!taskRoot || !rawTaskId || !nowText || !marker || typeof process.send !== "function") {
  throw new Error("wakeup-child requires task root, task ID, clock, marker, and IPC");
}

const now = Number(nowText);
const store = new FilesystemDurableTaskStore(taskRoot, { now: () => now });
const service = new WakeupService({
  store,
  now: () => now,
  leaseTtlMs: 10_000,
  maxContinuationLaunches: 1,
  maxRecoveryAttempts: 2,
  captureWorkspace: async (state) => {
    if (state.workspace === null) throw new Error("workspace missing");
    return state.workspace;
  },
  evaluateAvailability: () => ({ available: true, reason: "health_available" }),
  launcher: {
    launch: async (_packageData, continuationId) => {
      await appendFile(marker, `${JSON.stringify({ continuationId })}\n`, "utf8");
      return success({ invocationId: invocationId(continuationId) });
    },
  },
});

process.send({ type: "ready" });
process.once("message", async (message) => {
  if (message !== "go") return;
  const result = await service.scanDueTasks();
  process.send?.({ type: "result", result });
  process.disconnect();
});
