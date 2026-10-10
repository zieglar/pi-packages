import { randomBytes } from "node:crypto";
import { encodeUlid } from "../protocol/identity.js";
import {
  captureFields,
  rejectRequest,
  requireInstant,
  requireParticipantId,
  requireText,
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
import type { DurableStore } from "./store.js";
import { requireSingleRowChange, type TransactionHandle } from "./transaction.js";

/**
 * Session binding, Participant ownership, leases, and fencing
 * (CE-0002-B3-P2A). Private storage plane only: nothing here is re-exported
 * from the package barrel, there is no delivery API, no adapter wiring, no
 * background heartbeat, and no takeover.
 *
 * Model
 * - A Session is identified by an opaque, non-secret `ses_<ULID>` SessionRef.
 *   It is never a Participant identity and never a credential: every
 *   operation additionally requires a Host Capability of the exact scope.
 * - `bindSession` (scope `attach`) durably records that a Session belongs to
 *   one Participant. A Participant may accumulate many historical Sessions; a
 *   Session belongs to exactly one Participant.
 * - `acquireOwnership` (scope `attach`) makes one bound Session the single
 *   current Owner of a Participant that has no current Owner (no ownership
 *   row, or only an expired one). It allocates the next fencing token and
 *   writes the lease in the same owned transaction. A live Owner is never
 *   displaced: that is takeover, which is not active.
 * - `renewLease`, `releaseOwnership`, and `verifyOwnership` (scope `resume`)
 *   require the current Owner Session, the current fencing token, and an
 *   unexpired lease, all evaluated inside the same owned transaction.
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
 * Leases
 * - Default TTL 120 s, configurable 30–3600 s; 30 s is a renewal
 *   recommendation for hosts, not a scheduler. Time comes only from the
 *   injected clock seam.
 * - A lease authorizes only within `[expiresAt - ttl, expiresAt)`. An instant
 *   at or after expiry is `LEASE_EXPIRED`; an instant before the start of the
 *   current lease term (a wall-clock rollback) is `LEASE_CLOCK_REGRESSION`, so
 *   a rolled-back clock can never renew, and therefore never extend, a lease.
 *   The schema persists no lease-start column, so the term start is derived
 *   from the host lease TTL policy, which must stay consistent for a lease's
 *   lifetime. A rollback that lands inside the current term is
 *   indistinguishable from a valid instant without a persisted monotonic
 *   observation; refusals are zero-write, so none is recorded.
 */

export const SESSION_ID_PREFIX = "ses_" as const;
export const SESSION_ID_PATTERN = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/;

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

function requireSessionId(value: unknown, path: string): string {
  const text = requireText(value, path, 30);
  if (!SESSION_ID_PATTERN.test(text)) rejectRequest(`${path}: invalid identity`);
  return text;
}

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

/** Expiry is computed before the owned transaction, so an unrepresentable
 * instant is a request refusal, never a transaction failure. */
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

const SESSION_COLUMNS =
  "SELECT participant_id, session_id, bound_at, detached_at, CAST(private_revision AS TEXT) AS private_revision FROM participant_session";

function sessionFromRow(row: unknown): SessionBinding & { readonly detached: boolean } {
  const value = row as Record<string, unknown>;
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.participant_id !== "string" ||
    typeof value.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(value.session_id) ||
    !isInstant(value.bound_at) ||
    !(value.detached_at === null || isInstant(value.detached_at)) ||
    value.private_revision !== "1"
  ) {
    corrupt();
  }
  return Object.freeze({
    participantId: value.participant_id as string,
    sessionId: value.session_id as string,
    boundAt: value.bound_at as string,
    detached: value.detached_at !== null,
  });
}

function sessionRow(
  handle: QueryHandle,
  participantId: string,
  sessionId: string,
): (SessionBinding & { readonly detached: boolean }) | undefined {
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
}

interface OwnershipState {
  readonly ownership: OwnershipRecord | undefined;
  /** Highest fencing token ever allocated; 0 when none has been. */
  readonly highWater: number;
}

