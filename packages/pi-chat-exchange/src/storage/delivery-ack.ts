import { Value } from "@sinclair/typebox/value";
import { ReceiptSchema, SHA256_HEX_PATTERN, type Receipt, type Message } from "../protocol/entities.js";
import { EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN, RECEIPT_ID_PATTERN, EVENT_ID_PATTERN, generateEntityId } from "../protocol/identity.js";
import { CreationDomainError, readMessageInTransaction, messageCreatedAuditSequence } from "./creation.js";
import { authorityRequest, runMessagingTransaction, requireMembership, type AuthorityRequest } from "./messaging.js";
import { authorizeCurrentOwner } from "./ownership.js";
import { captureFields, ParticipantRequestError, requireText, requireInstant, SESSION_ID_PATTERN } from "./participant-identity.js";
import { clock, readParticipantRow, refuse, type ClockSeam } from "./participant.js";
import type { DurableStore } from "./store.js";
import { requireSingleRowChange, StorageTransactionError, type TransactionHandle } from "./transaction.js";

/** Private synchronous, value-free fault boundaries; not a public ACK surface. */
export interface DeliveryAckSeams extends ClockSeam {
  readonly beforeReceiptInsert?: () => void;
  readonly afterReceiptInsert?: () => void;
  readonly afterAuditInsert?: () => void;
}
export interface DeliveryAckResult {
  readonly disposition: "CREATED" | "REPLAYED";
  readonly receipt: Receipt;
  readonly receiptAuditSequence: number;
}
export type DeliveryAckReconciliation =
  | { readonly disposition: "COMMITTED"; readonly receipt: Receipt; readonly receiptAuditSequence: number }
  | { readonly disposition: "NO_TRACE" };
