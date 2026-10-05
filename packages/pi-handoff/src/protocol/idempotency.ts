/**
 * Idempotency contract (frozen v1).
 *
 * The ChatGPT-facing create operation accepts an optional idempotency key so
 * that a retried create (e.g. after a caller-side timeout) never silently
 * produces a second handoff:
 *
 *   create(key=A, digest=D) -> ho_123
 *   create(key=A, digest=D) -> ho_123   (same record returned)
 *   create(key=A, digest=E) -> IDEMPOTENCY_KEY_CONFLICT (never a new id)
 *
 * The store is keyed by (scope, idempotencyKey). This module ships an
 * in-memory reference implementation; the durable broker must preserve the
 * same semantics transactionally.
 */
import { createHash } from "node:crypto";

export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;

export class IdempotencyKeyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_CONFLICT" as const;
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(`idempotency key conflict: ${idempotencyKey}`);
    this.name = "IdempotencyKeyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

export interface IdempotentCreateRecord {
  readonly handoffId: string;
  readonly requestDigest: string;
  readonly createdAt: string;
}

export interface IdempotencyStore {
  /** Returns the existing record for an equivalent request, or undefined. */
  get(key: string): IdempotentCreateRecord | undefined;
  /**
   * Records a new create. Throws {@link IdempotencyKeyConflictError} when the
   * key exists with a different request digest.
   */
  record(key: string, record: IdempotentCreateRecord): IdempotentCreateRecord;
}

/**
 * Deterministic content digest (SHA-256 hex) over a canonicalized JSON form:
 * object keys are sorted recursively so logically equal requests produce equal
 * digests regardless of key order.
 */
export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** In-memory reference implementation of the frozen idempotency semantics. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, IdempotentCreateRecord>();

  get(key: string): IdempotentCreateRecord | undefined {
    return this.#records.get(key);
  }

  record(key: string, record: IdempotentCreateRecord): IdempotentCreateRecord {
    const existing = this.#records.get(key);
    if (existing) {
      if (existing.requestDigest !== record.requestDigest) {
        throw new IdempotencyKeyConflictError(key);
      }
      return existing;
    }
    this.#records.set(key, record);
    return record;
  }

  get size(): number {
    return this.#records.size;
  }
}
