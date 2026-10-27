/**
 * Idempotency contract (frozen v2; strengthened from v1).
 *
 * A retried create (e.g. after a caller-side timeout) must never silently
 * produce a second entity. Keys are scoped to an explicit NAMESPACE, so
 * distinct callers cannot collide on the same key string:
 *
 *   record(ns, key=A, digest=D) -> entity 1
 *   record(ns, key=A, digest=D) -> entity 1   (same record replayed)
 *   record(ns, key=A, digest=E) -> IDEMPOTENCY_KEY_CONFLICT (never a new id)
 *   record(otherNs, key=A, ...)  -> independent record
 *
 * The store contract is keyed by (namespace, key) and returns IMMUTABLE
 * records. This module defines the contract and the canonical digest; the
 * in-memory REFERENCE implementation lives in core (`core/reference.ts`) —
 * it is a semantics reference, not a durable store. A durable host must
 * preserve these semantics transactionally.
 */
import { createHash } from "node:crypto";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
export const NAMESPACE_MAX_LENGTH = 256;

export class IdempotencyKeyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT" as const;
  readonly idempotencyKey: string;

  constructor(namespace: string, idempotencyKey: string) {
    super(`idempotency key conflict: ${namespace}:${idempotencyKey}`);
    this.name = "IdempotencyKeyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

/** Canonical-digest input is unsupported (or cyclic) JSON-ish data. */
export class DigestInputError extends Error {
  readonly code = "DIGEST_INPUT_UNSUPPORTED" as const;

  constructor(detail: string) {
    super(`canonical digest input rejected: ${detail}`);
    this.name = "DigestInputError";
  }
}

export interface IdempotentCreateRecord {
  readonly entityId: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface IdempotencyStore {
  /** Returns the existing immutable record for an equivalent request, or undefined. */
  get(namespace: string, key: string): IdempotentCreateRecord | undefined;
  /**
   * Records a new create. Returns the stored immutable record. Throws
   * {@link IdempotencyKeyConflictError} when the (namespace, key) exists with
   * a different request digest.
   */
  record(
    namespace: string,
    key: string,
    record: IdempotentCreateRecord,
  ): IdempotentCreateRecord;
}

/**
 * Deterministic content digest (SHA-256 hex) over a canonicalized JSON form:
 * object keys are sorted recursively so logically equal requests produce
 * equal digests regardless of key order. Unsupported values (undefined,
 * functions, symbols, bigints, non-finite numbers) and cyclic structures are
 * rejected with {@link DigestInputError} instead of silently degrading.
 */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value, new Set())).digest("hex");
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new DigestInputError("numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "undefined" || type === "function" || type === "symbol" || type === "bigint") {
    throw new DigestInputError(`unsupported value of type ${type}`);
  }
  if (ancestors.has(value as object)) {
    throw new DigestInputError("cyclic structure");
  }
  ancestors.add(value as object);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Reflect.ownKeys(value).length !== value.length + 1) {
        throw new DigestInputError("sparse arrays or extra array properties are unsupported");
      }
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DigestInputError("only plain JSON objects are supported");
    }
    if (Reflect.ownKeys(value as object).length !== Object.keys(value as object).length) {
      throw new DigestInputError("symbol or non-enumerable properties are unsupported");
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value as object);
  }
}
