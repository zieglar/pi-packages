import type { ModelDecision } from "../policy/model-policy.js";
import type { ThinkingLevel } from "../types/execution.js";
import type { ExecutionResult } from "../types/result.js";

/**
 * Narrow side-effect ports of the Wayforge kernel. Production implementations
 * live exclusively in the Pi compatibility adapter; tests use fakes.
 */

/** Port that may request a parent session model change. Sole implementor: adapter. */
export interface MainSessionModelPort {
  applyModelDecision(decision: ModelDecision): Promise<ExecutionResult<{ provider: string; modelId: string }>>;
}

/** Fully resolved request for one nested model call. */
export interface NestedModelRequest {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: ThinkingLevel;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  /** Logical invocation allowance; not necessarily a provider payload ceiling. */
  readonly budgetLimit: number;
}

/**
 * Safe response observation for advisor diagnostics: allowlisted stop
 * reason, fixed block-type counts, and observation-only text statistics.
 * Never carries block bodies, reasoning text, or provider payloads.
 */
export interface NestedResponseObservation {
  readonly stopReason: import("../trace/advisor-diagnostics.js").AdvisorDiagnosticStopReason;
  readonly blocks: import("../trace/advisor-diagnostics.js").AdvisorBlockCounts;
  readonly text: import("../trace/advisor-diagnostics.js").AdvisorTextStats;
  /** SDK option and prepared payload facts, not a guaranteed provider ceiling. */
  readonly request?: import("../trace/advisor-diagnostics.js").AdvisorRequestObservation;
}

/** Output of one nested model call. */
export interface NestedModelOutput {
  readonly text: string;
  /** SDK counters retained for existing accounting; no provider-provenance claim. */
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Present when the runtime observed the resolved response shape. */
  readonly observed?: NestedResponseObservation;
}

/** Port performing exactly one nested model call attempt. Never retries. */
export interface NestedModelRuntimePort {
  stream(request: NestedModelRequest): Promise<ExecutionResult<NestedModelOutput>>;
}
