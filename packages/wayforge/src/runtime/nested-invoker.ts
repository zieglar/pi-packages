import type { InvocationContext } from "../kernel/invocation-context.js";
import type { CapabilityCatalog } from "../kernel/capability-catalog.js";
import type { ModelDecision, ModelPolicy } from "../policy/model-policy.js";
import type { RolePolicy } from "../policy/role-policy.js";
import type { TraceEvent } from "../trace/trace.js";
import { createTraceEvent } from "../trace/trace.js";
import type { InvocationRole, PersistSafeValue } from "../types/execution.js";
import type { InvocationId } from "../types/identity.js";
import type { ExecutionResult, Failure } from "../types/result.js";
import { failure } from "../types/result.js";
import type { NestedModelOutput, NestedModelRuntimePort } from "./ports.js";

export interface NestedInvokeInput {
  readonly parent: InvocationContext;
  readonly invocationId: InvocationId;
  /** Nested roles only: worker or advisor. */
  readonly role: InvocationRole;
  readonly prompt: string;
  readonly budgetLimit?: number;
  readonly metadata?: Readonly<Record<string, PersistSafeValue>>;
}

export interface NestedInvokeSuccess {
  readonly child: InvocationContext;
  readonly decision: ModelDecision;
  readonly output: NestedModelOutput;
  readonly trace: readonly TraceEvent[];
}

/**
 * Performs one nested invocation attempt: derives the child context, resolves
 * role and model policy, and calls the runtime port exactly once. It never
 * retries, never mutates the parent session, and emits sanitized trace events.
 */
export class NestedInvoker {
  constructor(
    private readonly rolePolicy: RolePolicy,
    private readonly modelPolicy: ModelPolicy,
    private readonly catalog: typeof CapabilityCatalog,
    private readonly runtime: NestedModelRuntimePort,
  ) {}

  async invoke(input: NestedInvokeInput): Promise<ExecutionResult<NestedInvokeSuccess>> {
    const trace: TraceEvent[] = [];
    if (input.role === "main") {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "main_role_not_nested",
        message: "the main role runs in the parent session; nested invocation requires worker or advisor",
      });
    }
    const derived = input.parent.deriveChild({
      invocationId: input.invocationId,
      role: input.role,
      ...(input.budgetLimit !== undefined ? { budgetLimit: input.budgetLimit } : {}),
      ...(input.metadata !== undefined ? { traceMetadata: input.metadata } : {}),
    });
    if (!derived.ok) {
      return failure(NestedInvoker.derivationFailure(derived.failure));
    }
    const child = derived.context;
    if (input.parent.signal.aborted) {
      return failure({
        kind: "cancellation",
        scope: "invocation",
        confidence: "certain",
        code: "parent_cancelled",
        message: "parent invocation cancelled before nested runtime call",
      });
    }

    const requirement = this.rolePolicy.resolve({ role: input.role, taskId: child.taskId });
    if (!requirement.ok) {
      return failure({
        kind: "validation",
        scope: "invocation",
        confidence: "certain",
        code: "unknown_role",
        message: `no role rule for "${input.role}"`,
      });
    }
    trace.push(
      createTraceEvent("policy_decision", {
        invocationId: child.invocationId,
        taskId: child.taskId,
        detail: { role: input.role, capabilityId: requirement.requirement.capabilityId },
      }),
    );

    const resolved = this.modelPolicy.resolve(requirement.requirement, this.catalog);
    if (!resolved.ok) {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: resolved.failure.kind,
        message: `model policy rejected the requirement: ${resolved.failure.kind}`,
      });
    }
    const routeDecision = resolved.decision;
    const effectiveBudgetLimit = Math.min(
      routeDecision.budget.limit,
      requirement.requirement.budgetLimit,
      child.budget.remaining,
    );
    const decision: ModelDecision = {
      ...routeDecision,
      budget: { limit: effectiveBudgetLimit },
    };
    if (effectiveBudgetLimit <= 0) {
      return failure({
        kind: "capability",
        scope: "invocation",
        confidence: "certain",
        code: "budget_exhausted",
        message: "nested invocation budget is exhausted",
      });
    }
    trace.push(
      createTraceEvent("route_selection", {
        invocationId: child.invocationId,
        taskId: child.taskId,
        detail: { routeId: decision.routeId, provider: decision.provider, modelId: decision.modelId, tier: decision.tier },
      }),
    );
    trace.push(
      createTraceEvent("nesting", {
        invocationId: child.invocationId,
        taskId: child.taskId,
        detail: {
          parentInvocationId: child.parentInvocationId,
          depth: child.depth,
          ...(input.metadata ?? {}),
        },
      }),
    );
    trace.push(
      createTraceEvent("invocation", {
        invocationId: child.invocationId,
        taskId: child.taskId,
        detail: { role: input.role, provider: decision.provider, modelId: decision.modelId },
      }),
    );

    // Single attempt; no retry loop exists here by design.
    const streamed = await this.runtime.stream({
      provider: decision.provider,
      modelId: decision.modelId,
      thinking: decision.thinking,
      prompt: input.prompt,
      signal: child.signal,
      budgetLimit: decision.budget.limit,
    });
    if (!streamed.ok) {
      return failure(streamed.failure);
    }
    child.spend(streamed.value.usage.inputTokens + streamed.value.usage.outputTokens);
    return { ok: true, value: { child, decision, output: streamed.value, trace } };
  }

  private static derivationFailure(cause: { kind: string }): Failure {
    return {
      kind: "capability",
      scope: "invocation",
      confidence: "certain",
      code: cause.kind,
      message: `child derivation failed closed: ${cause.kind}`,
    };
  }
}
