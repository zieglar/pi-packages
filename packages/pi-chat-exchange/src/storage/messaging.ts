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
import { messageRequestDigest, normalizeCreateMessageRequest } from "./creation-request.js";
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
  readonly deliveryMode?: "followUp" | "steer";
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
    ["participantId", "sessionId", "fencingToken", "capability", "message", "association"],
    ["participantId", "sessionId", "fencingToken", "capability", "message"],
    "request",
  );
  const authority = authorityRequest(fields);
  const request = normalizeCreateMessageRequest(fields.message);
  let association: { requestMessageId?: string; policyId?: string; selectionVersion?: number; targetRuntimeSessionId?: string; bindingEpoch?: number } | undefined;
  if (fields.association !== undefined) {
    const a = captureFields(fields.association, ["requestMessageId", "policyId", "selectionVersion", "targetRuntimeSessionId", "bindingEpoch"], [], "association");
    if (a.policyId !== undefined) requireText(a.policyId, "policyId", 256);
    if (a.requestMessageId !== undefined && (typeof a.requestMessageId !== "string" || !MESSAGE_ID_PATTERN.test(a.requestMessageId))) throw new ParticipantRequestError("invalid request Message ID");
    if (a.selectionVersion !== undefined && (!Number.isSafeInteger(a.selectionVersion) || (a.selectionVersion as number) < 1)) throw new ParticipantRequestError("invalid selection version");
    if (a.targetRuntimeSessionId !== undefined && (typeof a.targetRuntimeSessionId !== "string" || a.targetRuntimeSessionId.length < 1 || a.targetRuntimeSessionId.length > 256)) throw new ParticipantRequestError("invalid target session");
    if (a.bindingEpoch !== undefined && (!Number.isSafeInteger(a.bindingEpoch) || (a.bindingEpoch as number) < 1)) throw new ParticipantRequestError("invalid binding epoch");
    association = a as typeof association;
  }

  return runMessagingTransaction(store, "Authorized Message send", (tx) => {
    // Sample only after BEGIN IMMEDIATE owns the writer lock.
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...authority, scope: "send", now });
    const membership = requireMembership(tx, request.exchangeId, authority.participantId);
    requireStableSender(tx, authority.participantId, request.from);
    if (association?.requestMessageId !== undefined) {
      const original = readMessageMetadataInTransaction(tx, request.exchangeId, association.requestMessageId);
      if (!original || original.from.adapter !== request.to.adapter || original.from.endpointId !== request.to.endpointId ||
          original.to.adapter !== request.from.adapter || original.to.endpointId !== request.from.endpointId ||
          messageCreatedAuditSequence(tx, original) <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
      const originalLink = tx.prepare("SELECT request_message_id, target_owner_session_id, target_owner_fencing_token FROM message_association WHERE exchange_id=? AND message_id=?").get(request.exchangeId, original.messageId);
      // A received reply may itself be replied to. The immediate parent's target
      // Owner still fixes who may answer; endpoint reversal and membership above
      // remain mandatory, without granting the sender read access to its own message.
      if (!originalLink || originalLink.target_owner_session_id !== authority.sessionId || originalLink.target_owner_fencing_token !== authority.fencingToken) refuse("MESSAGE_READ_REJECTED");
    }
    const targetOwner = tx.prepare("SELECT p.participant_id, o.session_id, o.fencing_token, o.expires_at, o.lease_started_at FROM participant p JOIN participant_ownership o ON o.participant_id=p.participant_id JOIN exchange_membership m ON m.participant_id=p.participant_id WHERE p.endpoint_adapter=? AND p.endpoint_id=? AND m.exchange_id=?").get(request.to.adapter, request.to.endpointId, request.exchangeId);
    const ownerActive = targetOwner && typeof targetOwner.session_id === "string" && typeof targetOwner.fencing_token === "number" &&
      typeof targetOwner.expires_at === "string" && typeof targetOwner.lease_started_at === "string" && targetOwner.lease_started_at <= now && now < targetOwner.expires_at;
    if (association?.selectionVersion !== undefined && !ownerActive) refuse("MESSAGE_READ_REJECTED");
    if (association?.selectionVersion !== undefined) {
      const binding = tx.prepare("SELECT runtime_session_id, binding_epoch FROM native_session_binding WHERE participant_id=? AND session_id=? AND fencing_token=?").get(targetOwner!.participant_id!, targetOwner!.session_id!, targetOwner!.fencing_token!);
      if (!binding || binding.runtime_session_id !== association.targetRuntimeSessionId || binding.binding_epoch !== association.bindingEpoch) refuse("MESSAGE_READ_REJECTED");
      if (!association.policyId) refuse("MESSAGE_READ_REJECTED");
      const selection = tx.prepare("SELECT participant_id, session_id, fencing_token, runtime_session_id, binding_epoch FROM selected_session_binding WHERE policy_id=? AND selection_version=?").get(association.policyId, association.selectionVersion);
      if (!selection || selection.participant_id !== targetOwner!.participant_id || selection.session_id !== targetOwner!.session_id || selection.fencing_token !== targetOwner!.fencing_token || selection.runtime_session_id !== association.targetRuntimeSessionId || selection.binding_epoch !== association.bindingEpoch) refuse("MESSAGE_READ_REJECTED");
    }
    const targetBinding = ownerActive ? tx.prepare("SELECT runtime_session_id, binding_epoch FROM native_session_binding WHERE participant_id=? AND session_id=? AND fencing_token=?").get(targetOwner.participant_id!, targetOwner.session_id!, targetOwner.fencing_token!) : undefined;
    const effectiveAssociation = { ...association,
      ...(association?.selectionVersion === undefined && targetBinding && typeof targetBinding.runtime_session_id === "string" && typeof targetBinding.binding_epoch === "number" ? { targetRuntimeSessionId: targetBinding.runtime_session_id, bindingEpoch: targetBinding.binding_epoch } : {}),
      ...(ownerActive ? { targetOwnerSessionId: targetOwner.session_id as string, targetOwnerFencingToken: targetOwner.fencing_token as number } : {}) };

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
      effectiveAssociation,
    );
    const auditSequence = messageCreatedAuditSequence(tx, transaction.creation.message);
    return Object.freeze({ ...transaction.creation, auditSequence });
  });
}

