import { EXCHANGE_ID_PATTERN, generateEntityId, MESSAGE_ID_PATTERN } from "../protocol/identity.js";
import type { Message } from "../protocol/entities.js";
import {
  CreationDomainError,
  createMessageInTransaction,
  messageCreatedAuditSequence,
  readMessageInTransaction,
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

interface AuthorityRequest {
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

function authorityRequest(fields: Record<string, unknown>): AuthorityRequest {
  return Object.freeze({
    capability: fields.capability,
    participantId: requireParticipantId(fields.participantId, "participantId"),
    sessionId: requireSessionId(fields.sessionId, "sessionId"),
    fencingToken: requireFencingToken(fields.fencingToken),
  });
}

function runMessagingTransaction<T>(
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

function requireMembership(tx: TransactionHandle, exchangeId: string, participantId: string) {
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

  return runMessagingTransaction(store, "Protected Message read", (tx) => {
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...authority, scope: "read", now });
    const membership = requireMembership(tx, exchangeId, authority.participantId);
    const message = readMessageInTransaction(tx, exchangeId, messageId);
    if (message === undefined) refuse("MESSAGE_READ_REJECTED");
    if (!stableEndpointMatches(tx, authority.participantId, message.to)) refuse("MESSAGE_READ_REJECTED");
    const auditSequence = messageCreatedAuditSequence(tx, message);
    if (auditSequence <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
    return Object.freeze({ message, auditSequence });
  });
}
