/**
 * Generic exchange entity schemas (frozen v2).
 *
 * Payload bodies and result bodies are expected data and may be persisted by
 * the host, but they are sensitive: keep them out of diagnostic logs and
 * correlate via digests (IDs, digests, lengths, typed outcomes) instead.
 * Never persist credentials or environment secrets; endpoint identity is
 * opaque routing identity only.
 */
import { Type, type Static } from "@sinclair/typebox";
import "./formats.js";
import {
  ATTEMPT_ID_PATTERN,
  EVENT_ID_PATTERN,
  EXCHANGE_ID_PATTERN,
  MESSAGE_ID_PATTERN,
  RECEIPT_ID_PATTERN,
  RESULT_ID_PATTERN,
} from "./identity.js";
import { MESSAGE_STATES } from "./lifecycle.js";
import { AttemptTransportSchema, DispatchMarkerSchema, RuntimeOutcomeSchema, TransportOutcomeSchema } from "./outcomes.js";

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const Sha256Schema = Type.String({
  pattern: SHA256_HEX_PATTERN.source,
  description: "SHA-256 hex digest. Correlate via digest, never log the body.",
});

const idSchema = (pattern: RegExp, description: string) =>
  Type.String({ pattern: pattern.source, description });

/**
 * Opaque, non-secret routing identity for one adapter endpoint.
 *
 * - `adapter` names the adapter kind that understands `endpointId`;
 * - `endpointId` is the DURABLE endpoint identity (survives restarts);
 * - `instanceId` is the EPHEMERAL process incarnation, when one is live.
 *
 * EndpointRef deliberately carries no free-form routing metadata and no
 * credentials: anything secret or adapter-specific beyond these three fields
 * stays adapter-local. `additionalProperties: false` enforces this.
 */
