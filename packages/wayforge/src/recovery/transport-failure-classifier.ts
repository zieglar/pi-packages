/**
 * Passive transport classification for TR1. This module answers only
 * "what happened?" for attributable provider/model evidence. It owns no
 * route switching, retry, cooldown, continuation, budget, account, Worker,
 * Advisor, or Completion Authority behavior.
 */

export type TransportFailureClassificationKind =
  | "transient_throttle"
  | "transient_provider"
  | "transient_connection"
  | "authentication"
  | "economic_quota"
  | "context_overflow"
  | "cancelled"
  | "tool_failure"
  | "successful_result"
  | "incomplete_result"
  | "unknown";

export type TransportEvidenceProvenance = "structured" | "provider_specific" | "normalized" | "ambiguous";

export interface SelectedInvocationAttribution {
  readonly provider: string;
  readonly modelId: string;
  readonly invocationId?: string;
}

export interface ProviderFailureEvidence {
  readonly provider: string;
  readonly modelId: string;
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly retryAfterMs?: unknown;
  readonly networkCode?: string;
  readonly contextOverflow?: boolean;
  readonly toolError?: boolean;
  readonly message?: unknown;
}

export interface ResolvedProviderMessageEvidence {
  readonly provider: string;
  readonly modelId: string;
  readonly stopReason: string;
  readonly errorMessage?: unknown;
  readonly responseStatus?: number;
}

export interface TransportFailureClassification {
  readonly classification: TransportFailureClassificationKind;
  readonly confidence: "certain" | "ambiguous";
  readonly evidence: TransportEvidenceProvenance;
  readonly code: string;
  readonly retryAfterMs?: number;
  readonly detail?: string;
}

const MAX_CLASSIFIED_RETRY_AFTER_MS = 30_000;

const TEMPORARY_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

export function classifyProviderFailure(
  evidence: ProviderFailureEvidence,
  selected: SelectedInvocationAttribution,
): TransportFailureClassification {
  if (!isAttributed(evidence, selected)) {
    return unknownClassification("provider/model attribution mismatch");
  }

  if (evidence.toolError === true) {
    return structured("tool_failure", "tool_failure");
  }
  if (evidence.contextOverflow === true) {
    return structured("context_overflow", "context_overflow");
  }
  if (typeof evidence.networkCode === "string" && TEMPORARY_NETWORK_CODES.has(evidence.networkCode)) {
    return structured("transient_connection", evidence.networkCode.toLowerCase());
  }

  if (typeof evidence.status === "number" && Number.isInteger(evidence.status)) {
    const status = evidence.status;
    if (status === 401 || status === 403) {
      return structured("authentication", `http_${status}`);
    }
    if (status === 402) {
      return structured("economic_quota", "http_402");
    }
    if (status === 429) {
      const classified = structured("transient_throttle", "http_429");
      const retryAfterMs = normalizedRetryHint(evidence.retryAfterMs) ?? retryHintFromHeaders(evidence.headers);
      return retryAfterMs === undefined ? classified : { ...classified, retryAfterMs };
    }
    if (status >= 500 && status <= 599) {
      const classified = structured("transient_provider", `http_${status}`);
      const retryAfterMs = normalizedRetryHint(evidence.retryAfterMs);
      return retryAfterMs === undefined ? classified : { ...classified, retryAfterMs };
    }
  }

  return {
    classification: "unknown",
    confidence: "ambiguous",
    evidence: "ambiguous",
    code: "unknown",
    ...(evidence.message === undefined ? {} : { detail: sanitizeClassificationDetail(evidence.message) }),
  };
}

export function classifyResolvedProviderMessage(
  message: ResolvedProviderMessageEvidence,
  selected: SelectedInvocationAttribution,
): TransportFailureClassification {
  if (!isAttributed(message, selected)) {
    return unknownClassification("provider/model attribution mismatch");
  }

  if (message.stopReason === "stop" || message.stopReason === "toolUse") {
    return structured("successful_result", message.stopReason === "stop" ? "stop" : "tool_use");
  }
  if (message.stopReason === "length" || message.stopReason === "deferred") {
    return structured("incomplete_result", message.stopReason);
  }
  if (message.stopReason === "aborted") {
    return structured("cancelled", "aborted");
  }
  if (message.stopReason !== "error") {
    return unknownClassification(`unsupported terminal stop reason: ${message.stopReason}`, "unsupported_stop_reason");
  }

  const status = typeof message.responseStatus === "number" && Number.isInteger(message.responseStatus)
    ? message.responseStatus
    : undefined;
  if (status !== undefined && status >= 200 && status <= 299) {
    return structured("transient_connection", "stream_terminated_after_success_response");
  }
  if (status === 429) {
    return structured("transient_throttle", "http_429");
  }
  if (status === 401 || status === 403) {
    return structured("authentication", `http_${status}`);
  }
  if (status === 402) {
    return structured("economic_quota", "http_402");
  }

  const classified = structured("transient_provider", "transport_stream_error");
  return message.errorMessage === undefined
    ? classified
    : { ...classified, detail: sanitizeClassificationDetail(message.errorMessage) };
}

function isAttributed(
  evidence: Readonly<{ provider: string; modelId: string }>,
  selected: SelectedInvocationAttribution,
): boolean {
  return evidence.provider === selected.provider &&
    evidence.modelId === selected.modelId &&
    selected.provider.length > 0 &&
    selected.modelId.length > 0;
}

function structured(
  classification: TransportFailureClassificationKind,
  code: string,
): TransportFailureClassification {
  return {
    classification,
    confidence: "certain",
    evidence: "structured",
    code,
  };
}

function unknownClassification(detail: string, code = "unknown"): TransportFailureClassification {
  return {
    classification: "unknown",
    confidence: "ambiguous",
    evidence: "ambiguous",
    code,
    detail: sanitizeClassificationDetail(detail),
  };
}

function normalizedRetryHint(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  if (rounded <= 0 || rounded > MAX_CLASSIFIED_RETRY_AFTER_MS) return undefined;
  return rounded;
}

function retryHintFromHeaders(headers: Readonly<Record<string, string>> | undefined): number | undefined {
  if (headers === undefined) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return normalizedRetryHint(seconds * 1_000);
}

function sanitizeClassificationDetail(value: unknown): string {
  return String(value ?? "unknown")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, "[redacted-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}\b/g, "Bearer [redacted]")
    .replace(/(?:~\/|[A-Za-z]:\\|\/(?:Users|home|private|var|tmp|etc|opt|srv|mnt|media)\/)[^\s"'`]+/g, "[path]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, 200);
}