interface Request {
  readonly authority: AuthorityRequest;
  readonly exchangeId: string;
  readonly messageId: string;
  readonly payloadDigest: string;
  readonly payloadLength: number;
  readonly messageCreatedAuditSequence: number;
}
const FIELDS = ["participantId","sessionId","fencingToken","capability","exchangeId","messageId","payloadDigest","payloadLength","messageCreatedAuditSequence"] as const;
function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function request(input: unknown): Request {
  const f = captureFields(input, FIELDS, FIELDS, "request");
  const authority = authorityRequest(f);
  const exchangeId = requireText(f.exchangeId, "exchangeId", 29);
  const messageId = requireText(f.messageId, "messageId", 30);
  if (!EXCHANGE_ID_PATTERN.test(exchangeId) || !MESSAGE_ID_PATTERN.test(messageId) ||
      typeof f.payloadDigest !== "string" || !SHA256_HEX_PATTERN.test(f.payloadDigest) ||
      !integer(f.payloadLength, 0) || !integer(f.messageCreatedAuditSequence, 1)) {
    throw new ParticipantRequestError("ACK metadata: invalid fields");
  }
  return Object.freeze({authority,exchangeId,messageId,payloadDigest:f.payloadDigest,
    payloadLength:f.payloadLength,messageCreatedAuditSequence:f.messageCreatedAuditSequence});
}
function corrupt(): never { throw new CreationDomainError("STORAGE_IDEMPOTENCY_CORRUPT"); }
function canonical(value: unknown): value is string {
  try { requireInstant(value, "stored instant"); return true; } catch { return false; }
}
function hooks(seams: DeliveryAckSeams): DeliveryAckSeams {
  try {
    const captured = { now: seams.now, beforeReceiptInsert: seams.beforeReceiptInsert,
      afterReceiptInsert: seams.afterReceiptInsert, afterAuditInsert: seams.afterAuditInsert };
    if (Object.values(captured).some(v => v !== undefined && typeof v !== "function")) throw new Error();
    return Object.freeze({
      ...(captured.now === undefined ? {} : {now:captured.now}),
      ...(captured.beforeReceiptInsert === undefined ? {} : {beforeReceiptInsert:captured.beforeReceiptInsert}),
      ...(captured.afterReceiptInsert === undefined ? {} : {afterReceiptInsert:captured.afterReceiptInsert}),
      ...(captured.afterAuditInsert === undefined ? {} : {afterAuditInsert:captured.afterAuditInsert}),
    });
  } catch { throw new StorageTransactionError("ACK seam capture failed", "begin", {outcome:"ROLLED_BACK"}); }
}
function hook(action: (() => void) | undefined): void {
  if (action === undefined) return;
  try { if (action() === undefined) return; } catch { /* never preserve caller exceptions */ }
  throw new Error("private ACK hook failed or returned an unsupported value");
}
function trustedTime(seams: DeliveryAckSeams): string {
  // Do not let an injected domain-error instance escape through the owned wrapper.
  try { return clock(seams); } catch { throw new Error("ACK clock failed"); }
}
function eligible(tx: TransactionHandle, store: DurableStore, r: Request, now: string): Message {
  authorizeCurrentOwner(tx, store, {...r.authority,scope:"ack",now});
  const membership = requireMembership(tx,r.exchangeId,r.authority.participantId);
  const message = readMessageInTransaction(tx,r.exchangeId,r.messageId);
  if (message === undefined) refuse("MESSAGE_READ_REJECTED");
  const participant = readParticipantRow(tx,r.authority.participantId);
  if (participant === undefined || participant.adapter !== message.to.adapter || participant.endpointId !== message.to.endpointId) refuse("MESSAGE_READ_REJECTED");
  const sequence = messageCreatedAuditSequence(tx,message);
  if (sequence <= membership.joinBoundarySeq || sequence !== r.messageCreatedAuditSequence ||
      message.payloadDigest !== r.payloadDigest || message.payloadLength !== r.payloadLength) refuse("MESSAGE_READ_REJECTED");
  return message;
}
interface Evidence { readonly receipt: Receipt; readonly receiptAuditSequence: number }
function evidence(tx: TransactionHandle, r: Request, message: Message): Evidence | undefined {
  // A Message has one stable recipient. A conflicting other-recipient row is
  // inconsistent evidence, not absence of this caller's natural key.
  const recipients = tx.prepare("SELECT recipient_participant_id FROM delivery_ack_receipt WHERE exchange_id=? AND message_id=? LIMIT 2").all(r.exchangeId,r.messageId);
  const recipient = recipients[0];
  if (recipients.length > 1 || (recipient !== undefined && recipient.recipient_participant_id !== r.authority.participantId)) corrupt();
  const row = tx.prepare("SELECT * FROM delivery_ack_receipt WHERE exchange_id=? AND message_id=? AND recipient_participant_id=?")
    .get(r.exchangeId,r.messageId,r.authority.participantId);
  if (row === undefined) {
    // An orphan audit cannot be assigned to a Message from its subject alone.
    // Refuse ambiguous evidence in this Exchange; never manufacture a missing row.
    const orphan = tx.prepare("SELECT a.event_id FROM audit_event AS a WHERE a.exchange_id=? AND a.kind='receipt_recorded' AND NOT EXISTS (SELECT 1 FROM delivery_ack_receipt AS r WHERE r.receipt_id=a.subject_id AND r.exchange_id=a.exchange_id) LIMIT 1").get(r.exchangeId);
    if (orphan !== undefined) corrupt();
    return undefined;
  }
  if (Object.keys(row).length !== 12 || typeof row.receipt_id !== "string" || !RECEIPT_ID_PATTERN.test(row.receipt_id) ||
      row.exchange_id !== r.exchangeId || row.message_id !== r.messageId || row.recipient_participant_id !== r.authority.participantId ||
      typeof row.ack_session_id !== "string" || !SESSION_ID_PATTERN.test(row.ack_session_id) ||
      !integer(row.ack_fencing_token,1) || !integer(row.trust_generation,1) || row.private_revision !== 1 ||
      row.payload_digest !== message.payloadDigest || row.payload_length !== message.payloadLength ||
      row.message_created_audit_seq !== r.messageCreatedAuditSequence || !canonical(row.created_at)) corrupt();
  if (tx.prepare("SELECT session_id FROM participant_session WHERE participant_id=? AND session_id=?")
      .get(r.authority.participantId,row.ack_session_id) === undefined) corrupt();
  if (tx.prepare("SELECT generation FROM host_trust_root WHERE generation=?").get(row.trust_generation) === undefined) corrupt();
  const audits = tx.prepare("SELECT * FROM audit_event WHERE exchange_id=? AND kind='receipt_recorded' AND subject_id=? LIMIT 2").all(r.exchangeId,row.receipt_id);
  if (audits.length !== 1) corrupt();
  const a = audits[0];
  if (a === undefined) corrupt();
  if (Object.keys(a).length !== 10 || typeof a.event_id !== "string" || !EVENT_ID_PATTERN.test(a.event_id) ||
      a.exchange_id !== r.exchangeId || a.kind !== "receipt_recorded" || a.subject_id !== row.receipt_id ||
      !integer(a.sequence,1) || a.sequence <= r.messageCreatedAuditSequence || a.digest !== row.payload_digest ||
      a.length !== row.payload_length || a.outcome !== "delivery_ack" || a.created_at !== row.created_at || a.private_revision !== 1) corrupt();
  const receipt = Object.freeze({receiptId:row.receipt_id,exchangeId:r.exchangeId,messageId:r.messageId,
    endpoint:Object.freeze({adapter:message.to.adapter,endpointId:message.to.endpointId}),kind:"delivery_ack" as const,createdAt:row.created_at});
  if (!Value.Check(ReceiptSchema,receipt)) corrupt();
  return Object.freeze({receipt,receiptAuditSequence:a.sequence});
}
/** BEGIN → post-lock tA → exact current ACK authority → eligibility → evidence → pair → COMMIT.
 * No implicit retry, cursor write, transport action, or task-completion inference. */
