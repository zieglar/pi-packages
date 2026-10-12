import { Value } from "@sinclair/typebox/value";
import { EndpointRefSchema, type EndpointRef } from "../protocol/entities.js";
import { EVENT_ID_PATTERN, EXCHANGE_ID_PATTERN, generateEntityId } from "../protocol/identity.js";
import { canonicalDigest, type IdempotentCreateRecord } from "../protocol/idempotency.js";
import {
  classifyCapability,
  currentGenerationInTransaction,
  generateCapability,
  isOperationalCapabilityScope,
  isSessionBoundCapabilityScope,
  type CapabilityStatus,
  type ReadableHandle,
  type OperationalCapabilityScope,
} from "./capability.js";
import { StoreLifecycleError } from "./errors.js";
import {
  captureFields,
  generateParticipantId,
  PARTICIPANT_ID_PATTERN,
  PARTICIPANT_JOINED_EVENT_KIND,
  ParticipantRequestError,
  requireIdempotencyKey,
  requireInstant,
  requireParticipantId,
  requireSessionId,
  requireText,
  rejectRequest,
} from "./participant-identity.js";
import { parseSessionRow, SESSION_COLUMNS } from "./session-state.js";
import type { DurableStore } from "./store.js";
import {
  ConditionalMutationError,
  StorageTransactionError,
  requireSingleRowChange,
  withImmediateTransaction,
  type TransactionHandle,
} from "./transaction.js";
import { deriveCapabilityDigest, digestsMatch, readHostSecretDigest } from "./trust-root.js";

/**
 * Participant identity, Endpoint binding, Host Capability issuance, and
 * Exchange membership (CE-0002-B3-P1B).
 *
 * This is the private identity/membership plane only. It deliberately contains
 * no runtime ownership, no leases or fencing, no delivery, no cursors or ACKs,
 * and no adapter wiring. Session binding, ownership, leases, and fencing live
 * in the private B3-P2A plane (`ownership.ts`), which reuses this module's
 * owned-transaction wrapper and authorization; delivery and cursors remain
 * unauthorized B3-P3 scope and the cursor table stays inert.
 *
 * Every durable mutation runs inside the accepted `withImmediateTransaction`
 * primitive, so BUSY / ROLLED_BACK / INDETERMINATE classification, connection
 * invalidation, retry eligibility, and refusal-over-repair are inherited
 * unchanged from B1/B2. Authorization is evaluated inside the same owned
 * transaction as the mutation it authorizes.
 *
 * Accepted B2 behavior is untouched: Exchange and Message creation, the
 * request digest, idempotency and conflict semantics, and audit sequencing all
 * keep their accepted contracts. Membership adds its own audit event through
 * the same per-Exchange MAX(sequence)+1 discipline.
 */

type ParticipantDomainCode =
  | "STORAGE_IDEMPOTENCY_CORRUPT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "CAPABILITY_REJECTED"
  | "CAPABILITY_SCOPE_UNSUPPORTED"
  | "PARTICIPANT_NOT_FOUND"
  | "PARTICIPANT_ENDPOINT_CONFLICT"
  | "PARTICIPANT_BINDING_MISMATCH"
  | "STORAGE_EXCHANGE_NOT_FOUND"
  | "EXCHANGE_JOIN_REJECTED"
  // CE-0002-B3-P2A Session binding, ownership, lease, and fencing refusals.
  // CE-0002-B3-P3A durable messaging refusals.
  | "PARTICIPANT_NOT_MEMBER"
  | "MESSAGE_READ_REJECTED"
  | "SESSION_ALREADY_BOUND"
  | "SESSION_BOUND_TO_OTHER_PARTICIPANT"
  | "SESSION_NOT_BOUND"
  // CE-0002-B3-P2C-B: the authorized Detach refusals. `SESSION_DETACHED` is
  // deliberately NOT a caller-visible domain code: a detached Session makes
  // its Session-bound capabilities unusable, which callers see as the one
  // opaque CAPABILITY_REJECTED classification; only the host-local
  // capability status read identifies SESSION_DETACHED.
  | "SESSION_IS_CURRENT_OWNER"
  | "SESSION_CLOCK_REGRESSION"
  | "OWNERSHIP_HELD"
  | "OWNERSHIP_NOT_CURRENT"
  | "OWNERSHIP_TAKEOVER_REQUIRED"
  | "OWNERSHIP_TAKEOVER_INELIGIBLE"
  | "FENCING_STALE"
  | "FENCING_EXHAUSTED"
  | "LEASE_EXPIRED"
  | "LEASE_CLOCK_REGRESSION"
  | "LEASE_TERM_SHORTENED"
  | "STORAGE_OWNERSHIP_CORRUPT";

/** Fixed sanitized details: never a capability, digest, secret, SQL message,
 * stored value, or filesystem path. `CAPABILITY_REJECTED` is deliberately one
 * opaque classification for forged, unknown, wrong-scope, wrong-generation,
 * revoked, and expired capabilities, so the refusal is not an oracle. */
