import type { HealthRegistry } from "./health-registry.js";
import type { Failure } from "../types/result.js";
import type { TransportFailureClassification } from "./transport-failure-classifier.js";
import type { ExecutionRoute } from "../workflow/contracts.js";

export interface HealthProjectionOptions {
  readonly maxAmbiguousRouteCooldownMs?: number;
  readonly now?: () => number;
}

export interface TransportHealthAttribution {
  readonly provider: string;
  readonly modelId: string;
  readonly invocationId: string;
}

export interface TransportTerminalObservation extends TransportHealthAttribution {
  readonly stopReason: string;
}

export interface TransportHealthProjectionInput {
  readonly route: ExecutionRoute;
  readonly classification: TransportFailureClassification;
  readonly attribution: TransportHealthAttribution;
  readonly terminal?: TransportTerminalObservation;
}

export type TransportHealthEffect = "none" | "cooldown_opened" | "route_cleared";

const MAX_TRANSPORT_ROUTE_COOLDOWN_MS = 30_000;

export class HealthProjector {
  private readonly maxAmbiguousRouteCooldownMs: number;
  private readonly now: () => number;

  constructor(private readonly health: HealthRegistry, options: HealthProjectionOptions = {}) {
    this.maxAmbiguousRouteCooldownMs = options.maxAmbiguousRouteCooldownMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
  }

  projectTransport(input: TransportHealthProjectionInput): TransportHealthEffect {
    const { route, classification, attribution, terminal } = input;
    if (!HealthProjector.matchesRoute(route, attribution)) return "none";
    if (classification.confidence !== "certain" || classification.evidence === "ambiguous") return "none";

    if (classification.classification === "successful_result") {
      if (terminal === undefined || !HealthProjector.matchesRoute(route, terminal)) return "none";
      if (terminal.invocationId !== attribution.invocationId) return "none";
      const expectedCode = terminal.stopReason === "stop"
        ? "stop"
        : terminal.stopReason === "toolUse"
          ? "tool_use"
          : undefined;
      if (expectedCode === undefined || classification.code !== expectedCode) return "none";
      this.health.clearRoute(route.routeId);
      return "route_cleared";
    }

    if (classification.classification !== "transient_throttle" &&
        classification.classification !== "transient_provider" &&
        classification.classification !== "transient_connection") {
      return "none";
    }

    const hint = classification.retryAfterMs;
    const cooldownMs = typeof hint === "number" && Number.isFinite(hint) && hint > 0
      ? Math.max(1, Math.min(Math.floor(hint), MAX_TRANSPORT_ROUTE_COOLDOWN_MS))
      : MAX_TRANSPORT_ROUTE_COOLDOWN_MS;
    this.health.recordRoute(route.routeId, {
      status: "cooldown",
      cooldownMs,
      metadata: {
        classification: classification.classification,
        code: classification.code,
        evidence: classification.evidence,
      },
    });
    return "cooldown_opened";
  }

  private static matchesRoute(
    route: ExecutionRoute,
    attribution: TransportHealthAttribution,
  ): boolean {
    return attribution.invocationId.length > 0 &&
      attribution.provider === route.provider &&
      attribution.modelId === route.modelId;
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
          cooldownMs: Math.max(1, outcome.resetAtMs - this.now()),
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