export const EndpointRefSchema = Type.Object(
  {
    adapter: Type.String({ minLength: 1, maxLength: 64 }),
    endpointId: Type.String({ minLength: 1, maxLength: 256 }),
    instanceId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export type EndpointRef = Static<typeof EndpointRefSchema>;

/**
 * Exchange aggregate root: OPEN governs correlation and message creation;
 * CLOSED is an explicit owner action (core `closeExchange`), never implied by
 * reads. Legacy `ho_` identity prefix retained from v1 (documented
 * compatibility; no id migration).
 */
export const ExchangeSchema = Type.Object(
  {
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Opaque immutable exchange identity: ho_ followed by a ULID (legacy v1 prefix, retained)."),
    state: Type.Union([Type.Literal("OPEN"), Type.Literal("CLOSED")]),
    createdAt: Type.String({ format: "date-time" }),
    closedAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export type Exchange = Static<typeof ExchangeSchema>;

/** A Message is an independently lifecycle-tracked entity inside one Exchange. */
export const MessageSchema = Type.Object(
  {
    messageId: idSchema(MESSAGE_ID_PATTERN, "Opaque immutable message identity: msg_ followed by a ULID (additive v2)."),
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Owning exchange identity."),
    from: EndpointRefSchema,
    to: EndpointRefSchema,
    state: Type.Union(MESSAGE_STATES.map((state) => Type.Literal(state))),
    payloadDigest: Sha256Schema,
    payloadLength: Type.Integer({ minimum: 0 }),
    createdAt: Type.String({ format: "date-time" }),
    idempotencyKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

export type Message = Static<typeof MessageSchema>;

/** Consumer lease: claim ownership with a fencing token and expiry. */
export const LeaseSchema = Type.Object(
  {
    consumerId: Type.String({ minLength: 1, maxLength: 128 }),
    instanceId: Type.String({ minLength: 1, maxLength: 256 }),
    fencingToken: Type.Integer({ minimum: 1 }),
    expiresAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type Lease = Static<typeof LeaseSchema>;

/**
 * DeliveryAttempt: the durable dispatch-evidence record. `dispatch` is marked
 * `started` durably BEFORE any adapter side effect; `transport` records the
 * generic outcome afterwards. The recorded `lease` is the fencing authority
 * for every mutation that cites this attempt.
 */
export const DeliveryAttemptSchema = Type.Object(
  {
    attemptId: idSchema(ATTEMPT_ID_PATTERN, "Opaque immutable attempt identity: att_ followed by a ULID (additive v2)."),
    messageId: idSchema(MESSAGE_ID_PATTERN, "Correlated message identity."),
    endpoint: EndpointRefSchema,
    lease: LeaseSchema,
    dispatch: DispatchMarkerSchema,
    transport: AttemptTransportSchema,
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type DeliveryAttempt = Static<typeof DeliveryAttemptSchema>;

/** Adapter-observed runtime evidence, correlated independently of transport. */
export const RuntimeEvidenceSchema = Type.Object(
  {
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Correlated exchange identity."),
    messageId: idSchema(MESSAGE_ID_PATTERN, "Correlated message identity."),
    attemptId: idSchema(ATTEMPT_ID_PATTERN, "Correlated attempt identity."),
    endpoint: EndpointRefSchema,
    outcome: RuntimeOutcomeSchema,
    observedAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);
export type RuntimeEvidence = Static<typeof RuntimeEvidenceSchema>;

/**
 * Immutable Result with full correlation (exchange, message, attempt) and
 * layered outcome discriminants. `applicationEvidence` is opaque JSON the
 * protocol never interprets. Publication is once: exact replay or conflict.
 */
export const ResultSchema = Type.Object(
  {
    resultId: idSchema(RESULT_ID_PATTERN, "Opaque immutable result identity: hr_ followed by a ULID (unchanged from v1)."),
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Correlated exchange identity."),
    messageId: idSchema(MESSAGE_ID_PATTERN, "Correlated message identity."),
    attemptId: idSchema(ATTEMPT_ID_PATTERN, "Correlated attempt identity."),
    source: EndpointRefSchema,
    transport: TransportOutcomeSchema,
    runtime: RuntimeOutcomeSchema,
    body: Type.String({ maxLength: 1_000_000 }),
    resultDigest: Sha256Schema,
    settledAt: Type.String({ format: "date-time" }),
    applicationEvidence: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

export type Result = Static<typeof ResultSchema>;

/** Non-mutating observation receipts (reads never change lifecycle state). */
export const ReceiptSchema = Type.Object(
  {
    receiptId: idSchema(RECEIPT_ID_PATTERN, "Opaque immutable receipt identity: rcpt_ followed by a ULID (additive v2)."),
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Correlated exchange identity."),
    messageId: idSchema(MESSAGE_ID_PATTERN, "Correlated message identity."),
    endpoint: EndpointRefSchema,
    kind: Type.Union([
      Type.Literal("read"),
      Type.Literal("delivery_ack"),
      Type.Literal("duplicate_suppressed"),
    ]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { additionalProperties: false },
);

export type Receipt = Static<typeof ReceiptSchema>;

/** Registered consumer (claim principal). Labels are non-secret diagnostics. */
export const ConsumerSchema = Type.Object(
  {
    consumerId: Type.String({ minLength: 1, maxLength: 128 }),
    label: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    createdAt: Type.String({ format: "date-time" }),
    lastSeenAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export type Consumer = Static<typeof ConsumerSchema>;

export const EVENT_KINDS = [
  "exchange_opened",
  "exchange_closed",
  "message_created",
  "message_state_changed",
  "attempt_recorded",
  "result_published",
  "receipt_recorded",
] as const;

/**
 * Bounded diagnostic event: IDs, digests, lengths, and typed outcomes only.
 * Raw payload bodies are structurally rejected (no `payload` field exists).
 */
export const EventSchema = Type.Object(
  {
    eventId: idSchema(EVENT_ID_PATTERN, "Opaque immutable event identity: evt_ followed by a ULID (additive v2)."),
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Correlated exchange identity."),
    sequence: Type.Integer({ minimum: 1 }),
    kind: Type.Union(EVENT_KINDS.map((kind) => Type.Literal(kind))),
    subjectId: Type.String({ minLength: 1, maxLength: 256 }),
    createdAt: Type.String({ format: "date-time" }),
    digest: Type.Optional(Sha256Schema),
    length: Type.Optional(Type.Integer({ minimum: 0 })),
    outcome: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

export type Event = Static<typeof EventSchema>;

/**
 * Explicit reconciliation evidence for quarantined (DELIVERY_UNKNOWN)
 * resolution. Late correlated acceptance or a confirmed no-effect proof must
 * travel with this record — an expired consumer lease is never sufficient.
 */
export const ReconciliationEvidenceSchema = Type.Object(
  {
    resolvedAt: Type.String({ format: "date-time" }),
    basis: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);

export type ReconciliationEvidence = Static<typeof ReconciliationEvidenceSchema>;

/**
 * Separate administrative archive, never an execution state or Result.
 * OPEN/CLOSED semantics are unchanged. A disposition permanently disables
 * protocol activity but preserves each original unresolved delivery fact.
 * Owner identity must come from the authenticated host, not an adapter label.
 */
export const ExchangeDispositionSchema = Type.Object(
  {
    exchangeId: idSchema(EXCHANGE_ID_PATTERN, "Administratively archived exchange identity."),
    status: Type.Literal("ABANDONED_UNRESOLVED"),
    ownerId: Type.String({ minLength: 1, maxLength: 256 }),
    recordedAt: Type.String({ format: "date-time" }),
    reason: Type.String({ minLength: 1, maxLength: 1024 }),
    // This is investigation/owner-intent metadata, not execution proof.
    reconciliation: ReconciliationEvidenceSchema,
    unresolved: Type.Array(Type.Object(
      {
        messageId: idSchema(MESSAGE_ID_PATTERN, "Original unresolved message identity."),
        originalState: Type.Literal("DELIVERY_UNKNOWN"),
        transport: Type.Literal("ambiguous"),
        unresolvedSideEffects: Type.Literal(true),
        attempt: DeliveryAttemptSchema,
      },
      { additionalProperties: false },
    ), { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type ExchangeDisposition = Static<typeof ExchangeDispositionSchema>;
export type DispositionIntent = Pick<ExchangeDisposition, "ownerId" | "recordedAt" | "reason" | "reconciliation">;