export function recordDeliveryAck(store: DurableStore,input: unknown,seams: DeliveryAckSeams = {}): DeliveryAckResult {
  const r=request(input), h=hooks(seams);
  return runMessagingTransaction(store,"Delivery ACK",tx=>{
    const now=trustedTime(h);
    const message=eligible(tx,store,r,now);
    const existing=evidence(tx,r,message);
    if (existing !== undefined) return Object.freeze({disposition:"REPLAYED",...existing});
    const exchange=tx.prepare("SELECT state,closed_at FROM exchange WHERE exchange_id=?").get(r.exchangeId);
    if (exchange?.state !== "OPEN" || exchange.closed_at !== null || tx.prepare("SELECT exchange_id FROM disposition WHERE exchange_id=?").get(r.exchangeId) !== undefined) {
      throw new CreationDomainError("EXCHANGE_DISPOSITION_REJECTED");
    }
    const generation=tx.prepare("SELECT MAX(generation) AS generation FROM host_trust_root").get()?.generation;
    const maximum=tx.prepare("SELECT MAX(sequence) AS maximum FROM audit_event WHERE exchange_id=?").get(r.exchangeId)?.maximum;
    if (!integer(generation,1) || !integer(maximum,1) || !integer(maximum+1,1)) corrupt();
    const receiptId=generateEntityId("rcpt_",Date.parse(now));
    const eventId=generateEntityId("evt_",Date.parse(now));
    hook(h.beforeReceiptInsert);
    requireSingleRowChange(tx.prepare("INSERT INTO delivery_ack_receipt(receipt_id,exchange_id,message_id,recipient_participant_id,ack_session_id,ack_fencing_token,trust_generation,payload_digest,payload_length,message_created_audit_seq,created_at,private_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)")
      .run(receiptId,r.exchangeId,r.messageId,r.authority.participantId,r.authority.sessionId,r.authority.fencingToken,generation,r.payloadDigest,r.payloadLength,r.messageCreatedAuditSequence,now),"ACK receipt insert");
    hook(h.afterReceiptInsert);
    requireSingleRowChange(tx.prepare("INSERT INTO audit_event(event_id,exchange_id,sequence,kind,subject_id,created_at,digest,length,outcome,private_revision) VALUES (?,?,?,'receipt_recorded',?,?,?,?,'delivery_ack',1)")
      .run(eventId,r.exchangeId,maximum+1,receiptId,now,r.payloadDigest,r.payloadLength),"ACK audit insert");
    hook(h.afterAuditInsert);
    const committed=evidence(tx,r,message);
    if (committed === undefined) corrupt();
    return Object.freeze({disposition:"CREATED",...committed});
  });
}
/** Read-only evidence classification with the identical current authorization chain.
 * NO_TRACE is snapshot absence, not quiescence, cancellation, or retry permission. */
export function reconcileDeliveryAck(store: DurableStore,input: unknown,seams: DeliveryAckSeams = {}): DeliveryAckReconciliation {
  const r=request(input), h=hooks(seams);
  return runMessagingTransaction(store,"ACK evidence query",tx=>{
    const message=eligible(tx,store,r,trustedTime(h));
    const existing=evidence(tx,r,message);
    return existing === undefined ? Object.freeze({disposition:"NO_TRACE"}) : Object.freeze({disposition:"COMMITTED",...existing});
  });
}