/** Persist the Pi runtime's own registration against its current CE ownership. */
export function bindNativeSession(store: DurableStore, input: unknown, seams: ClockSeam = {}): void {
  const fields = captureFields(input, ["participantId", "sessionId", "fencingToken", "capability", "runtimeSessionId", "bindingEpoch"], ["participantId", "sessionId", "fencingToken", "capability", "runtimeSessionId", "bindingEpoch"], "request");
  const authority = authorityRequest(fields);
  const runtimeSessionId = requireText(fields.runtimeSessionId, "runtimeSessionId", 256);
  if (!Number.isSafeInteger(fields.bindingEpoch) || (fields.bindingEpoch as number) < 1) throw new ParticipantRequestError("invalid binding epoch");
  runMessagingTransaction(store, "Native Session binding", tx => {
    authorizeCurrentOwner(tx, store, { ...authority, scope: "send", now: clock(seams) });
    const row = tx.prepare("SELECT runtime_session_id, binding_epoch FROM native_session_binding WHERE participant_id=? AND session_id=? AND fencing_token=?").get(authority.participantId, authority.sessionId, authority.fencingToken);
    if (row !== undefined) {
      if (row.runtime_session_id !== runtimeSessionId || row.binding_epoch !== fields.bindingEpoch) refuse("MESSAGE_READ_REJECTED");
      return;
    }
    tx.prepare("INSERT INTO native_session_binding(participant_id,session_id,fencing_token,runtime_session_id,binding_epoch) VALUES (?,?,?,?,?)").run(authority.participantId, authority.sessionId, authority.fencingToken, runtimeSessionId, fields.bindingEpoch as number);
  });
}