const DOMAIN_DETAIL: Record<ParticipantDomainCode, string> = {
  STORAGE_IDEMPOTENCY_CORRUPT: "stored Participant state is inconsistent; operator review required",
  IDEMPOTENCY_KEY_CONFLICT: "idempotency key conflicts with a valid stored request",
  CAPABILITY_REJECTED: "host capability authorization rejected",
  CAPABILITY_SCOPE_UNSUPPORTED: "requested capability scope is not operational",
  PARTICIPANT_NOT_FOUND: "operation requires an existing durable Participant",
  PARTICIPANT_ENDPOINT_CONFLICT: "endpoint identity is already bound to another Participant",
  PARTICIPANT_BINDING_MISMATCH: "Participant endpoint binding is immutable and does not match",
  STORAGE_EXCHANGE_NOT_FOUND: "operation requires an existing durable Exchange",
  EXCHANGE_JOIN_REJECTED: "the Exchange is not open for new membership",
  PARTICIPANT_NOT_MEMBER: "operation requires durable Exchange membership",
  MESSAGE_READ_REJECTED: "protected Message metadata is not eligible for this Participant",
  SESSION_ALREADY_BOUND: "the Session is already bound to this Participant",
  SESSION_BOUND_TO_OTHER_PARTICIPANT: "the Session is bound to another Participant",
  SESSION_NOT_BOUND: "operation requires a currently bound Session",
  SESSION_IS_CURRENT_OWNER: "the current Owner Session cannot be detached while the ownership row references it",
  SESSION_CLOCK_REGRESSION: "the operation clock precedes the Session binding instant",
  OWNERSHIP_HELD: "the Participant already has a current Owner",
  OWNERSHIP_NOT_CURRENT: "the Session is not the current Owner of the Participant",
  OWNERSHIP_TAKEOVER_REQUIRED: "replacing an existing Owner requires takeover authority",
  OWNERSHIP_TAKEOVER_INELIGIBLE: "takeover requires an existing expired or legacy ownership row; initial acquisition is the attach operation",
  FENCING_STALE: "the presented fencing token is not current",
  FENCING_EXHAUSTED: "the Participant fencing token space is exhausted; operator review required",
  LEASE_EXPIRED: "the ownership lease has expired",
  LEASE_CLOCK_REGRESSION: "the operation clock precedes the current lease term",
  LEASE_TERM_SHORTENED: "renewal must not shorten the current lease term",
  STORAGE_OWNERSHIP_CORRUPT: "stored ownership state is inconsistent; operator review required",
};

export class ParticipantDomainError extends Error {
  readonly outcome = "ROLLED_BACK";
  readonly retryable = false;
  readonly code: ParticipantDomainCode;

  constructor(code: ParticipantDomainCode) {
    super(DOMAIN_DETAIL[code]);
    this.name = "ParticipantDomainError";
    this.code = code;
  }
}

/** @internal Shared with the private B3-P2A ownership plane (`ownership.ts`). */
export function refuse(code: ParticipantDomainCode): never {
  throw new ParticipantDomainError(code);
}

function corrupt(): never {
  throw new ParticipantDomainError("STORAGE_IDEMPOTENCY_CORRUPT");
}

/** Private synchronous fault boundaries, matching the accepted B2 seam
 * discipline: hooks receive no capabilities or values, and a caller-thrown
 * value is never inspected or retained. */
export function hook(action: (() => void) | undefined): void {
  if (action === undefined) return;
  try {
    if (action() === undefined) return;
  } catch {
    /* replace caller exceptions before the accepted helper sees them */
  }
  throw new Error("private participant hook failed or returned a non-undefined value");
}

export interface ClockSeam {
  readonly now?: () => string;
}

/** @internal Shared with the private B3-P2A ownership plane. */
export function clock(seams: ClockSeam): string {
  const value = (seams.now ?? (() => new Date().toISOString()))();
  return requireInstant(value, "now");
}

/**
 * Owned-transaction wrapper with the accepted error-translation discipline:
 * domain refusals surface as themselves when the helper proved a rollback;
 * INDETERMINATE always wins; SQLite text, hook failures, and arbitrary thrown
 * values are never retained or published.
 */
/** @internal Shared with the private B3-P2A ownership plane. */
export function runOwned<T>(store: DurableStore, label: string, body: (tx: TransactionHandle) => T): T {
  let captured: { value: T } | undefined;
  // ParticipantRequestError joins the typed passthrough in R1: transaction-time
  // clock validation can reject a request inside the owned transaction; the
  // refusal must surface as itself after a proven rollback, never sanitized
  // into a generic transaction failure.
  let domainFailure: ParticipantDomainError | ParticipantRequestError | ConditionalMutationError | StoreLifecycleError | undefined;
  try {
    withImmediateTransaction(store.database, (tx) => {
      try {
        captured = { value: body(tx) };
      } catch (error) {
        if (
          error instanceof ParticipantDomainError ||
          error instanceof ParticipantRequestError ||
          error instanceof ConditionalMutationError ||
          error instanceof StoreLifecycleError
        ) {
          domainFailure = error;
          throw error;
        }
        throw new Error(`${label} callback failed`);
      }
    });
  } catch (error) {
    if (error instanceof ConditionalMutationError && error === domainFailure) throw error;
    if (error instanceof StorageTransactionError) {
      if (error.outcome === "ROLLED_BACK" && domainFailure !== undefined && error.cause === domainFailure) {
        throw domainFailure;
      }
      throw new StorageTransactionError(`${label} transaction failed`, error.stage, {
        outcome: error.outcome,
        busy: error.retryable,
      });
    }
    throw new StorageTransactionError(`${label} transaction outcome is unknown`, "callback");
  }
  return captured!.value;
}

