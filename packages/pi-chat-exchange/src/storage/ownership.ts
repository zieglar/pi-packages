import { randomBytes } from "node:crypto";
import { encodeUlid } from "../protocol/identity.js";
import {
  captureFields,
  rejectRequest,
  requireInstant,
  requireParticipantId,
  requireSessionId,
  SESSION_ID_PATTERN,
  SESSION_ID_PREFIX,
} from "./participant-identity.js";
import {
  authorize,
  clock,
  hook,
  readParticipantRow,
  refuse,
  runOwned,
  type ClockSeam,
} from "./participant.js";
import { parseSessionRow, SESSION_COLUMNS, type SessionLifecycleState } from "./session-state.js";
import type { DurableStore } from "./store.js";
import { requireSingleRowChange, type TransactionHandle } from "./transaction.js";

/**
 * Session binding, Participant ownership, leases, and fencing
 * (CE-0002-B3-P2A, remediated by CE-0002-B3-P2A-R1; takeover added by
 * CE-0002-B3-P2B). Private storage plane
 * only: nothing here is re-exported from the package barrel, there is no
 * delivery API, no adapter wiring, and no background heartbeat.
 *
 * Model
 * - A Session is identified by an opaque, non-secret `ses_<ULID>` SessionRef.
 *   It is never a Participant identity and never a credential: every
 *   operation additionally requires a Host Capability of the exact scope,
 *   and `resume`/`takeover` capabilities are additionally bound to exactly one
 *   Session.
 * - `bindSession` (scope `attach`) durably records that a Session belongs to
 *   one Participant. A Participant may accumulate many historical Sessions; a
 *   Session belongs to exactly one Participant (durably unique since v3).
 * - `acquireOwnership` (scope `attach`) is admitted only when NO ownership
 *   row exists for the Participant (R1 design clarification Q1: replacing any
 *   existing Owner, including an expired one, is takeover; an existing row is
 *   `OWNERSHIP_HELD` while live and `OWNERSHIP_TAKEOVER_REQUIRED` once
 *   expired). It allocates the next fencing token and writes the lease in the
 *   same owned transaction.
 * - `takeoverOwnership` (scope `takeover`, CE-0002-B3-P2B) replaces an EXISTING
 *   expired or legacy (NULL `lease_started_at`) Owner with a bound target
 *   Session, atomically allocating exactly high-water + 1 and persisting a new
 *   lease term in one owned IMMEDIATE transaction. A live Owner refuses
 *   (`OWNERSHIP_HELD`), a clock-regressed lease refuses
 *   (`LEASE_CLOCK_REGRESSION`), an absent ownership row refuses
 *   (`OWNERSHIP_TAKEOVER_INELIGIBLE` — initial acquisition remains the attach
 *   operation), and corrupt state refuses (`STORAGE_OWNERSHIP_CORRUPT`). There
 *   is no force takeover of a live Owner. The takeover capability is
 *   Session-bound to the prospective new Owner Session, consistent with the
 *   accepted resume model: a Session ID alone never grants takeover authority.
 * - `reconcileTakeover` is a zero-write, fail-closed reconciliation read for
 *   an uncertain takeover outcome (for example INDETERMINATE). It classifies
 *   the current durable relationship to the caller's request evidence
 *   (Participant, target Session, term boundaries, optional fencing token) as
 *   COMMITTED / NO_TRACE / EVIDENCE_CONFLICT. It never invents exactly-once
 *   semantics: a refused and a rolled-back takeover are indistinguishable
 *   post-hoc (both are zero-write), and a committed-then-superseded takeover
 *   reports NO_TRACE. Retrying is safe only because every attempt is freshly
 *   authorized and eligibility-checked; EVIDENCE_CONFLICT is operator review,
 *   never an automatic retry.
 * - `detachSession` (scope `resume`, CE-0002-B3-P2C-B, D4) performs the
 *   authorized one-way ATTACHED → DETACHED transition of the Session the
 *   resume capability is durably bound to — self only, never a Session ID
 *   as credential. The current Owner Session is refused in every lease
 *   state (`SESSION_IS_CURRENT_OWNER`; Q5), a clock before `bound_at`
 *   refuses (`SESSION_CLOCK_REGRESSION`), and the guarded revision-1 → 2
 *   update must change exactly one row. Detach never touches ownership,
 *   fencing, or capability rows; the persisted `detached_at` invalidates
 *   every Session-bound capability at read time (D7) — caller-visibly as the
 *   one opaque `CAPABILITY_REJECTED`, host-locally as `SESSION_DETACHED`.
 * - `reconcileDetach` is the matching zero-write, fail-closed
 *   reconciliation read after an uncertain outcome (BUSY, ROLLED_BACK,
 *   INDETERMINATE, lost response): COMMITTED / NO_TRACE / EVIDENCE_CONFLICT
 *   classified from the durable Session state alone. A committed Detach is
 *   terminal; the durable effect is idempotent but the API response is not
 *   (a retry refuses), so reconcile first and never blindly retry.
 * - `renewLease`, `releaseOwnership`, and `verifyOwnership` (scope `resume`)
 *   require the current Owner Session, a Session-bound resume capability, the
 *   current fencing token, and an unexpired lease, all evaluated inside the
 *   same owned transaction.
 *
 * Fencing
 * - Per Participant, `participant_fencing_high_water` holds the highest token
 *   ever allocated. The first acquisition allocates token 1 and inserts the
 *   high-water row; every later acquisition allocates exactly high-water + 1.
 *   The row is never decremented or deleted, so tokens survive restart, lease
 *   expiry, and release, and are never reused. Allocation beyond
 *   `Number.MAX_SAFE_INTEGER` is refused (`FENCING_EXHAUSTED`).
 * - An ownership row must always carry exactly the current high-water token
 *   and a bound Session; anything else is refused as
 *   `STORAGE_OWNERSHIP_CORRUPT`, never adopted or repaired.
 *
 * Leases (R1: persisted term boundaries)
 * - Default TTL 120 s, configurable 30-3600 s; 30 s is a renewal
 *   recommendation for hosts, not a scheduler. Time comes only from the
 *   injected clock seam, sampled once per operation at transaction time —
 *   inside the owned transaction, after BEGIN IMMEDIATE has acquired the
 *   writer lock (CE-0002-B3-P2B-R1): authorization, lease evaluation, and
 *   the persisted term boundaries never use a stale pre-lock instant, so a
 *   renewal serialized after expiry refuses LEASE_EXPIRED instead of
 *   reviving the lease, and a capability that expired during a lock wait is
 *   never accepted.
 * - The lease term is durably persisted: `lease_started_at` is written at
 *   acquisition and updated at every renewal. A lease authorizes only within
 *   `[leaseStartedAt, expiresAt)`. An instant at or after expiry is
 *   `LEASE_EXPIRED`; an instant before the persisted start (a wall-clock
 *   rollback across the term boundary) is `LEASE_CLOCK_REGRESSION`, so a
 *   rolled-back clock can never renew, and therefore never extend, a lease.
 *   A request TTL is used ONLY to compute a new expiry at acquisition or
 *   renewal; it never reinterprets a stored term.
 * - A legacy v2 ownership row (NULL `lease_started_at`) is treated as expired
 *   at every instant: no lease start is fabricated from an untrusted TTL and
 *   no v3 operation ever authorizes against it.
 * - A rollback that lands inside the current term is indistinguishable from a
 *   valid instant without a persisted monotonic observation; refusals are
 *   zero-write, so none is recorded.
 */