/** Freeze the target owner observed while a policy selection is committed. */
export function bindSelectedSession(store: DurableStore, input: unknown, seams: ClockSeam = {}): void {
  const keys = ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "endpointId", "policyId", "selectionVersion", "runtimeSessionId", "bindingEpoch"] as const;
  const fields = captureFields(input, keys, keys, "request");
  const authority = authorityRequest(fields);
  const exchangeId = requireText(fields.exchangeId, "exchangeId", 29);
  const endpointId = requireText(fields.endpointId, "endpointId", 256);
  const policyId = requireText(fields.policyId, "policyId", 256);
  const runtime = requireText(fields.runtimeSessionId, "runtimeSessionId", 256);
  if (!Number.isSafeInteger(fields.selectionVersion) || (fields.selectionVersion as number) < 1 || !Number.isSafeInteger(fields.bindingEpoch) || (fields.bindingEpoch as number) < 1) throw new ParticipantRequestError("invalid selection identity");
  runMessagingTransaction(store, "Selected Session binding", tx => {
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...authority, scope: "send", now });
    requireMembership(tx, exchangeId, authority.participantId);
    const owner = tx.prepare("SELECT p.participant_id, o.session_id, o.fencing_token, o.expires_at, o.lease_started_at, b.runtime_session_id, b.binding_epoch FROM participant p JOIN participant_ownership o ON o.participant_id=p.participant_id JOIN exchange_membership m ON m.participant_id=p.participant_id JOIN native_session_binding b ON b.participant_id=p.participant_id AND b.session_id=o.session_id AND b.fencing_token=o.fencing_token WHERE p.endpoint_adapter='pi' AND p.endpoint_id=? AND m.exchange_id=?").get(endpointId, exchangeId);
    if (!owner || owner.runtime_session_id !== runtime || owner.binding_epoch !== fields.bindingEpoch || typeof owner.expires_at !== "string" || typeof owner.lease_started_at !== "string" || owner.lease_started_at > now || now >= owner.expires_at) refuse("MESSAGE_READ_REJECTED");
    tx.prepare("INSERT INTO selected_session_binding(policy_id,selection_version,participant_id,session_id,fencing_token,runtime_session_id,binding_epoch) VALUES (?,?,?,?,?,?,?)").run(policyId, fields.selectionVersion as number, owner.participant_id!, owner.session_id!, owner.fencing_token!, runtime, fields.bindingEpoch as number);
  });
}

/** Check task routing without granting payload access or consuming a message. */
export function verifyTaskTarget(store: DurableStore, input: unknown, seams: ClockSeam = {}): boolean {
  const keys = ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "messageId"] as const;
  const fields = captureFields(input, keys, keys, "request");
  const authority = authorityRequest(fields);
  const exchangeId = requireText(fields.exchangeId, "exchangeId", 29);
  const messageId = requireText(fields.messageId, "messageId", 30);
  if (!EXCHANGE_ID_PATTERN.test(exchangeId) || !MESSAGE_ID_PATTERN.test(messageId)) throw new ParticipantRequestError("invalid message identity");
  return runMessagingTransaction(store, "Task target verification", tx => {
    authorizeCurrentOwner(tx, store, { ...authority, scope: "read", now: clock(seams) });
    const membership = requireMembership(tx, exchangeId, authority.participantId);
    const message = readMessageMetadataInTransaction(tx, exchangeId, messageId);
    if (!message || !stableEndpointMatches(tx, authority.participantId, message.to) || messageCreatedAuditSequence(tx, message) <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
    const link = tx.prepare("SELECT selection_version, target_owner_session_id, target_owner_fencing_token FROM message_association WHERE exchange_id=? AND message_id=?").get(exchangeId, messageId);
    return link !== undefined && link.target_owner_session_id === authority.sessionId && link.target_owner_fencing_token === authority.fencingToken;
  });
}


