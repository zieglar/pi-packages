import { EVENT_KINDS, type Message } from "../protocol/entities.js";
import { EVENT_ID_PATTERN, EXCHANGE_ID_PATTERN, MESSAGE_ID_PATTERN } from "../protocol/identity.js";
import {
  CreationDomainError,
  messageCreatedAuditSequence,
  readMessageMetadataInTransaction,
} from "./creation.js";
import {
  authorityRequest,
  requireMembership,
  runMessagingTransaction,
  type ProtectedMessageMetadata,
} from "./messaging.js";
import { authorizeCurrentOwner } from "./ownership.js";
import {
  captureFields,
  ParticipantRequestError,
  PARTICIPANT_JOINED_EVENT_KIND,
  requireText,
} from "./participant-identity.js";
import { clock, hook, readParticipantRow, type ClockSeam } from "./participant.js";
import type { DurableStore } from "./store.js";
import type { TransactionHandle } from "./transaction.js";

/** Private implementation limits. They are not frozen protocol constants. */
export const INBOX_DEFAULT_PAGE_SIZE = 50;
export const INBOX_MAX_PAGE_SIZE = 50;
export const INBOX_DEFAULT_RAW_SCAN_LIMIT = 2_000;
export const INBOX_MAX_RAW_SCAN_LIMIT = 2_000;
const AUDIT_KIND_SET = new Set<string>([...EVENT_KINDS, PARTICIPANT_JOINED_EVENT_KIND]);

export interface InboxDiscoverySeams extends ClockSeam {
  /** Private deterministic test seam; production callers omit this. */
  readonly afterBegin?: (() => void) | undefined;
}

export interface InboxDiscoveryResult {
  readonly messages: readonly ProtectedMessageMetadata[];
  /** Last raw Audit Sequence actually examined, or null when no row was examined. */
  readonly continuationAuditSequence: number | null;
  /** True only when this call examined its complete raw-scan budget. */
  readonly scanBudgetExhausted: boolean;
}

interface DiscoveryRequest {
  readonly capability: unknown;
  readonly participantId: string;
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly exchangeId: string;
  readonly afterAuditSequence: number;
  readonly pageSize: number;
  readonly rawScanLimit: number;
}

interface RawAuditCandidate {
  readonly sequence: number;
  readonly kind: string;
  readonly subjectId: string;
}

function corrupt(): never {
  throw new CreationDomainError("STORAGE_IDEMPOTENCY_CORRUPT");
}

function requireIntegerInRange(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ParticipantRequestError(`${path}: integer out of range`);
  }
  return value;
}

function normalizeRequest(input: unknown): DiscoveryRequest {
  const fields = captureFields(
    input,
    [
      "participantId",
      "sessionId",
      "fencingToken",
      "capability",
      "exchangeId",
      "afterAuditSequence",
      "pageSize",
      "rawScanLimit",
    ],
    ["participantId", "sessionId", "fencingToken", "capability", "exchangeId"],
    "request",
  );
  const authority = authorityRequest(fields);
  const exchangeId = requireText(fields.exchangeId, "exchangeId", 29);
  if (!EXCHANGE_ID_PATTERN.test(exchangeId)) {
    throw new ParticipantRequestError("exchangeId: invalid identity");
  }
  const afterAuditSequence = Object.hasOwn(fields, "afterAuditSequence")
    ? requireIntegerInRange(fields.afterAuditSequence, "afterAuditSequence", 0, Number.MAX_SAFE_INTEGER)
    : 0;
  const pageSize = Object.hasOwn(fields, "pageSize")
    ? requireIntegerInRange(fields.pageSize, "pageSize", 1, INBOX_MAX_PAGE_SIZE)
    : INBOX_DEFAULT_PAGE_SIZE;
  const rawScanLimit = Object.hasOwn(fields, "rawScanLimit")
    ? requireIntegerInRange(fields.rawScanLimit, "rawScanLimit", 1, INBOX_MAX_RAW_SCAN_LIMIT)
    : INBOX_DEFAULT_RAW_SCAN_LIMIT;
  if (pageSize > rawScanLimit) {
    throw new ParticipantRequestError("pageSize: exceeds rawScanLimit");
  }
  return Object.freeze({ ...authority, exchangeId, afterAuditSequence, pageSize, rawScanLimit });
}

