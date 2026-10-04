/**
 * Typed execution outcomes. Every fallible kernel operation returns
 * `ExecutionResult<T>`; failures are sanitized discriminated records that are
 * safe to persist and trace. Normalization is deliberately conservative.
 */

export type FailureKind =
  | "authentication"
  | "cancellation"
  | "context_overflow"
  | "rate_limit"
  | "usage_limit"
  | "provider"
  | "network"
  | "validation"
  | "reasoning"
  | "tool"
  | "capability"
  | "unknown";

const FAILURE_SCOPES = new Set<string>([
  "account",
  "model",
  "provider",
  "invocation",
  "task",
  "system",
]);

const FAILURE_CONFIDENCES = new Set<string>(["certain", "ambiguous"]);

export type FailureScope = "account" | "model" | "provider" | "invocation" | "task" | "system";

export type FailureConfidence = "certain" | "ambiguous";

export interface FailureMetadata {
  readonly [key: string]: string | number | boolean | null;
}

export interface Failure {
  readonly kind: FailureKind;
  readonly scope: FailureScope;
  readonly confidence: FailureConfidence;
  /** Stable machine-readable code. */
  readonly code: string;
  /** Sanitized human-readable message; never contains secrets or stacks. */
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly resetAtMs?: number;
  readonly metadata?: FailureMetadata;
}

export type ExecutionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: Failure };

export const success = <T>(value: T): ExecutionResult<T> => ({ ok: true, value });

export const failure = (f: Failure): ExecutionResult<never> => ({ ok: false, failure: f });

const FAILURE_KINDS = new Set<string>([
  "authentication",
  "cancellation",
  "context_overflow",
  "rate_limit",
  "usage_limit",
  "provider",
  "network",
  "validation",
  "reasoning",
  "tool",
  "capability",
  "unknown",
]);

export function isFailure(value: unknown): value is Failure {
  return (
    typeof value === "object" &&
    value !== null &&
    FAILURE_KINDS.has(String((value as { kind?: unknown }).kind)) &&
    FAILURE_SCOPES.has(String((value as { scope?: unknown }).scope)) &&
    FAILURE_CONFIDENCES.has(String((value as { confidence?: unknown }).confidence)) &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Strip obvious key material and bound message length. */
function sanitizeMessage(raw: unknown): string {
  return String(raw ?? "unknown failure")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, "Bearer [redacted]")
    .slice(0, 200);
}

function asRecord(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
      status: (error as { status?: unknown }).status,
    };
  }
  if (typeof error === "object" && error !== null) return error as Record<string, unknown>;
  return {};
}


function timingHints(record: Readonly<Record<string, unknown>>): Pick<Failure, "retryAfterMs" | "resetAtMs"> {
  const retryAfterMs = record.retryAfterMs;
  const resetAtMs = record.resetAtMs;
  return {
    ...(typeof retryAfterMs === "number" && Number.isInteger(retryAfterMs) && retryAfterMs >= 0
      ? { retryAfterMs }
      : {}),
    ...(typeof resetAtMs === "number" && Number.isInteger(resetAtMs) && resetAtMs >= 0
      ? { resetAtMs }
      : {}),
  };
}
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

/**
 * Conservative normalization of unknown thrown values into typed failures.
 * An unqualified HTTP 429 stays `rate_limit` with ambiguous confidence and is
 * never automatically upgraded to `usage_limit`.
 */
export function normalizeError(error: unknown): Failure {
  if (isFailure(error)) {
    return { ...error, message: sanitizeMessage(error.message) };
  }
  const rec = asRecord(error);
  const name = typeof rec.name === "string" ? rec.name : "";
  const rawMessage = typeof rec.message === "string" ? rec.message : String(error);
  const message = sanitizeMessage(rawMessage);
  const status = typeof rec.status === "number" ? rec.status : undefined;
  const code = typeof rec.code === "string" ? rec.code : undefined;

  const timing = timingHints(rec);
  if (name === "AbortError" || code === "ABORT_ERR" || code === "ERR_ABORTED") {
    return { kind: "cancellation", scope: "invocation", confidence: "certain", code: "aborted", message };
  }
  if (status === 401 || status === 403) {
    return { kind: "authentication", scope: "account", confidence: "certain", code: `http_${status}`, message };
  }
  if (status === 429) {
    if (/usage|quota|credit|plan/i.test(rawMessage)) {
      return { kind: "usage_limit", scope: "account", confidence: "certain", code: "usage_exhausted", message, ...timing };
    }
    return { kind: "rate_limit", scope: "provider", confidence: "ambiguous", code: "http_429", message, ...timing };
  }
  if (status !== undefined && status >= 400 && /context|token|too long|maximum.{0,20}length/i.test(rawMessage)) {
    return { kind: "context_overflow", scope: "model", confidence: "certain", code: "context_overflow", message };
  }
  if ((code !== undefined && NETWORK_CODES.has(code)) || (name === "TypeError" && /fetch/i.test(rawMessage))) {
    return { kind: "network", scope: "provider", confidence: "ambiguous", code: code ?? "network", message };
  }
  if (status !== undefined && status >= 500) {
    return { kind: "provider", scope: "provider", confidence: "ambiguous", code: `http_${status}`, message };
  }
  if (name === "ValidationError" || name === "ZodError") {
    return { kind: "validation", scope: "invocation", confidence: "certain", code: "validation", message };
  }
  if (name === "ReasoningError") {
    return { kind: "reasoning", scope: "model", confidence: "ambiguous", code: "reasoning", message };
  }
  if (name === "ToolError") {
    return { kind: "tool", scope: "invocation", confidence: "certain", code: "tool", message };
  }
  return { kind: "unknown", scope: "system", confidence: "ambiguous", code: "unknown", message };
}
