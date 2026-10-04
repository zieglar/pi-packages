import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  type SubagentDelegationCancel,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationResultRequest,
  type SubagentDelegationStatus,
} from "pi-subagents/delegation";
import type { InvocationContext } from "../kernel/invocation-context.js";
import { ConcurrencyLimiter } from "../runtime/concurrency-limiter.js";
import type { InvocationId } from "../types/identity.js";
import { normalizeError } from "../types/result.js";
import type { Failure } from "../types/result.js";
import type { ExecutionRoute, WorkerOutcome, WorkerStatus } from "../workflow/contracts.js";

export interface DelegationEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

// pi-subagents records the effective child model as `<provider>/<modelId>` plus an
// optional `:<thinking-level>` suffix (applyThinkingSuffix in its child-tool-plan).
// The thinking level is an execution parameter of the SAME base route, not a
// different model, so route identity is compared on the base model only. Any
// other difference — including a missing model — still fails closed.
const WORKER_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function baseWorkerModel(model: string): string {
  const idx = model.lastIndexOf(":");
  return idx !== -1 && WORKER_THINKING_LEVELS.has(model.slice(idx + 1)) ? model.slice(0, idx) : model;
}

export interface WorkerExecutionInput {
  readonly parent: InvocationContext;
  readonly invocationId: InvocationId;
  readonly route: ExecutionRoute;
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly toolBudgetHard: number;
  readonly context: "fresh" | "fork";
  readonly result: SubagentDelegationResultRequest;
  readonly signal?: AbortSignal;
}

export interface PiSubagentWorkerOptions {
  readonly ownerRunId: string;
  readonly maxConcurrency: number;
  readonly agent?: string;
}

function statusFailure(
  status: Exclude<SubagentDelegationStatus, "completed" | "invalid_request">,
  error?: string,
 ): Failure {
  if (status === "cancelled" || status === "interrupted") {
    return {
      kind: "cancellation",
      scope: "invocation",
      confidence: "certain",
      code: `worker_${status}`,
      message: `worker ${status}`,
    };
  }
  if (status === "timed_out") {
    return {
      kind: "network",
      scope: "invocation",
      confidence: "ambiguous",
      code: "worker_timed_out",
      message: "worker timed out",
    };
  }
  const normalized = normalizeError(new Error(error ?? `worker ended with status ${status}`));
  return { ...normalized, code: `worker_${status}` };
}

function failedOutcome(input: WorkerExecutionInput, failure: Failure, status: WorkerStatus = "failed"): WorkerOutcome {
  return {
    taskId: input.parent.taskId,
    invocationId: input.invocationId,
    parentInvocationId: input.parent.invocationId,
    selectedRoute: input.route,
    status,
    failure,
    remainingBudget: Math.min(input.route.budgetLimit, input.parent.budget.remaining),
  };
}

export class PiSubagentWorkerAdapter {
  private sequence = 0;
  private readonly limiter: ConcurrencyLimiter;
  private readonly agent: string;

  constructor(private readonly events: DelegationEventBus, private readonly options: PiSubagentWorkerOptions) {
    this.limiter = new ConcurrencyLimiter(options.maxConcurrency);
    this.agent = options.agent ?? "worker";
  }

  execute(input: WorkerExecutionInput): Promise<WorkerOutcome> {
    return this.limiter.run(() => this.launch(input));
  }

  executeMany(inputs: readonly WorkerExecutionInput[]): Promise<readonly WorkerOutcome[]> {
    return Promise.all(inputs.map((input) => this.execute(input)));
  }