function safeStoredSequence(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) corrupt();
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) corrupt();
  return Number(parsed);
}

function rawAuditCandidate(row: Record<string, unknown>, exchangeId: string): RawAuditCandidate {
  const sequence = safeStoredSequence(row.sequence);
  if (
    Object.keys(row).length !== 5 ||
    typeof row.event_id !== "string" ||
    !EVENT_ID_PATTERN.test(row.event_id) ||
    row.exchange_id !== exchangeId ||
    typeof row.kind !== "string" ||
    !AUDIT_KIND_SET.has(row.kind) ||
    typeof row.subject_id !== "string" ||
    row.subject_id.length === 0 ||
    row.subject_id.length > 256
  ) {
    corrupt();
  }
  return Object.freeze({ sequence, kind: row.kind, subjectId: row.subject_id });
}

function recipientMatches(
  message: Message,
  binding: { readonly adapter: string; readonly endpointId: string },
): boolean {
  return message.to.adapter === binding.adapter && message.to.endpointId === binding.endpointId;
}

/**
 * Session-authorized, bounded, metadata-only Inbox Discovery.
 *
 * The operation owns one IMMEDIATE transaction, so authorization and the Audit
 * window are one serialized snapshot. It never writes ACK state, delivery
 * cursor state, or a durable discovery cursor. A null continuation means no raw
 * Audit row was examined; otherwise the continuation is exactly the last raw
 * sequence examined, including filtered non-message events.
 */
export function discoverInboxMessages(
  store: DurableStore,
  input: unknown,
  seams: InboxDiscoverySeams = {},
): InboxDiscoveryResult {
  const request = normalizeRequest(input);
  return runMessagingTransaction(store, "Inbox discovery", (tx: TransactionHandle) => {
    hook(seams.afterBegin);
    const now = clock(seams);
    authorizeCurrentOwner(tx, store, { ...request, scope: "read", now });
    const membership = requireMembership(tx, request.exchangeId, request.participantId);
    const binding = readParticipantRow(tx, request.participantId);
    if (binding === undefined) corrupt();

    const lowerBound = Math.max(request.afterAuditSequence, membership.joinBoundarySeq);
    const rows = tx
      .prepare(
        "SELECT event_id, exchange_id, CAST(sequence AS TEXT) AS sequence, kind, subject_id FROM audit_event WHERE exchange_id=? AND sequence>? ORDER BY audit_event.sequence ASC LIMIT ?",
      )
      .all(request.exchangeId, lowerBound, request.rawScanLimit) as Record<string, unknown>[];

    const messages: ProtectedMessageMetadata[] = [];
    let examined = 0;
    let continuationAuditSequence: number | null = null;
    for (const row of rows) {
      const candidate = rawAuditCandidate(row, request.exchangeId);
      examined += 1;
      continuationAuditSequence = candidate.sequence;
      if (candidate.kind !== "message_created") continue;
      if (!MESSAGE_ID_PATTERN.test(candidate.subjectId)) corrupt();

      const message = readMessageMetadataInTransaction(tx, request.exchangeId, candidate.subjectId);
      if (message === undefined) corrupt();
      const auditSequence = messageCreatedAuditSequence(tx, message);
      if (auditSequence !== candidate.sequence) corrupt();
      if (!recipientMatches(message, binding)) continue;

      messages.push(Object.freeze({ message, auditSequence }));
      if (messages.length === request.pageSize) break;
    }

    return Object.freeze({
      messages: Object.freeze(messages),
      continuationAuditSequence,
      scanBudgetExhausted: examined === request.rawScanLimit,
    });
  });
}