export { SESSION_ID_PATTERN, SESSION_ID_PREFIX } from "./participant-identity.js";

export const LEASE_DEFAULT_TTL_SECONDS = 120;
export const LEASE_RENEWAL_RECOMMENDATION_SECONDS = 30;
export const LEASE_MIN_TTL_SECONDS = 30;
export const LEASE_MAX_TTL_SECONDS = 3600;

export const FIRST_FENCING_TOKEN = 1;
export const FENCING_TOKEN_MAX = Number.MAX_SAFE_INTEGER;

const ULID_RANDOM_BYTES = 10;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function generateSessionId(now: number = Date.now()): string {
  return SESSION_ID_PREFIX + encodeUlid(now, randomBytes(ULID_RANDOM_BYTES));
}

// ---------------------------------------------------------------------------
// Request validation (sanitized; never echoes a value)
// ---------------------------------------------------------------------------

function requireFencingToken(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < FIRST_FENCING_TOKEN) {
    rejectRequest(`${path}: invalid fencing token`);
  }
  return value;
}

function requireLeaseTtl(fields: Record<string, unknown>): number {
  if (!Object.hasOwn(fields, "leaseTtlSeconds")) return LEASE_DEFAULT_TTL_SECONDS;
  const value = fields.leaseTtlSeconds;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < LEASE_MIN_TTL_SECONDS ||
    value > LEASE_MAX_TTL_SECONDS
  ) {
    rejectRequest("leaseTtlSeconds: out of range");
  }
  return value;
}

/** Expiry is computed at transaction time, from the operation clock sampled
 * inside the owned transaction (B3-P2B-R1). An unrepresentable instant raises
 * a request refusal (`ParticipantRequestError`), which `runOwned` surfaces as
 * itself after a proven rollback: zero writes, never a generic transaction
 * failure. */
function leaseExpiry(now: string, ttlSeconds: number): string {
  const instant = new Date(Date.parse(now) + ttlSeconds * 1000);
  const text = Number.isFinite(instant.getTime()) ? instant.toISOString() : "";
  return requireInstant(text, "lease expiry");
}

// ---------------------------------------------------------------------------
// Durable rows (strict validation; inconsistency is refused, never repaired)
// ---------------------------------------------------------------------------

/** Satisfied by the owned-transaction handle and by a raw read connection. */
interface QueryHandle {
  prepare(sql: string): {
    get(...parameters: string[]): unknown;
    all(...parameters: string[]): unknown[];
  };
}

function corrupt(): never {
  return refuse("STORAGE_OWNERSHIP_CORRUPT");
}

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

/** Reads an INTEGER column through its exact decimal text so a value outside
 * the safe-integer range is detected instead of silently rounded. */
function safeToken(text: unknown): number {
  if (typeof text !== "string" || !/^[1-9][0-9]{0,15}$/.test(text)) corrupt();
  const value = Number(text);
  if (!Number.isSafeInteger(value) || String(value) !== text) corrupt();
  return value;
}

export interface SessionBinding {
  readonly participantId: string;
  readonly sessionId: string;
  readonly boundAt: string;
}

interface SessionRowView extends SessionBinding {
  readonly detached: boolean;
  readonly detachedAt: string | null;
}

/** Strict Session-row validation (CE-0002-B3-P2C-A): exactly ATTACHED
 * (NULL `detached_at`, revision 1) or DETACHED (canonical instant, revision
 * 2); every other combination is `STORAGE_OWNERSHIP_CORRUPT`, refused and
 * never repaired. A DETACHED Session is never a current binding. */
function sessionFromRow(row: unknown): SessionRowView {
  const parsed = parseSessionRow(row);
  if (parsed === undefined) corrupt();
  return Object.freeze({
    participantId: parsed.participantId,
    sessionId: parsed.sessionId,
    boundAt: parsed.boundAt,
    detached: parsed.state === "DETACHED",
    detachedAt: parsed.detachedAt,
  });
}

function sessionRow(
  handle: QueryHandle,
  participantId: string,
  sessionId: string,
): SessionRowView | undefined {
  const row = handle.prepare(`${SESSION_COLUMNS} WHERE participant_id = ? AND session_id = ?`).get(participantId, sessionId);
  if (row === undefined) return undefined;
  const session = sessionFromRow(row);
  if (session.participantId !== participantId || session.sessionId !== sessionId) corrupt();
  return session;
}

function sessionOwnedElsewhere(handle: QueryHandle, participantId: string, sessionId: string): boolean {
  const row = handle
    .prepare("SELECT participant_id FROM participant_session WHERE session_id = ? AND participant_id <> ? LIMIT 1")
    .get(sessionId, participantId);
  return row !== undefined;
}

export interface OwnershipRecord {
  readonly participantId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly expiresAt: string;
  /** Persisted start of the current lease term (R1). NULL only on legacy v2
   * rows, which no v3 operation may authorize. */
  readonly leaseStartedAt: string | null;
}

