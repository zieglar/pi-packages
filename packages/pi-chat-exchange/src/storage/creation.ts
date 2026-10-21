import { createHash } from "node:crypto";
import { types } from "node:util";
import { Value } from "@sinclair/typebox/value";
import {
  EndpointRefSchema, EventSchema, ExchangeSchema, MessageSchema, SHA256_HEX_PATTERN,
  type EndpointRef, type Exchange, type Message,
} from "../protocol/entities.js";
import { assertExchangeActive } from "../core/rules.js";
import {
  generateEntityId, generateHandoffId, EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN,
} from "../protocol/identity.js";
import { canonicalDigest, type IdempotentCreateRecord } from "../protocol/idempotency.js";
import {
  copyCapturedMessagePayloadForPersistence, normalizeCreateExchangeRequest,
  normalizeCreateMessageRequest,
  type NormalizedExchangeRequest, type NormalizedMessageRequest,
} from "./creation-request.js";
import type { DurableStore } from "./store.js";
import {
  ConditionalMutationError, StorageTransactionError, requireSingleRowChange,
  withImmediateTransaction, type TransactionHandle,
} from "./transaction.js";

export interface ExchangeCreation {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly exchange: Exchange;
  readonly record: IdempotentCreateRecord;
}

/** Private synchronous fault boundaries. Hooks receive no capabilities or values.
 * Trusted test/host code owns execution deadlines; these are not a sandbox. */
interface PrivateCreationSeams {
  readonly now?: () => string;
  readonly afterExchangeInsert?: () => void;
  readonly afterIdempotencyInsert?: () => void;
  readonly afterAuditInsert?: () => void;
}

type CreationDomainCode =
  | "STORAGE_IDEMPOTENCY_CORRUPT"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "STORAGE_EXCHANGE_NOT_FOUND"
  | "EXCHANGE_DISPOSITION_REJECTED";

/** Fixed sanitized details: never a SQL message, stored value, or payload byte. */
const DOMAIN_DETAIL: Record<CreationDomainCode, string> = {
  STORAGE_IDEMPOTENCY_CORRUPT: "stored Exchange creation is inconsistent; operator review required",
  IDEMPOTENCY_KEY_CONFLICT: "creation idempotency key conflicts with a valid stored request",
  STORAGE_EXCHANGE_NOT_FOUND: "creation requires an existing durable Exchange",
  EXCHANGE_DISPOSITION_REJECTED: "administrative disposition rejected: the Exchange is not open",
};

export class CreationDomainError extends Error {
  readonly outcome = "ROLLED_BACK";
  readonly retryable = false;
  readonly code: CreationDomainCode;
  constructor(code: CreationDomainCode) {
    super(DOMAIN_DETAIL[code]);
    this.name = "CreationDomainError";
    this.code = code;
  }
}

function corrupt(): never {
  throw new CreationDomainError("STORAGE_IDEMPOTENCY_CORRUPT");
}

/** Validate durable consistency BEFORE comparing the incoming request digest.
 * Schema v1 has no immutable creation metadata enforcement: coordinated writes
 * by a privileged raw connection are not authenticated by this validation. */
