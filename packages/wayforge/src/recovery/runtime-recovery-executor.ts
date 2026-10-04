import type {
  RecoveryAction,
  RecoveryBudget,
  RecoveryCoordinator,
  RecoveryDecision,
  RouteHealth,
  RouteRef,
} from "./recovery-coordinator.js";
import type { HealthRegistry } from "./health-registry.js";
import type { HealthProjector } from "./health-projector.js";
import type { WorkflowEventLog } from "../workflow/events.js";
import type { ExecutionRoute } from "../workflow/contracts.js";
import type { InvocationId, TaskId } from "../types/identity.js";
import { invocationId as mkInvocationId } from "../types/identity.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure } from "../types/result.js";

export interface RecoveryCounters {
  readonly retries: number;
  readonly fallbacks: number;
  readonly rotations: number;
}

export interface RecoveryStepInput {
  readonly currentRoute: ExecutionRoute;
  readonly alternatives: readonly ExecutionRoute[];
  readonly budget: RecoveryBudget;
  readonly failure: Failure;
  readonly failedInvocationId: InvocationId;
}

export interface RecoveryNextAttempt {
  readonly route: ExecutionRoute;
  readonly invocationId: InvocationId;
  readonly parentInvocationId: InvocationId;
  readonly retryAfterMs?: number;
}

export interface RecoveryTerminal {
  readonly action: "stop" | "block" | "suspend";
  readonly reason: string;
  readonly resumeAtMs?: number;
}

export interface RecoveryStepResult {
  readonly decision: RecoveryDecision;
  readonly terminal?: RecoveryTerminal;
  readonly next?: RecoveryNextAttempt;
  readonly budgetAfter: RecoveryBudget;
  readonly counters: RecoveryCounters;
}

export interface RecoveryExecutorInit {
  readonly taskId: TaskId;
}

export interface RecoveryRunInput<T> {
  readonly initialRoute: ExecutionRoute;
  readonly alternatives: readonly ExecutionRoute[];
  readonly budget: RecoveryBudget;
  readonly initialInvocationId: InvocationId;
  readonly maxSteps: number;
  readonly attempt: (route: ExecutionRoute, invocationId: InvocationId) => Promise<ExecutionResult<T>>;
}

const RETRY_SUFFIX = /#r(\d+)$/;

function nextInvocationId(failed: InvocationId): InvocationId {
  const raw = String(failed);
  const match = RETRY_SUFFIX.exec(raw);
  if (match) {
    const count = Number.parseInt(match[1] ?? "1", 10) + 1;
    return mkInvocationId(raw.replace(RETRY_SUFFIX, `#r${count}`));
  }
  return mkInvocationId(`${raw}#r1`);
}

function toRouteRef(route: ExecutionRoute): RouteRef {
  return {
    routeId: route.routeId,
    provider: route.provider,
    modelId: route.modelId,
    ...(route.accountRef !== undefined ? { accountId: route.accountRef } : {}),
  };
}

function toRouteHealth(health: HealthRegistry, route: ExecutionRoute): RouteHealth {
  const record = health.getRoute(route.routeId);
  return {
    available: health.isAvailable(route.routeId),
    ...(record?.cooldownUntilMs !== undefined ? { cooldownUntilMs: record.cooldownUntilMs } : {}),
  };
}

const FALLBACK_ACTIONS: ReadonlySet<RecoveryAction> = new Set([
  "rotate_account",
  "fallback_model",
  "fallback_provider",
]);

/**
 * Executes recovery decisions; it never decides policy. All planning comes
 * from the injected Phase 1A `RecoveryCoordinator` and all cooldown state is
 * written through the injected `HealthProjector` into the single
 * `HealthRegistry`. Every step is bounded, observable, and creates a new
 * linked invocation for continuation attempts.
 */
export class RuntimeRecoveryExecutor {
  private counters: RecoveryCounters = { retries: 0, fallbacks: 0, rotations: 0 };

  constructor(
    private readonly coordinator: RecoveryCoordinator,
    private readonly projector: HealthProjector,
    private readonly health: HealthRegistry,
    private readonly events: WorkflowEventLog,
    private readonly init: RecoveryExecutorInit,
  ) {}

