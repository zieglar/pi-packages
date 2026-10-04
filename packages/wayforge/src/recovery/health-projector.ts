import type { HealthRegistry } from "./health-registry.js";
import type { Failure } from "../types/result.js";
import type { ExecutionRoute } from "../workflow/contracts.js";

export interface HealthProjectionOptions {
  readonly maxAmbiguousRouteCooldownMs?: number;
}

export class HealthProjector {
  private readonly maxAmbiguousRouteCooldownMs: number;

  constructor(private readonly health: HealthRegistry, options: HealthProjectionOptions = {}) {
    this.maxAmbiguousRouteCooldownMs = options.maxAmbiguousRouteCooldownMs ?? 30_000;
  }

  record(route: ExecutionRoute, outcome: Failure | { readonly ok: true }): void {
    if ("ok" in outcome) {
      this.health.recordRoute(route.routeId, { status: "available" });
      return;
    }
    if (outcome.kind === "cancellation" || outcome.kind === "context_overflow") return;

    if (outcome.kind === "rate_limit" && outcome.confidence === "ambiguous") {
      const requested = outcome.retryAfterMs ?? this.maxAmbiguousRouteCooldownMs;
      const cooldownMs = Math.max(1, Math.min(requested, this.maxAmbiguousRouteCooldownMs));
      this.health.recordRoute(route.routeId, {
        status: "cooldown",
        cooldownMs,
        metadata: { code: outcome.code, confidence: outcome.confidence },
      });
      return;
    }

    if (outcome.confidence !== "certain") return;
    if ((outcome.kind === "authentication" || outcome.kind === "usage_limit") && route.accountRef !== undefined) {
      if (outcome.resetAtMs !== undefined) {
        this.health.recordAccount(route.accountRef, {
          status: "cooldown",
          cooldownMs: Math.max(1, outcome.resetAtMs - Date.now()),
          metadata: { code: outcome.code, kind: outcome.kind },
        });
      } else {
        this.health.recordAccount(route.accountRef, {
          status: "unavailable",
          metadata: { code: outcome.code, kind: outcome.kind },
        });
      }
      return;
    }

    if (outcome.scope === "provider" && outcome.retryAfterMs !== undefined) {
      this.health.recordProvider(route.provider, {
        status: "cooldown",
        cooldownMs: outcome.retryAfterMs,
        metadata: { code: outcome.code, kind: outcome.kind },
      });
    }
  }
}
