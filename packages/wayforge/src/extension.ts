import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CompletionAuthority } from "./completion/completion-authority.js";
import { createWayforgeTools } from "./runtime/extension-tools.js";
import { createDurableExecution, type DurableExecution } from "./runtime/durable-composition.js";
import { LiveDurableProjection } from "./runtime/durable-task-projection.js";
import { WorkflowDiskSink } from "./runtime/workflow-disk-sink.js";
import { checkOwnershipGuard } from "./runtime/ownership-guard.js";
import { MainModelController } from "./runtime/main-model-controller.js";
import { PiCompatibilityAdapter } from "./runtime/pi-compatibility-adapter.js";
import type { ExecutionRoute } from "./workflow/contracts.js";
import { createWorkflowRuntime, type WorkflowRuntime } from "./workflow/runtime-factory.js";
import type { ModelTier, ThinkingLevel } from "./types/execution.js";
import { routeId, taskId } from "./types/identity.js";
interface WayforgeExtensionState {
  runtime?: WorkflowRuntime;
  guardFailures?: readonly string[];
  taskSequence: number;
  readonly sink: WorkflowDiskSink;
  durable?: DurableExecution;
  projection?: LiveDurableProjection;
  startupScanStarted?: boolean;
}

/** Durable-composition overrides for isolated profiles and deterministic tests. */
export interface WayforgeExtensionDurableOverrides {
  readonly storeRoot?: string;
  readonly agentDir?: string;
  readonly now?: () => number;
  readonly launcher?: import("./durable/contracts.js").ContinuationLauncher;
  readonly leaseTtlMs?: number;
  readonly maxContinuationLaunches?: number;
  readonly maxRecoveryAttempts?: number;
}

/** Composition overrides for the live Wayforge extension factory. */
export interface WayforgeExtensionOverrides {
  readonly durable?: WayforgeExtensionDurableOverrides;
  readonly observeRuntime?: (runtime: WorkflowRuntime | undefined) => void;
}
const DEFAULT_CRITERIA = "all recorded validations pass and the before-done advisor approves";

/**
 * Derive the Alpha 0 route table from the observed native model. The current
 * model is observed, never rewritten: Wayforge starts on whatever Main is
 * already using and registers role-scoped views of that same route.
 */
function observedRoutes(
  provider: string,
  modelId: string,
  thinking: ThinkingLevel,
  reasoning: boolean,
): readonly ExecutionRoute[] {
  const tier: ModelTier = "flagship";
  return [
    {
      routeId: routeId("observed-main"),
      provider,
      modelId,
      tier,
      thinking,
      capabilities: { worker: false, advisor: false, tools: true, reasoning },
      // Dogfood calibration: real Main turns on 1M-context models routinely
      // exceed the original 4k cap, which fed every worker budget check.
      budgetLimit: 12_000,
    },
    {
      routeId: routeId("observed-worker"),
      provider,
      modelId,
      tier,
      thinking: "low",
      capabilities: { worker: true, advisor: false, tools: true, reasoning },
      // Dogfood calibration: cumulative input across tool-using turns is far
      // larger than the visible prompt; see the worker-route note below.
      budgetLimit: 32_000,
    },
    {
      routeId: routeId("observed-advisor"),
      provider,
      modelId,
      tier,
      thinking: "high",
      capabilities: { worker: false, advisor: true, tools: false, reasoning: true },
      budgetLimit: 800,
    },
  ];
}

