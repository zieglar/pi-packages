import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createWayforgeTools } from "./runtime/extension-tools.js";
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

function startWorkflow(
  pi: Parameters<ExtensionFactory>[0],
  ctx: ExtensionContext,
  state: WayforgeExtensionState,
  objective: string,
): WorkflowRuntime {
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
  state.taskSequence += 1;
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
      taskId: taskId(`alpha0-${state.taskSequence}`),
      objective,
      completionCriteria: DEFAULT_CRITERIA,
    },
    mainModel: new MainModelController(adapter),
    nestedRuntime: adapter,
    // The first event fires synchronously inside createWorkflowRuntime, before
    // `runtime` is assigned; the status writer therefore goes through a mutable
    // controller reference attached right after construction.
    onEvent: (event) => {
      state.sink.appendEvent(event);
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
    },
  });
  controllerRef = runtime.controller;
  state.sink.writeStatus(runtime.controller.taskId, runtime.controller.status());
  state.runtime = runtime;
  return runtime;
}

/**
 * The Wayforge Alpha 0 extension. Native Main execution stays untouched;
 * Wayforge adds `/wayforge`, a narrow tool surface, and lifecycle tracking.
 * The fail-closed ownership guard runs on every session start, and the sole
 * parent model-change path remains MainModelController -> adapter.setModel.
 */
export const wayforgeExtension: ExtensionFactory = (pi) => {
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
        startWorkflow(pi, ctx, state, objective);
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
      return;
    }
    state.guardFailures = guard.failures;
    ctx.ui.notify(`Wayforge ownership guard failed closed:\n${guard.failures.join("\n")}`, "error");
  });

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

  pi.on("session_shutdown", () => {
    const runtime = state.runtime;
    if (runtime === undefined) return;
    if (runtime.controller.status().status === "running") {
      runtime.controller.cancel();
    }
  });
};
