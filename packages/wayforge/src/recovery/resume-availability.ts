import type { AuthoritativeTaskState } from "../durable/state.js";
import type { HealthRegistry } from "./health-registry.js";

export interface ResumeAvailability {
  readonly available: boolean;
  readonly reason:
    | "not_suspended"
    | "resume_not_before"
    | "explicit_reset_elapsed"
    | "retry_after_elapsed"
    | "known_quota_window_elapsed"
    | "health_available"
    | "health_unavailable";
}

/**
 * Deterministic, read-only availability evaluation for a persisted suspension.
 * It consumes the existing authoritative HealthRegistry for probe strategies;
 * it neither classifies failures nor writes route/account health.
 */
export function evaluateResumeAvailability(
  state: AuthoritativeTaskState,
  health: HealthRegistry,
  nowMs: number,
): ResumeAvailability {
  const suspension = state.suspension;
  if (state.status !== "suspended" || suspension === null) {
    return { available: false, reason: "not_suspended" };
  }

  if (
    suspension.strategy === "explicit_reset" ||
    suspension.strategy === "retry_after" ||
    suspension.strategy === "known_quota_window"
  ) {
    if (nowMs < suspension.resumeNotBeforeMs) {
      return { available: false, reason: "resume_not_before" };
    }
    if (suspension.strategy === "explicit_reset") {
      return { available: true, reason: "explicit_reset_elapsed" };
    }
    if (suspension.strategy === "retry_after") {
      return { available: true, reason: "retry_after_elapsed" };
    }
    return { available: true, reason: "known_quota_window_elapsed" };
  }

  return health.isAvailable(suspension.scopeKey)
    ? { available: true, reason: "health_available" }
    : { available: false, reason: "health_unavailable" };
}
