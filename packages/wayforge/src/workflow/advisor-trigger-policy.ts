import type { Failure } from "../types/result.js";

export type AdvisorTriggerReason =
  | "manual"
  | "before_done"
  | "repeated_reasoning"
  | "repeated_validation";

export interface AdvisorTriggerInput {
  readonly manual: boolean;
  readonly beforeDone: boolean;
  readonly failures: readonly Failure[];
}

export type AdvisorTriggerDecision =
  | { readonly trigger: true; readonly reason: AdvisorTriggerReason }
  | { readonly trigger: false };

export class AdvisorTriggerPolicy {
  constructor(private readonly threshold = 2) {
    if (!Number.isInteger(threshold) || threshold < 1) throw new RangeError("advisor threshold must be positive");
  }

  evaluate(input: AdvisorTriggerInput): AdvisorTriggerDecision {
    if (input.manual) return { trigger: true, reason: "manual" };
    if (input.beforeDone) return { trigger: true, reason: "before_done" };
    const semanticCount = input.failures.filter((failure) => failure.kind === "reasoning").length;
    if (semanticCount >= this.threshold) return { trigger: true, reason: "repeated_reasoning" };
    const validationCount = input.failures.filter((failure) => failure.kind === "validation").length;
    if (validationCount >= this.threshold) return { trigger: true, reason: "repeated_validation" };
    return { trigger: false };
  }
}
