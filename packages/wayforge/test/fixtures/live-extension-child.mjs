import { appendFile } from "node:fs/promises";
import { createWayforgeExtension } from "../../dist/extension.js";
import { FilesystemDurableTaskStore } from "../../dist/durable/filesystem-task-store.js";
import { PiContinuationLauncher } from "../../dist/runtime/pi-continuation-launcher.js";

/**
 * Phase 1.1 restart-acceptance child. Each invocation composes the REAL
 * Wayforge extension factory in a fresh process against a minimal Pi host
 * double, sharing only the durable store root, the disposable Git workspace,
 * and the continuation marker file across the process boundary.
 *
 *   start mode: session_start -> /wayforge governed task -> durable create ->
 *               real RecoveryCoordinator suspend decision -> wait for the
 *               authoritative suspended state -> exit (simulated process death)
 *   resume mode: fresh composition -> session_start startup scan -> lease ->
 *               drift check -> RESUMING -> NEW continuation session launch
 */

const [mode, storeRoot, workspace, marker, nowText] = process.argv.slice(2);
if (
  (mode !== "start" && mode !== "resume") ||
  !storeRoot ||
  !workspace ||
  !marker ||
  !nowText ||
  typeof process.send !== "function"
) {
  throw new Error("live-extension-child requires start/resume mode, store root, workspace, marker, clock, and IPC");
}

const nowMs = Number(nowText);
const now = () => nowMs;

function makeLauncher() {
  let sequence = 0;
  return new PiContinuationLauncher({
    factory: {
      create: async () => {
        sequence += 1;
        const sessionId = `fresh-continuation-session-${sequence}-${process.pid}`;
        return {
          sessionId,
          prompt: async (text) => {
            await appendFile(marker, `${JSON.stringify({ sessionId, prompt: text.slice(0, 400) })}\n`, "utf8");
          },
        };
      },
    },
  });
}

function makeHost(cwd) {
  const tools = [];
  const commands = [];
  const notifications = [];
  const lifecycle = new Map();
  const delegationHandlers = new Map();
  const model = { provider: "test-provider", id: "test-model", reasoning: true, name: "Test Model" };
  const host = {
    registerFlag: () => undefined,
    getFlag: () => false,
    registerTool: (tool) => tools.push(tool),
    registerCommand: (name, command) => commands.push({ name, ...command }),
    on: (event, handler) => {
      const list = lifecycle.get(event) ?? [];
      list.push(handler);
      lifecycle.set(event, list);
    },
    sendUserMessage: () => {},
    getAllTools: () => tools.map((tool) => ({ ...tool, sourceInfo: { source: "wayforge", path: `${cwd}/dist/extension.js` } })),
    getCommands: () => commands.map((command) => ({ ...command, sourceInfo: { source: "wayforge", path: `${cwd}/dist/extension.js` } })),
    setModel: async () => true,
    events: {
      emit: (channel, data) => {
        for (const handler of delegationHandlers.get(channel) ?? []) handler(data);
      },
      on: (channel, handler) => {
        const set = delegationHandlers.get(channel) ?? new Set();
        set.add(handler);
        delegationHandlers.set(channel, set);
        return () => set.delete(handler);
      },
    },
    async emitLifecycle(event) {
      for (const handler of lifecycle.get(event) ?? []) await handler({}, host.ctx);
    },
    async runCommand(name, args) {
      const command = commands.find((candidate) => candidate.name === name);
      if (command === undefined) throw new Error(`command not registered: ${name}`);
      await command.handler(args, host.ctx);
    },
    ctx: {
      cwd,
      model,
      thinkingLevel: "medium",
      modelRegistry: {
        find: (provider, modelId) =>
          provider === model.provider && modelId === model.id ? model : undefined,
        streamSimple: () => {
          throw new Error("not used by this child");
        },
      },
      ui: { notify: (message, level) => notifications.push({ level, message }) },
    },
  };
  return host;
}

let reportedRuntime;
const factory = createWayforgeExtension({
  durable: { storeRoot, now, launcher: makeLauncher() },
  observeRuntime: (runtime) => {
    if (runtime !== undefined) reportedRuntime = runtime;
  },
});

async function waitForState(store, predicate) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const listed = await store.list();
    if (listed.ok && listed.value.length > 0 && predicate(listed.value[0])) return listed.value[0];
    if (Date.now() > deadline) throw new Error("timed out waiting for durable state in child");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

process.send({ type: "ready" });
process.once("message", async (message) => {
  if (typeof message !== "object" || message === null || message.type !== "go") return;
  const store = new FilesystemDurableTaskStore(storeRoot, { now });
  const host = makeHost(workspace);
  factory(host);
  await host.emitLifecycle("session_start");

  if (mode === "start") {
    await host.runCommand("wayforge", "restart acceptance through the live extension");
    if (reportedRuntime === undefined) throw new Error("runtime was not observed");
    const decision = reportedRuntime.recovery.plan({
      currentRoute: {
        routeId: "observed-worker",
        provider: "test-provider",
        modelId: "test-model",
        tier: "flagship",
        thinking: "low",
        capabilities: { worker: true, advisor: false, tools: true, reasoning: true },
        budgetLimit: 32_000,
      },
      alternatives: [],
      budget: { retriesLeft: 0, fallbacksLeft: 0 },
      failure: {
        kind: "usage_limit",
        scope: "account",
        confidence: "certain",
        code: "quota_exhausted",
        message: "usage window exhausted",
        resetAtMs: nowMs + 1_000,
      },
      failedInvocationId: "live-suspend-inv",
    });
    if (decision.terminal?.action !== "suspend") throw new Error("expected a suspend decision");
    const suspended = await waitForState(store, (state) => state.status === "suspended");
    process.send?.({ type: "result", status: suspended.status, revision: suspended.revision });
    process.disconnect();
    return;
  }

  const resumed = await waitForState(
    store,
    (state) => state.status === "running" && state.continuation?.phase === "launched",
  );
  process.send?.({
    type: "result",
    status: resumed.status,
    continuationId: resumed.continuation?.continuationId,
    continuationPhase: resumed.continuation?.phase,
    leaseGeneration: resumed.leaseGeneration,
    invocationProvenance: resumed.invocationProvenance ?? null,
  });
  process.disconnect();
});