  private launch(input: WorkerExecutionInput): Promise<WorkerOutcome> {
    const derived = input.parent.deriveChild({
      invocationId: input.invocationId,
      role: "worker",
      budgetLimit: Math.min(input.route.budgetLimit, input.parent.budget.remaining),
      traceMetadata: { routeId: input.route.routeId },
    });
    if (!derived.ok) {
      return Promise.resolve(failedOutcome(input, {
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: derived.failure.kind,
        message: `worker child derivation failed: ${derived.failure.kind}`,
      }));
    }

    const child = derived.context;
    const requestId = `${this.options.ownerRunId}:${input.invocationId}:${++this.sequence}`;
    const correlation = {
      requestId,
      ownerRunId: this.options.ownerRunId,
      nodeId: String(input.invocationId),
    } as const;
    const request: SubagentDelegationRequest = {
      ...correlation,
      agent: this.agent,
      task: input.prompt,
      context: input.context,
      cwd: input.cwd,
      model: `${input.route.provider}/${input.route.modelId}`,
      thinking: input.route.thinking,
      timeoutMs: input.timeoutMs,
      toolBudget: { hard: input.toolBudgetHard },
      artifacts: true,
      result: input.result,
    };

    return new Promise<WorkerOutcome>((resolve) => {
      let settled = false;
      let cancelSent = false;
      let timer: NodeJS.Timeout | undefined;
      const expectedModel = `${input.route.provider}/${input.route.modelId}`;
      const removeResponse = this.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
        const response = raw as Partial<SubagentDelegationResponse>;
        if (response.requestId !== requestId) return;
        if (response.ownerRunId !== undefined && response.ownerRunId !== correlation.ownerRunId) return;
        if (response.nodeId !== undefined && response.nodeId !== correlation.nodeId) return;
        settle(this.fromResponse(input, response as SubagentDelegationResponse, expectedModel));
      });

      const sendCancel = (): void => {
        if (cancelSent || settled) return;
        cancelSent = true;
        this.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, correlation satisfies SubagentDelegationCancel);
      };
      const onAbort = (): void => {
        sendCancel();
        settle(failedOutcome(input, statusFailure("cancelled"), "cancelled"));
      };
      child.signal.addEventListener("abort", onAbort, { once: true });
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        removeResponse();
        child.signal.removeEventListener("abort", onAbort);
        input.signal?.removeEventListener("abort", onAbort);
      };
      const settle = (outcome: WorkerOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      if (child.signal.aborted || input.signal?.aborted === true) {
        sendCancel();
      }
      timer = setTimeout(() => {
        sendCancel();
        settle(failedOutcome(input, statusFailure("timed_out"), "timed_out"));
      }, input.timeoutMs);
      this.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
    });
  }

  private fromResponse(
    input: WorkerExecutionInput,
    response: SubagentDelegationResponse,
    expectedModel: string,
  ): WorkerOutcome {
    if (response.status === "invalid_request") {
      return failedOutcome(input, {
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "worker_invalid_request",
        message: normalizeError(new Error(response.error ?? "worker request was invalid")).message,
      });
    }
    if (response.status === "completed") {
      const observed = response.model;
      if (observed === undefined || baseWorkerModel(observed) !== expectedModel) {
        return failedOutcome(input, {
          kind: "capability",
          scope: "model",
          confidence: "certain",
          code: "worker_model_mismatch",
          message: `worker terminal model did not match the selected route (expected ${expectedModel}, observed ${observed ?? "none"})`,
        });
      }
    }

    const used = (response.usage?.input ?? 0) + (response.usage?.output ?? 0);
    const budget = Math.min(input.route.budgetLimit, input.parent.budget.remaining);
    if (used > budget) {
      return failedOutcome(input, {
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "worker_token_budget_exceeded",
        message: "worker reported usage beyond its resolved token budget",
      });
    }
    if (response.status !== "completed") {
      const outcomeStatus: WorkerStatus =
        response.status === "unavailable_context" || response.status === "duplicate_node"
          ? "failed"
          : response.status;
      return failedOutcome(
        input,
        statusFailure(response.status, response.error),
        outcomeStatus,
      );
    }

    input.parent.spend(used);
    return {
      taskId: input.parent.taskId,
      invocationId: input.invocationId,
      parentInvocationId: input.parent.invocationId,
      selectedRoute: input.route,
      observedModel: response.model ?? expectedModel,
      status: "completed",
      ...(response.result?.kind === "text" ? { text: response.result.text } : {}),
      ...(response.result?.kind === "structured" ? { structured: response.result.value } : {}),
      ...(response.usage !== undefined
        ? {
            usage: {
              inputTokens: response.usage.input,
              outputTokens: response.usage.output,
              toolCalls: response.usage.toolCalls,
              durationMs: response.usage.durationMs,
            },
          }
        : {}),
      remainingBudget: Math.max(0, budget - used),
    };
  }
}
