import type { PassiveAccountAdapter } from "../adapters/passive-account-adapter.js";
import type { WorkerExecutionInput } from "../adapters/pi-subagent-worker-adapter.js";
import type { AdvisorReviewInput, AdvisorReviewOutcome, PiAdvisorAdapter } from "../adapters/pi-advisor-adapter.js";
import type { MainModelController } from "../runtime/main-model-controller.js";
import type { InvocationContext } from "../kernel/invocation-context.js";
import type { ModelDecision } from "../policy/model-policy.js";
import type { RuntimeRecoveryExecutor, RecoveryStepResult } from "../recovery/runtime-recovery-executor.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure } from "../types/result.js";
import type { InvocationId } from "../types/identity.js";
import { invocationId } from "../types/identity.js";
import type { ExecutionRoute, StructuredAdvisorVerdict, WorkerOutcome } from "./contracts.js";
import { buildAdvisorEvidence } from "./advisor-evidence.js";
import { AdvisorTriggerPolicy } from "./advisor-trigger-policy.js";
import type { WorkflowEventLog } from "./events.js";
import type { WorkflowTaskState } from "./workflow-state.js";

export interface WorkerDelegationPort {
  executeMany(inputs: readonly WorkerExecutionInput[]): Promise<readonly WorkerOutcome[]>;
}

export interface AdvisorReviewPort {
  review(input: AdvisorReviewInput): Promise<ExecutionResult<AdvisorReviewOutcome>>;
}

export interface WorkflowControllerConfig {
  readonly cwd: string;
  readonly requireAdvisorApproval: boolean;
  readonly maxWorkers?: number;
  readonly workerTimeoutMs?: number;
  readonly workerToolBudgetHard?: number;
  readonly workspaceDigest?: string;
}

export interface WorkflowControllerOptions {
  readonly state: WorkflowTaskState;
  readonly routes: PassiveAccountAdapter;
  readonly workers?: WorkerDelegationPort;
  readonly advisors?: AdvisorReviewPort;
  readonly recovery: RuntimeRecoveryExecutor;
  readonly mainModel: MainModelController;
  readonly mainContext: InvocationContext;
  readonly observedMainRoute: ExecutionRoute;
  readonly log: WorkflowEventLog;
  readonly trigger?: AdvisorTriggerPolicy;
  readonly config: WorkflowControllerConfig;
}

export interface DelegationReport {
  readonly outcomes: readonly WorkerOutcome[];
  readonly recovery?: RecoveryStepResult;
}

const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_WORKER_TIMEOUT_MS = 600_000;
const DEFAULT_WORKER_TOOL_BUDGET = 80;

function cancellationFailure(message: string): Failure {
  return {
    kind: "cancellation",
    scope: "task",
    confidence: "certain",
    code: "workflow_cancelled",
    message,
  };
}

/**
 * Sequencing-only workflow controller. Route selection comes from the
 * passive account adapter, recovery decisions from the injected
 * `RuntimeRecoveryExecutor` (which delegates to the sole coordinator), and
 * parent model changes flow only through the injected `MainModelController`.
 * It never retries on its own and never mutates the parent session.
 */
export class WorkflowController {
  private readonly failures: Failure[] = [];
  private readonly workerFindings: string[] = [];
  private workerSequence = 0;
  private advisorSequence = 0;

  constructor(private readonly options: WorkflowControllerOptions) {}

  get taskId() {
    return this.options.state.snapshot().taskId;
  }

  beginMainTurn(): ExecutionResult<void> {
    return this.options.state.startMain(
      this.options.mainContext.invocationId,
      this.options.observedMainRoute.routeId,
    );
  }

