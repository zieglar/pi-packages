import type { ThinkingLevel } from "../types/execution.js";
import type { Failure } from "../types/result.js";
import type { ExecutionResult } from "../types/result.js";
import { failure } from "../types/result.js";
import type { TaskId } from "../types/identity.js";

/**
 * Narrow external adapter contracts. These interfaces receive Wayforge-native
 * types only: they expose no parent `setModel`, no parent abort, no session
 * continuation mutation, and no hidden retry loops. Phase 1A defines the
 * shapes; concrete production adapters are future work.
 */

/** Sanitized route as seen by account enumeration. */
export interface SanitizedRoute {
  readonly routeId: string;
  readonly provider: string;
  readonly modelId: string;
  readonly accountId?: string;
  readonly status: "available" | "cooldown" | "suspended" | "unavailable";
}

export interface AccountRouteQuery {
  readonly taskId: TaskId;
  readonly role: "worker" | "advisor";
}

export interface AccountAdapter {
  /** Enumerate sanitized eligible routes. */
  listEligibleRoutes(query: AccountRouteQuery): Promise<ExecutionResult<readonly SanitizedRoute[]>>;
  /** Report a typed outcome for a route this account served. */
  reportRouteOutcome(
    route: SanitizedRoute,
    outcome: Failure | { ok: true },
  ): Promise<ExecutionResult<void>>;
}

/** Fully resolved worker launch request; nothing may be deferred. */
export interface WorkerLaunchRequest {
  readonly taskId: TaskId;
  readonly role: "worker";
  readonly provider: string;
  readonly modelId: string;
  readonly thinking: ThinkingLevel;
  readonly budget: { readonly limit: number };
  readonly prompt: string;
}

export interface WorkerAdapter {
  launch(request: WorkerLaunchRequest): Promise<ExecutionResult<{ workerId: string }>>;
}

/** Observational input only; the advisor never receives mutation authority. */
export interface AdvisorObservation {
  readonly taskId: TaskId;
  readonly routeId: string;
  readonly failure: Failure;
}

/** Typed advisor verdict. */
export interface AdvisorVerdict {
  readonly approve: boolean;
  readonly rationale: string;
}

export interface AdvisorAdapter {
  review(observation: AdvisorObservation): Promise<ExecutionResult<AdvisorVerdict>>;
}

/** Authorized continuation request. */
export interface ContinuationRequest {
  readonly taskId: TaskId;
  readonly authorizedBy: string;
  readonly reason: string;
}

export interface ContinuationLauncher {
  launch(request: ContinuationRequest): Promise<ExecutionResult<{ continuationId: string }>>;
}

const THINKING_LEVELS: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Guard: a worker launch request must be fully resolved before launch. */
export function assertResolvedWorkerLaunch(request: unknown): ExecutionResult<void> {
  const bad = (message: string): ExecutionResult<void> =>
    failure({
      kind: "validation",
      scope: "invocation",
      confidence: "certain",
      code: "unresolved_worker_launch",
      message,
    });
  if (typeof request !== "object" || request === null) {
    return bad("worker launch request must be an object");
  }
  const r = request as Record<string, unknown>;
  if (typeof r.taskId !== "string" || r.taskId === "") return bad("taskId is required");
  if (r.role !== "worker") return bad("role must be worker");
  if (typeof r.provider !== "string" || r.provider === "") return bad("provider is required");
  if (typeof r.modelId !== "string" || r.modelId === "") return bad("modelId is required");
  if (typeof r.thinking !== "string" || !THINKING_LEVELS.includes(r.thinking)) {
    return bad("thinking level is required");
  }
  const budget = r.budget as { limit?: unknown } | undefined;
  if (typeof budget !== "object" || budget === null || typeof budget.limit !== "number" || budget.limit <= 0) {
    return bad("budget limit is required");
  }
  if (typeof r.prompt !== "string") return bad("prompt is required");
  return { ok: true, value: undefined };
}

/** Type guard for advisor verdicts. */
export function isAdvisorVerdict(value: unknown): value is AdvisorVerdict {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { approve?: unknown }).approve === "boolean" &&
    typeof (value as { rationale?: unknown }).rationale === "string"
  );
}
