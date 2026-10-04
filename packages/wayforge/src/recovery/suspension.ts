import type { AuthoritativeTaskState } from "../durable/state.js";
import { DURABLE_LIMITS } from "../durable/state.js";
import { isSensitiveKey } from "../trace/redaction.js";
import type { Failure, FailureMetadata } from "../types/result.js";

export type DurableSuspension = NonNullable<AuthoritativeTaskState["suspension"]>;
type DurableFailure = DurableSuspension["originatingFailure"];

export interface SuspensionPlanningContext {
  readonly nowMs: number;
  readonly routeKey: string;
  readonly accountKey?: string;
  readonly modelKey: string;
  readonly providerKey: string;
  readonly maxChecks: number;
  readonly safeAvailabilityProbe: boolean;
  readonly availabilityProbeDelayMs: number;
  readonly boundedContinuationDelayMs: number;
  readonly maxScheduleDelayMs: number;
}

const MAX_RESUME_CHECKS = 20;
const SECRET_PATTERN = /\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b|\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi;

function sanitizeText(value: string, maxLength: number): string {
  return value.replace(SECRET_PATTERN, "[redacted]").slice(0, maxLength);
}

function sanitizeMetadata(metadata: FailureMetadata | undefined): FailureMetadata | undefined {
  if (metadata === undefined) return undefined;
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right))) {
    if (Object.keys(safe).length >= DURABLE_LIMITS.maxFailureMetadataEntries) break;
    if (isSensitiveKey(key)) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    safe[key.slice(0, 100)] =
      typeof value === "string"
        ? sanitizeText(value, DURABLE_LIMITS.maxFailureMetadataValueLength)
        : value;
  }
  return Object.keys(safe).length === 0 ? undefined : safe;
}

function sanitizeFailure(input: Failure): DurableFailure {
  const retryAfterMs =
    input.retryAfterMs !== undefined && Number.isInteger(input.retryAfterMs) && input.retryAfterMs >= 0
      ? input.retryAfterMs
      : undefined;
  const resetAtMs =
    input.resetAtMs !== undefined && Number.isInteger(input.resetAtMs) && input.resetAtMs >= 0
      ? input.resetAtMs
      : undefined;
  const metadata = sanitizeMetadata(input.metadata);
  return {
    kind: input.kind,
    scope: input.scope,
    confidence: input.confidence,
    code: sanitizeText(input.code, 100),
    message: sanitizeText(input.message, DURABLE_LIMITS.maxMessageLength),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(resetAtMs === undefined ? {} : { resetAtMs }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function boundedAbsolute(candidateMs: number, context: SuspensionPlanningContext): number {
  const maximum = context.nowMs + Math.max(1, context.maxScheduleDelayMs);
  return Math.max(context.nowMs, Math.min(Math.trunc(candidateMs), maximum));
}

function scopeFor(failure: Failure, context: SuspensionPlanningContext): {
  readonly scope: DurableSuspension["scope"];
  readonly scopeKey: string;
} {
  if (failure.kind === "rate_limit" && failure.confidence === "ambiguous") {
    return { scope: "route", scopeKey: context.routeKey };
  }
  if (failure.scope === "account" && context.accountKey !== undefined) {
    return { scope: "account", scopeKey: context.accountKey };
  }
  if (failure.scope === "model") return { scope: "model", scopeKey: context.modelKey };
  if (failure.scope === "provider") return { scope: "provider", scopeKey: context.providerKey };
  return { scope: "route", scopeKey: context.routeKey };
}

/**
 * Deterministic scheduling projection for a typed failure. This does not decide
 * whether recovery should suspend; only RecoveryCoordinator owns that policy.
 */
export function scheduleSuspension(
  failure: Failure,
  context: SuspensionPlanningContext,
): DurableSuspension | null {
  if (failure.kind !== "rate_limit" && failure.kind !== "usage_limit" && failure.kind !== "provider") {
    return null;
  }
  const kind: DurableSuspension["kind"] =
    failure.kind === "provider" ? "provider_outage" : failure.kind;
  const scope = scopeFor(failure, context);
  let strategy: DurableSuspension["strategy"];
  let scheduledAtMs: number;

  if (failure.resetAtMs !== undefined && Number.isFinite(failure.resetAtMs)) {
    strategy = "explicit_reset";
    scheduledAtMs = boundedAbsolute(failure.resetAtMs, context);
  } else if (failure.retryAfterMs !== undefined && Number.isFinite(failure.retryAfterMs)) {
    strategy = "retry_after";
    scheduledAtMs = boundedAbsolute(context.nowMs + Math.max(0, failure.retryAfterMs), context);
  } else {
    const quotaReset = failure.metadata?.quotaWindowResetAtMs;
    const quotaReliable = failure.metadata?.quotaWindowReliable === true && failure.confidence === "certain";
    if (quotaReliable && typeof quotaReset === "number" && Number.isFinite(quotaReset)) {
      strategy = "known_quota_window";
      scheduledAtMs = boundedAbsolute(quotaReset, context);
    } else if (context.safeAvailabilityProbe) {
      strategy = "availability_probe";
      scheduledAtMs = boundedAbsolute(context.nowMs + Math.max(1, context.availabilityProbeDelayMs), context);
    } else {
      strategy = "bounded_continuation";
      scheduledAtMs = boundedAbsolute(context.nowMs + Math.max(1, context.boundedContinuationDelayMs), context);
    }
  }

  return {
    kind,
    reason: sanitizeText(`${kind} suspended after bounded recovery routes were unavailable`, DURABLE_LIMITS.maxReasonLength),
    scope: scope.scope,
    scopeKey: sanitizeText(scope.scopeKey, DURABLE_LIMITS.maxIdentifierLength),
    observedAtMs: context.nowMs,
    resumeNotBeforeMs: scheduledAtMs,
    nextCheckAtMs: scheduledAtMs,
    strategy,
    checkCount: 0,
    maxChecks: Math.max(1, Math.min(MAX_RESUME_CHECKS, Math.trunc(context.maxChecks))),
    originatingFailure: sanitizeFailure(failure),
    decidedBy: "recovery_coordinator",
  };
}
