import type { ModelTier, ThinkingLevel } from "../types/execution.js";
import type { InvocationId, RouteId, TaskId } from "../types/identity.js";
import type { Failure } from "../types/result.js";

export interface RouteCapabilities {
  readonly worker: boolean;
  readonly advisor: boolean;
  readonly tools: boolean;
  readonly reasoning: boolean;
}

export interface ExecutionRoute {
  readonly routeId: RouteId;
  readonly provider: string;
  readonly modelId: string;
  readonly accountRef?: string;
  readonly tier: ModelTier;
  readonly thinking: ThinkingLevel;
  readonly capabilities: RouteCapabilities;
  readonly budgetLimit: number;
}

export type WorkerStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "tool_budget_exhausted"
  | "structured_output_failed"
  | "acceptance_failed";

export interface WorkerUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
}

export interface WorkerOutcome {
  readonly taskId: TaskId;
  readonly invocationId: InvocationId;
  readonly parentInvocationId: InvocationId;
  readonly selectedRoute: ExecutionRoute;
  readonly observedModel?: string;
  readonly status: WorkerStatus;
  readonly text?: string;
  readonly structured?: unknown;
  readonly failure?: Failure;
  readonly usage?: WorkerUsage;
  readonly remainingBudget: number;
}

export type AdvisorVerdictStatus = "approve" | "changes_requested" | "unable";

export interface AdvisorFinding {
  readonly code: string;
  readonly severity: "blocker" | "warning" | "note";
  readonly summary: string;
  readonly path?: string;
}

export interface StructuredAdvisorVerdict {
  readonly status: AdvisorVerdictStatus;
  readonly summary: string;
  readonly findings: readonly AdvisorFinding[];
}

export interface ValidationResult {
  readonly name: string;
  readonly ok: boolean;
  readonly summary: string;
}
