import type { PassiveAccountAdapter } from "../adapters/passive-account-adapter.js";
import type { CompletionAuthorityPort } from "../completion/completion-authority.js";
import type { WorkerExecutionInput } from "../adapters/pi-subagent-worker-adapter.js";
import type { AdvisorReviewInput, AdvisorReviewOutcome, PiAdvisorAdapter } from "../adapters/pi-advisor-adapter.js";
import type { MainModelController } from "../runtime/main-model-controller.js";
import type { InvocationContext } from "../kernel/invocation-context.js";
import type { ModelDecision } from "../policy/model-policy.js";
import type { RuntimeRecoveryExecutor, RecoveryStepResult } from "../recovery/runtime-recovery-executor.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure } from "../types/result.js";
import type { InvocationId, TaskId } from "../types/identity.js";
import { invocationId } from "../types/identity.js";
import type { ExecutionRoute, StructuredAdvisorVerdict, WorkerOutcome } from "./contracts.js";
import { buildAdvisorEvidence, type AdvisorEvidence } from "./advisor-evidence.js";
import { AdvisorTriggerPolicy } from "./advisor-trigger-policy.js";
import type { WorkflowEventLog } from "./events.js";
import {
  advisorDiagnosticRecordIsSafe,
  AUTHORITATIVE_COMPLETION_PURPOSE,
  buildAdvisorDiagnosticRecord,
  readAdvisorFailureDiagnostic,
} from "../trace/advisor-diagnostics.js";
import type { WorkflowTaskState } from "./workflow-state.js";

export interface WorkerDelegationPort {
  executeMany(inputs: readonly WorkerExecutionInput[]): Promise<readonly WorkerOutcome[]>;
}


/**
 * Authoritative durable sink for unresolved worker failures. Binding must
 * succeed before the delegation result is accepted: completion readiness
 * consumes durable unresolved items, so an ephemeral-only failure would
 * silently vanish from governed completion truth.
 */
export interface DurableUnresolvedPort {
  recordUnresolved(input: {
    readonly taskId: TaskId;
    readonly items: readonly string[];
  }): Promise<ExecutionResult<void>>;
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
  readonly durableUnresolved?: DurableUnresolvedPort;
  readonly completionAuthority?: CompletionAuthorityPort;
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
  private completionReviewClaimed = false;

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