  plan(input: RecoveryStepInput): RecoveryStepResult {
    this.events.emit("failure_classified", {
      taskId: this.init.taskId,
      invocationId: input.failedInvocationId,
      detail: {
        kind: input.failure.kind,
        scope: input.failure.scope,
        confidence: input.failure.confidence,
        code: input.failure.code,
      },
    });
    this.projector.record(input.currentRoute, input.failure);

    const health: Record<string, RouteHealth> = {};
    for (const route of [input.currentRoute, ...input.alternatives]) {
      health[route.routeId] = toRouteHealth(this.health, route);
    }
    const decision = this.coordinator.plan({
      failure: input.failure,
      currentRoute: toRouteRef(input.currentRoute),
      alternatives: input.alternatives.map(toRouteRef),
      budget: input.budget,
      health,
    });
    this.events.emit("recovery_decided", {
      taskId: this.init.taskId,
      invocationId: input.failedInvocationId,
      detail: {
        action: decision.action,
        reason: decision.reason,
        ...(decision.route !== undefined ? { routeId: decision.route.routeId } : {}),
      },
    });

    if (decision.action === "stop" || decision.action === "block" || decision.action === "suspend") {
      const terminal: RecoveryTerminal = {
        action: decision.action,
        reason: decision.reason,
        ...(decision.resumeAtMs !== undefined ? { resumeAtMs: decision.resumeAtMs } : {}),
      };
      this.events.emit("recovery_applied", {
        taskId: this.init.taskId,
        invocationId: input.failedInvocationId,
        detail: { action: decision.action, terminal: true },
      });
      return {
        decision,
        terminal,
        budgetAfter: input.budget,
        counters: this.counters,
      };
    }

    let budgetAfter = input.budget;
    let counters = this.counters;
    if (decision.action === "retry_same_route") {
      budgetAfter = { ...input.budget, retriesLeft: Math.max(0, input.budget.retriesLeft - 1) };
      counters = { ...this.counters, retries: this.counters.retries + 1 };
    } else if (FALLBACK_ACTIONS.has(decision.action)) {
      budgetAfter = { ...input.budget, fallbacksLeft: Math.max(0, input.budget.fallbacksLeft - 1) };
      counters = {
        ...this.counters,
        fallbacks: this.counters.fallbacks + 1,
        rotations: decision.action === "rotate_account" ? this.counters.rotations + 1 : this.counters.rotations,
      };
    }
    this.counters = counters;
    this.events.emit("budget_changed", {
      taskId: this.init.taskId,
      invocationId: input.failedInvocationId,
      detail: budgetAfter,
    });

    const nextId = nextInvocationId(input.failedInvocationId);
    const target = this.resolveTarget(input, decision);
    const next: RecoveryNextAttempt = {
      route: target,
      invocationId: nextId,
      parentInvocationId: input.failedInvocationId,
      ...(decision.retryAfterMs !== undefined ? { retryAfterMs: decision.retryAfterMs } : {}),
    };
    this.events.emit("recovery_applied", {
      taskId: this.init.taskId,
      invocationId: nextId,
      parentInvocationId: input.failedInvocationId,
      detail: {
        action: decision.action,
        routeId: target.routeId,
        provider: target.provider,
        modelId: target.modelId,
      },
    });
    return { decision, next, budgetAfter, counters };
  }

  async run<T>(input: RecoveryRunInput<T>): Promise<ExecutionResult<T>> {
    let route = input.initialRoute;
    let currentId = input.initialInvocationId;
    let budget = input.budget;
    for (let step = 0; step < Math.max(1, input.maxSteps); step += 1) {
      const attempted = await input.attempt(route, currentId);
      if (attempted.ok) return attempted;
      const planned = this.plan({
        currentRoute: route,
        alternatives: input.alternatives.filter((candidate) => candidate.routeId !== route.routeId),
        budget,
        failure: attempted.failure,
        failedInvocationId: currentId,
      });
      if (planned.terminal !== undefined || planned.next === undefined) {
        return failure(this.terminalFailure(planned.terminal));
      }
      route = planned.next.route;
      currentId = planned.next.invocationId;
      budget = planned.budgetAfter;
    }
    return failure({
      kind: "capability",
      scope: "task",
      confidence: "certain",
      code: "recovery_blocked",
      message: "recovery step limit reached",
    });
  }

  private terminalFailure(terminal: RecoveryTerminal | undefined): Failure {
    if (terminal?.action === "stop") {
      return {
        kind: "cancellation",
        scope: "task",
        confidence: "certain",
        code: "recovery_stopped",
        message: terminal.reason,
      };
    }
    if (terminal?.action === "suspend") {
      return {
        kind: "usage_limit",
        scope: "task",
        confidence: "certain",
        code: "recovery_suspended",
        message: terminal.reason,
        ...(terminal.resumeAtMs !== undefined
          ? { metadata: { resumeAtMs: terminal.resumeAtMs }, resetAtMs: terminal.resumeAtMs }
          : {}),
      };
    }
    return {
      kind: "capability",
      scope: "task",
      confidence: "certain",
      code: "recovery_blocked",
      message: terminal?.reason ?? "recovery budget exhausted",
    };
  }

  private resolveTarget(input: RecoveryStepInput, decision: RecoveryDecision): ExecutionRoute {
    if (decision.route === undefined) return input.currentRoute;
    const target = [input.currentRoute, ...input.alternatives].find(
      (candidate) => candidate.routeId === decision.route?.routeId,
    );
    return target ?? input.currentRoute;
  }
}
