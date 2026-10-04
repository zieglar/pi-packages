import { describe, expect, it } from "vitest";
import { RecoveryCoordinator, type RecoveryInput } from "../src/recovery/recovery-coordinator.js";
import { scheduleSuspension, type SuspensionPlanningContext } from "../src/recovery/suspension.js";
import { normalizeError, type Failure } from "../src/types/result.js";

const context: SuspensionPlanningContext = {
  nowMs: 1_000,
  routeKey: "route-a",
  accountKey: "account-hash-a",
  modelKey: "model-a",
  providerKey: "provider-a",
  maxChecks: 5,
  safeAvailabilityProbe: true,
  availabilityProbeDelayMs: 20_000,
  boundedContinuationDelayMs: 60_000,
  maxScheduleDelayMs: 24 * 60 * 60 * 1_000,
};

const typed = (kind: Failure["kind"], extra: Partial<Failure> = {}): Failure => ({
  kind,
  scope: "provider",
  confidence: "certain",
  code: kind,
  message: `${kind} failure`,
  ...extra,
});

function recoveryInput(failure: Failure, alternatives: RecoveryInput["alternatives"] = []): RecoveryInput {
  return {
    failure,
    currentRoute: { routeId: "route-a", provider: "provider-a", modelId: "model-a", accountId: "account-hash-a" },
    alternatives,
    budget: { retriesLeft: 0, fallbacksLeft: 1 },
    health: {},
    suspensionContext: context,
  };
}

describe("scheduleSuspension", () => {
  it("uses explicit reset before Retry-After and known quota metadata", () => {
    const record = scheduleSuspension(
      typed("usage_limit", {
        scope: "account",
        resetAtMs: 8_000,
        retryAfterMs: 500,
        metadata: { quotaWindowResetAtMs: 9_000, quotaWindowReliable: true },
      }),
      context,
    );
    expect(record).toMatchObject({
      kind: "usage_limit",
      scope: "account",
      scopeKey: "account-hash-a",
      strategy: "explicit_reset",
      resumeNotBeforeMs: 8_000,
      nextCheckAtMs: 8_000,
      checkCount: 0,
      maxChecks: 5,
      decidedBy: "recovery_coordinator",
    });
  });

  it("uses Retry-After before reliable known quota-window metadata", () => {
    const record = scheduleSuspension(
      typed("rate_limit", {
        confidence: "ambiguous",
        retryAfterMs: 3_000,
        metadata: { quotaWindowResetAtMs: 9_000, quotaWindowReliable: true },
      }),
      context,
    );
    expect(record).toMatchObject({ kind: "rate_limit", scope: "route", strategy: "retry_after", nextCheckAtMs: 4_000 });
  });

  it("accepts quota-window timing only when normalized metadata marks it reliable", () => {
    const reliable = scheduleSuspension(
      typed("usage_limit", {
        scope: "account",
        metadata: { quotaWindowResetAtMs: 10_000, quotaWindowReliable: true },
      }),
      context,
    );
    const unreliable = scheduleSuspension(
      typed("usage_limit", {
        scope: "account",
        metadata: { quotaWindowResetAtMs: 10_000 },
      }),
      context,
    );
    expect(reliable?.strategy).toBe("known_quota_window");
    expect(reliable?.nextCheckAtMs).toBe(10_000);
    expect(unreliable?.strategy).toBe("availability_probe");
    expect(unreliable?.nextCheckAtMs).toBe(21_000);
  });

  it("keeps an ambiguous HTTP 429 route-scoped and never upgrades it to usage_limit", () => {
    const failure = normalizeError({ status: 429, message: "Too Many Requests" });
    const record = scheduleSuspension(failure, context);
    expect(failure).toMatchObject({ kind: "rate_limit", confidence: "ambiguous" });
    expect(record).toMatchObject({
      kind: "rate_limit",
      scope: "route",
      scopeKey: "route-a",
      strategy: "availability_probe",
      nextCheckAtMs: 21_000,
    });
    expect(record?.kind).not.toBe("usage_limit");
  });

  it("represents normalized provider failures as provider_outage and falls back to a bounded continuation only without a safe probe", () => {
    const outage = scheduleSuspension(typed("provider"), context);
    const bounded = scheduleSuspension(typed("provider"), { ...context, safeAvailabilityProbe: false });
    expect(outage).toMatchObject({ kind: "provider_outage", scope: "provider", strategy: "availability_probe" });
    expect(bounded).toMatchObject({ kind: "provider_outage", strategy: "bounded_continuation", nextCheckAtMs: 61_000 });
  });

  it("never suspends cancellation and always persists positive bounded checks", () => {
    expect(scheduleSuspension(typed("cancellation", { scope: "invocation" }), context)).toBeNull();
    const bounded = scheduleSuspension(typed("rate_limit", { confidence: "ambiguous" }), {
      ...context,
      maxChecks: 999,
    });
    expect(bounded?.maxChecks).toBeGreaterThan(0);
    expect(bounded?.maxChecks).toBeLessThanOrEqual(20);
  });
});

describe("RecoveryCoordinator suspension ownership", () => {
  it("prefers an available fallback and only then authors a structured suspension", () => {
    const coordinator = new RecoveryCoordinator();
    const usage = typed("usage_limit", { scope: "account", resetAtMs: 8_000 });
    const rotated = coordinator.plan(
      recoveryInput(usage, [{ routeId: "route-b", provider: "provider-a", modelId: "model-a", accountId: "account-hash-b" }]),
    );
    expect(rotated.action).toBe("rotate_account");
    expect(rotated.suspension).toBeUndefined();

    const suspended = coordinator.plan(recoveryInput(usage));
    expect(suspended.action).toBe("suspend");
    expect(suspended.suspension).toMatchObject({ strategy: "explicit_reset", nextCheckAtMs: 8_000 });
  });

  it("stops cancellation without authoring a suspension", () => {
    const decision = new RecoveryCoordinator().plan(
      recoveryInput(typed("cancellation", { scope: "invocation" })),
    );
    expect(decision.action).toBe("stop");
    expect(decision.suspension).toBeUndefined();
  });
});
