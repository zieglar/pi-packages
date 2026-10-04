import { describe, expect, it } from "vitest";
import { buildAdvisorEvidence } from "../src/workflow/advisor-evidence.js";
import { AdvisorTriggerPolicy } from "../src/workflow/advisor-trigger-policy.js";
import type { Failure } from "../src/types/result.js";

const failure = (kind: Failure["kind"]): Failure => ({
  kind, scope: kind === "reasoning" ? "model" : "invocation", confidence: "certain", code: kind, message: kind,
});

describe("AdvisorTriggerPolicy", () => {
  it("supports manual and before-done triggers", () => {
    const policy = new AdvisorTriggerPolicy(2);
    expect(policy.evaluate({ manual: true, beforeDone: false, failures: [] })).toEqual({ trigger: true, reason: "manual" });
    expect(policy.evaluate({ manual: false, beforeDone: true, failures: [] })).toEqual({ trigger: true, reason: "before_done" });
  });

  it("triggers only after repeated semantic or validation failures", () => {
    const policy = new AdvisorTriggerPolicy(2);
    expect(policy.evaluate({ manual: false, beforeDone: false, failures: [failure("reasoning")] }).trigger).toBe(false);
    expect(policy.evaluate({ manual: false, beforeDone: false, failures: [failure("reasoning"), failure("reasoning")] })).toEqual({ trigger: true, reason: "repeated_reasoning" });
    expect(policy.evaluate({ manual: false, beforeDone: false, failures: [failure("validation"), failure("validation")] })).toEqual({ trigger: true, reason: "repeated_validation" });
  });

  it.each(["cancellation", "authentication", "usage_limit", "rate_limit", "provider", "network", "context_overflow"] as const)(
    "never auto-triggers on %s failures", (kind) => {
      const policy = new AdvisorTriggerPolicy(2);
      expect(policy.evaluate({ manual: false, beforeDone: false, failures: [failure(kind), failure(kind)] }).trigger).toBe(false);
    },
  );
});

describe("advisor evidence", () => {
  it("keeps bounded useful evidence and removes sensitive or reasoning material", () => {
    const evidence = buildAdvisorEvidence({
      objective: "review change", completionCriteria: "tests pass", implementationSummary: "implemented",
      changedPaths: ["src/a.ts"], diffSummary: "small diff", validations: [{ name: "test", ok: true, summary: "pass" }],
      workerFindings: ["looks good"], unresolved: [], workspaceDigest: "abc",
      extra: { apiKey: "sk-secret-value", transcript: "private", reasoning: "hidden", safe: "kept" },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("hidden");
    expect(evidence.extra).toMatchObject({ safe: "kept" });
  });
});