function replay(tx: TransactionHandle, request: NormalizedExchangeRequest): ExchangeCreation | undefined {
  const row = tx.prepare("SELECT * FROM idempotency_record WHERE namespace=? AND idempotency_key=?")
    .get(request.namespace, request.idempotencyKey);
  if (row === undefined) return undefined;
  if (Object.keys(row).length !== 6 || row.namespace !== request.namespace ||
      row.idempotency_key !== request.idempotencyKey || row.private_revision !== 1 ||
      typeof row.request_digest !== "string" || !SHA256_HEX_PATTERN.test(row.request_digest) ||
      typeof row.entity_id !== "string" || !EXCHANGE_ID_PATTERN.test(row.entity_id) ||
      typeof row.created_at !== "string") corrupt();

  const stored = tx.prepare("SELECT * FROM exchange WHERE exchange_id=?").get(row.entity_id);
  if (stored === undefined || Object.keys(stored).length !== 5 || stored.private_revision !== 1 ||
      stored.exchange_id !== row.entity_id || stored.created_at !== row.created_at ||
      !((stored.state === "OPEN" && stored.closed_at === null) ||
        (stored.state === "CLOSED" && typeof stored.closed_at === "string"))) corrupt();

  const candidate = {
    exchangeId: stored.exchange_id,
    state: stored.state,
    createdAt: stored.created_at,
    ...(stored.closed_at === null ? {} : { closedAt: stored.closed_at }),
  };
  if (!Value.Check(ExchangeSchema, candidate)) corrupt();
  // Exchange v1 has no creation-content fields. A different stored digest cannot
  // describe a valid Exchange-create request; it is corruption, not conflict.
  const storedDigest = canonicalDigest({ op: "chat-exchange/exchange.create", v: 1 });
  if (row.request_digest !== storedDigest) corrupt();
  if (row.request_digest !== request.requestDigest) {
    throw new CreationDomainError("IDEMPOTENCY_KEY_CONFLICT");
  }
  return Object.freeze({
    disposition: "REPLAYED",
    exchange: Object.freeze(candidate),
    record: Object.freeze({ entityId: row.entity_id, requestDigest: row.request_digest, createdAt: row.created_at }),
  });
}

function hook(action: (() => void) | undefined): void {
  if (action === undefined) return;
  try {
    // Never inspect unsupported results or arbitrary thrown values.
    if (action() === undefined) return;
  } catch { /* replace caller exceptions before the B1 helper sees them */ }
  throw new Error("private creation hook failed or returned a non-undefined value");
}

/** Private, trusted-host operation. No authentication, dispatch, Message writes,
 * automatic retries, resolution API, or public control binding is provided.
 * Results escape only after the accepted helper confirms COMMITTED. */
export function createExchange(store: DurableStore, input: unknown, privateSeams: PrivateCreationSeams = {}): ExchangeCreation {
  const request = normalizeCreateExchangeRequest(input);
  let exchange: Exchange;
  let eventId: string;
  let hooks: {
    afterExchangeInsert: (() => void) | undefined;
    afterIdempotencyInsert: (() => void) | undefined;
    afterAuditInsert: (() => void) | undefined;
  };
  try {
    // Capture seam accessors before entering the transaction. A caller-created
    // domain-error instance must not be mistaken for an internal SQL/domain error.
    hooks = {
      afterExchangeInsert: privateSeams.afterExchangeInsert,
      afterIdempotencyInsert: privateSeams.afterIdempotencyInsert,
      afterAuditInsert: privateSeams.afterAuditInsert,
    };
    if (Object.values(hooks).some((value) => value !== undefined && typeof value !== "function")) {
      throw new Error("invalid private hook");
    }
    const createdAt = (privateSeams.now ?? (() => new Date().toISOString()))();
    if (typeof createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
        !Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
      throw new Error("invalid private clock");
    }
    const time = Date.parse(createdAt);
    exchange = Object.freeze({ exchangeId: generateHandoffId(time), state: "OPEN", createdAt });
    eventId = generateEntityId("evt_", time);
  } catch {
    throw new StorageTransactionError("creation candidate generation failed", "begin", { outcome: "ROLLED_BACK" });
  }

  let captured: ExchangeCreation | undefined;
  let domainFailure: CreationDomainError | ConditionalMutationError | undefined;
  try {
    withImmediateTransaction(store.database, (tx) => {
      try {
        const existing = replay(tx, request);
        if (existing !== undefined) {
          captured = existing;
          return; // Exactly undefined, including replay.
        }
        const event = {
          eventId, exchangeId: exchange.exchangeId, sequence: 1, kind: "exchange_opened",
          subjectId: exchange.exchangeId, createdAt: exchange.createdAt,
        };
        if (!Value.Check(ExchangeSchema, exchange) || !Value.Check(EventSchema, event)) {
          throw new Error("creation candidate failed frozen schema validation");
        }
        requireSingleRowChange(tx.prepare(
          "INSERT INTO exchange(exchange_id, state, created_at, closed_at, private_revision) VALUES (?, 'OPEN', ?, NULL, 1)",
        ).run(exchange.exchangeId, exchange.createdAt), "Exchange insert");
        hook(hooks.afterExchangeInsert);
        requireSingleRowChange(tx.prepare(
          "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
        ).run(request.namespace, request.idempotencyKey, request.requestDigest, exchange.exchangeId, exchange.createdAt), "idempotency insert");
        hook(hooks.afterIdempotencyInsert);
        requireSingleRowChange(tx.prepare(
          "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, 1, 'exchange_opened', ?, ?, 1)",
        ).run(eventId, exchange.exchangeId, exchange.exchangeId, exchange.createdAt), "audit insert");
        hook(hooks.afterAuditInsert);
        captured = Object.freeze({
          disposition: "CREATED", exchange,
          record: Object.freeze({ entityId: exchange.exchangeId, requestDigest: request.requestDigest, createdAt: exchange.createdAt }),
        });
        // No return value: B1 runtime enforces exactly undefined.
      } catch (error) {
        if (error instanceof CreationDomainError || error instanceof ConditionalMutationError) {
          domainFailure = error;
          throw error;
        }
        // SQLite messages, hook failures and arbitrary objects are not retained.
        throw new Error("Exchange creation callback failed");
      }
    });
  } catch (error) {
    if (error instanceof ConditionalMutationError && error === domainFailure) throw error;
    if (error instanceof StorageTransactionError) {
      if (error.outcome === "ROLLED_BACK" && domainFailure !== undefined && error.cause === domainFailure) {
        throw domainFailure;
      }
      // INDETERMINATE always wins over nested domain failures. B1 alone owns
      // rollback classification, connection invalidation and retry eligibility.
      throw new StorageTransactionError("Exchange creation transaction failed", error.stage, {
        outcome: error.outcome, busy: error.retryable,
      });
    }
    throw new StorageTransactionError("Exchange creation transaction outcome is unknown", "callback");
  }
  // Both callback paths assign captured; never construct results with reads
  // after commit, nor publish a candidate on any helper failure.
  return captured!;
}