async function startWorkflow(
  pi: Parameters<ExtensionFactory>[0],
  ctx: ExtensionContext,
  state: WayforgeExtensionState,
  objective: string,
  overrides: WayforgeExtensionOverrides,
): Promise<WorkflowRuntime> {
  const model = ctx.model;
  if (model === undefined) {
    throw new Error("no model is selected; select one before starting Wayforge");
  }
  const observedThinking = ctx.thinkingLevel;
  const thinking: ThinkingLevel = observedThinking === undefined || observedThinking === "off" ? "minimal" : observedThinking;
  const routes = observedRoutes(String(model.provider), model.id, thinking, model.reasoning);
  const observedMainRoute = routes[0];
  if (observedMainRoute === undefined) {
    throw new Error("observed route table is empty");
  }
  const adapter = new PiCompatibilityAdapter(pi, ctx);
  // Allocate from persisted identities, not the process-local counter. Store
  // creation remains the atomic admission gate: concurrent collision fails
  // closed before any live runtime/event can target an existing task.
  if (state.durable !== undefined) {
    const listed = await state.durable.store.list();
    if (!listed.ok) throw new Error(`durable task admission failed: ${listed.failure.code}`);
    for (const existing of listed.value) {
      const match = /^alpha0-(\d+)$/.exec(existing.taskId);
      if (match !== null) {
        const sequence = Number(match[1]);
        if (Number.isSafeInteger(sequence)) state.taskSequence = Math.max(state.taskSequence, sequence);
      }
    }
  }
  state.taskSequence += 1;
  const activeTaskId = taskId(`alpha0-${state.taskSequence}`);
  if (state.projection !== undefined) {
    const created = await state.projection.startDurableTask({
      taskId: activeTaskId,
      objective,
      completionCriteria: DEFAULT_CRITERIA,
      workspaceRoot: ctx.cwd,
      policyVersions: { role: "main", model: `${String(model.provider)}/${model.id}` },
    });
    if (!created.ok) throw new Error(`durable task admission failed: ${created.failure.code}`);
  }
  const completionAuthority = state.durable === undefined
    ? undefined
    : new CompletionAuthority({
        store: state.durable.store,
        workspaceRoot: ctx.cwd,
        taskId: activeTaskId,
        leaseTtlMs: overrides.durable?.leaseTtlMs ?? 30_000,
        now: overrides.durable?.now ?? (() => Date.now()),
      });
  let controllerRef: WorkflowRuntime["controller"] | undefined;
  const runtime = createWorkflowRuntime({
    ownerRunId: `wayforge-alpha0-${state.taskSequence}`,
    delegation: pi.events,
    modelAvailability: {
      hasModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId) !== undefined,
    },
    routes,
    observedMainRoute,
    task: {
      taskId: activeTaskId,
      objective,
      completionCriteria: DEFAULT_CRITERIA,
    },
    mainModel: new MainModelController(adapter),
    nestedRuntime: adapter,
    ...(completionAuthority !== undefined ? { completionAuthority } : {}),
    // The first event fires synchronously inside createWorkflowRuntime, before
    // `runtime` is assigned; the status writer therefore goes through a mutable
    // controller reference attached right after construction.
    onEvent: (event) => {
      state.sink.appendEvent(event);
      state.projection?.project(event);
      if (controllerRef !== undefined) {
        state.sink.writeStatus(event.taskId, controllerRef.status());
      }
    },
    config: {
      cwd: ctx.cwd,
      requireAdvisorApproval: true,
      maxWorkers: 4,
      // Parent budget feeds worker checks: min(worker route, parent remaining).
      mainBudgetLimit: 96_000,
      // One time domain for the whole live composition: the recovery
      // executor, durable projection, and wakeup scheduler must observe the
      // same clock or suspension windows and due scans diverge.
      ...(overrides.durable?.now !== undefined ? { now: overrides.durable.now } : {}),
    },
  });
  controllerRef = runtime.controller;
  state.sink.writeStatus(runtime.controller.taskId, runtime.controller.status());
  state.runtime = runtime;
  overrides?.observeRuntime?.(runtime);
  return runtime;
}

/**
 * The Wayforge Alpha 0 extension. Native Main execution stays untouched;
 * Wayforge adds `/wayforge`, a narrow tool surface, and lifecycle tracking.
 * The fail-closed ownership guard runs on every session start, and the sole
 * parent model-change path remains MainModelController -> adapter.setModel.
 */
