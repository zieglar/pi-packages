import { appendFile } from "node:fs/promises";
import { FilesystemDurableTaskStore } from "../../dist/durable/filesystem-task-store.js";
import { captureWorkspaceCheckpoint } from "../../dist/durable/workspace-checkpoint.js";
import { StartupRecoveryScanner } from "../../dist/recovery/startup-recovery-scan.js";
import { WakeupService } from "../../dist/recovery/wakeup-service.js";
import { invocationId } from "../../dist/types/identity.js";
import { success } from "../../dist/types/result.js";

const [mode, taskRoot, nowText, marker] = process.argv.slice(2);
if ((mode !== "suspend" && mode !== "resume") || !taskRoot || !nowText || !marker || typeof process.send !== "function") {
  throw new Error("restart-child requires suspend/resume mode, task root, clock, marker, and IPC");
}

const now = Number(nowText);
const store = new FilesystemDurableTaskStore(taskRoot, { now: () => now });

async function resume(recaptureWorkspace) {
  const wakeup = new WakeupService({
    store,
    now: () => now,
    leaseTtlMs: 10_000,
    maxContinuationLaunches: 1,
    maxRecoveryAttempts: 2,
    captureWorkspace: async (state) => {
      if (state.workspace === null) throw new Error("workspace missing");
      if (!recaptureWorkspace) return state.workspace;
      const captured = await captureWorkspaceCheckpoint({
        workspaceRoot: state.workspace.workspaceRoot,
        taskWriteSet: state.workspace.taskWriteSet,
        capturedAtMs: now,
      });
      if (!captured.ok) throw new Error(captured.failure.code);
      return captured.value;
    },
    evaluateAvailability: () => ({ available: true, reason: "health_available" }),
    launcher: {
      launch: async (_packageData, continuationId) => {
        await appendFile(marker, `${JSON.stringify({ continuationId })}\n`, "utf8");
        return success({ invocationId: invocationId(continuationId) });
      },
    },
  });
  return new StartupRecoveryScanner(store, wakeup, () => now).scan();
}

process.send({ type: "ready" });
process.once("message", async (message) => {
  let result;
  if (mode === "suspend" && typeof message === "object" && message !== null && message.type === "capture-and-state") {
    const captured = await captureWorkspaceCheckpoint({
      workspaceRoot: message.workspaceRoot,
      taskWriteSet: message.taskWriteSet,
      capturedAtMs: now,
    });
    result = captured.ok ? await store.create({ ...message.state, workspace: captured.value }) : captured;
  } else if (mode === "suspend" && typeof message === "object" && message !== null && message.type === "state") {
    result = await store.create(message.state);
  } else if (mode === "resume" && typeof message === "object" && message !== null && message.type === "go") {
    result = await resume(message.recaptureWorkspace === true);
  } else {
    return;
  }
  process.send?.({ type: "result", result });
  process.disconnect();
});
