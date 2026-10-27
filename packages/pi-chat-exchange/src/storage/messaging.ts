import { EXCHANGE_ID_PATTERN, generateEntityId, MESSAGE_ID_PATTERN } from "../protocol/identity.js";
import type { Message } from "../protocol/entities.js";
import {
  CreationDomainError,
  createMessageInTransaction,
  messageCreatedAuditSequence,
  readMessageInTransaction,
  readMessageMetadataInTransaction,
  readMessagePayloadBodyInTransaction,
  type MessageCreation,
  type MessageTransactionHooks,
} from "./creation.js";
import { normalizeCreateMessageRequest } from "./creation-request.js";
import { StoreLifecycleError } from "./errors.js";
import { authorizeCurrentOwner } from "./ownership.js";
import {
  captureFields,
  ParticipantRequestError,
  requireParticipantId,
  requireSessionId,
  requireText,
} from "./participant-identity.js";
import {
  clock,
  ParticipantDomainError,
  readMembershipRow,
  readParticipantRow,
  refuse,
  type ClockSeam,
} from "./participant.js";
import type { DurableStore } from "./store.js";
import {
  ConditionalMutationError,
  StorageTransactionError,
  withImmediateTransaction,
  type TransactionHandle,
} from "./transaction.js";

/** Private B3-P3A result. Audit order remains a private projection and never
 * adds a property to the frozen public Message entity. */
export interface AuthorizedMessageCreation extends MessageCreation {
  readonly auditSequence: number;
}

/** Recipient-visible metadata only. Payload bytes remain private storage data. */
export interface ProtectedMessageMetadata {
  readonly message: Message;
  readonly auditSequence: number;
}

export interface MessagingSeams extends ClockSeam, MessageTransactionHooks {}

export interface AuthorityRequest {
  readonly capability: unknown;
  readonly participantId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
}

function requireFencingToken(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ParticipantRequestError("fencingToken: invalid fencing token");
  }
  return value;
}

export function authorityRequest(fields: Record<string, unknown>): AuthorityRequest {
  return Object.freeze({
    capability: fields.capability,
    participantId: requireParticipantId(fields.participantId, "participantId"),
    sessionId: requireSessionId(fields.sessionId, "sessionId"),
    fencingToken: requireFencingToken(fields.fencingToken),
  });
}