interface OwnershipState {
  readonly ownership: OwnershipRecord | undefined;
  /** Highest fencing token ever allocated; 0 when none has been. */
  readonly highWater: number;
}

function ownershipRow(handle: QueryHandle, participantId: string): OwnershipRecord | undefined {
  const row = handle
    .prepare(
      "SELECT participant_id, session_id, CAST(fencing_token AS TEXT) AS fencing_token, expires_at, lease_started_at, CAST(private_revision AS TEXT) AS private_revision FROM participant_ownership WHERE participant_id = ?",
    )
    .get(participantId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (
    row.participant_id !== participantId ||
    typeof row.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(row.session_id) ||
    !isInstant(row.expires_at) ||
    !(row.lease_started_at === null || isInstant(row.lease_started_at)) ||
    typeof row.private_revision !== "string" ||
    !/^[1-9][0-9]*$/.test(row.private_revision)
  ) {
    corrupt();
  }
  return Object.freeze({
    participantId,
    sessionId: row.session_id as string,
    fencingToken: safeToken(row.fencing_token),
    expiresAt: row.expires_at as string,
    leaseStartedAt: row.lease_started_at as string | null,
  });
}

function highWaterRow(handle: QueryHandle, participantId: string): number | undefined {
  const row = handle
    .prepare(
      "SELECT participant_id, CAST(fencing_token AS TEXT) AS fencing_token, CAST(private_revision AS TEXT) AS private_revision FROM participant_fencing_high_water WHERE participant_id = ?",
    )
    .get(participantId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (
    row.participant_id !== participantId ||
    typeof row.private_revision !== "string" ||
    !/^[1-9][0-9]*$/.test(row.private_revision)
  ) {
    corrupt();
  }
  return safeToken(row.fencing_token);
}

/** One consistent view of a Participant's ownership and fencing: an
 * ownership row must carry exactly the current high-water token and belong to
 * a bound, attached Session of the same Participant. */
function loadOwnershipState(handle: QueryHandle, participantId: string): OwnershipState {
  const ownership = ownershipRow(handle, participantId);
  const highWater = highWaterRow(handle, participantId);
  if (ownership !== undefined) {
    if (highWater === undefined || ownership.fencingToken !== highWater) corrupt();
    const session = sessionRow(handle, participantId, ownership.sessionId);
    if (session === undefined || session.detached) corrupt();
  }
  return { ownership, highWater: highWater ?? 0 };
}

type LeaseEvaluation = "ACTIVE" | "EXPIRED" | "CLOCK_REGRESSION";

/** Evaluates the lease against the persisted term boundaries only. A request
 * TTL is never an input: a stored term is never reinterpreted. A legacy v2 row
 * (NULL start) is expired at every instant, so no lease start is fabricated
 * and no legacy row ever authorizes. */
function evaluateLease(ownership: OwnershipRecord, now: string): LeaseEvaluation {
  if (ownership.leaseStartedAt === null) return "EXPIRED";
  const nowMs = Date.parse(now);
  if (nowMs >= Date.parse(ownership.expiresAt)) return "EXPIRED";
  if (nowMs < Date.parse(ownership.leaseStartedAt)) return "CLOCK_REGRESSION";
  return "ACTIVE";
}
// ---------------------------------------------------------------------------
// Owner authorization (in-transaction primitive)
// ---------------------------------------------------------------------------

export interface OwnerPresentation {
  readonly capability: unknown;
  readonly participantId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly now: string;
  /** Defaults to `resume` for accepted P2 owner operations. Later callers
   * must present their exact Session-bound operation scope. */
  readonly scope?: "resume" | "send" | "read" | "payload_read" | "ack";
}

/**
 * Current-Owner authorization inside the caller's owned transaction. In order:
 * a currently valid capability for the exact requested Session-bound scope
 * (defaulting to accepted P2 `resume`), the Participant, an attached bound
 * Session, the Session being the current Owner, the presented fencing token
 * being current, and the lease being unexpired and not clock-regressed against
 * its persisted start. Ownership is never inferred from the Session ID: the
 * durable ownership row decides.
 */
export function authorizeCurrentOwner(
  tx: TransactionHandle,
  store: DurableStore,
  presentation: OwnerPresentation,
): OwnershipRecord {
  const { participantId, sessionId, fencingToken, now } = presentation;
  authorize(tx, store, {
    capability: presentation.capability,
    participantId,
    scope: presentation.scope ?? "resume",
    now,
    sessionId,
  });
  if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
  const session = sessionRow(tx, participantId, sessionId);
  if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
  const { ownership } = loadOwnershipState(tx, participantId);
  if (ownership === undefined || ownership.sessionId !== sessionId) refuse("OWNERSHIP_NOT_CURRENT");
  if (ownership.fencingToken !== fencingToken) refuse("FENCING_STALE");
  const lease = evaluateLease(ownership, now);
  if (lease === "EXPIRED") refuse("LEASE_EXPIRED");
  if (lease === "CLOCK_REGRESSION") refuse("LEASE_CLOCK_REGRESSION");
  return ownership;
}

const OWNER_FIELDS = ["participantId", "sessionId", "fencingToken", "capability"] as const;

function ownerFields(input: unknown, extra: readonly string[] = []): Record<string, unknown> {
  return captureFields(input, [...OWNER_FIELDS, ...extra], [...OWNER_FIELDS], "request");
}

function normalizeOwnerRequest(fields: Record<string, unknown>, now: string): OwnerPresentation {
  return Object.freeze({
    capability: fields.capability,
    participantId: requireParticipantId(fields.participantId, "participantId"),
    sessionId: requireSessionId(fields.sessionId, "sessionId"),
    fencingToken: requireFencingToken(fields.fencingToken, "fencingToken"),
    now,
  });
}

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

export interface BindSessionSeams extends ClockSeam {
  readonly afterSessionInsert?: () => void;
}

/**
 * Durably binds a Session to a Participant under a valid `attach` capability.
 * Binding never confers ownership. A duplicate binding is refused
 * (`SESSION_ALREADY_BOUND`) and a Session already bound to another
 * Participant is refused (`SESSION_BOUND_TO_OTHER_PARTICIPANT`); both are
 * zero-write.
 */
export function bindSession(store: DurableStore, input: unknown, seams: BindSessionSeams = {}): SessionBinding {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "capability"],
    ["participantId", "sessionId", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const sessionId = requireSessionId(fields.sessionId, "sessionId");
  const capability = fields.capability;
  const afterSessionInsert = seams.afterSessionInsert;

  return runOwned(store, "Session binding", (tx) => {
    // R1: the operation clock is sampled at transaction time, after BEGIN
    // IMMEDIATE has acquired the writer lock, so the capability expiry check
    // never evaluates against a stale pre-lock instant.
    const boundAt = clock(seams);
    authorize(tx, store, { capability, participantId, scope: "attach", now: boundAt });
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    if (sessionRow(tx, participantId, sessionId) !== undefined) refuse("SESSION_ALREADY_BOUND");
    if (sessionOwnedElsewhere(tx, participantId, sessionId)) refuse("SESSION_BOUND_TO_OTHER_PARTICIPANT");
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
        )
        .run(participantId, sessionId, boundAt),
      "session insert",
    );
    hook(afterSessionInsert);
    return Object.freeze({ participantId, sessionId, boundAt });
  });
}