// ---------------------------------------------------------------------------
// Durable identity reads (private, minimal)
// ---------------------------------------------------------------------------

export interface ParticipantRecord {
  readonly participantId: string;
  readonly adapter: string;
  readonly endpointId: string;
  readonly createdAt: string;
}

export interface MembershipRecord {
  readonly exchangeId: string;
  readonly participantId: string;
  readonly joinBoundarySeq: number;
  readonly createdAt: string;
}

function isValidStoredEndpointText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\uD800-\uDFFF]/u.test(value)
  );
}

function participantFromRow(row: Record<string, unknown> | undefined): ParticipantRecord | undefined {
  if (row === undefined) return undefined;
  if (
    typeof row.participant_id !== "string" ||
    !PARTICIPANT_ID_PATTERN.test(row.participant_id) ||
    !isValidStoredEndpointText(row.endpoint_adapter, 64) ||
    !isValidStoredEndpointText(row.endpoint_id, 256) ||
    typeof row.created_at !== "string"
  ) {
    corrupt();
  }
  return Object.freeze({
    participantId: row.participant_id as string,
    adapter: row.endpoint_adapter as string,
    endpointId: row.endpoint_id as string,
    createdAt: row.created_at as string,
  });
}

const PARTICIPANT_BY_ID =
  "SELECT participant_id, endpoint_adapter, endpoint_id, created_at FROM participant WHERE participant_id = ?";
const PARTICIPANT_BY_ENDPOINT =
  "SELECT participant_id, endpoint_adapter, endpoint_id, created_at FROM participant WHERE endpoint_adapter = ? AND endpoint_id = ?";
const MEMBERSHIP_BY_KEY =
  "SELECT exchange_id, participant_id, join_boundary_seq, created_at FROM exchange_membership WHERE exchange_id = ? AND participant_id = ?";

/** @internal Shared with the private B3-P2A ownership plane. */
export function readParticipantRow(handle: ReadableHandle, participantId: string): ParticipantRecord | undefined {
  const statement = handle.prepare(PARTICIPANT_BY_ID) as { get(value: string): unknown };
  return participantFromRow(statement.get(participantId) as Record<string, unknown> | undefined);
}

function readParticipantByEndpointRow(
  handle: ReadableHandle,
  adapter: string,
  endpointId: string,
): ParticipantRecord | undefined {
  const statement = handle.prepare(PARTICIPANT_BY_ENDPOINT) as { get(a: string, b: string): unknown };
  return participantFromRow(statement.get(adapter, endpointId) as Record<string, unknown> | undefined);
}

function membershipFromRow(row: Record<string, unknown> | undefined): MembershipRecord | undefined {
  if (row === undefined) return undefined;
  if (
    typeof row.exchange_id !== "string" ||
    !EXCHANGE_ID_PATTERN.test(row.exchange_id) ||
    typeof row.participant_id !== "string" ||
    !PARTICIPANT_ID_PATTERN.test(row.participant_id) ||
    typeof row.join_boundary_seq !== "number" ||
    !Number.isSafeInteger(row.join_boundary_seq) ||
    row.join_boundary_seq < 1 ||
    typeof row.created_at !== "string"
  ) {
    corrupt();
  }
  return Object.freeze({
    exchangeId: row.exchange_id as string,
    participantId: row.participant_id as string,
    joinBoundarySeq: row.join_boundary_seq as number,
    createdAt: row.created_at as string,
  });
}

/** @internal Shared with the private B3-P3A messaging plane. */
export function readMembershipRow(
  handle: ReadableHandle,
  exchangeId: string,
  participantId: string,
): MembershipRecord | undefined {
  const statement = handle.prepare(MEMBERSHIP_BY_KEY) as { get(a: string, b: string): unknown };
  return membershipFromRow(statement.get(exchangeId, participantId) as Record<string, unknown> | undefined);
}

/** Participant existence and its stable Endpoint projection. */
export function readParticipant(store: DurableStore, participantId: unknown): ParticipantRecord | undefined {
  return readParticipantRow(store.database, requireParticipantId(participantId, "participantId"));
}

/** Stable Endpoint binding lookup. `instanceId` is ephemeral and is never part
 * of the stable projection, so it is not accepted here. */
export function readParticipantByEndpoint(
  store: DurableStore,
  adapter: unknown,
  endpointId: unknown,
): ParticipantRecord | undefined {
  return readParticipantByEndpointRow(
    store.database,
    requireText(adapter, "adapter", 64),
    requireText(endpointId, "endpointId", 256),
  );
}

/** Exchange membership and its immutable join boundary. */
export function readExchangeMembership(
  store: DurableStore,
  exchangeId: unknown,
  participantId: unknown,
): MembershipRecord | undefined {
  return readMembershipRow(
    store.database,
    requireExchangeId(exchangeId, "exchangeId"),
    requireParticipantId(participantId, "participantId"),
  );
}

/** Host-local capability status. Never exposed to a caller surface and never
 * attached to an error: operations refuse with one opaque classification. */