export interface MessageCreation {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly message: Message;
  readonly record: IdempotentCreateRecord;
}

interface PrivateMessageCreationSeams {
  readonly now?: () => string;
  readonly afterMessageInsert?: () => void;
  readonly afterIdempotencyInsert?: () => void;
  readonly afterAuditInsert?: () => void;
}

/** Generated identity and transaction-time metadata for one candidate. */
export interface TrustedMessageCreationMetadata {
  readonly messageId: string;
  readonly eventId: string;
  readonly createdAt: string;
}

export interface MessageTransactionHooks {
  readonly afterMessageInsert?: (() => void) | undefined;
  readonly afterIdempotencyInsert?: (() => void) | undefined;
  readonly afterAuditInsert?: (() => void) | undefined;
}

export interface TransactionMessageCreation {
  readonly creation: MessageCreation;
  /** Defined for a newly inserted Message; replay callers that need ordering
   * must validate the durable correlation with `messageCreatedAuditSequence`. */
  readonly auditSequence?: number;
}

/** Stored endpoint JSON is data, never trusted structure: parse then schema-check. */
function storedEndpoint(json: unknown): EndpointRef {
  if (typeof json !== "string") corrupt();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return corrupt();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype ||
      !Value.Check(EndpointRefSchema, parsed)) corrupt();
  return Object.freeze(parsed as EndpointRef);
}

/** Strict canonical unsigned decimal text from SQLite INTEGER projection.
 * Check range losslessly before conversion; arbitrary driver failures are not
 * translated to corruption. Schema-v1 revisions are compared as exact text. */
function safeStoredInteger(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) corrupt();
  const integer = BigInt(value);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) corrupt();
  return Number(integer);
}

/** Validate durable Message consistency BEFORE comparing the incoming digest.
 * Replay precedes admission: historical identity is not execution authority,
 * and privileged raw writes remain unauthenticated by this validation. */