  endMainTurn(): ExecutionResult<void> {
    const active = this.options.state.snapshot().activeMainInvocationId;
    if (active === undefined) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "main_not_active",
        message: "no Main invocation is active",
      });
    }
    return this.options.state.endMain(active);
  }

  async delegateWorkers(input: { readonly prompts: readonly string[] }): Promise<ExecutionResult<DelegationReport>> {
    if (this.options.mainContext.signal.aborted) {
      return failure(cancellationFailure("workflow cancelled before worker delegation"));
    }
    const workers = this.options.workers;
    if (workers === undefined) {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "workers_unavailable",
        message: "no worker delegation engine is configured",
      });
    }
    const routes = await this.options.routes.listExecutionRoutes({
      taskId: this.taskId,
      role: "worker",
    });
    if (!routes.ok) return routes;
    const route = routes.value[0];
    if (route === undefined) {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "no_worker_route",
        message: "no eligible worker route is currently available",
      });
    }
    const limit = this.options.config.maxWorkers ?? DEFAULT_MAX_WORKERS;
    if (input.prompts.length > limit) {
      return failure({
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "worker_limit_exceeded",
        message: `at most ${limit} workers may be delegated at once`,
      });
    }
    const timeoutMs = this.options.config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
    const toolBudgetHard = this.options.config.workerToolBudgetHard ?? DEFAULT_WORKER_TOOL_BUDGET;
    const inputs = input.prompts.map<WorkerExecutionInput>((prompt) => ({
      parent: this.options.mainContext,
      invocationId: invocationId(`worker-${++this.workerSequence}`),
      route,
      prompt,
      cwd: this.options.config.cwd,
      timeoutMs,
      toolBudgetHard,
      context: "fresh",
      result: { kind: "text" },
    }));
    this.options.log.emit("worker_launched", {
      taskId: this.taskId,
      invocationId: this.options.mainContext.invocationId,
      detail: { count: inputs.length, routeId: route.routeId, provider: route.provider, modelId: route.modelId },
    });

    const outcomes = await workers.executeMany(inputs);
    let recovery: RecoveryStepResult | undefined;
    for (const outcome of outcomes) {
      this.options.state.recordChild({
        invocationId: outcome.invocationId,
        parentInvocationId: outcome.parentInvocationId,
        role: "worker",
        routeId: outcome.selectedRoute.routeId,
        status: outcome.status,
      });
      if (outcome.status === "completed") {
        if (outcome.text !== undefined) this.workerFindings.push(outcome.text.slice(0, 1_000));
        continue;
      }
      if (outcome.failure !== undefined) this.failures.push(outcome.failure);
      this.options.state.addUnresolved(
        `worker ${outcome.invocationId} ended ${outcome.status}` +
          (outcome.failure !== undefined ? `: ${outcome.failure.code}` : ""),
      );
      if (recovery === undefined && outcome.failure !== undefined) {
        const snapshot = this.options.state.snapshot();
        recovery = this.options.recovery.plan({
          currentRoute: outcome.selectedRoute,
          alternatives: routes.value.filter((candidate) => candidate.routeId !== outcome.selectedRoute.routeId),
          budget: snapshot.recoveryBudget,
          failure: outcome.failure,
          failedInvocationId: outcome.invocationId,
        });
        this.options.state.setRecoveryBudget(recovery.budgetAfter);
      }
    }
    this.options.log.emit("worker_finished", {
      taskId: this.taskId,
      detail: { count: outcomes.length, failed: outcomes.filter((outcome) => outcome.status !== "completed").length },
    });
    return { ok: true, value: { outcomes, ...(recovery !== undefined ? { recovery } : {}) } };
  }

  advise(input: { readonly manual?: boolean; readonly beforeDone?: boolean }): Promise<ExecutionResult<{ verdict: StructuredAdvisorVerdict }>> {
    if (this.options.mainContext.signal.aborted) {
      return Promise.resolve(failure(cancellationFailure("workflow cancelled before advisor review")));
    }
    const advisors = this.options.advisors;
    if (advisors === undefined) {
      return Promise.resolve(failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "advisors_unavailable",
        message: "no advisor engine is configured",
      }));
    }
    const trigger = (this.options.trigger ?? new AdvisorTriggerPolicy()).evaluate({
      manual: input.manual === true,
      beforeDone: input.beforeDone === true,
      failures: this.failures,
    });
    if (!trigger.trigger) {
      return Promise.resolve(failure({
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "advisor_not_triggered",
        message: "no advisor trigger condition is met",
      }));
    }
    return this.options.routes.listExecutionRoutes({ taskId: this.taskId, role: "advisor" }).then((routes) => {
      if (!routes.ok) return routes;
      const route = routes.value[0];
      if (route === undefined) {
        return failure({
          kind: "capability",
          scope: "invocation",
          confidence: "certain",
          code: "no_advisor_route",
          message: "no eligible advisor route is currently available",
        });
      }
      this.options.log.emit("advisor_triggered", {
        taskId: this.taskId,
        detail: { reason: trigger.reason, routeId: route.routeId },
      });
      const snapshot = this.options.state.snapshot();
      const invocation = invocationId(`advisor-${++this.advisorSequence}`);
      const reviewInput: AdvisorReviewInput = {
        parent: this.options.mainContext,
        invocationId: invocation,
        budgetLimit: route.budgetLimit,
        evidence: buildAdvisorEvidence({
          objective: snapshot.objective,
          completionCriteria: snapshot.completionCriteria,
          implementationSummary: snapshot.unresolved.length === 0
            ? "all recorded validations and worker outcomes are reflected in state"
            : snapshot.unresolved.join("; ").slice(0, 4_000),
          changedPaths: snapshot.children.map((child) => child.routeId),
          diffSummary: "in-process Alpha 0 workflow; no repository diff is tracked by the controller",
          validations: [...snapshot.validations],
          workerFindings: this.workerFindings,
          unresolved: [...snapshot.unresolved],
          workspaceDigest: this.options.config.workspaceDigest ?? "unavailable",
        }),
      };
      return advisors.review(reviewInput).then((reviewed) => {
        if (!reviewed.ok) {
          if (reviewed.failure.kind !== "cancellation") this.failures.push(reviewed.failure);
          return reviewed;
        }
        this.options.state.recordChild({
          invocationId: reviewed.value.invocationId,
          parentInvocationId: reviewed.value.parentInvocationId,
          role: "advisor",
          routeId: reviewed.value.decision.routeId,
          status: reviewed.value.verdict.status,
        });
        this.options.state.recordAdvisorVerdict(reviewed.value.verdict);
        for (const finding of reviewed.value.verdict.findings) {
          if (finding.severity === "blocker") this.options.state.addUnresolved(`${finding.code}: ${finding.summary}`);
        }
        return { ok: true, value: { verdict: reviewed.value.verdict } };
      });
    });
  }

  recordValidation(result: { readonly name: string; readonly ok: boolean; readonly summary: string }): void {
    this.options.state.recordValidation(result);
  }

  async applyMainModelDecision(decision: ModelDecision): Promise<ExecutionResult<{ provider: string; modelId: string }>> {
    return this.options.mainModel.applyModelDecision({ role: "main", decision });
  }

  cancel(): void {
    this.options.mainContext.requestCancellation();
    this.options.state.setStatus("cancelled");
    this.options.log.emit("cancellation", {
      taskId: this.taskId,
      invocationId: this.options.mainContext.invocationId,
      detail: { reason: "operator or controller cancellation" },
    });
  }

  complete(): ExecutionResult<{ readonly summary: string }> {
    const snapshot = this.options.state.snapshot();
    const latest = new Map(snapshot.validations.map((result) => [result.name, result]));
    if (latest.size === 0 || [...latest.values()].some((result) => !result.ok)) {
      return failure({
        kind: "validation",
        scope: "task",
        confidence: "certain",
        code: "completion_gate_failed",
        message: "completion requires at least one passing validation and no failed validation",
      });
    }
    if (this.options.config.requireAdvisorApproval) {
      const latest = snapshot.advisorVerdicts.at(-1);
      if (latest === undefined || latest.status !== "approve") {
        return failure({
          kind: "validation",
          scope: "task",
          confidence: "certain",
          code: "completion_gate_failed",
          message: "completion requires an approving advisor verdict",
        });
      }
    }
    if (snapshot.status === "cancelled") {
      return failure(cancellationFailure("a cancelled workflow cannot complete"));
    }
    this.options.state.setStatus("completed");
    this.options.log.emit("completion_ready", {
      taskId: this.taskId,
      invocationId: this.options.mainContext.invocationId,
      detail: { validations: snapshot.validations.length },
    });
    return {
      ok: true,
      value: { summary: `completed with ${snapshot.validations.length} passing validation(s)` },
    };
  }

  status() {
    return this.options.state.snapshot();
  }

  activeMainInvocationId(): InvocationId | undefined {
    return this.options.state.snapshot().activeMainInvocationId;
  }
}
