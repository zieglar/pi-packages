import { describe, expect, it } from "vitest";
import {
  augmentAdvisorFailureDiagnostic,
  buildAdvisorDiagnosticRecord,
  readAdvisorFailureDiagnostic,
} from "../src/trace/advisor-diagnostics.js";
import type { Failure } from "../src/types/result.js";

const actual = { stream: "rejected" as const, reasoning: "high", logicalBudget: 800, sdkMaxTokens: 800 };
function cause(): Failure {
  return { kind: "provider", scope: "provider", confidence: "certain", code: "offline", message: "synthetic",
    metadata: { diagStream: "resolved", diagReasoning: "low", diagLogicalBudget: 9, diagSdkMaxTokens: 7,
      diagPreparedMaxTokens: 800, diagPreparedMaxTokensField: "max_tokens", diagInputTokens: 1, diagOutputTokens: 2,
      diagUnknown: "PRIVATE_BODY Authorization: Basic synthetic Cookie: private credential=private" } };
}
function record(failure: Failure) {
  return buildAdvisorDiagnosticRecord({ invocationId: "advisor", candidateDigest: "a".repeat(64),
    candidateRevision: 1, workspaceDigest: "b".repeat(64), ...readAdvisorFailureDiagnostic(failure), parseValid: false });
}
function expectUnavailable(failure: Failure) {
  const diagnostic = record(failure);
  expect(diagnostic.request).toEqual({ logicalBudget: "unavailable", sdkMaxTokens: "unavailable", reasoning: "unavailable" });
  expect(diagnostic.stream).toBe("unavailable");
  expect(diagnostic.usage).toBeUndefined();
  expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE|Authorization|Cookie|credential/);
}

describe("private Advisor failure diagnostic provenance", () => {
  it("does not derive provenance from pre-existing keys, enums, plausible numbers, or flags", () => {
    const forged = Object.assign(cause(), { trusted: true, authoritative: true, observed: actual });
    expectUnavailable(forged);
  });

  it("reads current diagnostic facts without changing preserved metadata", () => {
    const original = cause();
    const failure = augmentAdvisorFailureDiagnostic(original, () => actual);
    expect(failure.metadata).toEqual(original.metadata);
    expect(record(failure).request).toEqual({ logicalBudget: 800, sdkMaxTokens: 800, reasoning: "high" });
    expect(record(failure).usage).toBeUndefined();
    expectUnavailable(original);
  });

  it.each(["clone", "serialized"] as const)("does not grant provenance to a %s of a genuine diagnostic failure", (transport) => {
    const failure = augmentAdvisorFailureDiagnostic(cause(), () => actual);
    const copied = transport === "clone" ? { ...failure } : JSON.parse(JSON.stringify(failure)) as Failure;
    expectUnavailable(copied);
    expect(record(failure).request.sdkMaxTokens).toBe(800);
  });

  it.each(["construction", "malformed"] as const)("degrades %s failures without promoting preserved observations", (mode) => {
    const original = cause();
    const failure = augmentAdvisorFailureDiagnostic(original, () => {
      if (mode === "construction") throw new Error("PRIVATE diagnostic construction failure");
      return { ...actual, get blocks(): never { throw new Error("PRIVATE malformed transport"); } };
    });
    expect(failure).toBe(original);
    expectUnavailable(failure);
  });

  it.each([null, 42, undefined])("treats malformed carrier identity %j as unavailable", (failure) => {
    expect(() => expectUnavailable(failure as unknown as Failure)).not.toThrow();
  });

  it("never reads arbitrary metadata getters when checking provenance", () => {
    const failure = { ...cause(), get metadata(): never { throw new Error("PRIVATE metadata getter"); } };
    expect(() => expectUnavailable(failure)).not.toThrow();
  });
});
