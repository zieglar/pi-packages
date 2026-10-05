import { PassiveAccountAdapter, type ModelAvailabilityPort } from "../adapters/passive-account-adapter.js";
import type { CompletionAuthorityPort } from "../completion/completion-authority.js";
import type { DelegationEventBus } from "../adapters/pi-subagent-worker-adapter.js";
import { PiSubagentWorkerAdapter } from "../adapters/pi-subagent-worker-adapter.js";
import { PiAdvisorAdapter } from "../adapters/pi-advisor-adapter.js";
import { CapabilityCatalog } from "../kernel/capability-catalog.js";
import { createInvocation } from "../kernel/invocation-context.js";
import type { MainModelController } from "../runtime/main-model-controller.js";
import { NestedInvoker } from "../runtime/nested-invoker.js";
import type { NestedModelRuntimePort } from "../runtime/ports.js";
import { ModelPolicy, type StaticModelRoute } from "../policy/model-policy.js";
import { RolePolicy, type RoleRule } from "../policy/role-policy.js";
import { HealthProjector } from "../recovery/health-projector.js";
import { HealthRegistry } from "../recovery/health-registry.js";
import { RecoveryCoordinator, type RecoveryBudget } from "../recovery/recovery-coordinator.js";
import { RuntimeRecoveryExecutor } from "../recovery/runtime-recovery-executor.js";
import { capabilityId, invocationId, type TaskId } from "../types/identity.js";
import type { ExecutionRoute } from "./contracts.js";
import { WorkflowEventLog, type WorkflowEvent } from "./events.js";
import { AdvisorTriggerPolicy } from "./advisor-trigger-policy.js";
import { WorkflowController } from "./workflow-controller.js";
import { WorkflowStateStore, type WorkflowTaskState } from "./workflow-state.js";

export interface WorkflowRuntimeTaskInit {
  readonly taskId: TaskId;
  readonly objective: string;
  readonly completionCriteria: string;
  readonly recoveryBudget?: RecoveryBudget;
}

export interface WorkflowRuntimeConfig {
  readonly cwd?: string;
  readonly requireAdvisorApproval?: boolean;
  readonly maxWorkers?: number;
  readonly mainBudgetLimit?: number;
  readonly now?: () => number;
}

export interface WorkflowRuntimeInput {
  readonly ownerRunId: string;
  readonly delegation: DelegationEventBus;
  readonly modelAvailability: ModelAvailabilityPort;
  readonly routes: readonly ExecutionRoute[];
  readonly observedMainRoute: ExecutionRoute;
  readonly task: WorkflowRuntimeTaskInit;
  readonly mainModel: MainModelController;
  readonly nestedRuntime?: NestedModelRuntimePort;
  readonly completionAuthority?: CompletionAuthorityPort;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly config?: WorkflowRuntimeConfig;
}

export interface WorkflowRuntime {
  readonly controller: WorkflowController;
  readonly health: HealthRegistry;
  readonly log: WorkflowEventLog;
  readonly state: WorkflowTaskState;
  readonly recovery: RuntimeRecoveryExecutor;
  readonly workerAdapter: PiSubagentWorkerAdapter;
  readonly advisorAdapter: PiAdvisorAdapter | undefined;
}

const DEFAULT_MAIN_BUDGET = 2_000;

/**
 * The one runtime composition root for an in-process Wayforge workflow. The
 * sole `RecoveryCoordinator` and sole `HealthRegistry` of a task are
 * constructed here and nowhere else; every component below receives them by
 * injection. Advisor runtime composition goes through `NestedInvoker` only
 * when a nested runtime port is supplied.
 */
export function createWorkflowRuntime(input: WorkflowRuntimeInput): WorkflowRuntime {
  const now = input.config?.now ?? (() => Date.now());
  const log = new WorkflowEventLog(now, input.onEvent);
  const state = new WorkflowStateStore(log).create({
    taskId: input.task.taskId,
    objective: input.task.objective,
    completionCriteria: input.task.completionCriteria,
    recoveryBudget: input.task.recoveryBudget ?? { retriesLeft: 1, fallbacksLeft: 2 },
  });

  const health = new HealthRegistry(now);
  const projector = new HealthProjector(health);
  const coordinator = new RecoveryCoordinator();
  const recovery = new RuntimeRecoveryExecutor(coordinator, projector, health, log, {
    taskId: input.task.taskId,
    ...(input.config?.now !== undefined ? { now: input.config.now } : {}),
  });
  const accountRoutes = new PassiveAccountAdapter(input.routes, input.modelAvailability, health, (route, outcome) =>
    projector.record(route, outcome),
  );

  const maxWorkers = input.config?.maxWorkers ?? 4;
  const workerAdapter = new PiSubagentWorkerAdapter(input.delegation, {
    ownerRunId: input.ownerRunId,
    maxConcurrency: Math.max(1, maxWorkers),
  });

  let advisorAdapter: PiAdvisorAdapter | undefined;
  if (input.nestedRuntime !== undefined) {
    const advisorRoute = input.routes.find((route) => route.capabilities.advisor);
    if (advisorRoute !== undefined) {
      const rules: readonly RoleRule[] = [
        {
          role: "advisor",
          capabilityId: capabilityId("cap-advisor"),
          allowNested: false,
          needsStreaming: true,
          needsReasoning: true,
          needsTools: false,
          budgetLimit: advisorRoute.budgetLimit,
        },
      ];
      const staticRoutes: readonly StaticModelRoute[] = [
        {
          routeId: advisorRoute.routeId,
          provider: advisorRoute.provider,
          modelId: advisorRoute.modelId,
          tier: advisorRoute.tier,
          thinking: advisorRoute.thinking,
          capabilityId: capabilityId("cap-advisor"),
          budgetLimit: advisorRoute.budgetLimit,
        },
      ];
      advisorAdapter = new PiAdvisorAdapter(
        new NestedInvoker(new RolePolicy(rules), new ModelPolicy(staticRoutes), CapabilityCatalog, input.nestedRuntime),
      );
    }
  }

  const mainContext = createInvocation({
    invocationId: invocationId(`${input.task.taskId}:main`),
    taskId: input.task.taskId,
    role: "main",
    maxDepth: 3,
    budgetLimit: input.config?.mainBudgetLimit ?? DEFAULT_MAIN_BUDGET,
  });

  const controller = new WorkflowController({
    state,
    routes: accountRoutes,
    workers: workerAdapter,
    ...(advisorAdapter !== undefined ? { advisors: advisorAdapter } : {}),
    ...(input.completionAuthority !== undefined ? { completionAuthority: input.completionAuthority } : {}),
    recovery,
    mainModel: input.mainModel,
    mainContext,
    observedMainRoute: input.observedMainRoute,
    log,
    trigger: new AdvisorTriggerPolicy(),
    config: {
      cwd: input.config?.cwd ?? process.cwd(),
      requireAdvisorApproval: input.config?.requireAdvisorApproval ?? false,
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    },
  });

  return {
    controller,
    health,
    log,
    state,
    recovery,
    workerAdapter,
    advisorAdapter,
  };
}
