import { describe, expect, it } from "vitest";
import { HealthRegistry } from "../src/recovery/health-registry.js";
import { evaluateResumeAvailability } from "../src/recovery/resume-availability.js";
import { populatedTaskState } from "./helpers/durable-task-fixture.js";

describe("evaluateResumeAvailability", () => {
  it("waits for an explicit reset without consulting health", () => {
    const state = populatedTaskState({
      suspension: {
        ...populatedTaskState().suspension!,
        strategy: "explicit_reset",
        resumeNotBeforeMs: 5_000,
        nextCheckAtMs: 5_000,
      },
    });
    const health = new HealthRegistry(() => 1_000);
    expect(evaluateResumeAvailability(state, health, 1_000)).toEqual({ available: false, reason: "resume_not_before" });
    expect(evaluateResumeAvailability(state, health, 5_000)).toEqual({ available: true, reason: "explicit_reset_elapsed" });
  });

  it("uses only authoritative HealthRegistry state for availability probes", () => {
    const state = populatedTaskState({
      suspension: {
        ...populatedTaskState().suspension!,
        kind: "provider_outage",
        scope: "route",
        scopeKey: "route-a",
        strategy: "availability_probe",
      },
    });
    let now = 1_000;
    const health = new HealthRegistry(() => now);
    health.recordRoute("route-a", { status: "cooldown", cooldownMs: 2_000 });
    expect(evaluateResumeAvailability(state, health, 1_000)).toEqual({ available: false, reason: "health_unavailable" });
    now = 3_000;
    expect(evaluateResumeAvailability(state, health, now)).toEqual({ available: true, reason: "health_available" });
  });

  it("rejects non-suspended states without inventing a failure classifier", () => {
    const health = new HealthRegistry(() => 1_000);
    const state = populatedTaskState({ status: "running", suspension: null });
    expect(evaluateResumeAvailability(state, health, 1_000)).toEqual({ available: false, reason: "not_suspended" });
  });
});
