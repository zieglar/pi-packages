import { StoreLifecycleError } from "./errors.js";
import { SESSION_ID_PATTERN } from "./participant-identity.js";

/**
 * Session lifecycle state (CE-0002-B3-P2C-A). Private storage plane only.
 *
 * A durable `participant_session` row is in exactly one of two states:
 *
 * - ATTACHED: `detached_at IS NULL` and `private_revision = 1`;
 * - DETACHED: `detached_at` is a canonical instant and `private_revision = 2`.
 *
 * Every other combination is malformed durable state: it is refused by the
 * caller as corruption and is never repaired. DETACHED is terminal: schema v4
 * triggers forbid deleting a Session row, rewriting its identity or
 * `bound_at`, reverting or repeating the detach, and detaching the current
 * Owner Session. A Session ID is therefore never reused, and a detached
 * Session never regains active authority.
 *
 * This module has no dependency on the refusal vocabulary of the
 * Participant/ownership planes: parsing returns `undefined` for malformed
 * rows and each caller classifies the refusal with its own typed code.
 * Canonicality is shared with the schema: the v4
 * `participant_session_detach_once` trigger enforces the same
 * canonical-instant rule on the detach UPDATE path (see `schema.ts` for the
 * exact SQLite-versus-application boundary); this parser remains the
 * authority for every row read.
 */

export type SessionLifecycleState = "ATTACHED" | "DETACHED";

export const ATTACHED_SESSION_REVISION = "1";
export const DETACHED_SESSION_REVISION = "2";

export interface SessionRowState {
  readonly participantId: string;
  readonly sessionId: string;
  readonly boundAt: string;
  readonly state: SessionLifecycleState;
  /** Present exactly when `state` is DETACHED. */
  readonly detachedAt: string | null;
}

/** Column list that every Session-row reader must use: the revision is read
 * through its exact decimal text so no out-of-range value is silently
 * rounded. */
export const SESSION_COLUMNS =
  "SELECT participant_id, session_id, bound_at, detached_at, CAST(private_revision AS TEXT) AS private_revision FROM participant_session";

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isCanonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Parses one row selected with `SESSION_COLUMNS`. Returns `undefined` for
 * any malformed row: a non-canonical identity or instant, or any
 * `(detached_at, private_revision)` combination other than ATTACHED (NULL, 1)
 * or DETACHED (instant, 2). A detach recorded before its own binding is also
 * malformed: lifecycle history is ordered. */
export function parseSessionRow(row: unknown): SessionRowState | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const value = row as Record<string, unknown>;
  if (
    typeof value.participant_id !== "string" ||
    typeof value.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(value.session_id) ||
    !isCanonicalInstant(value.bound_at)
  ) {
    return undefined;
  }
  let state: SessionLifecycleState;
  if (value.detached_at === null && value.private_revision === ATTACHED_SESSION_REVISION) {
    state = "ATTACHED";
  } else if (
    isCanonicalInstant(value.detached_at) &&
    value.private_revision === DETACHED_SESSION_REVISION &&
    Date.parse(value.detached_at) >= Date.parse(value.bound_at)
  ) {
    state = "DETACHED";
  } else {
    return undefined;
  }
  return Object.freeze({
    participantId: value.participant_id,
    sessionId: value.session_id,
    boundAt: value.bound_at,
    state,
    detachedAt: state === "DETACHED" ? (value.detached_at as string) : null,
  });
}

interface SessionQueryHandle {
  prepare(sql: string): { get(...parameters: string[]): unknown; all(...parameters: string[]): unknown[] };
}

/**
 * Migration precondition for schema v4 (CE-0002-B3-P2C-A), evaluated against
 * a v2 or v3 store. No v2 or v3 operation ever detaches a Session or advances
 * a Session row's revision, so every pre-v4 Session row must be exactly
 * ATTACHED (NULL, revision 1) and no ownership row may reference a detached
 * Session. Anything else is foreign durable state: the migration refuses it
 * (STORAGE_CORRUPT, zero writes) and never repairs, adopts, or reinterprets
 * it.
 */
export function assertPreV4SessionState(handle: SessionQueryHandle): void {
  const refuse = (): never => {
    throw new StoreLifecycleError(
      "STORAGE_CORRUPT",
      "stored Session lifecycle state is inconsistent; operator review required",
    );
  };
  for (const row of handle.prepare(SESSION_COLUMNS).all()) {
    const parsed = parseSessionRow(row);
    if (parsed === undefined || parsed.state !== "ATTACHED") refuse();
  }
  const ownerOfDetached = handle
    .prepare(
      "SELECT 1 FROM participant_ownership o JOIN participant_session s ON s.session_id = o.session_id WHERE s.detached_at IS NOT NULL LIMIT 1",
    )
    .get();
  if (ownerOfDetached !== undefined) refuse();
}