// ---------------------------------------------------------------------------
// Ownership acquisition, renewal, release, verification
// ---------------------------------------------------------------------------

export interface OwnershipLease extends OwnershipRecord {
  readonly leaseTtlSeconds: number;
  /** Persisted term start written by this operation. Never null on a v3 write. */
  readonly leaseStartedAt: string;
}

export interface AcquireOwnershipSeams extends ClockSeam {
  readonly afterFencingWrite?: () => void;
  readonly afterOwnershipWrite?: () => void;
}

/**
 * Explicit acquisition for a Participant with NO existing ownership row, under
 * a valid `attach` capability and a bound Session. The fencing allocation and
 * the ownership write are one atomic unit.
 *
 * R1 acquisition boundary (design clarification Q1): any existing ownership
 * row refuses acquisition — `OWNERSHIP_HELD` while the lease is live at the
 * operation's clock, `OWNERSHIP_TAKEOVER_REQUIRED` once expired (including a
 *   legacy v2 row, which is expired at every instant). Replacing an existing
 *   Owner is `takeoverOwnership` (CE-0002-B3-P2B). There is no silent adoption.
 *
 * The new lease term is persisted: `lease_started_at = now` and
 * `expires_at = now + ttl`.
 */
export function acquireOwnership(
  store: DurableStore,
  input: unknown,
  seams: AcquireOwnershipSeams = {},
): OwnershipLease {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "capability", "leaseTtlSeconds"],
    ["participantId", "sessionId", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const sessionId = requireSessionId(fields.sessionId, "sessionId");
  const leaseTtlSeconds = requireLeaseTtl(fields);
  const capability = fields.capability;
  const afterFencingWrite = seams.afterFencingWrite;
  const afterOwnershipWrite = seams.afterOwnershipWrite;

  return runOwned(store, "Ownership acquisition", (tx) => {
    // R1: transaction-time clock — sampled after the writer lock is held, so
    // authorization, eligibility, and the persisted term boundaries all derive
    // from the serialization instant, never from a stale pre-lock sample.
    const now = clock(seams);
    const expiresAt = leaseExpiry(now, leaseTtlSeconds);
    authorize(tx, store, { capability, participantId, scope: "attach", now });
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    const session = sessionRow(tx, participantId, sessionId);
    if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
    const { ownership: previous, highWater } = loadOwnershipState(tx, participantId);
    if (previous !== undefined) {
      if (evaluateLease(previous, now) === "EXPIRED") refuse("OWNERSHIP_TAKEOVER_REQUIRED");
      refuse("OWNERSHIP_HELD");
    }
    if (highWater >= FENCING_TOKEN_MAX) refuse("FENCING_EXHAUSTED");
    const fencingToken = highWater + 1;

    if (highWater === 0) {
      requireSingleRowChange(
        tx
          .prepare(
            "INSERT INTO participant_fencing_high_water(participant_id, fencing_token, private_revision) VALUES (?, ?, 1)",
          )
          .run(participantId, fencingToken),
        "fencing allocation",
      );
    } else {
      requireSingleRowChange(
        tx
          .prepare(
            "UPDATE participant_fencing_high_water SET fencing_token = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND fencing_token = ?",
          )
          .run(fencingToken, participantId, highWater),
        "fencing allocation",
      );
    }
    hook(afterFencingWrite);

    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, lease_started_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .run(participantId, sessionId, fencingToken, expiresAt, now),
      "ownership insert",
    );
    hook(afterOwnershipWrite);
    return Object.freeze({ participantId, sessionId, fencingToken, expiresAt, leaseTtlSeconds, leaseStartedAt: now });
  });
}

export interface RenewLeaseSeams extends ClockSeam {
  readonly afterOwnershipWrite?: () => void;
}

/**
 * Explicit renewal by the current Owner: a Session-bound `resume` capability,
 * current fencing token, and an unexpired, non-regressed lease evaluated
 * against the persisted term start. The request TTL is used only to compute
 * the NEW expiry (`now + ttl`); the persisted term start advances to `now`,
 * so renewal can never extend a lease from a rolled-back clock and never
 * reinterprets a stored term. The fencing token is unchanged.
 */
export function renewLease(store: DurableStore, input: unknown, seams: RenewLeaseSeams = {}): OwnershipLease {
  const fields = ownerFields(input, ["leaseTtlSeconds"]);
  const leaseTtlSeconds = requireLeaseTtl(fields);
  const afterOwnershipWrite = seams.afterOwnershipWrite;

  return runOwned(store, "Lease renewal", (tx) => {
    // R1: transaction-time clock — sampled after the writer lock is held. A
    // renewal initiated before expiry but serialized after it evaluates the
    // persisted term at the serialization instant and refuses LEASE_EXPIRED;
    // it can never revive an expired lease from a stale pre-lock sample.
    const now = clock(seams);
    const expiresAt = leaseExpiry(now, leaseTtlSeconds);
    const presentation = normalizeOwnerRequest(fields, now);
    const current = authorizeCurrentOwner(tx, store, presentation);
    // Renewal never shortens the term: the new expiry must not precede the
    // current one. (The request TTL only computes the new expiry; it never
    // reinterprets the stored term.)
    if (Date.parse(expiresAt) < Date.parse(current.expiresAt)) refuse("LEASE_TERM_SHORTENED");
    requireSingleRowChange(
      tx
        .prepare(
          "UPDATE participant_ownership SET expires_at = ?, lease_started_at = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND session_id = ? AND fencing_token = ? AND expires_at = ?",
        )
        .run(expiresAt, now, current.participantId, current.sessionId, current.fencingToken, current.expiresAt),
      "lease renewal",
    );
    hook(afterOwnershipWrite);
    return Object.freeze({
      participantId: current.participantId,
      sessionId: current.sessionId,
      fencingToken: current.fencingToken,
      expiresAt,
      leaseTtlSeconds,
      leaseStartedAt: now,
    });
  });
}