export function readCapabilityStatus(
  store: DurableStore,
  input: unknown,
  seams: ClockSeam = {},
): CapabilityStatus {
  const fields = captureFields(
    input,
    ["capability", "participantId", "scope", "sessionId"],
    ["capability", "participantId", "scope"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const scope = requireText(fields.scope, "scope", 32);
  if (!isOperationalCapabilityScope(scope)) return "SCOPE_MISMATCH";
  const sessionId = Object.hasOwn(fields, "sessionId") ? requireSessionId(fields.sessionId, "sessionId") : undefined;
  return classifyCapability(store.database, store.databasePath, {
    capability: fields.capability,
    participantId,
    scope,
    now: clock(seams),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function requireExchangeId(value: unknown, path: string): string {
  const text = requireText(value, path, 29);
  if (!EXCHANGE_ID_PATTERN.test(text)) rejectRequest(`${path}: invalid identity`);
  return text;
}

/** @internal Shared with the private B3-P2A ownership plane. Must run inside
 * the owned transaction of the mutation it authorizes. */
export function authorize(
  tx: TransactionHandle,
  store: DurableStore,
  presentation: {
    capability: unknown;
    participantId: string;
    scope: OperationalCapabilityScope;
    now: string;
    sessionId?: string;
  },
): void {
  if (classifyCapability(tx, store.databasePath, presentation) !== "VALID") {
    refuse("CAPABILITY_REJECTED");
  }
}

// ---------------------------------------------------------------------------
// Participant identity and Endpoint binding
// ---------------------------------------------------------------------------

export interface ParticipantCreation {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly participant: ParticipantRecord;
  readonly record: IdempotentCreateRecord;
}

interface NormalizedParticipantRequest {
  readonly namespace: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
  readonly adapter: string;
  readonly endpointId: string;
  readonly sponsor: { readonly participantId: string; readonly capability: unknown } | undefined;
}

/** The stable Endpoint projection is exactly `(adapter, endpointId)`:
 * `instanceId` is accepted for shape compatibility with `EndpointRef` but is
 * ephemeral, excluded from identity, excluded from the request digest, and
 * never persisted in the Participant binding. */
function normalizeEndpointProjection(input: unknown, path: string): { adapter: string; endpointId: string } {
  const fields = captureFields(input, ["adapter", "endpointId", "instanceId"], ["adapter", "endpointId"], path);
  const endpoint: EndpointRef = {
    adapter: requireText(fields.adapter, `${path}.adapter`, 64),
    endpointId: requireText(fields.endpointId, `${path}.endpointId`, 256),
  };
  if (Object.hasOwn(fields, "instanceId")) {
    endpoint.instanceId = requireText(fields.instanceId, `${path}.instanceId`, 256);
  }
  if (!Value.Check(EndpointRefSchema, endpoint)) rejectRequest(`${path}: invalid endpoint`);
  return { adapter: endpoint.adapter, endpointId: endpoint.endpointId };
}

function normalizeCreateParticipant(input: unknown): NormalizedParticipantRequest {
  const fields = captureFields(
    input,
    ["endpoint", "idempotencyKey", "sponsor"],
    ["endpoint", "idempotencyKey"],
    "request",
  );
  const { adapter, endpointId } = normalizeEndpointProjection(fields.endpoint, "endpoint");
  const idempotencyKey = requireIdempotencyKey(fields.idempotencyKey, "idempotencyKey");
  let sponsor: NormalizedParticipantRequest["sponsor"];
  if (Object.hasOwn(fields, "sponsor")) {
    const sponsorFields = captureFields(
      fields.sponsor,
      ["participantId", "capability"],
      ["participantId", "capability"],
      "sponsor",
    );
    sponsor = {
      participantId: requireParticipantId(sponsorFields.participantId, "sponsor.participantId"),
      capability: sponsorFields.capability,
    };
  }
  return Object.freeze({
    namespace: JSON.stringify(["participant.create"]),
    idempotencyKey,
    requestDigest: canonicalDigest({ op: "chat-exchange/participant.create", v: 1, adapter, endpointId }),
    adapter,
    endpointId,
    sponsor,
  });
}

function idempotencyRow(
  tx: TransactionHandle,
  namespace: string,
  idempotencyKey: string,
): { entityId: string; requestDigest: string; createdAt: string } | undefined {
  const row = tx
    .prepare(
      "SELECT namespace, idempotency_key, request_digest, entity_id, created_at, CAST(private_revision AS TEXT) AS private_revision FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
    )
    .get(namespace, idempotencyKey);
  if (row === undefined) return undefined;
  if (
    Object.keys(row).length !== 6 ||
    row.namespace !== namespace ||
    row.idempotency_key !== idempotencyKey ||
    row.private_revision !== "1" ||
    typeof row.request_digest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.request_digest) ||
    typeof row.entity_id !== "string" ||
    typeof row.created_at !== "string"
  ) {
    corrupt();
  }
  return {
    entityId: row.entity_id as string,
    requestDigest: row.request_digest as string,
    createdAt: row.created_at as string,
  };
}

/** Validate durable consistency BEFORE comparing the incoming digest, exactly
 * as the accepted B2 replay path does: a stored digest that no valid stored
 * request can produce is corruption, never a conflict. */
function replayParticipant(
  tx: TransactionHandle,
  request: NormalizedParticipantRequest,
): ParticipantCreation | undefined {
  const row = idempotencyRow(tx, request.namespace, request.idempotencyKey);
  if (row === undefined) return undefined;
  if (!PARTICIPANT_ID_PATTERN.test(row.entityId)) corrupt();
  const stored = readParticipantRow(tx, row.entityId);
  if (stored === undefined || stored.createdAt !== row.createdAt) corrupt();
  const storedDigest = canonicalDigest({
    op: "chat-exchange/participant.create",
    v: 1,
    adapter: stored.adapter,
    endpointId: stored.endpointId,
  });
  if (row.requestDigest !== storedDigest) corrupt();
  if (row.requestDigest !== request.requestDigest) refuse("IDEMPOTENCY_KEY_CONFLICT");
  return Object.freeze({
    disposition: "REPLAYED",
    participant: stored,
    record: Object.freeze({
      entityId: row.entityId,
      requestDigest: row.requestDigest,
      createdAt: row.createdAt,
    }),
  });
}

export interface CreateParticipantSeams extends ClockSeam {
  readonly afterParticipantInsert?: () => void;
  readonly afterIdempotencyInsert?: () => void;
}

/**
 * Creates one durable, globally unique Participant identity immutably bound to
 * one stable Endpoint identity.
 *
 * Authorization: this is a host-local trusted operation (the caller already
 * holds the validated private store and its host trust root). When a `sponsor`
 * is supplied, the sponsor's `create` capability is verified inside the same
 * owned transaction, which is the operational use of the `create` scope. A
 * Session ID or Participant ID alone never authorizes anything.
 *
 * No audit event is emitted: `audit_event` is Exchange-scoped by the accepted
 * v1 DDL, and Participant identity is global. Membership — which is
 * Exchange-scoped — does emit its audit event.
 */
export function createParticipant(
  store: DurableStore,
  input: unknown,
  seams: CreateParticipantSeams = {},
): ParticipantCreation {
  const request = normalizeCreateParticipant(input);
  const afterParticipantInsert = seams.afterParticipantInsert;
  const afterIdempotencyInsert = seams.afterIdempotencyInsert;
  return runOwned(store, "Participant creation", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held, so a
    // sponsor capability is never authorized on a stale pre-lock instant.
    const createdAt = clock(seams);
    const participantId = generateParticipantId(Date.parse(createdAt));
    // CE-0002-B3-P1B-R1 (MAJOR-1): current authorization precedes every
    // protected result, including an idempotent replay. A sponsored request
    // must present a currently valid `create` capability before any stored
    // Participant identity or binding is disclosed, so an idempotency key is
    // never an authorization credential. Deliberate error-precedence change:
    // for sponsored requests, CAPABILITY_REJECTED now outranks replay,
    // conflict, and corruption classification. Unsponsored host-local
    // creation keeps its accepted semantics unchanged.
    if (request.sponsor !== undefined) {
      authorize(tx, store, {
        capability: request.sponsor.capability,
        participantId: request.sponsor.participantId,
        scope: "create",
        now: createdAt,
      });
    }
    const replayed = replayParticipant(tx, request);
    if (replayed !== undefined) return replayed;

    if (readParticipantByEndpointRow(tx, request.adapter, request.endpointId) !== undefined) {
      refuse("PARTICIPANT_ENDPOINT_CONFLICT");
    }
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, ?, ?, ?, 1)",
        )
        .run(participantId, request.adapter, request.endpointId, createdAt),
      "Participant insert",
    );
    hook(afterParticipantInsert);
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .run(request.namespace, request.idempotencyKey, request.requestDigest, participantId, createdAt),
      "idempotency insert",
    );
    hook(afterIdempotencyInsert);
    return Object.freeze({
      disposition: "CREATED" as const,
      participant: Object.freeze({
        participantId,
        adapter: request.adapter,
        endpointId: request.endpointId,
        createdAt,
      }),
      record: Object.freeze({
        entityId: participantId,
        requestDigest: request.requestDigest,
        createdAt,
      }),
    });
  });
}

