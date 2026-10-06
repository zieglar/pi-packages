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
  /** Stable sanitized reason code when durable authority failed to initialize. */
  durableUnavailable?: string;
  /**
   * U2.1 Default Governed Mode: session-private routing preference, never
   * durable, never task state. Explicit operator authority only — OFF by
   * default, ON via `pi --wayforge` or `/wayforge on`.
   */
  defaultGovernedMode: boolean;
  modeInitialized?: boolean;
  entryInProgress?: boolean;
  /** This session observed a settled authoritative refusal; no durable history authorizes entry. */
  readonly completionRefusedRuntimes: WeakSet<WorkflowRuntime>;
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
  /** Replaces the durable composition root entirely (isolated profiles, tests). */
  readonly durableFactory?: () => DurableExecution;
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

async function admitWorkflow(
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
    ...(state.projection !== undefined ? { durableUnresolved: state.projection } : {}),
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

/** Shared guarded entry; reserve admission synchronously before any store awaits. */
async function startWorkflow(
  pi: Parameters<ExtensionFactory>[0], ctx: ExtensionContext,
  state: WayforgeExtensionState, objective: string, overrides: WayforgeExtensionOverrides,
): Promise<WorkflowRuntime> {
  if (state.entryInProgress === true) throw new Error("governed entry is already in progress");
  state.entryInProgress = true;
  try {
    return await admitWorkflow(pi, ctx, state, objective, overrides);
  } finally {
    state.entryInProgress = false;
  }
}

/**
 * The Wayforge Alpha 0 extension. Native Main execution stays untouched;
 * Wayforge adds `/wayforge`, a narrow tool surface, and lifecycle tracking.
 * The fail-closed ownership guard runs on every session start, and the sole
 * parent model-change path remains MainModelController -> adapter.setModel.
 */
/** Live representable terminal workflow statuses; suspended/resuming are durable-only recovery states. */
function runtimeTerminal(runtime: WorkflowRuntime): boolean {
  const status = runtime.controller.status().status;
  return status === "completed" || status === "cancelled" || status === "blocked";
}

/** New task eligibility comes only from live status or this session's authoritative completion result. */
function runtimeReplaceable(state: WayforgeExtensionState, runtime: WorkflowRuntime): boolean {
  return runtimeTerminal(runtime) || state.completionRefusedRuntimes.has(runtime);
}

/** One shared status renderer for bare `/wayforge` and `/wayforge status`. */
function renderWayforgeStatus(state: WayforgeExtensionState): string {
  const runtime = state.runtime;
  const taskLine = runtime === undefined
    ? "active governed task: no"
    : state.completionRefusedRuntimes.has(runtime)
      ? `active governed task: no (last task ${runtime.controller.taskId}: changes_requested; next entry creates a new task)`
      : runtimeTerminal(runtime)
        ? `active governed task: no (last task ${runtime.controller.taskId}: ${runtime.controller.status().status})`
        : `active governed task: yes (${runtime.controller.taskId}, ${runtime.controller.status().status})`;
  const durableLine = state.durable !== undefined && state.durableUnavailable === undefined
    ? "durable authority: available"
    : `durable authority: unavailable (${state.durableUnavailable ?? "durable_authority_unavailable"})`;
  return [
    "Wayforge session status:",
    `default governed mode: ${state.defaultGovernedMode ? "on" : "off"}`,
    taskLine,
    durableLine,
    "Controls: /wayforge <objective> | /wayforge on | /wayforge off | /wayforge status. pi --wayforge starts a session on. Session-scoped; never persisted across sessions.",
  ].join("\n");
}

/** Initialize session Default Governed Mode once from the native --wayforge flag. */
function initializeDefaultGovernedMode(
  pi: Parameters<ExtensionFactory>[0],
  state: WayforgeExtensionState,
  ctx: ExtensionContext,
  reason?: string,
): void {
  if (state.modeInitialized === true) return;
  state.modeInitialized = true;
  // Pi replays CLI flags when constructing replacement sessions. Only the
  // original startup consumes launch authority; new/resume/fork/reload start OFF.
  if (reason !== undefined && reason !== "startup") return;
  if (pi.getFlag("wayforge") !== true) return;
  if (ctx.mode === "print" || ctx.mode === "json") {
    // Print mode's supported UI notify is a no-op; stderr is its visible channel.
    process.stderr.write("Default Governed Mode (--wayforge) is unsupported in print mode; this session starts with it off.\n");
    ctx.ui.notify(
      "Default Governed Mode (--wayforge) is unsupported in print mode; this session starts with it off.",
      "warning",
    );
    return;
  }
  state.defaultGovernedMode = true;
  ctx.ui.notify(
    "default governed mode: on (--wayforge) — eligible ordinary operator turns enter governed execution for this session; /wayforge off disables it",
    "info",
  );
}

/** The governed-start user message shared by explicit entry and default routing. */
function governedStartMessage(objective: string): string {
  return [
    `Wayforge workflow started (objective: ${objective}).`,
    "Work on it directly or with the Wayforge tools:",
    "- wayforge_delegate_workers: bounded Worker delegation",
    "- wayforge_record_validation: record each validation command result",
    "- wayforge_advise: advisor review (beforeDone gates completion)",
    "- wayforge_task_status: sanitized snapshot",
    "- wayforge_tasks: sanitized historical durable task list (read-only)",
    "- wayforge_complete / wayforge_cancel",
    "Completion requires passing validations and an approving advisor verdict.",
  ].join("\n");
}

function wayforgeExtensionBody(
  pi: Parameters<ExtensionFactory>[0],
  overrides: WayforgeExtensionOverrides,
): void {
  const state: WayforgeExtensionState = {
    taskSequence: 0,
    sink: new WorkflowDiskSink(),
    defaultGovernedMode: false,
    completionRefusedRuntimes: new WeakSet(),
  };

  pi.registerFlag("wayforge", {
    type: "boolean",
    default: false,
    description: "Start this Pi session with Default Governed Mode on: eligible ordinary operator turns enter Wayforge governed execution (session-scoped, not persisted)",
  });

  for (const tool of createWayforgeTools({
    getRuntime: () => state.runtime,
    getGuardFailures: () => state.guardFailures,
    getDurableStore: () => state.durable?.store,
    getGovernedUnavailable: () => state.durableUnavailable,
    onCompletionChangesRequested: (runtime) => state.completionRefusedRuntimes.add(runtime),
  })) {
    pi.registerTool(tool);
  }

  pi.registerCommand("wayforge", {
    description:
      "Wayforge entry and session mode: /wayforge <objective> starts a governed task; " +
      "/wayforge on|off toggles session-scoped Default Governed Mode; /wayforge or /wayforge status " +
      "shows mode, active task, and durable authority; pi --wayforge starts a session on",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "" || trimmed === "status") {
        ctx.ui.notify(renderWayforgeStatus(state), "info");
        return;
      }
      if (trimmed === "on" || trimmed === "off") {
        state.defaultGovernedMode = trimmed === "on";
        ctx.ui.notify(
          state.defaultGovernedMode
            ? "default governed mode: on — eligible ordinary operator turns now enter governed execution for this session"
            : "default governed mode: off — future ordinary turns stay ordinary; any active governed task is untouched",
          "info",
        );
        return;
      }
      if (state.guardFailures !== undefined) {
        ctx.ui.notify(
          `Wayforge is disabled: the ownership guard failed closed.\n${state.guardFailures.join("\n")}`,
          "error",
        );
        return;
      }
      if (state.durable === undefined || state.durableUnavailable !== undefined) {
        ctx.ui.notify(
          `Wayforge governed execution is unavailable (${state.durableUnavailable ?? "durable_authority_unavailable"}): ` +
            "durable task authority could not be initialized. No governed task was started.",
          "error",
        );
        return;
      }
      if (state.runtime !== undefined && !(await runtimeReplaceable(state, state.runtime))) {
        ctx.ui.notify(
          "A Wayforge workflow is already active; cancel it with the wayforge_cancel tool first.",
          "warning",
        );
        return;
      }
      const objective = trimmed;
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
      pi.sendUserMessage(governedStartMessage(objective));
    },
  });

  // U2.1 Default Governed Entry: total, fail-closed top-level turn router.
  // Eligibility is explicit (session mode + operator source provenance +
  // no active non-terminal runtime) — never prompt-content classification.
  pi.on("input", async (event, ctx) => {
    try {
      if (state.defaultGovernedMode !== true) return;
      if (event.source === "extension") return;
      const objective = event.text.trim();
      if (objective.length === 0) {
        if (event.images?.length) throw new Error("a textual governed objective is required");
        return;
      }
      // Leave command/skill/template syntax to Pi, including unknown RPC slash inputs.
      if (objective.startsWith("/")) return;
      if (state.runtime !== undefined && !(await runtimeReplaceable(state, state.runtime))) return;
      if (
        state.guardFailures !== undefined ||
        state.durable === undefined ||
        state.durableUnavailable !== undefined
      ) {
        ctx.ui.notify(
          "Default governed entry failed: Wayforge governed execution is unavailable " +
            `(${state.durableUnavailable ?? "durable_authority_unavailable"}); ` +
            "the prompt was not executed and nothing ran ungoverned. Resolve Wayforge " +
            "availability or turn default mode off with /wayforge off.",
          "error",
        );
        return { action: "handled" };
      }
      await startWorkflow(pi, ctx, state, objective, overrides);
      const message = governedStartMessage(objective);
      pi.sendUserMessage(
        event.images?.length
          ? [{ type: "text", text: message }, ...event.images]
          : message,
        { deliverAs: event.streamingBehavior ?? "followUp" },
      );
      return { action: "handled" };
    } catch {
      // Pi catches escaped input-handler exceptions and continues ordinary execution.
      // Reporting is best effort; neither notification nor stderr failure may escape.
      const message = "Default governed entry failed (governed_entry_failed). " +
        "The original prompt was consumed; inspect /wayforge status before continuing.";
      try {
        ctx.ui.notify(message, "error");
      } catch {
        try { process.stderr.write(`${message}\n`); } catch { /* consume even if reporting is unavailable */ }
      }
      return { action: "handled" };
    }
  });

  pi.on("session_start", (event, ctx) => {
    initializeDefaultGovernedMode(pi, state, ctx, event.reason);
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
      const durable = overrides.durableFactory !== undefined
        ? overrides.durableFactory()
        : createDurableExecution({
            cwd: ctx.cwd,
            ...(overrides.durable ?? {}),
          });
      state.durable = durable;
      state.projection = new LiveDurableProjection(durable.store, {
        ...(overrides.durable?.now !== undefined ? { now: overrides.durable.now } : {}),
      });
      delete state.durableUnavailable;
    } catch {
      state.durableUnavailable = "durable_authority_unavailable";
      ctx.ui.notify(
        "Wayforge governed execution is unavailable: durable task authority could not be initialized. " +
        "Governed /wayforge start is disabled for this session; historical durable inspection is unavailable.",
        "error",
      );
      return;
    }
  }
  if (state.startupScanStarted === true) return;
  state.startupScanStarted = true;
  const scanner = state.durable.scanner;
  void scanner
    .scan({
      // Never reconcile a task owned by THIS process's live runtime.
      isOwnedTask: (id) => state.runtime !== undefined && state.runtime.controller.taskId === id,
    })
    .then((scanned) => {
      if (!scanned.ok) {
        ctx.ui.notify(`Wayforge startup recovery failed: ${scanned.failure.code}`, "error");
        return;
      }
      if (scanned.value.reconciled > 0) {
        ctx.ui.notify(
          `Wayforge startup reconciliation marked ${scanned.value.reconciled} running task(s) from a previous execution as blocked (interrupted_execution).`,
          "info",
        );
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