export interface OwnershipRelease {
  readonly participantId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly releasedAt: string;
}

export interface ReleaseOwnershipSeams extends ClockSeam {
  readonly afterOwnershipDelete?: () => void;
}

/**
 * Explicit release by the current Owner. Only the ownership row is removed;
 * the fencing high-water is untouched, so the next acquisition still
 * allocates a strictly greater token.
 */
export function releaseOwnership(
  store: DurableStore,
  input: unknown,
  seams: ReleaseOwnershipSeams = {},
): OwnershipRelease {
  const fields = ownerFields(input);
  const afterOwnershipDelete = seams.afterOwnershipDelete;

  return runOwned(store, "Ownership release", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held.
    const now = clock(seams);
    const current = authorizeCurrentOwner(tx, store, normalizeOwnerRequest(fields, now));
    requireSingleRowChange(
      tx
        .prepare(
          "DELETE FROM participant_ownership WHERE participant_id = ? AND session_id = ? AND fencing_token = ? AND expires_at = ?",
        )
        .run(current.participantId, current.sessionId, current.fencingToken, current.expiresAt),
      "ownership release",
    );
    hook(afterOwnershipDelete);
    return Object.freeze({
      participantId: current.participantId,
      sessionId: current.sessionId,
      fencingToken: current.fencingToken,
      releasedAt: now,
    });
  });
}

export interface TakeoverOwnershipSeams extends ClockSeam {
  readonly afterFencingWrite?: () => void;
  readonly afterOwnershipWrite?: () => void;
}

/**
 * Explicit Owner takeover (CE-0002-B3-P2B), scope `takeover`. Replaces an
 * EXISTING expired or legacy (NULL `lease_started_at`) Owner with a bound
 * target Session — never an absent row (initial acquisition remains the
 * `attach` operation), never a live Owner (no force takeover in this phase),
 * and never a clock-regressed lease.
 *
 * Authorization: a currently valid `takeover` capability durably bound to the
 * target Session (the prospective new Owner), evaluated inside the same owned
 * transaction as the replacement. A Session ID alone never grants takeover
 * authority.
 *
 * Atomicity: eligibility, fencing allocation (exactly high-water + 1), and
 * the Owner replacement commit or roll back as one IMMEDIATE unit — exactly
 * one winner, no partial fencing allocation, no partial replacement, no token
 * reuse, overflow refused (`FENCING_EXHAUSTED`), and every refusal path is
 * zero-write. The high-water and ownership UPDATEs are guarded by the exact
 * pre-read values, so any interleaved change fails the single-row check and
 * rolls back rather than adopting foreign state.
 *
 * The superseded Session loses current ownership immediately: its fencing
 * token is stale, and its `resume` capability cannot renew, release, or
 * verify the new Owner (the durable ownership row decides, never the Session
 * ID). Historical Session bindings are preserved for audit continuity; no
 * Participant identity, membership, join boundary, or audit row is touched.
 *
 * The new lease term is persisted: `lease_started_at = now` and
 * `expires_at = now + ttl` (a legacy row's NULL start is replaced, never
 * reinterpreted).
 */
export function takeoverOwnership(
  store: DurableStore,
  input: unknown,
  seams: TakeoverOwnershipSeams = {},
): OwnershipLease {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "capability", "leaseTtlSeconds"],
    ["participantId", "sessionId", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const sessionId = requireSessionId(fields.sessionId, "sessionId");
  const leaseTtlSeconds = requireLeaseTtl(fields);
  const capability = fields.capability;
  const afterFencingWrite = seams.afterFencingWrite;
  const afterOwnershipWrite = seams.afterOwnershipWrite;

  return runOwned(store, "Ownership takeover", (tx) => {
    // R1: transaction-time clock — sampled after the writer lock is held, so
    // takeover eligibility and the persisted new term derive from the
    // serialization instant. A takeover can never win on a stale pre-lock
    // sample, and a live Owner at serialization always refuses.
    const now = clock(seams);
    const expiresAt = leaseExpiry(now, leaseTtlSeconds);
    authorize(tx, store, { capability, participantId, scope: "takeover", now, sessionId });
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    const session = sessionRow(tx, participantId, sessionId);
    if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
    const { ownership: previous, highWater } = loadOwnershipState(tx, participantId);
    if (previous === undefined) refuse("OWNERSHIP_TAKEOVER_INELIGIBLE");
    const lease = evaluateLease(previous, now);
    if (lease === "ACTIVE") refuse("OWNERSHIP_HELD");
    if (lease === "CLOCK_REGRESSION") refuse("LEASE_CLOCK_REGRESSION");
    // EXPIRED — including a legacy v2 row (NULL start), which is expired at
    // every instant and never authorized anything. Takeover replaces it with a
    // fully persisted v3 term; the NULL start is never reinterpreted.
    if (highWater >= FENCING_TOKEN_MAX) refuse("FENCING_EXHAUSTED");
    const fencingToken = highWater + 1;

    requireSingleRowChange(
      tx
        .prepare(
          "UPDATE participant_fencing_high_water SET fencing_token = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND fencing_token = ?",
        )
        .run(fencingToken, participantId, highWater),
      "fencing allocation",
    );
    hook(afterFencingWrite);

    requireSingleRowChange(
      tx
        .prepare(
          "UPDATE participant_ownership SET session_id = ?, fencing_token = ?, expires_at = ?, lease_started_at = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND session_id = ? AND fencing_token = ? AND expires_at = ?",
        )
        .run(sessionId, fencingToken, expiresAt, now, previous.participantId, previous.sessionId, previous.fencingToken, previous.expiresAt),
      "ownership takeover",
    );
    hook(afterOwnershipWrite);
    return Object.freeze({ participantId, sessionId, fencingToken, expiresAt, leaseTtlSeconds, leaseStartedAt: now });
  });
}