export interface EndpointBinding {
  readonly participantId: string;
  readonly adapter: string;
  readonly endpointId: string;
  readonly boundAt: string;
}

/**
 * Authorized affirmation of a Participant's immutable Endpoint binding.
 *
 * VALIDATION-ONLY: despite the imperative name (kept stable in R1 — the
 * accepted API is not renamed), this operation never creates, changes, or
 * removes a binding and performs zero writes. The binding is established
 * exactly once, atomically with identity creation in `createParticipant`.
 * This operation only verifies, under a current `bind` capability, that the
 * presented Endpoint identity is the one already durably bound.
 *
 * The binding itself is established once, at creation, and is immutable by the
 * accepted `participant_identity_immutable` trigger and the
 * `UNIQUE (endpoint_adapter, endpoint_id)` constraint. This operation requires
 * a `bind` capability and performs zero writes: it refuses any attempt to bind
 * a Participant to a different Endpoint identity (no silent reassignment, no
 * aliasing) and any attempt to claim an Endpoint identity already owned by
 * another Participant (no duplicate ownership). A differing ephemeral
 * `instanceId` is accepted and ignored: it is not part of stable routing.
 */
export function bindEndpointRef(store: DurableStore, input: unknown, seams: ClockSeam = {}): EndpointBinding {
  const fields = captureFields(
    input,
    ["participantId", "endpoint", "capability"],
    ["participantId", "endpoint", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const { adapter, endpointId } = normalizeEndpointProjection(fields.endpoint, "endpoint");
  const capability = fields.capability;
  return runOwned(store, "Endpoint binding", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held.
    const now = clock(seams);
    authorize(tx, store, { capability, participantId, scope: "bind", now });
    const participant = readParticipantRow(tx, participantId);
    if (participant === undefined) refuse("PARTICIPANT_NOT_FOUND");
    const owner = readParticipantByEndpointRow(tx, adapter, endpointId);
    if (owner !== undefined && owner.participantId !== participantId) {
      refuse("PARTICIPANT_ENDPOINT_CONFLICT");
    }
    if (participant.adapter !== adapter || participant.endpointId !== endpointId) {
      refuse("PARTICIPANT_BINDING_MISMATCH");
    }
    return Object.freeze({
      participantId: participant.participantId,
      adapter: participant.adapter,
      endpointId: participant.endpointId,
      boundAt: participant.createdAt,
    });
  });
}

// ---------------------------------------------------------------------------
// Host Capability issuance and revocation
// ---------------------------------------------------------------------------

export interface IssuedCapability {
  /** The plaintext bearer token. Returned exactly once, to the issuing host;
   * only its host-keyed digest is persisted. */
  readonly capability: string;
  readonly participantId: string;
  readonly scope: OperationalCapabilityScope;
  readonly trustGeneration: number;
  readonly createdAt: string;
  readonly expiresAt?: string;
  /** The Session a Session-bound (`resume`/`takeover`) capability is durably
   * bound to (CE-0002-B3-P2A-R1 / B3-P2B). */
  readonly sessionId?: string;
}

export interface IssueCapabilitySeams extends ClockSeam {
  readonly tokenBytes?: () => Uint8Array;
  readonly afterCapabilityInsert?: () => void;
}

/**
 * Issues one Host Capability for an existing Participant, bound to the current
 * trust generation and exactly one operational scope.
 *
 * Host authority is the issuing authority: the live host secret must still pass
 * the artifact policy and match the persisted fingerprint of the current
 * generation, inside the same owned transaction that inserts the digest row.
 * No plaintext token or secret is persisted, logged, or audited.
 *
 * Session-bound scopes (CE-0002-B3-P2A-R1 `resume`; CE-0002-B3-P2B
 * `takeover`): such a capability requires `sessionId` and is durably bound to
 * exactly that Session, which must be a currently bound Session of the
 * Participant at issuance. Session binding is a narrowing of authority, never
 * a credential: the bearer token is still required, and a Session ID alone
 * authorizes nothing. `sessionId` is refused for every other scope.
 */
export function issueCapability(
  store: DurableStore,
  input: unknown,
  seams: IssueCapabilitySeams = {},
): IssuedCapability {
  const fields = captureFields(
    input,
    ["participantId", "scope", "expiresAt", "sessionId"],
    ["participantId", "scope"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const scope = requireText(fields.scope, "scope", 32);
  const expiresAt = Object.hasOwn(fields, "expiresAt") ? requireInstant(fields.expiresAt, "expiresAt") : undefined;
  const hasSession = Object.hasOwn(fields, "sessionId");
  const sessionBound = isSessionBoundCapabilityScope(scope);
  if (sessionBound && !hasSession) rejectRequest("sessionId: missing required field");
  if (!sessionBound && hasSession) rejectRequest("sessionId: unknown field");
  const sessionId = hasSession ? requireSessionId(fields.sessionId, "sessionId") : undefined;
  const afterCapabilityInsert = seams.afterCapabilityInsert;
  if (!isOperationalCapabilityScope(scope)) refuse("CAPABILITY_SCOPE_UNSUPPORTED");
  const capability = generateCapability(seams.tokenBytes);

  return runOwned(store, "Capability issuance", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held.
    const createdAt = clock(seams);
    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    if (sessionId !== undefined) {
      // A Session-bound capability may only be bound to a Session that is
      // currently bound to this Participant; the durable binding is checked
      // inside the same transaction that records the capability. B3-P2C-A:
      // the row is strictly validated — only ATTACHED qualifies, a DETACHED
      // Session never receives a new capability, and a malformed lifecycle
      // row is refused as corruption, never adopted.
      const row = tx
        .prepare(`${SESSION_COLUMNS} WHERE participant_id = ? AND session_id = ?`)
        .get(participantId, sessionId);
      if (row === undefined) refuse("SESSION_NOT_BOUND");
      const binding = parseSessionRow(row);
      if (binding === undefined || binding.participantId !== participantId || binding.sessionId !== sessionId) {
        refuse("STORAGE_OWNERSHIP_CORRUPT");
      }
      if (binding.state !== "ATTACHED") refuse("SESSION_NOT_BOUND");
    }
    const generation = currentGenerationInTransaction(tx);
    if (generation === undefined) {
      throw new StoreLifecycleError("STORAGE_CORRUPT", "a v2 store has no host trust root generation");
    }
    if (!digestsMatch(readHostSecretDigest(store.databasePath), generation.secret_digest)) {
      throw new StoreLifecycleError(
        "STORAGE_TRUST_ROOT_MISMATCH",
        "the host secret does not match the persisted trust-root fingerprint",
      );
    }
    const digest = deriveCapabilityDigest(store.databasePath, {
      generation: generation.generation,
      participantId,
      scope,
      token: capability.slice("cap_".length),
    });
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at, session_id, private_revision) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 1)",
        )
        .run(digest, participantId, scope, generation.generation, createdAt, expiresAt ?? null, sessionId ?? null),
      "capability insert",
    );
    hook(afterCapabilityInsert);
    return Object.freeze({
      capability,
      participantId,
      scope,
      trustGeneration: generation.generation,
      createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(sessionId === undefined ? {} : { sessionId }),
    });
  });
}

