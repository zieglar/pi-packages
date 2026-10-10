import { randomBytes } from "node:crypto";
import { encodeUlid } from "../protocol/identity.js";
import { IDEMPOTENCY_KEY_MAX_LENGTH } from "../protocol/idempotency.js";

/**
 * Private B3 identity-plane conventions (CE-0002-B3-P1B).
 *
 * Participant identity follows the accepted repository ULID convention —
 * `prt_` + Crockford Base32 ULID, produced by the frozen protocol encoder
 * (`encodeUlid`). The prefix lives here, in the private storage plane, rather
 * than in `protocol/identity.ts`: the protocol entity surface is frozen and
 * publicly re-exported, the Participant plane is private B3 storage state, and
 * B2 identity semantics must not change. No existing identity, pattern, or
 * generator is modified.
 *
 * The `participant_joined` audit kind is likewise a private storage event kind.
 * The frozen protocol `EVENT_KINDS` vocabulary is untouched; the durable
 * `audit_event.kind` column is free text in the accepted v1 DDL, and this
 * module owns the validation for the one kind P1B appends.
 */

export const PARTICIPANT_ID_PREFIX = "prt_" as const;
export const PARTICIPANT_ID_PATTERN = /^prt_[0-9A-HJKMNP-TV-Z]{26}$/;

/** 256-bit capability token, hex-encoded behind a `cap_` prefix. */
export const HOST_CAPABILITY_BYTES = 32;
export const CAPABILITY_PATTERN = /^cap_[0-9a-f]{64}$/;

export const PARTICIPANT_JOINED_EVENT_KIND = "participant_joined" as const;

const ULID_RANDOM_BYTES = 10;

export function generateParticipantId(now: number): string {
  return PARTICIPANT_ID_PREFIX + encodeUlid(now, randomBytes(ULID_RANDOM_BYTES));
}

export function isParticipantId(value: unknown): value is string {
  return typeof value === "string" && PARTICIPANT_ID_PATTERN.test(value);
}

/** Fixed sanitized request refusal: never echoes a capability, secret, stored
 * value, SQL fragment, or filesystem path. */
export class ParticipantRequestError extends Error {
  readonly code = "STORAGE_PARTICIPANT_REQUEST_INVALID";
  readonly retryable = false;
  /** R1: when a request rejection is raised inside an owned transaction (for
   * example transaction-time clock validation), the transaction has been
   * provably rolled back before this error surfaces. */
  readonly outcome = "ROLLED_BACK";

  constructor(detail: string) {
    super(`participant request rejected: ${detail}`);
    this.name = "ParticipantRequestError";
  }
}

export function rejectRequest(detail: string): never {
  throw new ParticipantRequestError(detail);
}

/** Capture enumerable own fields once, mirroring the accepted B2 creation
 * request discipline: no prototype pollution, no accessor re-entry, no unknown
 * fields, and never a retained caller-thrown error. */
export function captureFields(
  input: unknown,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): Record<string, unknown> {
  try {
    if (typeof input !== "object" || input === null) rejectRequest(`${path}: expected object`);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) rejectRequest(`${path}: expected plain object`);
    const keys = Reflect.ownKeys(input);
    for (const key of keys) {
      if (typeof key !== "string" || !allowed.includes(key)) rejectRequest(`${path}: unknown field`);
      if (!Object.getOwnPropertyDescriptor(input, key)?.enumerable) rejectRequest(`${path}: non-enumerable field`);
    }
    for (const key of required) {
      if (!keys.includes(key)) rejectRequest(`${path}: missing required field`);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) result[key as string] = (input as Record<PropertyKey, unknown>)[key];
    return result;
  } catch {
    return rejectRequest(`${path}: invalid fields or inaccessible input`);
  }
}

export function requireText(value: unknown, path: string, maximum: number, noNul = false): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\uD800-\uDFFF]/u.test(value) ||
    (noNul && value.includes("\u0000"))
  ) {
    rejectRequest(`${path}: invalid string`);
  }
  return value;
}

export function requireIdempotencyKey(value: unknown, path: string): string {
  return requireText(value, path, IDEMPOTENCY_KEY_MAX_LENGTH, true);
}

export function requireParticipantId(value: unknown, path: string): string {
  const text = requireText(value, path, 30);
  if (!PARTICIPANT_ID_PATTERN.test(text)) rejectRequest(`${path}: invalid identity`);
  return text;
}

/** ISO-8601 millisecond UTC instants only, matching the accepted B2 clock
 * discipline for durable timestamps. */
export function requireInstant(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    rejectRequest(`${path}: invalid instant`);
  }
  return value;
}

/**
 * Session identity (CE-0002-B3-P2A): an opaque, non-secret `ses_<ULID>`
 * SessionRef. A Session is never a Participant identity and never a
 * credential. Shared by the ownership plane and by Session-bound capability
 * issuance (CE-0002-B3-P2A-R1).
 */
export const SESSION_ID_PREFIX = "ses_" as const;
export const SESSION_ID_PATTERN = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function requireSessionId(value: unknown, path: string): string {
  const text = requireText(value, path, 30);
  if (!SESSION_ID_PATTERN.test(text)) rejectRequest(`${path}: invalid identity`);
  return text;
}