// ---------------------------------------------------------------------------
// Session detach (CE-0002-B3-P2C-B)
// ---------------------------------------------------------------------------

export interface SessionDetach {
  readonly participantId: string;
  readonly sessionId: string;
  readonly boundAt: string;
  readonly detachedAt: string;
}

export interface DetachSessionSeams extends ClockSeam {
  readonly afterSessionUpdate?: () => void;
}

/**
 * The authorized one-way ATTACHED → DETACHED transition (CE-0002-B3-P2C-B,
 * D4): performed by the Session's own Session-bound `resume` capability —
 * self only. The capability must authorize exactly its bound Session; a
 * Session ID alone is never a credential, and no `detach` scope exists.
 *
 * Inside one owned IMMEDIATE transaction, in order: the operation clock is
 * sampled after the writer lock is held; the capability is validated
 * (trust generation, expiry, revocation, Session binding — a DETACHED
 * Session's capability is already unusable there, so a repeat Detach of a
 * terminal Session refuses `CAPABILITY_REJECTED`); the Participant exists;
 * the Session is a currently bound ATTACHED row; the complete ownership
 * state is loaded and validated (an ownership row must carry exactly the
 * current fencing token and reference a bound, attached Session); the
 * Session is refused as `SESSION_IS_CURRENT_OWNER` while the ownership row
 * references it — live, expired, legacy, or clock-regressed alike, so the
 * way out of ownership is the existing release or takeover, never Detach
 * (Q5); a clock regressed before the persisted `bound_at` refuses
 * `SESSION_CLOCK_REGRESSION`; then exactly the guarded
 * `detached_at IS NULL AND private_revision = 1` → `detached_at = now,
 * private_revision = 2` update runs, requiring exactly one changed row.
 *
 * Detach never modifies the ownership row or the fencing high-water, never
 * deletes the Session row, and never mutates capability rows: the persisted
 * `detached_at` is the lifecycle source of truth, and every Session-bound
 * capability becomes unusable at read time from then on (see
 * `capability.ts`). Every refusal is zero-write. The schema v4 triggers are
 * the defense in depth behind these application checks.
 */
export function detachSession(store: DurableStore, input: unknown, seams: DetachSessionSeams = {}): SessionDetach {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "capability"],
    ["participantId", "sessionId", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const sessionId = requireSessionId(fields.sessionId, "sessionId");
  const capability = fields.capability;
  const afterSessionUpdate = seams.afterSessionUpdate;

  return runOwned(store, "Session detach", (tx) => {
    // Transaction-time clock: sampled after BEGIN IMMEDIATE has acquired the
    // writer lock, so the persisted detach instant and every authorization
    // decision derive from the serialization instant.
    const now = clock(seams);
    authorize(tx, store, { capability, participantId, scope: "resume", now, sessionId });
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    const session = sessionRow(tx, participantId, sessionId);
    if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
    const { ownership } = loadOwnershipState(tx, participantId);
    // Q5: the current Owner — live, expired, legacy, or clock-regressed — is
    // not detachable while the ownership row references its Session. The
    // check deliberately ignores lease state: an expired Owner must first be
    // superseded through the authorized takeover path (Q4: it cannot release).
    if (ownership !== undefined && ownership.sessionId === sessionId) {
      refuse("SESSION_IS_CURRENT_OWNER");
    }
    if (Date.parse(now) < Date.parse(session.boundAt)) refuse("SESSION_CLOCK_REGRESSION");
    requireSingleRowChange(
      tx
        .prepare(
          "UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE participant_id = ? AND session_id = ? AND detached_at IS NULL AND private_revision = 1",
        )
        .run(now, participantId, sessionId),
      "session detach",
    );
    hook(afterSessionUpdate);
    return Object.freeze({ participantId, sessionId, boundAt: session.boundAt, detachedAt: now });
  });
}

/** Zero-write current-Owner authorization, evaluated in an owned transaction
 * so it observes the same serialized state any mutation would. Returns the
 * durable record exactly as persisted, including the term start. */
export function verifyOwnership(store: DurableStore, input: unknown, seams: ClockSeam = {}): OwnershipRecord {
  const fields = ownerFields(input);
  // R1: transaction-time clock, sampled after the writer lock is held.
  return runOwned(store, "Ownership verification", (tx) =>
    authorizeCurrentOwner(tx, store, normalizeOwnerRequest(fields, clock(seams))),
  );
}

// ---------------------------------------------------------------------------
// Durable reads (private, host-local, no authorization semantics)
// ---------------------------------------------------------------------------

/** Runs several reads against one consistent snapshot: a deferred read
 * transaction whose snapshot is established by the first read inside `body`.
 * Reads authorize nothing. */
function readSnapshot<T>(store: DurableStore, body: (handle: QueryHandle) => T): T {
  const db = store.database;
  if (db.isTransaction) throw new Error("ownership reads cannot run inside an active transaction");
  db.exec("BEGIN");
  try {
    return body(db as unknown as QueryHandle);
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
  }
}

/** One Participant–Session binding, or undefined. Detached rows are not
 * current bindings and are reported as undefined. */
export function readSessionBinding(
  store: DurableStore,
  participantId: unknown,
  sessionId: unknown,
): SessionBinding | undefined {
  const pid = requireParticipantId(participantId, "participantId");
  const sid = requireSessionId(sessionId, "sessionId");
  return readSnapshot(store, (handle) => {
    const session = sessionRow(handle, pid, sid);
    if (session === undefined || session.detached) return undefined;
    return Object.freeze({ participantId: session.participantId, sessionId: session.sessionId, boundAt: session.boundAt });
  });
}