export interface RevokedCapability {
  readonly participantId: string;
  readonly scope: OperationalCapabilityScope;
  readonly revokedAt: string;
}

/** Explicit host revocation. Revocation is durable and one-way: there is no
 * automatic capability recovery, reissue, or un-revoke path. Revoking a
 * Session-bound (`resume`/`takeover`) capability requires presenting its bound
 * Session, matching the session check of the capability plane. */
export function revokeCapability(store: DurableStore, input: unknown, seams: ClockSeam = {}): RevokedCapability {
  const fields = captureFields(
    input,
    ["participantId", "scope", "capability", "sessionId"],
    ["participantId", "scope", "capability"],
    "request",
  );
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const scope = requireText(fields.scope, "scope", 32);
  const capability = fields.capability;
  if (!isOperationalCapabilityScope(scope)) refuse("CAPABILITY_SCOPE_UNSUPPORTED");
  const sessionId = Object.hasOwn(fields, "sessionId") ? requireSessionId(fields.sessionId, "sessionId") : undefined;
  if (isSessionBoundCapabilityScope(scope) && sessionId === undefined) rejectRequest("sessionId: missing required field");

  return runOwned(store, "Capability revocation", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held, so a
    // capability that expired while this operation waited for the lock can
    // never be treated as valid.
    const revokedAt = clock(seams);
    if (classifyCapability(tx, store.databasePath, { capability, participantId, scope, now: revokedAt, ...(sessionId === undefined ? {} : { sessionId }) }) !== "VALID") {
      refuse("CAPABILITY_REJECTED");
    }
    const generation = currentGenerationInTransaction(tx);
    if (generation === undefined) {
      throw new StoreLifecycleError("STORAGE_CORRUPT", "a v2 store has no host trust root generation");
    }
    const digest = deriveCapabilityDigest(store.databasePath, {
      generation: generation.generation,
      participantId,
      scope,
      token: (capability as string).slice("cap_".length),
    });
    requireSingleRowChange(
      tx
        .prepare("UPDATE participant_capability SET revoked_at = ? WHERE capability_digest = ? AND revoked_at IS NULL")
        .run(revokedAt, digest),
      "capability revocation",
    );
    return Object.freeze({ participantId, scope, revokedAt });
  });
}