export function runMessagingTransaction<T>(
  store: DurableStore,
  label: string,
  body: (tx: TransactionHandle) => T,
): T {
  let captured: { value: T } | undefined;
  let domainFailure:
    | ParticipantDomainError
    | ParticipantRequestError
    | CreationDomainError
    | ConditionalMutationError
    | StoreLifecycleError
    | undefined;
  try {
    withImmediateTransaction(store.database, (tx) => {
      try {
        captured = { value: body(tx) };
      } catch (error) {
        if (
          error instanceof ParticipantDomainError ||
          error instanceof ParticipantRequestError ||
          error instanceof CreationDomainError ||
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

export function requireMembership(tx: TransactionHandle, exchangeId: string, participantId: string) {
  const membership = readMembershipRow(tx, exchangeId, participantId);
  if (membership === undefined) refuse("PARTICIPANT_NOT_MEMBER");
  return membership;
}

function stableEndpointMatches(
  tx: TransactionHandle,
  participantId: string,
  endpoint: Message["from"],
): boolean {
  const participant = readParticipantRow(tx, participantId);
  return (
    participant !== undefined &&
    participant.adapter === endpoint.adapter &&
    participant.endpointId === endpoint.endpointId
  );
}

function requireStableSender(
  tx: TransactionHandle,
  participantId: string,
  endpoint: Message["from"],
): void {
  if (!stableEndpointMatches(tx, participantId, endpoint)) refuse("PARTICIPANT_BINDING_MISMATCH");
}

/** Session-authorized durable send. Authorization, replay, admission, Message,
 * idempotency, and audit all serialize in one IMMEDIATE transaction. */
export function sendMessage(
  store: DurableStore,
  input: unknown,
  seams: MessagingSeams = {},
): AuthorizedMessageCreation {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "fencingToken", "capability", "message"],
    ["participantId", "sessionId", "fencingToken", "capability", "message"],
    "request",
  );
  const authority = authorityRequest(fields);
  const request = normalizeCreateMessageRequest(fields.message);

  return runMessagingTransaction(store, "Authorized Message send", (tx) => {
    // Sample only after BEGIN IMMEDIATE owns the writer lock.
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...authority, scope: "send", now });
    requireMembership(tx, request.exchangeId, authority.participantId);
    requireStableSender(tx, authority.participantId, request.from);

    const time = Date.parse(now);
    const transaction = createMessageInTransaction(
      tx,
      request,
      {
        messageId: generateEntityId("msg_", time),
        eventId: generateEntityId("evt_", time),
        createdAt: now,
      },
      seams,
    );
    const auditSequence = messageCreatedAuditSequence(tx, transaction.creation.message);
    return Object.freeze({ ...transaction.creation, auditSequence });
  });
}

/** Repeatable recipient-only protected metadata read. It deliberately takes the
 * same serialization lock as mutations so ownership authority and eligibility
 * are evaluated against one current durable snapshot. */
export function readMessageMetadata(
  store: DurableStore,
  input: unknown,
  seams: ClockSeam = {},
): ProtectedMessageMetadata {
  return runMessageRead(
    store,
    messageReadRequest(input),
    seams,
    "read",
    "Protected Message read",
    (tx, exchangeId, messageId) => readMessageInTransaction(tx, exchangeId, messageId),
    (_tx, eligible) => Object.freeze({ ...eligible }),
  );
}

/** Private B3-P4D result: authorized recipient metadata plus the exact payload
 * byte copy. The bytes are materialized only after the full eligibility chain
 * has passed inside the same serialized transaction. */
export interface ProtectedMessagePayload {
  readonly message: Message;
  readonly auditSequence: number;
  readonly payload: Uint8Array;
}

/** CE-0002-B3-P4D authorized payload read. Takes the same serialization lock
 * as mutations so the whole authorization and eligibility chain is evaluated
 * against one current durable snapshot: exact `payload_read` capability,
 * ATTACHED Session, current Owner, current fencing, active lease, Exchange
 * membership, recipient-only visibility, exact `message_created` audit
 * correlation, and the recipient's immutable join boundary — all metadata-only.
 * Only then is `payload_body` materialized, validated for BLOB type, exact
 * byte length, and SHA-256 digest, and returned as a fresh complete copy after
 * the committed transaction. The operation is a pure read: no Message state
 * change, Audit row, receipt, ACK, cursor advance, lease renewal, ownership
 * change, capability issuance, or automatic retry ever occurs. */
export function readMessagePayload(
  store: DurableStore,
  input: unknown,
  seams: ClockSeam = {},
): ProtectedMessagePayload {
  return runMessageRead(
    store,
    messageReadRequest(input),
    seams,
    "payload_read",
    "Authorized Message payload read",
    (tx, exchangeId, messageId) => readMessageMetadataInTransaction(tx, exchangeId, messageId),
    (tx, eligible) => Object.freeze({ ...eligible, payload: readMessagePayloadBodyInTransaction(tx, eligible.message) }),
  );
}

/** Shared request shape of both recipient-side Message reads. */
interface MessageReadRequest {
  readonly authority: AuthorityRequest;
  readonly exchangeId: string;
  readonly messageId: string;
}

function messageReadRequest(input: unknown): MessageReadRequest {
  const fields = captureFields(
    input,
    ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "messageId"],
    ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "messageId"],
    "request",
  );
  const authority = authorityRequest(fields);
  const exchangeId = requireText(fields.exchangeId, "exchangeId", 29);
  if (!EXCHANGE_ID_PATTERN.test(exchangeId)) {
    throw new ParticipantRequestError("exchangeId: invalid identity");
  }
  const messageId = requireText(fields.messageId, "messageId", 30);
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new ParticipantRequestError("messageId: invalid identity");
  }
  return { authority, exchangeId, messageId };
}

/** The one shared recipient-eligibility chain, written once for the metadata
 * and payload reads. `read` selects the caller's Message reader (the metadata
 * read revalidates payload integrity; the payload read stays metadata-only
 * here by construction), and `extend` runs only after the exact-scope
 * authorization, membership, opaque refusal, recipient binding, audit
 * correlation, and join boundary have all passed inside the caller's owned
 * transaction — so no extension (payload materialization included) can ever
 * precede eligibility. */
function runMessageRead<T>(
  store: DurableStore,
  request: MessageReadRequest,
  seams: ClockSeam,
  scope: "read" | "payload_read",
  label: string,
  read: (tx: TransactionHandle, exchangeId: string, messageId: string) => Message | undefined,
  extend: (tx: TransactionHandle, eligible: { message: Message; auditSequence: number }) => T,
): T {
  const { authority, exchangeId, messageId } = request;
  return runMessagingTransaction(store, label, (tx) => {
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...authority, scope, now });
    const membership = requireMembership(tx, exchangeId, authority.participantId);
    const message = read(tx, exchangeId, messageId);
    if (message === undefined) refuse("MESSAGE_READ_REJECTED");
    if (!stableEndpointMatches(tx, authority.participantId, message.to)) refuse("MESSAGE_READ_REJECTED");
    const auditSequence = messageCreatedAuditSequence(tx, message);
    if (auditSequence <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
    return extend(tx, { message, auditSequence });
  });
}