/** Every current Session binding of a Participant, oldest first. */
export function readSessionBindings(store: DurableStore, participantId: unknown): readonly SessionBinding[] {
  const pid = requireParticipantId(participantId, "participantId");
  return readSnapshot(store, (handle) =>
    Object.freeze(
      handle
        .prepare(`${SESSION_COLUMNS} WHERE participant_id = ? ORDER BY bound_at, session_id`)
        .all(pid)
        .map(sessionFromRow)
        .filter((session) => {
          if (session.participantId !== pid) corrupt();
          return !session.detached;
        })
        .map((session) =>
          Object.freeze({ participantId: session.participantId, sessionId: session.sessionId, boundAt: session.boundAt }),
        ),
    ),
  );
}

/** The durable ownership row, whether or not its lease is still live. Use
 * `readLeaseStatus` to evaluate it against a clock. */
export function readCurrentOwnership(store: DurableStore, participantId: unknown): OwnershipRecord | undefined {
  const pid = requireParticipantId(participantId, "participantId");
  return readSnapshot(store, (handle) => loadOwnershipState(handle, pid).ownership);
}

/** Highest fencing token ever allocated for the Participant; 0 when none. */
export function readFencingHighWater(store: DurableStore, participantId: unknown): number {
  const pid = requireParticipantId(participantId, "participantId");
  return readSnapshot(store, (handle) => loadOwnershipState(handle, pid).highWater);
}

export type LeaseStatus = "UNOWNED" | LeaseEvaluation;

export function readLeaseStatus(store: DurableStore, input: unknown, seams: ClockSeam = {}): LeaseStatus {
  const fields = captureFields(input, ["participantId"], ["participantId"], "request");
  const pid = requireParticipantId(fields.participantId, "participantId");
  return readSnapshot(store, (handle) => {
    // The clock is sampled once inside the deferred read transaction, before
    // the first read establishes the snapshot. The status is advisory: it
    // authorizes nothing and may already be stale when returned.
    const now = clock(seams);
    const { ownership } = loadOwnershipState(handle, pid);
    return ownership === undefined ? "UNOWNED" : evaluateLease(ownership, now);
  });
}

// ---------------------------------------------------------------------------
// Takeover reconciliation (zero-write, fail-closed; CE-0002-B3-P2B)
// ---------------------------------------------------------------------------

/** The durable evidence a takeover request would have persisted. The caller
 * knows every field from its own request (`now`, TTL) and result; the fencing
 * token is optional evidence that tightens the match when known. */
export interface TakeoverEvidence {
  readonly participantId: string;
  readonly sessionId: string;
  readonly leaseStartedAt: string;
  readonly expiresAt: string;
  readonly fencingToken?: number;
}

/** Fail-closed classification of the CURRENT durable relationship between a
 * takeover request's evidence and the ownership row:
 * - COMMITTED: the current row matches the evidence exactly (Session, term
 *   boundaries, and token when presented). A retry of the same logical request
 *   persists identical evidence, so an exact match is idempotent recognition,
 *   not a guess. Do not retry.
 * - NO_TRACE: the current state carries no trace of the request — no row, a
 *   legacy (NULL-start) row, a different Owner Session, or a same-Session row
 *   whose term predates the presented evidence (a committed write would have
 *   advanced the term start). The request did not commit, was refused, or its
 *   effects were later removed or superseded; these are indistinguishable from
 *   durable evidence alone. A fresh attempt is evaluated under current
 *   authorization and eligibility.
 * - EVIDENCE_CONFLICT: the presented target Session IS the current Owner but
 *   under different term or token evidence — the current state was installed
 *   by a different request. Never auto-retry: operator review.
 */
export type TakeoverReconciliationCode = "COMMITTED" | "NO_TRACE" | "EVIDENCE_CONFLICT";

export interface TakeoverReconciliation {
  readonly disposition: TakeoverReconciliationCode;
  /** The current durable ownership row exactly as persisted (undefined when
   * none exists). Host-local diagnostic detail; never an authorization. */
  readonly current: OwnershipRecord | undefined;
}

/** Zero-write reconciliation after an uncertain takeover outcome (for example
 * an INDETERMINATE transaction result). Reconciliation never relies on a
 * Session ID alone: the full evidence tuple (Participant, target Session, term
 * boundaries, optional fencing token) is compared against the durable row in
 * one consistent snapshot. It deliberately cannot distinguish a refused from a
 * rolled-back takeover (both are zero-write) and cannot distinguish a committed
 * request from a committed retry with identical parameters (they are the same
 * logical request); both limitations are documented rather than papered over
 * with invented exactly-once semantics. */
export function reconcileTakeover(store: DurableStore, input: unknown): TakeoverReconciliation {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "leaseStartedAt", "expiresAt", "fencingToken"],
    ["participantId", "sessionId", "leaseStartedAt", "expiresAt"],
    "request",
  );
  const pid = requireParticipantId(fields.participantId, "participantId");
  const sid = requireSessionId(fields.sessionId, "sessionId");
  const leaseStartedAt = requireInstant(fields.leaseStartedAt, "leaseStartedAt");
  const expiresAt = requireInstant(fields.expiresAt, "expiresAt");
  const fencingToken = Object.hasOwn(fields, "fencingToken")
    ? requireFencingToken(fields.fencingToken, "fencingToken")
    : undefined;
  return readSnapshot(store, (handle) => {
    const { ownership } = loadOwnershipState(handle, pid);
    if (ownership === undefined || ownership.leaseStartedAt === null || ownership.sessionId !== sid) {
      return Object.freeze({ disposition: "NO_TRACE" as const, current: ownership });
    }
    // A committed takeover persists exactly the presented term start. A row
    // whose term start PREDATES the presented start cannot carry this
    // request's effects (a committed write would have advanced the start), so
    // the request left no trace — this covers self-takeover reconciliation,
    // where the pre-takeover row names the same Session under an older term.
    if (Date.parse(ownership.leaseStartedAt) < Date.parse(leaseStartedAt)) {
      return Object.freeze({ disposition: "NO_TRACE" as const, current: ownership });
    }
    const matches =
      ownership.leaseStartedAt === leaseStartedAt &&
      ownership.expiresAt === expiresAt &&
      (fencingToken === undefined || ownership.fencingToken === fencingToken);
    return Object.freeze({ disposition: matches ? ("COMMITTED" as const) : ("EVIDENCE_CONFLICT" as const), current: ownership });
  });
}

