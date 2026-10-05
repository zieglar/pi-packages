import type { PersistSafeValue } from "../types/execution.js";

/**
 * Recursive trace redaction. Removes credential fields, API keys, bearer
 * tokens, cookies, authorization headers, raw provider bodies, and
 * unnecessary account identifiers while preserving safe diagnostic fields.
 * Deterministic: same input, same output; input is never mutated.
 */

const REDACTED = "[redacted]";

/** Deterministically remove credential material embedded inside diagnostic text. */
export function redactInlineSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*:\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(
      /\b(credential|credentials|password|passwd|token|api[-_ ]?key|secret)\s*([:=])\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
}

export type RedactedTraceValue =
  | null
  | string
  | number
  | boolean
  | readonly RedactedTraceValue[]
  | { readonly [key: string]: RedactedTraceValue };
const SENSITIVE_KEYS = new Set([
  // credentials and secrets
  "apikey",
  "api_key",
  "xapikey",
  "x_api_key",
  "key",
  "secret",
  "password",
  "passwd",
  "credential",
  "credentials",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "idtoken",
  "id_token",
  "sessiontoken",
  "session_token",
  "bearer",
  "authorization",
  "proxyauthorization",
  "proxy_authorization",
  "auth",
  "cookie",
  "cookies",
  "setcookie",
  "set_cookie",
  "setcookie_",
  // raw provider payloads
  "body",
  "rawbody",
  "raw_body",
  "providerbody",
  "provider_body",
  "requestbody",
  "request_body",
  "response",
  "responsebody",
  "response_body",
  "rawresponse",
  "raw_response",
  "providerresponse",
  "provider_response",
  "httpresponse",
  "http_response",
  // unnecessary account identifiers
  "accountid",
  "account_id",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

/** True when a key must never appear in trace data. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactValue(value: unknown, depth: number): RedactedTraceValue {
  if (depth > 16) return REDACTED;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, RedactedTraceValue> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redactValue(val, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactInlineSecrets(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return REDACTED;
}

/** Recursively redact a trace detail value. Never mutates the input. */
export function redact<T>(value: T): T {
  return redactValue(value, 0) as T;
}

/** Redact a metadata record down to persist-safe primitive values. */
export function redactTraceMetadata(
  record: Readonly<Record<string, unknown>>,
): Record<string, PersistSafeValue> {
  const redacted = redact(record) as Record<string, unknown>;
  const out: Record<string, PersistSafeValue> = {};
  for (const [key, value] of Object.entries(redacted)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}