// ---------------------------------------------------------------------------
// Exchange membership
// ---------------------------------------------------------------------------

export interface MembershipJoin {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly membership: MembershipRecord;
  readonly record: IdempotentCreateRecord;
}

export interface JoinExchangeSeams extends ClockSeam {
  readonly afterMembershipInsert?: () => void;
  readonly afterIdempotencyInsert?: () => void;
  readonly afterAuditInsert?: () => void;
}

/** Admission for NEW membership only, mirroring the accepted B2 admission
 * discipline: a missing Exchange, a CLOSED Exchange, or an administrative
 * disposition refuses new activity; zero-write replay stays available. */
function admitExchangeForJoin(tx: TransactionHandle, exchangeId: string): void {
  const row = tx
    .prepare(
      "SELECT exchange_id, state, created_at, closed_at, CAST(private_revision AS TEXT) AS private_revision FROM exchange WHERE exchange_id=?",
    )
    .get(exchangeId);
  if (row === undefined) refuse("STORAGE_EXCHANGE_NOT_FOUND");
  if (
    Object.keys(row).length !== 5 ||
    row.private_revision !== "1" ||
    row.exchange_id !== exchangeId ||
    !(
      (row.state === "OPEN" && row.closed_at === null) ||
      (row.state === "CLOSED" && typeof row.closed_at === "string")
    )
  ) {
    corrupt();
  }
  if (tx.prepare("SELECT exchange_id FROM disposition WHERE exchange_id=?").get(exchangeId) !== undefined) {
    refuse("EXCHANGE_JOIN_REJECTED");
  }
  if (row.state !== "OPEN") refuse("EXCHANGE_JOIN_REJECTED");
}

/** The accepted per-Exchange audit discipline: MAX(sequence)+1, refusing
 * unexpected durable history instead of repairing it. */
function nextAuditSequence(tx: TransactionHandle, exchangeId: string): number {
  const row = tx.prepare("SELECT MAX(sequence) AS maximum FROM audit_event WHERE exchange_id=?").get(exchangeId);
  const maximum = row?.maximum ?? null;
  if (maximum !== null && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)) corrupt();
  const sequence = (maximum ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) corrupt();
  return sequence;
}