function wayforgeExtensionBody(
  pi: Parameters<ExtensionFactory>[0],
  overrides: WayforgeExtensionOverrides,
): void {
  const state: WayforgeExtensionState = { taskSequence: 0, sink: new WorkflowDiskSink() };

  for (const tool of createWayforgeTools({
    getRuntime: () => state.runtime,
    getGuardFailures: () => state.guardFailures,
  })) {
    pi.registerTool(tool);
  }

  pi.registerCommand("wayforge", {
    description: "Start an assisted Wayforge Alpha 0 workflow: /wayforge <objective>",
    handler: async (args, ctx) => {
      if (state.guardFailures !== undefined) {
        ctx.ui.notify(
          `Wayforge is disabled: the ownership guard failed closed.\n${state.guardFailures.join("\n")}`,
          "error",
        );
        return;
      }
      if (state.runtime !== undefined) {
        ctx.ui.notify(
          "A Wayforge workflow is already active; cancel it with the wayforge_cancel tool first.",
          "warning",
        );
        return;
      }
      const objective = args.trim();
      if (objective.length === 0) {
        ctx.ui.notify("Usage: /wayforge <objective>", "warning");
        return;
      }
      try {
        await startWorkflow(pi, ctx, state, objective, overrides);
      } catch (error) {
        ctx.ui.notify(`Wayforge failed to start: ${error instanceof Error ? error.message : "unknown error"}`, "error");
        return;
      }
      pi.sendUserMessage(
        [
          `Wayforge workflow started (objective: ${objective}).`,
          "Work on it directly or with the Wayforge tools:",
          "- wayforge_delegate_workers: bounded Worker delegation",
          "- wayforge_record_validation: record each validation command result",
          "- wayforge_advise: advisor review (beforeDone gates completion)",
          "- wayforge_task_status: sanitized snapshot",
          "- wayforge_complete / wayforge_cancel",
          "Completion requires passing validations and an approving advisor verdict.",
        ].join("\n"),
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const guard = checkOwnershipGuard({
      tools: pi.getAllTools().map((tool) => ({
        name: tool.name,
        ...(tool.sourceInfo !== undefined
          ? {
              sourceInfo: {
                ...(tool.sourceInfo.source !== undefined ? { source: tool.sourceInfo.source } : {}),
                ...(tool.sourceInfo.path !== undefined ? { path: tool.sourceInfo.path } : {}),
              },
            }
          : {}),
      })),
      commands: pi.getCommands().map((command) => ({
        name: command.name,
        ...(command.sourceInfo !== undefined
          ? {
              sourceInfo: {
                ...(command.sourceInfo.source !== undefined ? { source: command.sourceInfo.source } : {}),
                ...(command.sourceInfo.path !== undefined ? { path: command.sourceInfo.path } : {}),
              },
            }
          : {}),
      })),
    });
    if (guard.ok) {
      delete state.guardFailures;
      startDurableExecution(state, overrides, ctx);
      return;
    }
    state.guardFailures = guard.failures;
    ctx.ui.notify(`Wayforge ownership guard failed closed:\n${guard.failures.join("\n")}`, "error");
  });

/**
 * Compose the durable execution stack once per process using the session
 * workspace, then run one bounded startup recovery pass. The scan never
 * blocks session start: it is fired asynchronously, failures surface as
 * typed sanitized notifications, and repeated session starts cannot enqueue
 * duplicate scans. Cross-process duplicate prevention stays with the
 * WakeupService lease and persisted continuation phases.
 */
function startDurableExecution(
  state: WayforgeExtensionState,
  overrides: WayforgeExtensionOverrides,
  ctx: ExtensionContext,
): void {
  if (state.durable === undefined) {
    try {
      const durable = createDurableExecution({
        cwd: ctx.cwd,
        ...(overrides.durable ?? {}),
      });
      state.durable = durable;
      state.projection = new LiveDurableProjection(durable.store, {
        ...(overrides.durable?.now !== undefined ? { now: overrides.durable.now } : {}),
      });
    } catch {
      ctx.ui.notify(
        "Wayforge durable execution is unavailable in this environment; workflows continue Alpha 0 only.",
        "warning",
      );
      return;
    }
  }
  if (state.startupScanStarted === true) return;
  state.startupScanStarted = true;
  const scanner = state.durable.scanner;
  void scanner
    .scan()
    .then((scanned) => {
      if (!scanned.ok) {
        ctx.ui.notify(`Wayforge startup recovery failed: ${scanned.failure.code}`, "error");
        return;
      }
      if (scanned.value.processed > 0) {
        ctx.ui.notify(
          `Wayforge startup recovery processed ${scanned.value.processed} suspended task(s).`,
          "info",
        );
      }
    })
    .catch(() => {
      ctx.ui.notify("Wayforge startup recovery failed: unknown error", "error");
    });
}
  pi.on("before_agent_start", () => {
    const runtime = state.runtime;
    if (runtime === undefined) return;
    const started = runtime.controller.beginMainTurn();
    if (!started.ok && started.failure.code !== "main_already_active") {
      // A workflow that cannot track Main still fails closed to the log only;
      // native Main execution is never blocked by Wayforge.
      runtime.log.emit("failure_classified", {
        taskId: runtime.controller.taskId,
        detail: { code: started.failure.code, message: started.failure.message },
      });
    }
  });

  pi.on("agent_end", () => {
    state.runtime?.controller.endMainTurn();
  });

  pi.on("session_shutdown", async () => {
    const runtime = state.runtime;
    if (runtime !== undefined && runtime.controller.status().status === "running") {
      runtime.controller.cancel();
    }
    // Pi awaits shutdown handlers, so drain durable projections before it
    // disposes the session/process. This is not a second recovery owner.
    await state.projection?.settle();
  });
}

/**
 * The live Wayforge extension factory. Constructed with composition overrides
 * for isolated profiles and deterministic tests; `wayforgeExtension` is the
 * default production instance Pi loads.
 */
export function createWayforgeExtension(overrides: WayforgeExtensionOverrides = {}): ExtensionFactory {
  return (pi) => wayforgeExtensionBody(pi, overrides);
}

export const wayforgeExtension: ExtensionFactory = createWayforgeExtension();
