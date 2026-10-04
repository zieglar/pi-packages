import type { Failure } from "../types/result.js";
import { scheduleSuspension, type DurableSuspension, type SuspensionPlanningContext } from "./suspension.js";

/** Reference to a configured route; account is optional. */
export interface RouteRef {
  readonly routeId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly accountId?: string;
}

/** Remaining recovery budget for one invocation. */
export interface RecoveryBudget {
  readonly retriesLeft: number;
  readonly fallbacksLeft: number;
}

/** Sanitized health snapshot keyed by route id. */
export interface RouteHealth {
  readonly available: boolean;
  readonly cooldownUntilMs?: number;
}

export type RecoveryAction =
  | "stop"
  | "block"
  | "retry_same_route"
  | "rotate_account"
  | "fallback_model"
  | "fallback_provider"
  | "suspend";

export interface RecoveryDecision {
  readonly action: RecoveryAction;
  readonly reason: string;
  /** Target route for rotate/fallback decisions. */
  readonly route?: RouteRef;
  readonly retryAfterMs?: number;
  readonly resumeAtMs?: number;
  readonly suspension?: DurableSuspension;
}

export interface RecoveryInput {
  readonly failure: Failure;
  readonly currentRoute: RouteRef;
  readonly alternatives: readonly RouteRef[];
  readonly budget: RecoveryBudget;
  readonly health: Readonly<Record<string, RouteHealth>>;
  readonly suspensionContext?: SuspensionPlanningContext;
}

function isHealthy(route: RouteRef, health: Readonly<Record<string, RouteHealth>>): boolean {
  const record = health[route.routeId];
  return record ? record.available : true;
}

/**
 * Pure, deterministic recovery planner. Precedence: cancellation stops;
 * exhausted budget blocks; temporary current-route failures retry within
 * bounds; account failures rotate; model failures fall back by model;
 * provider failures fall back by provider; reset-bearing limits suspend;
 * otherwise block. Returns decisions only — it never performs transitions,
 * and infrastructure failures never produce advisor semantics.
 */
export class RecoveryCoordinator {
  plan(input: RecoveryInput): RecoveryDecision {
    const { failure, currentRoute, alternatives, budget, health } = input;

    // 1. Cancellation always stops.
    if (failure.kind === "cancellation") {
      return { action: "stop", reason: "cancellation stops recovery" };
    }

    // 3. Exact temporary current-route failures may retry within bounds.
    const temporary =
      (failure.kind === "rate_limit" || failure.kind === "network" || failure.kind === "provider") &&
      failure.retryAfterMs !== undefined;
    if (temporary && budget.retriesLeft > 0) {
      return {
        action: "retry_same_route",
        reason: `temporary ${failure.kind} failure on current route`,
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      };
    }

    const candidate = (match: (route: RouteRef) => boolean): RouteRef | undefined =>
      alternatives.find((alt) => match(alt) && isHealthy(alt, health));

    if (budget.fallbacksLeft > 0) {
      // 4. Scoped account failures may rotate account.
      if (failure.scope === "account" || failure.kind === "authentication" || failure.kind === "usage_limit") {
        const rotate = candidate((alt) => alt.accountId !== undefined && alt.accountId !== currentRoute.accountId);
        if (rotate) {
          return { action: "rotate_account", reason: "account-scoped failure", route: rotate };
        }
      }

      // 5. Model-scoped failures may fallback model (same provider, different model).
      if (failure.scope === "model" || failure.kind === "context_overflow" || failure.kind === "reasoning") {
        const model = candidate((alt) => alt.provider === currentRoute.provider && alt.modelId !== currentRoute.modelId);
        if (model) {
          return { action: "fallback_model", reason: "model-scoped failure", route: model };
        }
      }

      // 6. Provider-scoped failures may fallback provider.
      if (failure.scope === "provider") {
        const provider = candidate((alt) => alt.provider !== currentRoute.provider);
        if (provider) {
          return { action: "fallback_provider", reason: "provider-scoped failure", route: provider };
        }
      }
    }


    // 7. Only this coordinator may author a durable suspension after no
    // healthy bounded retry/fallback route remains.
    if (input.suspensionContext !== undefined) {
      const suspension = scheduleSuspension(failure, input.suspensionContext);
      if (suspension !== null) {
        return {
          action: "suspend",
          reason: suspension.reason,
          resumeAtMs: suspension.resumeNotBeforeMs,
          suspension,
        };
      }
    }
    // 8. Legacy reset-bearing callers without scheduling context still suspend.
    if (failure.resetAtMs !== undefined) {
      return {
        action: "suspend",
        reason: "reset-bearing limit reached",
        resumeAtMs: failure.resetAtMs,
      };
    }

    // 9. Otherwise block, distinguishing exhausted budget for diagnostics.
    return budget.retriesLeft <= 0 && budget.fallbacksLeft <= 0
      ? { action: "block", reason: "recovery budget exhausted" }
      : { action: "block", reason: "no recovery rule matched" };
  }
}