function replayJoin(
  tx: TransactionHandle,
  namespace: string,
  idempotencyKey: string,
  requestDigest: string,
  exchangeId: string,
): MembershipJoin | undefined {
  const row = idempotencyRow(tx, namespace, idempotencyKey);
  if (row === undefined) return undefined;
  if (!PARTICIPANT_ID_PATTERN.test(row.entityId)) corrupt();
  const membership = readMembershipRow(tx, exchangeId, row.entityId);
  if (membership === undefined || membership.createdAt !== row.createdAt) corrupt();
  const storedDigest = canonicalDigest({
    op: "chat-exchange/participant.join",
    v: 1,
    exchangeId,
    participantId: row.entityId,
  });
  if (row.requestDigest !== storedDigest) corrupt();
  if (row.requestDigest !== requestDigest) refuse("IDEMPOTENCY_KEY_CONFLICT");
  // Zero writes and an unchanged join boundary: replay never re-allocates an
  // audit sequence and never moves the boundary.
  return Object.freeze({
    disposition: "REPLAYED",
    membership,
    record: Object.freeze({
      entityId: row.entityId,
      requestDigest: row.requestDigest,
      createdAt: row.createdAt,
    }),
  });
}

/**
 * Durable Exchange membership for one Participant.
 *
 * A valid `join` capability is required and verified inside the same owned
 * transaction as the mutation. Join allocates exactly one `participant_joined`
 * audit event through the accepted per-Exchange MAX(sequence)+1 discipline and
 * persists that sequence as the immutable `join_boundary_seq`, which is the
 * durable boundary between history that predates the join and activity that
 * follows it. Historical Message rows are never rewritten, and membership rows
 * are immutable and undeletable by the accepted v2 triggers.
 *
 * Eligibility derived from the boundary is a membership fact only. No message
 * listing, delivery, cursor, or ACK behavior exists in P1B.
 */
export function joinExchange(store: DurableStore, input: unknown, seams: JoinExchangeSeams = {}): MembershipJoin {
  const fields = captureFields(
    input,
    ["exchangeId", "participantId", "capability", "idempotencyKey"],
    ["exchangeId", "participantId", "capability", "idempotencyKey"],
    "request",
  );
  const exchangeId = requireExchangeId(fields.exchangeId, "exchangeId");
  const participantId = requireParticipantId(fields.participantId, "participantId");
  const idempotencyKey = requireIdempotencyKey(fields.idempotencyKey, "idempotencyKey");
  const capability = fields.capability;
  const namespace = JSON.stringify(["participant.join", exchangeId]);
  const requestDigest = canonicalDigest({
    op: "chat-exchange/participant.join",
    v: 1,
    exchangeId,
    participantId,
  });
  const afterMembershipInsert = seams.afterMembershipInsert;
  const afterIdempotencyInsert = seams.afterIdempotencyInsert;
  const afterAuditInsert = seams.afterAuditInsert;

  return runOwned(store, "Exchange membership join", (tx) => {
    // R1: transaction-time clock, sampled after the writer lock is held, so a
    // join capability is never authorized on a stale pre-lock instant.
    const createdAt = clock(seams);
    const eventId = generateEntityId("evt_", Date.parse(createdAt));
    // CE-0002-B3-P1B-R1 (MAJOR-1): current `join` authorization precedes every
    // protected result, including an idempotent replay, so no forged, expired,
    // revoked, wrong-scope, wrong-Participant, or wrong-generation capability
    // can obtain REPLAYED Membership data and an idempotency key is never an
    // authorization credential. Deliberate error-precedence change:
    // CAPABILITY_REJECTED now outranks replay, conflict, and corruption
    // classification on this path; within the authorized replay path the
    // accepted corruption-before-conflict ordering is unchanged.
    authorize(tx, store, { capability, participantId, scope: "join", now: createdAt });
    const replayed = replayJoin(tx, namespace, idempotencyKey, requestDigest, exchangeId);
    if (replayed !== undefined) return replayed;

    if (readParticipantRow(tx, participantId) === undefined) refuse("PARTICIPANT_NOT_FOUND");
    admitExchangeForJoin(tx, exchangeId);
    // An existing membership without its own idempotency record is orphan
    // durable state: refuse it, never adopt or repair it.
    if (readMembershipRow(tx, exchangeId, participantId) !== undefined) corrupt();

    const sequence = nextAuditSequence(tx, exchangeId);
    if (!EVENT_ID_PATTERN.test(eventId)) corrupt();
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO exchange_membership(exchange_id, participant_id, join_boundary_seq, created_at, private_revision) VALUES (?, ?, ?, ?, 1)",
        )
        .run(exchangeId, participantId, sequence, createdAt),
      "membership insert",
    );
    hook(afterMembershipInsert);
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
        )
        .run(namespace, idempotencyKey, requestDigest, participantId, createdAt),
      "idempotency insert",
    );
    hook(afterIdempotencyInsert);
    requireSingleRowChange(
      tx
        .prepare(
          "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, ?, 1)",
        )
        .run(eventId, exchangeId, sequence, PARTICIPANT_JOINED_EVENT_KIND, participantId, createdAt),
      "audit insert",
    );
    hook(afterAuditInsert);
    return Object.freeze({
      disposition: "CREATED" as const,
      membership: Object.freeze({ exchangeId, participantId, joinBoundarySeq: sequence, createdAt }),
      record: Object.freeze({ entityId: participantId, requestDigest, createdAt }),
    });
  });
}