function replayMessage(tx: TransactionHandle, request: NormalizedMessageRequest): MessageCreation | undefined {
  // B1 deliberately exposes no setReadBigInts capability. Cast INTEGER columns
  // to decimal text in these S3-only projections before the driver decodes them.
  const row = tx.prepare(
    "SELECT namespace, idempotency_key, request_digest, entity_id, created_at, CAST(private_revision AS TEXT) AS private_revision FROM idempotency_record WHERE namespace=? AND idempotency_key=?",
  ).get(request.namespace, request.idempotencyKey);
  if (row === undefined) return undefined;
  if (Object.keys(row).length !== 6 || row.namespace !== request.namespace ||
      row.idempotency_key !== request.idempotencyKey || row.private_revision !== "1" ||
      typeof row.request_digest !== "string" || !SHA256_HEX_PATTERN.test(row.request_digest) ||
      typeof row.entity_id !== "string" || !MESSAGE_ID_PATTERN.test(row.entity_id) ||
      typeof row.created_at !== "string") corrupt();

  const candidate = readMessageInTransaction(tx, request.exchangeId, row.entity_id);
  if (
    candidate === undefined ||
    candidate.idempotencyKey !== row.idempotency_key ||
    candidate.createdAt !== row.created_at
  ) {
    corrupt();
  }
  // Recompute the stored request identity from the durable row: a stored digest
  // that no valid stored request can produce is corruption, never a conflict.
  const storedDigest = canonicalDigest({
    op: "chat-exchange/message.create", v: 1, exchangeId: candidate.exchangeId,
    from: candidate.from, to: candidate.to,
    payloadDigest: candidate.payloadDigest, payloadLength: candidate.payloadLength,
  });
  if (row.request_digest !== storedDigest) corrupt();
  if (row.request_digest !== request.requestDigest) {
    throw new CreationDomainError("IDEMPOTENCY_KEY_CONFLICT");
  }
  return Object.freeze({
    disposition: "REPLAYED",
    message: Object.freeze(candidate),
    record: Object.freeze({ entityId: row.entity_id, requestDigest: row.request_digest, createdAt: row.created_at }),
  });
}

/** Strict metadata-only Message read for bounded Inbox enumeration. It does not
 * select or materialize `payload_body`; individual Message reads continue to use
 * `readMessageInTransaction` and retain full payload-integrity validation. */
export function readMessageMetadataInTransaction(
  tx: TransactionHandle,
  exchangeId: string,
  messageId: string,
): Message | undefined {
  const stored = tx
    .prepare(
      "SELECT message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, CAST(payload_length AS TEXT) AS payload_length, created_at, idempotency_key, CAST(private_revision AS TEXT) AS private_revision FROM message WHERE message_id=? AND exchange_id=?",
    )
    .get(messageId, exchangeId);
  if (stored === undefined) return undefined;
  const payloadLength = safeStoredInteger(stored.payload_length);
  if (
    Object.keys(stored).length !== 10 ||
    stored.private_revision !== "1" ||
    stored.message_id !== messageId ||
    stored.exchange_id !== exchangeId ||
    typeof stored.payload_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(stored.payload_digest)
  ) {
    corrupt();
  }
  // SAFETY: every projected scalar is checked above and the complete candidate
  // is validated against the frozen MessageSchema before it can escape.
  const candidate = {
    messageId: stored.message_id,
    exchangeId: stored.exchange_id,
    from: storedEndpoint(stored.from_endpoint_json),
    to: storedEndpoint(stored.to_endpoint_json),
    state: stored.state,
    payloadDigest: stored.payload_digest,
    payloadLength,
    createdAt: stored.created_at,
    ...(stored.idempotency_key === null ? {} : { idempotencyKey: stored.idempotency_key }),
  } as unknown as Message;
  if (!Value.Check(MessageSchema, candidate)) corrupt();
  return Object.freeze(candidate);
}

/** Strict private Message read inside a caller-owned transaction. Payload bytes
 * are validated for durable integrity but never returned. */