function ownershipRow(handle: QueryHandle, participantId: string): OwnershipRecord | undefined {
  const row = handle
    .prepare(
      "SELECT participant_id, session_id, CAST(fencing_token AS TEXT) AS fencing_token, expires_at, CAST(private_revision AS TEXT) AS private_revision FROM participant_ownership WHERE participant_id = ?",
    )
    .get(participantId) as Record<string, unknown> | undefined;
  if (row === undefined) return undefined;
  if (
    row.participant_id !== participantId ||
    typeof row.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(row.session_id) ||
    !isInstant(row.expires_at) ||
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

function evaluateLease(ownership: OwnershipRecord, now: string, ttlSeconds: number): LeaseEvaluation {
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(ownership.expiresAt);
  if (nowMs >= expiresMs) return "EXPIRED";
  if (nowMs < expiresMs - ttlSeconds * 1000) return "CLOCK_REGRESSION";
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
  readonly leaseTtlSeconds: number;
}

/**
 * Current-Owner authorization inside the caller's owned transaction. In order:
 * a currently valid `resume` capability for the Participant (trust generation
 * re-validated), the Participant, a bound Session, the Session being the
 * current Owner, the presented fencing token being current, and the lease
 * being unexpired and not clock-regressed. Ownership is never inferred from
 * the Session ID: the durable ownership row decides.
 */
export function authorizeCurrentOwner(
  tx: TransactionHandle,
  store: DurableStore,
  presentation: OwnerPresentation,
): OwnershipRecord {
  const { participantId, sessionId, fencingToken, now } = presentation;
  authorize(tx, store, { capability: presentation.capability, participantId, scope: "resume", now });
  if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
  const session = sessionRow(tx, participantId, sessionId);
  if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
  const { ownership } = loadOwnershipState(tx, participantId);
  if (ownership === undefined || ownership.sessionId !== sessionId) refuse("OWNERSHIP_NOT_CURRENT");
  if (ownership.fencingToken !== fencingToken) refuse("FENCING_STALE");
  const lease = evaluateLease(ownership, now, presentation.leaseTtlSeconds);
  if (lease === "EXPIRED") refuse("LEASE_EXPIRED");
  if (lease === "CLOCK_REGRESSION") refuse("LEASE_CLOCK_REGRESSION");
  return ownership;
}

function normalizeOwnerRequest(input: unknown, now: string): OwnerPresentation {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "fencingToken", "capability", "leaseTtlSeconds"],
    ["participantId", "sessionId", "fencingToken", "capability"],
    "request",
  );
  return Object.freeze({
    capability: fields.capability,
    participantId: requireParticipantId(fields.participantId, "participantId"),
    sessionId: requireSessionId(fields.sessionId, "sessionId"),
    fencingToken: requireFencingToken(fields.fencingToken, "fencingToken"),
    now,
    leaseTtlSeconds: requireLeaseTtl(fields),
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
  const boundAt = clock(seams);
  const afterSessionInsert = seams.afterSessionInsert;

  return runOwned(store, "Session binding", (tx) => {
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
}

export interface AcquireOwnershipSeams extends ClockSeam {
  readonly afterFencingWrite?: () => void;
  readonly afterOwnershipWrite?: () => void;
}

/**
 * Explicit acquisition for a Participant without a current Owner, under a
 * valid `attach` capability and a bound Session. The fencing allocation and
 * the ownership write are one atomic unit. A live lease — including one held
 * by the requesting Session itself — is refused (`OWNERSHIP_HELD`): there is
 * no silent adoption and no takeover. An expired lease is superseded by a new
 * term with a strictly greater fencing token.
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
  const now = clock(seams);
  const expiresAt = leaseExpiry(now, leaseTtlSeconds);
  const afterFencingWrite = seams.afterFencingWrite;
  const afterOwnershipWrite = seams.afterOwnershipWrite;

  return runOwned(store, "Ownership acquisition", (tx) => {
    authorize(tx, store, { capability, participantId, scope: "attach", now });
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    const session = sessionRow(tx, participantId, sessionId);
    if (session === undefined || session.detached) refuse("SESSION_NOT_BOUND");
    const { ownership: previous, highWater } = loadOwnershipState(tx, participantId);
    if (previous !== undefined && Date.parse(now) < Date.parse(previous.expiresAt)) refuse("OWNERSHIP_HELD");
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

    if (previous === undefined) {
      requireSingleRowChange(
        tx
          .prepare(
            "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, private_revision) VALUES (?, ?, ?, ?, 1)",
          )
          .run(participantId, sessionId, fencingToken, expiresAt),
        "ownership insert",
      );
    } else {
      requireSingleRowChange(
        tx
          .prepare(
            "UPDATE participant_ownership SET session_id = ?, fencing_token = ?, expires_at = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND session_id = ? AND fencing_token = ? AND expires_at = ?",
          )
          .run(sessionId, fencingToken, expiresAt, participantId, previous.sessionId, previous.fencingToken, previous.expiresAt),
        "ownership supersession",
      );
    }
    hook(afterOwnershipWrite);
    return Object.freeze({ participantId, sessionId, fencingToken, expiresAt, leaseTtlSeconds });
  });
}

export interface RenewLeaseSeams extends ClockSeam {
  readonly afterOwnershipWrite?: () => void;
}

/**
 * Explicit renewal by the current Owner: `resume` capability, current
 * fencing token, and an unexpired, non-regressed lease. The new expiry is
 * `now + ttl`, which the term check guarantees is never earlier than the
 * current expiry. The fencing token is unchanged.
 */
export function renewLease(store: DurableStore, input: unknown, seams: RenewLeaseSeams = {}): OwnershipLease {
  const now = clock(seams);
  const presentation = normalizeOwnerRequest(input, now);
  const expiresAt = leaseExpiry(now, presentation.leaseTtlSeconds);
  const afterOwnershipWrite = seams.afterOwnershipWrite;

  return runOwned(store, "Lease renewal", (tx) => {
    const current = authorizeCurrentOwner(tx, store, presentation);
    requireSingleRowChange(
      tx
        .prepare(
          "UPDATE participant_ownership SET expires_at = ?, private_revision = private_revision + 1 WHERE participant_id = ? AND session_id = ? AND fencing_token = ? AND expires_at = ?",
        )
        .run(expiresAt, current.participantId, current.sessionId, current.fencingToken, current.expiresAt),
      "lease renewal",
    );
    hook(afterOwnershipWrite);
    return Object.freeze({
      participantId: current.participantId,
      sessionId: current.sessionId,
      fencingToken: current.fencingToken,
      expiresAt,
      leaseTtlSeconds: presentation.leaseTtlSeconds,
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
  const now = clock(seams);
  const presentation = normalizeOwnerRequest(input, now);
  const afterOwnershipDelete = seams.afterOwnershipDelete;

  return runOwned(store, "Ownership release", (tx) => {
    const current = authorizeCurrentOwner(tx, store, presentation);
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

/** Zero-write current-Owner authorization, evaluated in an owned transaction
 * so it observes the same serialized state any mutation would. */
export function verifyOwnership(store: DurableStore, input: unknown, seams: ClockSeam = {}): OwnershipLease {
  const now = clock(seams);
  const presentation = normalizeOwnerRequest(input, now);
  return runOwned(store, "Ownership verification", (tx) => {
    const current = authorizeCurrentOwner(tx, store, presentation);
    return Object.freeze({ ...current, leaseTtlSeconds: presentation.leaseTtlSeconds });
  });
}

// ---------------------------------------------------------------------------
// Durable reads (private, host-local, no authorization semantics)
// ---------------------------------------------------------------------------

/** Runs several reads against one consistent snapshot. */
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
  const fields = captureFields(input, ["participantId", "leaseTtlSeconds"], ["participantId"], "request");
  const pid = requireParticipantId(fields.participantId, "participantId");
  const ttl = requireLeaseTtl(fields);
  const now = clock(seams);
  return readSnapshot(store, (handle) => {
    const { ownership } = loadOwnershipState(handle, pid);
    return ownership === undefined ? "UNOWNED" : evaluateLease(ownership, now, ttl);
  });
}
