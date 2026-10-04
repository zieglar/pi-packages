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
  readonly budgetLimit: number;
}

/** Output of one nested model call. */
export interface NestedModelOutput {
  readonly text: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Port performing exactly one nested model call attempt. Never retries. */
export interface NestedModelRuntimePort {
  stream(request: NestedModelRequest): Promise<ExecutionResult<NestedModelOutput>>;
}