export function readMessageInTransaction(
  tx: TransactionHandle,
  exchangeId: string,
  messageId: string,
): Message | undefined {
  const stored = tx
    .prepare(
      "SELECT message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, CAST(payload_length AS TEXT) AS payload_length, payload_body, created_at, idempotency_key, CAST(private_revision AS TEXT) AS private_revision FROM message WHERE message_id=? AND exchange_id=?",
    )
    .get(messageId, exchangeId);
  if (stored === undefined) return undefined;
  const payloadLength = safeStoredInteger(stored.payload_length);
  if (
    Object.keys(stored).length !== 11 ||
    stored.private_revision !== "1" ||
    stored.message_id !== messageId ||
    stored.exchange_id !== exchangeId ||
    typeof stored.payload_digest !== "string" ||
    !SHA256_HEX_PATTERN.test(stored.payload_digest) ||
    !types.isUint8Array(stored.payload_body) ||
    stored.payload_body.byteLength !== payloadLength ||
    createHash("sha256").update(stored.payload_body).digest("hex") !== stored.payload_digest
  ) {
    corrupt();
  }
  // SAFETY: every projected scalar is checked above and the complete candidate
  // is validated against the frozen MessageSchema before it can escape.
  const candidate = {
    messageId: stored.message_id,
    exchangeId: stored.exchange_id,
    from: storedEndpoint(stored.from_endpoint_json),
    to: storedEndpoint(stored.to_endpoint_json),
    state: stored.state,
    payloadDigest: stored.payload_digest,
    payloadLength,
    createdAt: stored.created_at,
    ...(stored.idempotency_key === null ? {} : { idempotencyKey: stored.idempotency_key }),
  } as unknown as Message;
  if (!Value.Check(MessageSchema, candidate)) corrupt();
  return Object.freeze(candidate);
}

/** CE-0002-B3-P4D strict payload-body materialization inside a caller-owned
 * transaction. The caller must already have established full authorization and
 * eligibility: this reads the stored bytes only afterwards, validates the BLOB
 * type, exact byte length, and SHA-256 digest against the authorized Message
 * metadata, and returns a fresh complete copy. The exact `message_created`
 * audit correlation is validated separately by the caller's eligibility chain. */
export function readMessagePayloadBodyInTransaction(
  tx: TransactionHandle,
  message: Message,
): Uint8Array {
  const row = tx
    .prepare("SELECT payload_body FROM message WHERE message_id=? AND exchange_id=?")
    .get(message.messageId, message.exchangeId);
  if (row === undefined || Object.keys(row).length !== 1) corrupt();
  const body = (row as { payload_body?: unknown }).payload_body;
  if (!types.isUint8Array(body)) corrupt();
  if (body.byteLength !== message.payloadLength) corrupt();
  if (createHash("sha256").update(body).digest("hex") !== message.payloadDigest) corrupt();
  return new Uint8Array(body);
}

/** Exact `message_created` correlation used as P3A ordering evidence. */
export function messageCreatedAuditSequence(tx: TransactionHandle, message: Message): number {
  const rows = tx
    .prepare(
      "SELECT event_id, exchange_id, CAST(sequence AS TEXT) AS sequence, kind, subject_id, created_at, digest, CAST(length AS TEXT) AS length, outcome, CAST(private_revision AS TEXT) AS private_revision FROM audit_event WHERE exchange_id=? AND kind='message_created' AND subject_id=? LIMIT 2",
    )
    .all(message.exchangeId, message.messageId);
  if (rows.length !== 1) corrupt();
  const row = rows[0]!;
  const sequence = safeStoredInteger(row.sequence);
  const length = safeStoredInteger(row.length);
  const event = {
    eventId: row.event_id,
    exchangeId: row.exchange_id,
    sequence,
    kind: row.kind,
    subjectId: row.subject_id,
    createdAt: row.created_at,
    digest: row.digest,
    length,
  };
  if (
    Object.keys(row).length !== 10 ||
    row.private_revision !== "1" ||
    row.outcome !== null ||
    sequence < 1 ||
    row.exchange_id !== message.exchangeId ||
    row.subject_id !== message.messageId ||
    row.created_at !== message.createdAt ||
    row.digest !== message.payloadDigest ||
    length !== message.payloadLength ||
    !Value.Check(EventSchema, event)
  ) {
    corrupt();
  }
  return sequence;
}

/** Admission for NEW creation only. No disposition object is fabricated: the
 * presence of the administrative row alone permanently refuses new activity. */