    this.options.state.beginGovernedWork();
    const unresolvedSummaries: string[] = [];
    let outcomes: readonly WorkerOutcome[];
    try {
      outcomes = await workers.executeMany(inputs);
    } finally {
      this.options.state.endGovernedWork();
    }
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
      const summary =
        `worker ${outcome.invocationId} ended ${outcome.status}` +
          (outcome.failure !== undefined ? `: ${outcome.failure.code}` : "");
      this.options.state.addUnresolved(summary);
      unresolvedSummaries.push(summary);
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
    // Bind unresolved worker failures to authoritative durable state BEFORE
    // the delegation result is accepted: readiness consumes durable
    // unresolved items, so an unbound failure must fail closed here.
    if (unresolvedSummaries.length > 0) {
      const binding = this.options.durableUnresolved;
      if (binding !== undefined) {
        const bound = await binding.recordUnresolved({ taskId: this.taskId, items: unresolvedSummaries });
        if (!bound.ok) {
          return failure({
            kind: "capability",
            scope: "task",
            confidence: "certain",
            code: "unresolved_binding_failed",
            message:
              "worker failure could not be bound to authoritative durable state; the delegation result is not authoritative",
          });
        }
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
    if (this.options.completionAuthority !== undefined) {
      return Promise.resolve(failure({
        kind: "capability",
        scope: "task",
        confidence: "certain",
        code: "advisor_reserved_for_completion",
        message: "governed Advisor review is reserved for CompletionAuthority; use wayforge_complete when ready",
      }));
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
    const snapshot = this.options.state.snapshot();
    const evidence = buildAdvisorEvidence({
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
    });
    return this.reviewAdvisorEvidence(evidence, trigger.reason).then((reviewed) =>
      reviewed.ok ? { ok: true, value: { verdict: reviewed.value.verdict } } : reviewed,
    );
  }

  private reviewCompletionEvidence(evidence: AdvisorEvidence): Promise<ExecutionResult<AdvisorReviewOutcome>> {
    if (this.completionReviewClaimed) {
      return Promise.resolve(failure({
        kind: "capability", scope: "task", confidence: "certain",
        code: "completion_review_spent",
        message: "the single authoritative completion review opportunity has already been claimed",
      }));
    }
    // Synchronous claim before route lookup or provider awaits. Never reset.
    this.completionReviewClaimed = true;
    return this.reviewAdvisorEvidence(evidence, "before_done", this.options.mainContext.reserveCompletionBudget());
  }

  private async reviewAdvisorEvidence(
    evidence: AdvisorEvidence,
    reason: string,
    parent: InvocationContext = this.options.mainContext,
  ): Promise<ExecutionResult<AdvisorReviewOutcome>> {
    const advisors = this.options.advisors;
    if (advisors === undefined) {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "advisors_unavailable",
        message: "no advisor engine is configured",
      });
    }
    const routes = await this.options.routes.listExecutionRoutes({ taskId: this.taskId, role: "advisor" });
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
      detail: { reason, routeId: route.routeId, purpose: parent.traceMetadata.purpose ?? "advisory" },
    });
    const reviewInput: AdvisorReviewInput = {
      parent,
      invocationId: invocationId(`advisor-${++this.advisorSequence}`),
      budgetLimit: route.budgetLimit,
      evidence,
    };
    const reviewed = await advisors.review(reviewInput);
    this.emitAuthoritativeReviewDiagnostic(evidence, parent, reviewInput.invocationId, reviewed);
    if (!reviewed.ok) {
      if (reviewed.failure.kind !== "cancellation") this.failures.push(reviewed.failure);
      return reviewed;
    }
    if (parent.signal.aborted) return failure(cancellationFailure("workflow cancelled during advisor review"));
    this.options.log.emit("budget_changed", {
      taskId: this.taskId, invocationId: reviewed.value.invocationId,
      detail: { purpose: parent.traceMetadata.purpose ?? "advisory", usage: reviewed.value.usage, budgetLimit: route.budgetLimit },
    });
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
    return reviewed;
  }
  /**
   * Best-effort, non-authoritative diagnostic for the one dispatched
   * authoritative completion review: an independent side channel that
   * correlates the bound candidate and classifies the observed
   * request/response shape. It never participates in readiness, verdicts,
   * CAS, recovery, or any authority decision, never adds a task-state
   * revision, and can never throw into the authoritative path.
   */
  private emitAuthoritativeReviewDiagnostic(
    evidence: AdvisorEvidence,
    parent: InvocationContext,
    invocationId: InvocationId,
    reviewed: ExecutionResult<AdvisorReviewOutcome>,
  ): void {
    if (parent.traceMetadata.purpose !== AUTHORITATIVE_COMPLETION_PURPOSE) return;
    try {
      const extra = evidence.extra as Record<string, unknown>;
      const correlation = {
        invocationId,
        candidateDigest: extra.candidateDigest,
        candidateRevision: extra.taskRevision,
        workspaceDigest: evidence.workspaceDigest,
      };
      const record = reviewed.ok
        ? buildAdvisorDiagnosticRecord({
            ...correlation,
            reasoning: reviewed.value.decision.thinking,
            logicalBudget: reviewed.value.decision.budget.limit,
            sdkMaxTokens: reviewed.value.observed?.request?.sdkMaxTokens,
            preparedMaxTokens: reviewed.value.observed?.request?.preparedMaxTokens,
            preparedMaxTokensField: reviewed.value.observed?.request?.preparedMaxTokensField,
            stream: "resolved",
            stopReason: reviewed.value.observed?.stopReason,
            // SDK counters do not establish provider-reported usage.
            blocks: reviewed.value.observed?.blocks,
            text: reviewed.value.observed?.text,
            parseValid: true,
          })
        : buildAdvisorDiagnosticRecord({
            ...correlation,
            ...readAdvisorFailureDiagnostic(reviewed.failure),
            parseValid: false,
          });
      if (!advisorDiagnosticRecordIsSafe(record)) return;
      this.options.log.emit("advisor_review_diagnostic", {
        taskId: this.taskId,
        invocationId,
        parentInvocationId: parent.invocationId,
        detail: record,
      });
    } catch {
      // Diagnostics must never alter the authoritative review result.
    }
  }


  async recordValidation(result: {
    readonly name: string;
    readonly ok: boolean;
    readonly summary: string;
  }): Promise<ExecutionResult<void>> {
    const authority = this.options.completionAuthority;
    if (authority === undefined) {
      return failure({
        kind: "capability",
        scope: "task",
        confidence: "certain",
        code: "completion_authority_unavailable",
        message: "durable completion authority is unavailable",
      });
    }
    const persisted = await authority.recordValidation(result);
    if (!persisted.ok) return persisted;
    this.options.state.recordValidation(result);
    return { ok: true, value: undefined };
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

  async complete(): Promise<ExecutionResult<{ readonly summary: string }>> {
    // Synchronous cancellation guard: durable cancellation projection is
    // async/best-effort, so it can never be the only barrier to completion.
    if (this.options.mainContext.signal.aborted || this.options.state.snapshot().status === "cancelled") {
      return failure(cancellationFailure("a cancelled workflow cannot complete"));
    }
    const authority = this.options.completionAuthority;
    if (authority === undefined) {
      return failure({
        kind: "capability",
        scope: "task",
        confidence: "certain",
        code: "completion_authority_unavailable",
        message: "durable completion authority is unavailable",
      });
    }
    const completed = await authority.requestCompletion({
      pending: () => this.options.state.governedWorkSnapshot(),
      review: (evidence) => this.reviewCompletionEvidence(evidence),
    });
    if (!completed.ok) return completed;
    if (!completed.value.idempotent) {
      this.options.state.setStatus("completed");
      this.options.log.emit("completion_ready", {
        taskId: this.taskId,
        invocationId: this.options.mainContext.invocationId,
        detail: { authoritativeRevision: completed.value.committedRevision },
      });
    }
    return { ok: true, value: { summary: completed.value.summary } };
  }

  status() {
    return this.options.state.snapshot();
  }

  activeMainInvocationId(): InvocationId | undefined {
    return this.options.state.snapshot().activeMainInvocationId;
  }
}