// ---------------------------------------------------------------------------
// Detach reconciliation (zero-write, fail-closed; CE-0002-B3-P2C-B)
// ---------------------------------------------------------------------------

/** The durable evidence a Detach request would have persisted. The caller
 * knows the Participant and Session from its own request; the optional
 * `detachedAt` is the detach instant evidence (a deterministic-seam caller
 * knows it exactly; a real-clock caller reconciles without it). */
export interface DetachEvidence {
  readonly participantId: string;
  readonly sessionId: string;
  readonly detachedAt?: string;
}

/** Fail-closed classification of the CURRENT durable relationship between a
 * Detach request's evidence and the Session row:
 * - COMMITTED: the Session row is DETACHED — with the evidence instant
 *   presented, it matches exactly; without it, the terminal durable effect
 *   this request wanted (the one-way detach of this Session) exists.
 *   Detach's durable effect is idempotent (terminal, exactly one row
 *   state), but its API response is NOT: a retry of the same call refuses
 *   `CAPABILITY_REJECTED` (the capability is lifecycle-dead), which is why
 *   reconciliation, not blind retry, is the post-uncertainty path. No
 *   exactly-once execution is claimed or implied.
 * - NO_TRACE: the pair has no Session row, or the row is ATTACHED. The
 *   request did not commit, was refused, or rolled back — indistinguishable
 *   from durable evidence alone because every refusal path is zero-write.
 *   A fresh attempt is evaluated under current authorization.
 * - EVIDENCE_CONFLICT: the Session is DETACHED but under a different
 *   instant than the presented evidence — a different detach committed.
 *   Never auto-retry: operator review.
 */
export type DetachReconciliationCode = "COMMITTED" | "NO_TRACE" | "EVIDENCE_CONFLICT";

export interface DetachReconciliation {
  readonly disposition: DetachReconciliationCode;
  /** The durable Session lifecycle exactly as persisted (undefined when no
   * binding of the pair exists). Host-local diagnostic detail; never an
   * authorization. */
  readonly current: { readonly state: SessionLifecycleState; readonly boundAt?: string; readonly detachedAt?: string } | undefined;
}

/** Zero-write, read-based reconciliation after an uncertain Detach outcome
 * (failure before or after COMMIT, a lost response, BUSY, ROLLED_BACK, or
 * INDETERMINATE). The classification reads one consistent snapshot of the
 * durable Session state — the persisted `detached_at` is the only source of
 * truth — and validates the Participant's ownership coherence in the same
 * snapshot, so concurrent takeovers and releases are simply part of the
 * observed state, never raced against. A committed Detach is terminal: it
 * stays DETACHED across any later reconciliation. This mirrors
 * `reconcileTakeover` deliberately and does not redesign it. */
export function reconcileDetach(store: DurableStore, input: unknown): DetachReconciliation {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "detachedAt"],
    ["participantId", "sessionId"],
    "request",
  );
  const pid = requireParticipantId(fields.participantId, "participantId");
  const sid = requireSessionId(fields.sessionId, "sessionId");
  const detachedAt = Object.hasOwn(fields, "detachedAt")
    ? requireInstant(fields.detachedAt, "detachedAt")
    : undefined;
  return readSnapshot(store, (handle) => {
    const session = sessionRow(handle, pid, sid);
    // Ownership coherence is validated in the same snapshot (a malformed
    // ownership row refuses STORAGE_OWNERSHIP_CORRUPT), exactly like the
    // lifecycle read. Reads authorize nothing.
    loadOwnershipState(handle, pid);
    if (session === undefined) {
      return Object.freeze({ disposition: "NO_TRACE" as const, current: undefined });
    }
    if (!session.detached) {
      return Object.freeze({ disposition: "NO_TRACE" as const, current: { state: "ATTACHED" as const, boundAt: session.boundAt } });
    }
    const current = Object.freeze({
      state: "DETACHED" as const,
      boundAt: session.boundAt,
      detachedAt: session.detachedAt as string,
    });
    const disposition =
      detachedAt === undefined || session.detachedAt === detachedAt
        ? ("COMMITTED" as const)
        : ("EVIDENCE_CONFLICT" as const);
    return Object.freeze({ disposition, current });
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle read (zero-write, host-local; CE-0002-B3-P2C-A)
// ---------------------------------------------------------------------------

export type SessionLifecycleCode = SessionLifecycleState | "NOT_FOUND";

export interface SessionLifecycle {
  readonly state: SessionLifecycleCode;
  /** Present for ATTACHED and DETACHED. */
  readonly boundAt?: string;
  /** Present exactly for DETACHED. */
  readonly detachedAt?: string;
}

/**
 * Private host-local lifecycle read of one Participant–Session pair:
 * `ATTACHED`, `DETACHED` (terminal), or `NOT_FOUND` (no binding of this Session
 * to this Participant — a Session bound to another Participant is also
 * `NOT_FOUND` for this pair, so the read never discloses foreign bindings).
 *
 * One consistent read snapshot, zero writes, no authorization semantics: the
 * result authorizes nothing and may be stale when returned. The Participant's
 * ownership state is validated in the same snapshot, so inconsistent durable
 * state (a malformed Session row, or an Owner referencing a detached Session)
 * refuses `STORAGE_OWNERSHIP_CORRUPT` instead of being reported. Never
 * attached to an error, result, or audit surface beyond this host-local call.
 */
export function readSessionLifecycle(store: DurableStore, input: unknown): SessionLifecycle {
  const fields = captureFields(input, ["participantId", "sessionId"], ["participantId", "sessionId"], "request");
  const pid = requireParticipantId(fields.participantId, "participantId");
  const sid = requireSessionId(fields.sessionId, "sessionId");
  return readSnapshot(store, (handle) => {
    const session = sessionRow(handle, pid, sid);
    loadOwnershipState(handle, pid);
    if (session === undefined) return Object.freeze({ state: "NOT_FOUND" as const });
    if (session.detached) {
      return Object.freeze({ state: "DETACHED" as const, boundAt: session.boundAt, detachedAt: session.detachedAt as string });
    }
    return Object.freeze({ state: "ATTACHED" as const, boundAt: session.boundAt });
  });
}