function admitExchange(tx: TransactionHandle, exchangeId: string): void {
  const row = tx.prepare(
    "SELECT exchange_id, state, created_at, closed_at, CAST(private_revision AS TEXT) AS private_revision FROM exchange WHERE exchange_id=?",
  ).get(exchangeId);
  if (row === undefined) throw new CreationDomainError("STORAGE_EXCHANGE_NOT_FOUND");
  if (Object.keys(row).length !== 5 || row.private_revision !== "1" || row.exchange_id !== exchangeId ||
      !((row.state === "OPEN" && row.closed_at === null) ||
        (row.state === "CLOSED" && typeof row.closed_at === "string"))) corrupt();
  const exchange = {
    exchangeId: row.exchange_id,
    state: row.state,
    createdAt: row.created_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  } as unknown as Exchange;
  if (!Value.Check(ExchangeSchema, exchange)) corrupt();
  if (tx.prepare("SELECT exchange_id FROM disposition WHERE exchange_id=?").get(exchangeId) !== undefined) {
    throw new CreationDomainError("EXCHANGE_DISPOSITION_REJECTED");
  }
  try {
    assertExchangeActive(exchange);
  } catch {
    // Frozen core owns the rule; storage publishes only the sanitized refusal.
    throw new CreationDomainError("EXCHANGE_DISPOSITION_REJECTED");
  }
}

function nextAuditSequence(tx: TransactionHandle, exchangeId: string): number {
  const row = tx.prepare("SELECT MAX(sequence) AS maximum FROM audit_event WHERE exchange_id=?").get(exchangeId);
  const maximum = row?.maximum ?? null;
  if (maximum !== null && (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1)) corrupt();
  const sequence = (maximum ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) corrupt();
  return sequence;
}

/** The only durable payload path. The fresh copy is bound once, verified against
 * the normalized digest and length, then best-effort cleared. Cleanup is hygiene,
 * not secure erasure, and never changes the owning transaction's classification. */
function persistCapturedMessageSnapshot(
  tx: TransactionHandle,
  request: NormalizedMessageRequest,
  trusted: TrustedMessageCreationMetadata,
): void {
  const copy = copyCapturedMessagePayloadForPersistence(request);
  try {
    if (copy.byteLength !== request.payloadLength ||
        createHash("sha256").update(copy).digest("hex") !== request.payloadDigest) {
      throw new Error("persistence copy failed digest or length validation");
    }
    requireSingleRowChange(tx.prepare(
      "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, 1)",
    ).run(
      trusted.messageId, request.exchangeId, request.fromEndpointJson, request.toEndpointJson,
      request.payloadDigest, request.payloadLength, copy, trusted.createdAt, request.idempotencyKey,
    ), "Message insert");
  } finally {
    try { copy.fill(0); } catch { /* cleanup must never replace a failure classification */ }
  }
}

/** Package-private transaction-scoped B2 persistence. The caller owns the
 * IMMEDIATE transaction and all authorization ordering. */