/** Sender-authorized lookup of immutable reply identities; payload reads remain separate. */
export function findMessageReplies(store: DurableStore, input: unknown, seams: ClockSeam = {}) {
  const fields = captureFields(input, ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "requestMessageId", "afterMessageId"], ["participantId", "sessionId", "fencingToken", "capability", "exchangeId", "requestMessageId"], "request");
  const authority = authorityRequest(fields);
  const exchangeId = requireText(fields.exchangeId, "exchangeId", 29);
  const requestId = requireText(fields.requestMessageId, "requestMessageId", 30);
  const afterMessageId = fields.afterMessageId === undefined ? null : requireText(fields.afterMessageId, "afterMessageId", 30);
  if (afterMessageId !== null && !MESSAGE_ID_PATTERN.test(afterMessageId)) throw new ParticipantRequestError("invalid reply cursor");
  if (!EXCHANGE_ID_PATTERN.test(exchangeId) || !MESSAGE_ID_PATTERN.test(requestId)) throw new ParticipantRequestError("invalid message identity");
  return runMessagingTransaction(store, "Reply discovery", tx => {
    authorizeCurrentOwner(tx, store, { ...authority, scope: "read", now: clock(seams) });
    const membership = requireMembership(tx, exchangeId, authority.participantId);
    const original = readMessageMetadataInTransaction(tx, exchangeId, requestId);
    if (!original || !stableEndpointMatches(tx, authority.participantId, original.from) || messageCreatedAuditSequence(tx, original) <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
    const link = tx.prepare("SELECT request_message_id, from_endpoint_json, to_endpoint_json, selection_version FROM message_association WHERE exchange_id=? AND message_id=?").get(exchangeId, requestId);
    if (!link || link.request_message_id !== requestId || link.from_endpoint_json !== JSON.stringify(original.from) || link.to_endpoint_json !== JSON.stringify(original.to)) refuse("MESSAGE_READ_REJECTED");
    if (afterMessageId !== null && !tx.prepare("SELECT 1 FROM message_association WHERE exchange_id=? AND request_message_id=? AND message_id=? AND message_id<>request_message_id").get(exchangeId, requestId, afterMessageId)) refuse("MESSAGE_READ_REJECTED");
    const rows = tx.prepare("SELECT a.message_id, a.from_endpoint_json, a.to_endpoint_json FROM message_association a JOIN message m ON m.message_id=a.message_id AND m.exchange_id=a.exchange_id WHERE a.exchange_id=? AND a.request_message_id=? AND a.message_id<>? AND (? IS NULL OR m.rowid>(SELECT rowid FROM message WHERE message_id=? AND exchange_id=?)) ORDER BY m.rowid LIMIT 51").all(exchangeId, requestId, requestId, afterMessageId, afterMessageId, exchangeId);
    const replies = rows.slice(0, 50).map(row => {
      if (typeof row.message_id !== "string") refuse("MESSAGE_READ_REJECTED");
      const reply = readMessageMetadataInTransaction(tx, exchangeId, row.message_id);
      if (!reply || reply.from.adapter !== original.to.adapter || reply.from.endpointId !== original.to.endpointId ||
          reply.to.adapter !== original.from.adapter || reply.to.endpointId !== original.from.endpointId ||
          row.from_endpoint_json !== JSON.stringify(reply.from) || row.to_endpoint_json !== JSON.stringify(reply.to) ||
          messageCreatedAuditSequence(tx, reply) <= membership.joinBoundarySeq) refuse("MESSAGE_READ_REJECTED");
      return Object.freeze({ messageId: reply.messageId });
    });
    return Object.freeze({ requestMessageId: requestId, target: original.to.endpointId, selectionVersion: link.selection_version, replies: Object.freeze(replies), hasMore: rows.length > 50 });
  });
}
/** Repeatable recipient-only protected metadata read. It deliberately takes the
 * same serialization lock as mutations so ownership authority and eligibility
 * are evaluated against one current durable snapshot. */
export function readMessageMetadata(
  store: DurableStore,
  input: unknown,
  seams: ClockSeam = {},
): ProtectedMessageMetadata & { readonly deliveryMode: "followUp" | "steer" } {
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
  readonly deliveryMode: "followUp" | "steer";
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

/** The creation fingerprint commits the mode; legacy messages without a key default to followUp. */
function readDeliveryMode(tx: TransactionHandle, message: Message): "followUp" | "steer" {
  if (message.idempotencyKey === undefined) return "followUp";
  const row = tx.prepare("SELECT request_digest, entity_id FROM idempotency_record WHERE namespace=? AND idempotency_key=?")
    .get(JSON.stringify(["message.create", message.exchangeId]), message.idempotencyKey);
  if (!row || row.entity_id !== message.messageId) refuse("MESSAGE_READ_REJECTED");
  if (row.request_digest === messageRequestDigest(message, "followUp")) return "followUp";
  if (row.request_digest === messageRequestDigest(message, "steer")) return "steer";
  refuse("MESSAGE_READ_REJECTED");
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
  extend: (tx: TransactionHandle, eligible: { message: Message; auditSequence: number; deliveryMode: "followUp" | "steer" }) => T,
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
    const deliveryMode = readDeliveryMode(tx, message);
    return extend(tx, { message, auditSequence, deliveryMode });
  });
}