export function createMessageInTransaction(
  tx: TransactionHandle,
  request: NormalizedMessageRequest,
  trusted: TrustedMessageCreationMetadata,
  hooks: MessageTransactionHooks = {},
): TransactionMessageCreation {
  const existing = replayMessage(tx, request);
  if (existing !== undefined) return Object.freeze({ creation: existing });

  admitExchange(tx, request.exchangeId);
  if (
    tx
      .prepare("SELECT message_id FROM message WHERE exchange_id=? AND idempotency_key=?")
      .get(request.exchangeId, request.idempotencyKey) !== undefined
  ) {
    corrupt();
  }

  const message = Object.freeze({
    messageId: trusted.messageId,
    exchangeId: request.exchangeId,
    from: request.from,
    to: request.to,
    state: "CREATED",
    payloadDigest: request.payloadDigest,
    payloadLength: request.payloadLength,
    createdAt: trusted.createdAt,
    idempotencyKey: request.idempotencyKey,
  } satisfies Message);
  if (!Value.Check(MessageSchema, message)) throw new Error("creation candidate failed frozen schema validation");

  persistCapturedMessageSnapshot(tx, request, trusted);
  hook(hooks.afterMessageInsert);
  requireSingleRowChange(
    tx
      .prepare(
        "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
      )
      .run(request.namespace, request.idempotencyKey, request.requestDigest, message.messageId, message.createdAt),
    "idempotency insert",
  );
  hook(hooks.afterIdempotencyInsert);

  const sequence = nextAuditSequence(tx, message.exchangeId);
  const event = {
    eventId: trusted.eventId,
    exchangeId: message.exchangeId,
    sequence,
    kind: "message_created",
    subjectId: message.messageId,
    createdAt: message.createdAt,
    digest: message.payloadDigest,
    length: message.payloadLength,
  };
  if (!Value.Check(EventSchema, event)) throw new Error("audit candidate failed frozen schema validation");
  requireSingleRowChange(
    tx
      .prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, 1)",
      )
      .run(
        event.eventId,
        event.exchangeId,
        event.sequence,
        event.subjectId,
        event.createdAt,
        event.digest,
        event.length,
      ),
    "audit insert",
  );
  hook(hooks.afterAuditInsert);

  return Object.freeze({
    creation: Object.freeze({
      disposition: "CREATED" as const,
      message,
      record: Object.freeze({
        entityId: message.messageId,
        requestDigest: request.requestDigest,
        createdAt: message.createdAt,
      }),
    }),
    auditSequence: sequence,
  });
}

/** Private, trusted-host Message creation. No authentication, admission bypass,
 * queueing, dispatch, delivery, resolution API, or public control binding.
 * Results escape only after the accepted helper confirms COMMITTED. */
export function createMessage(store: DurableStore, input: unknown, privateSeams: PrivateMessageCreationSeams = {}): MessageCreation {
  const request = normalizeCreateMessageRequest(input);
  let trusted: TrustedMessageCreationMetadata;
  let hooks: MessageTransactionHooks;
  try {
    hooks = {
      afterMessageInsert: privateSeams.afterMessageInsert,
      afterIdempotencyInsert: privateSeams.afterIdempotencyInsert,
      afterAuditInsert: privateSeams.afterAuditInsert,
    };
    if (Object.values(hooks).some((value) => value !== undefined && typeof value !== "function")) {
      throw new Error("invalid private hook");
    }
    const createdAt = (privateSeams.now ?? (() => new Date().toISOString()))();
    if (
      typeof createdAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt
    ) {
      throw new Error("invalid private clock");
    }
    const time = Date.parse(createdAt);
    trusted = Object.freeze({
      messageId: generateEntityId("msg_", time),
      eventId: generateEntityId("evt_", time),
      createdAt,
    });
  } catch {
    throw new StorageTransactionError("creation candidate generation failed", "begin", { outcome: "ROLLED_BACK" });
  }

  let captured: MessageCreation | undefined;
  let domainFailure: CreationDomainError | ConditionalMutationError | undefined;
  try {
    withImmediateTransaction(store.database, (tx) => {
      try {
        captured = createMessageInTransaction(tx, request, trusted, hooks).creation;
        // No return value: B1 runtime enforces exactly undefined.
      } catch (error) {
        if (error instanceof CreationDomainError || error instanceof ConditionalMutationError) {
          domainFailure = error;
          throw error;
        }
        // SQLite messages, hook failures and arbitrary objects are not retained.
        throw new Error("Message creation callback failed");
      }
    });
  } catch (error) {
    if (error instanceof ConditionalMutationError && error === domainFailure) throw error;
    if (error instanceof StorageTransactionError) {
      if (error.outcome === "ROLLED_BACK" && domainFailure !== undefined && error.cause === domainFailure) {
        throw domainFailure;
      }
      // INDETERMINATE always wins over nested domain failures. B1 alone owns
      // rollback classification, connection invalidation and retry eligibility.
      throw new StorageTransactionError("Message creation transaction failed", error.stage, {
        outcome: error.outcome, busy: error.retryable,
      });
    }
    throw new StorageTransactionError("Message creation transaction outcome is unknown", "callback");
  }
  return captured!;
}
