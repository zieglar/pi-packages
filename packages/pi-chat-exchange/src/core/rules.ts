/**
 * Core exchange rules (frozen v2): pure invariant helpers over the protocol
 * contracts. No I/O, no storage, no timers, no adapter/MCP/Pi/product
 * semantics — every function takes its evidence as data and returns new
 * values or throws. The durable host (out of scope for this phase) must call
 * these rules inside its transactions; they are the single legality authority.
 */
import { Value } from "@sinclair/typebox/value";
import { canonicalDigest } from "../protocol/idempotency.js";
import type { AuthorizationContext, AuthorizationScope } from "../protocol/capabilities.js";
import { assertAuthorized } from "./authorization.js";
import {
  type DeliveryAttempt,
  type Exchange,
  ExchangeSchema,
  MessageSchema,
  type ExchangeDisposition,
  type DispositionIntent,
  ExchangeDispositionSchema,
  type Lease,
  type Message,
  type ReconciliationEvidence,
  type Result,
  ResultSchema,
  type RuntimeEvidence,
  RuntimeEvidenceSchema,
  DeliveryAttemptSchema,
  LeaseSchema,
  ReconciliationEvidenceSchema,
} from "../protocol/entities.js";
import {
  type MessageState,
  type TransitionRequirement,
  FINISHED_MESSAGE_STATES,
  TRANSITION_REQUIREMENTS,
  isLegalTransition,
} from "../protocol/lifecycle.js";

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION" as const;
  readonly from: MessageState;
  readonly to: MessageState;

  constructor(from: MessageState, to: MessageState) {
    super(`illegal message state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** The move exists in the state machine but the presented evidence fails. */
export class TransitionEvidenceError extends Error {
  readonly code = "TRANSITION_EVIDENCE_REJECTED" as const;
  readonly from: MessageState;
  readonly to: MessageState;
  readonly reason: string;

  constructor(from: MessageState, to: MessageState, reason: string) {
    super(`transition evidence rejected (${from} -> ${to}): ${reason}`);
    this.name = "TransitionEvidenceError";
    this.from = from;
    this.to = to;
    this.reason = reason;
  }
}

export class CloseRejectedError extends Error {
  readonly code = "EXCHANGE_CLOSE_REJECTED" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(`exchange close rejected: ${reason}`);
    this.name = "CloseRejectedError";
    this.reason = reason;
  }
}

export class ResultConflictError extends Error {
  readonly code = "RESULT_CONFLICT" as const;
  readonly resultId: string;

  constructor(resultId: string) {
    super(`result already published with different content: ${resultId}`);
    this.name = "ResultConflictError";
    this.resultId = resultId;
  }
}

export class InvalidResultError extends Error {
  readonly code = "INVALID_RESULT" as const;

  constructor(detail: string) {
    super(`result violates the frozen schema: ${detail}`);
    this.name = "InvalidResultError";
  }
}

/**
 * Evidence guard loaded by the authenticated host, not accepted from an adapter.
 * `attempt` carries recorded dispatch evidence and lease; when lease proof is
 * required, the guard's `lease` must match that recorded claim exactly.
 * `reconciliation` is required for every quarantined-state exit.
 */
export interface TransitionGuard {
  /** Trusted authenticated-host context, never supplied as credentials by an adapter. */
  readonly authorization: AuthorizationContext;
  readonly now: string;
  /** Absent for request-only moves; mandatory validated evidence for attempt-backed moves. */
  readonly lease?: Lease;
  /** Authoritative latest claim loaded by the host transaction, not adapter input. */
  readonly currentLease?: Lease;
  /** Authoritative administrative disposition loaded by the host transaction. */
  readonly disposition?: ExchangeDisposition;
  readonly runtime?: RuntimeEvidence;
  readonly result?: Result;
  readonly attempt?: DeliveryAttempt;
  readonly reconciliation?: ReconciliationEvidence;
}

/**
 * Validate one message state transition against correlated evidence.
 * Returns `to` when legal; throws {@link IllegalTransitionError} for moves
 * the state machine does not license, or {@link TransitionEvidenceError}
 * when authority, lease fencing, attempt correlation, or evidence fails.
 */
export function assertMessageTransition(
  message: Pick<Message, "messageId" | "exchangeId" | "to" | "state">,
  to: MessageState,
  guard: TransitionGuard,
): MessageState {
  assertNotArchived(message.exchangeId, guard.disposition);
  const requirement = TRANSITION_REQUIREMENTS[`${message.state}>${to}`];
  if (requirement === undefined || !isLegalTransition(message.state, to)) {
    throw new IllegalTransitionError(message.state, to);
  }
  if (!Number.isFinite(Date.parse(guard.now))) {
    throw new TransitionEvidenceError(message.state, to, "invalid observation time");
  }
  assertTransitionAuthorization(requirement, guard, message, to);
  if (message.state === "QUEUED" && to === "CANCELLED" && guard.attempt !== undefined && (
    !Value.Check(DeliveryAttemptSchema, guard.attempt) ||
    guard.attempt.messageId !== message.messageId || !deepEqual(guard.attempt.endpoint, message.to) ||
    guard.attempt.dispatch !== "not_attempted" || guard.attempt.transport !== "pending"
  )) {
    throw new TransitionEvidenceError(message.state, to, "queued cancellation contradicts presented dispatch evidence");
  }
  const attempt = assertAttemptCorrelation(requirement, message, to, guard);
  if (attempt !== undefined) {
    assertLeaseEvidence(requirement, attempt, guard, message.state, to);
    assertEvidence(requirement, attempt, guard, message.state, to);
  }
  return to;
}

function assertTransitionAuthorization(
  requirement: TransitionRequirement,
  guard: TransitionGuard,
  message: Pick<Message, "messageId" | "exchangeId" | "to" | "state">,
  to: MessageState,
): void {
  const actions = [...requirement.actions];
  if (requirement.evidence === "cancel_confirmed" && guard.attempt?.dispatch === "started") {
    actions.push("settlement_report");
  }
  for (const action of actions) {
    let scope: AuthorizationScope;
    if (action === "exchange_send") {
      scope = { kind: "exchange", exchangeId: message.exchangeId };
    } else if (action === "exchange_cancel") {
      scope = { kind: "message", exchangeId: message.exchangeId, messageId: message.messageId };
    } else if (action === "message_claim") {
      scope = { kind: "destination", exchangeId: message.exchangeId, messageId: message.messageId, endpoint: message.to };
    } else {
      if (guard.attempt === undefined || !Value.Check(DeliveryAttemptSchema, guard.attempt)) throw new TransitionEvidenceError(message.state, to, "a valid correlated delivery attempt is required");
      scope = { kind: "attempt", exchangeId: message.exchangeId, messageId: message.messageId, attemptId: guard.attempt.attemptId, endpoint: message.to };
    }
    try { assertAuthorized(guard.authorization, action, scope); } catch {
      throw new TransitionEvidenceError(message.state, to, `scoped authorization required: ${action}`);
    }
  }
}

function assertAttemptCorrelation(
  requirement: TransitionRequirement,
  message: Pick<Message, "messageId" | "exchangeId" | "to" | "state">,
  to: MessageState,
  guard: TransitionGuard,
): DeliveryAttempt | undefined {
  if (requirement.lease === "none") return undefined;
  const { attempt } = guard;
  if (attempt === undefined) {
    throw new TransitionEvidenceError(message.state, to, "a correlated delivery attempt is required");
  }
  if (!Value.Check(DeliveryAttemptSchema, attempt)) {
    throw new TransitionEvidenceError(message.state, to, "invalid attempt record");
  }
  if (guard.reconciliation !== undefined && !Value.Check(ReconciliationEvidenceSchema, guard.reconciliation)) {
    throw new TransitionEvidenceError(message.state, to, "invalid reconciliation record");
  }
  if (attempt.messageId !== message.messageId) {
    throw new TransitionEvidenceError(
      message.state,
      to,
      `attempt ${attempt.attemptId} belongs to message ${attempt.messageId}, not ${message.messageId}`,
    );
  }
  if (!deepEqual(attempt.endpoint, message.to)) {
    throw new TransitionEvidenceError(
      message.state,
      to,
      `attempt ${attempt.attemptId} cites a different destination endpoint than message ${message.messageId}`,
    );
  }
  if (guard.runtime !== undefined && (
    !Value.Check(RuntimeEvidenceSchema, guard.runtime) ||
    guard.runtime.exchangeId !== message.exchangeId ||
    guard.runtime.messageId !== message.messageId ||
    guard.runtime.attemptId !== attempt.attemptId ||
    !deepEqual(guard.runtime.endpoint, message.to) ||
    Date.parse(guard.runtime.observedAt) > Date.parse(guard.now)
  )) {
    throw new TransitionEvidenceError(message.state, to, "uncorrelated or invalid runtime evidence");
  }
  if (guard.result !== undefined && (
    guard.result.exchangeId !== message.exchangeId ||
    guard.result.messageId !== message.messageId ||
    guard.result.attemptId !== attempt.attemptId ||
    !deepEqual(guard.result.source, message.to)
  )) {
    throw new TransitionEvidenceError(message.state, to, "uncorrelated result evidence");
  }
  return attempt;
}

function assertLeaseEvidence(
  requirement: TransitionRequirement,
  attempt: DeliveryAttempt,
  guard: TransitionGuard,
  from: MessageState,
  to: MessageState,
): void {
  if (!Value.Check(LeaseSchema, guard.lease)) {
    throw new TransitionEvidenceError(from, to, "invalid guard lease");
  }
  if (requirement.lease === "current" || requirement.evidence === "not_attempted") {
    if (guard.currentLease === undefined || !Value.Check(LeaseSchema, guard.currentLease) || !deepEqual(guard.currentLease, attempt.lease)) {
      throw new TransitionEvidenceError(from, to, "attempt no longer holds the authoritative fenced claim");
    }
  }
  if (!deepEqual(guard.lease, attempt.lease)) {
    throw new TransitionEvidenceError(from, to, "guard lease does not match the lease recorded on the attempt");
  }
  if (requirement.lease === "current" && Date.parse(guard.now) >= Date.parse(attempt.lease.expiresAt)) {
    throw new TransitionEvidenceError(from, to, "lease is expired for this mutation");
  }
}

function assertEvidence(
  requirement: TransitionRequirement,
  attempt: DeliveryAttempt,
  guard: TransitionGuard,
  from: MessageState,
  to: MessageState,
): void {
  const reject = (reason: string) => {
    throw new TransitionEvidenceError(from, to, reason);
  };
  switch (requirement.evidence) {
    case "none":
      return;
    case "not_attempted":
      if (attempt.dispatch !== "not_attempted" || attempt.transport !== "pending") {
        reject(`safe requeue/release requires a pending not-attempted record, found (${attempt.dispatch}, ${attempt.transport})`);
      }
      return;
    case "dispatch_started":
      if (attempt.dispatch !== "started") {
        reject(`entering DISPATCHING requires the durable dispatch-start marker, found "${attempt.dispatch}"`);
      }
      return;
    case "transport_delivered":
      if (attempt.dispatch !== "started" || attempt.transport !== "delivered" || guard.runtime?.outcome !== "accepted") {
        reject("acceptance requires both transport delivery and correlated runtime acceptance evidence");
      }
      return;
    case "transport_ambiguous":
      if (attempt.dispatch !== "started" || attempt.transport !== "ambiguous") {
        reject(`quarantine requires a started attempt with transport "ambiguous", found (${attempt.dispatch}, ${attempt.transport})`);
      }
      return;
    case "transport_failed":
      if (attempt.dispatch !== "started" || attempt.transport !== "failed") {
        reject(`definitive failure requires a started attempt with transport "failed", found (${attempt.dispatch}, ${attempt.transport})`);
      }
      return;
    case "runtime_progress":
      if (attempt.dispatch !== "started" || attempt.transport !== "delivered" || guard.runtime === undefined) {
        reject("runtime progress requires a delivered attempt and correlated runtime evidence");
      }
      if (to === "RUNNING" ? guard.runtime?.outcome !== "running" : !isSettlement(guard.runtime?.outcome)) {
        reject("runtime evidence does not prove the requested state");
      }
      return;
    case "result_published":
      if (attempt.dispatch !== "started" || attempt.transport !== "delivered" || guard.result === undefined) {
        reject("availability requires a delivered attempt and correlated immutable published result");
      }
      if (guard.result !== undefined) assertResultShape(guard.result);
      return;
    case "cancel_confirmed":
      if (attempt.dispatch === "not_attempted" && attempt.transport === "pending") return;
      if (attempt.dispatch !== "started" || attempt.transport !== "delivered" || guard.runtime?.outcome !== "cancelled") {
        reject("cancellation requires no-attempt proof or correlated runtime cancellation confirmation");
      }
      return;
    case "reconciled_delivered":
      if (guard.reconciliation === undefined) {
        reject("late correlated acceptance requires explicit reconciliation evidence, not lease reuse");
      }
      if (attempt.dispatch !== "started" || attempt.transport !== "delivered" || guard.runtime?.outcome !== "accepted") {
        reject("reconciled acceptance requires transport delivery and correlated runtime acceptance");
      }
      return;
    case "reconciled_not_executed":
      if (guard.reconciliation === undefined) {
        reject("confirming non-execution requires explicit reconciliation evidence, not lease reuse");
      }
      if (attempt.transport !== "failed") {
        reject(`reconciled non-execution requires transport "failed", found "${attempt.transport}"`);
      }
      return;
  }
}

export class ExchangeDispositionError extends Error {
  readonly code = "EXCHANGE_DISPOSITION_REJECTED" as const;
  constructor(detail: string) {
    super(`administrative disposition rejected: ${detail}`);
    this.name = "ExchangeDispositionError";
  }
}

/** Admission precondition for the future host's every protocol mutation. */
export function assertExchangeActive(
  exchange: Pick<Exchange, "exchangeId" | "state">,
  disposition?: ExchangeDisposition,
): void {
  assertNotArchived(exchange.exchangeId, disposition);
  if (exchange.state !== "OPEN") throw new ExchangeDispositionError("exchange is closed");
}

function assertNotArchived(exchangeId: string, disposition?: ExchangeDisposition): void {
  if (disposition === undefined) return;
  assertDispositionShape(disposition);
  if (disposition.exchangeId !== exchangeId) throw new ExchangeDispositionError("foreign disposition guard");
  throw new ExchangeDispositionError("ABANDONED_UNRESOLVED prohibits further protocol activity");
}

/**
 * Administrative termination, NOT runtime cancellation or normal CLOSED.
 * The authenticated host must load the complete message set, each current
 * unresolved attempt, and any existing disposition and commit atomically.
 * Owner/reconciliation text records intent only; unknown facts are unchanged.
 */
export function archiveUnresolvedExchange(
  exchange: Exchange,
  messages: readonly Message[],
  attempts: readonly DeliveryAttempt[],
  intent: DispositionIntent,
  authorization: AuthorizationContext,
  existing?: ExchangeDisposition,
): ExchangeDisposition {
  const reject = (detail: string): never => { throw new ExchangeDispositionError(detail); };
  try {
    assertAuthorized(authorization, "exchange_archive", { kind: "owner", exchangeId: exchange.exchangeId, ownerId: intent.ownerId });
  } catch { reject("scoped administrative owner authorization is required"); }
  if (!Value.Check(ExchangeSchema, exchange) || exchange.state !== "OPEN") reject("exchange must be open");
  const seenMessages = new Set<string>();
  for (const message of messages) {
    if (!Value.Check(MessageSchema, message) || message.exchangeId !== exchange.exchangeId) reject("invalid or foreign message");
    if (seenMessages.has(message.messageId)) reject("duplicate message");
    seenMessages.add(message.messageId);
    if (message.state !== "DELIVERY_UNKNOWN" && !FINISHED_MESSAGE_STATES.includes(message.state)) reject("in-flight activity must first be reconciled or quarantined");
  }
  const unresolvedMessages = messages.filter((message) => message.state === "DELIVERY_UNKNOWN");
  if (unresolvedMessages.length === 0 || attempts.length !== unresolvedMessages.length) reject("one active attempt per unresolved message is required");
  const seenAttempts = new Set<string>();
  const seenAttemptMessages = new Set<string>();
  for (const attempt of attempts) {
    if (!Value.Check(DeliveryAttemptSchema, attempt)) reject("invalid active attempt");
    const message = unresolvedMessages.find((entry) => entry.messageId === attempt.messageId);
    if (message === undefined || !deepEqual(message.to, attempt.endpoint)) reject("uncorrelated active attempt");
    if (attempt.dispatch !== "started" || attempt.transport !== "ambiguous") reject("original unknown/ambiguous evidence is required");
    if (seenAttempts.has(attempt.attemptId) || seenAttemptMessages.has(attempt.messageId)) reject("duplicate active attempt");
    seenAttempts.add(attempt.attemptId);
    seenAttemptMessages.add(attempt.messageId);
  }
  const candidate: ExchangeDisposition = {
    ...intent,
    exchangeId: exchange.exchangeId,
    status: "ABANDONED_UNRESOLVED",
    unresolved: [...unresolvedMessages].sort((a, b) => a.messageId.localeCompare(b.messageId)).map((message) => ({
      messageId: message.messageId,
      originalState: "DELIVERY_UNKNOWN",
      transport: "ambiguous",
      unresolvedSideEffects: true,
      attempt: attempts.find((attempt) => attempt.messageId === message.messageId)!,
    })),
  };
  assertDispositionShape(candidate);
  const recordedAt = Date.parse(candidate.recordedAt);
  if (Date.parse(exchange.createdAt) > recordedAt || messages.some((message) => Date.parse(message.createdAt) > recordedAt)) reject("disposition predates the aggregate");
  if (existing !== undefined) {
    assertDispositionShape(existing);
    if (!deepEqual(existing, candidate)) reject("immutable disposition conflicts with existing history");
  }
  return deepFreeze(clone(existing ?? candidate));
}

function assertDispositionShape(disposition: ExchangeDisposition): void {
  try { canonicalDigest(disposition); } catch { throw new ExchangeDispositionError("disposition must be plain JSON"); }
  if (!Value.Check(ExchangeDispositionSchema, disposition)) throw new ExchangeDispositionError("invalid disposition schema");
  const seenMessages = new Set<string>();
  const seenAttempts = new Set<string>();
  for (const entry of disposition.unresolved) {
    if (entry.attempt.messageId !== entry.messageId || entry.attempt.dispatch !== "started" || entry.attempt.transport !== "ambiguous" || seenMessages.has(entry.messageId) || seenAttempts.has(entry.attempt.attemptId)) {
      throw new ExchangeDispositionError("invalid original unresolved snapshot");
    }
    if (Date.parse(entry.attempt.createdAt) > Date.parse(disposition.recordedAt)) throw new ExchangeDispositionError("disposition predates the attempt");
    seenMessages.add(entry.messageId);
    seenAttempts.add(entry.attempt.attemptId);
  }
  if (Date.parse(disposition.reconciliation.resolvedAt) > Date.parse(disposition.recordedAt)) throw new ExchangeDispositionError("future reconciliation metadata");
}

/**
 * Explicitly close an open exchange with a scoped owner close grant,
 * and only when EVERY message of the exchange is finished
 * (RESULT_AVAILABLE / CANCELLED / FAILED): nothing in flight, nothing
 * quarantined, no pending cancellation. Reading results never contributes to
 * closability. Returns a new closed exchange; the input is not mutated.
 */
export function closeExchange(
  exchange: Exchange,
  messages: readonly Message[],
  authorization: AuthorizationContext,
  disposition?: ExchangeDisposition,
): Exchange {
  assertNotArchived(exchange.exchangeId, disposition);
  try {
    assertAuthorized(authorization, "exchange_close", { kind: "owner", exchangeId: exchange.exchangeId, ownerId: authorization?.principalId });
  } catch {
    throw new CloseRejectedError("scoped owner close authorization is required");
  }
  if (exchange.state !== "OPEN") {
    throw new CloseRejectedError(`exchange ${exchange.exchangeId} is already ${exchange.state}`);
  }
  for (const message of messages) {
    if (message.exchangeId !== exchange.exchangeId) {
      throw new CloseRejectedError(`message ${message.messageId} belongs to exchange ${message.exchangeId}, not ${exchange.exchangeId}`);
    }
    if (!FINISHED_MESSAGE_STATES.includes(message.state)) {
      throw new CloseRejectedError(`message ${message.messageId} is still ${message.state}`);
    }
  }
  return { ...exchange, state: "CLOSED" };
}

/**
 * Read a Result: a non-mutating, repeatable observation. Returns a deeply
 * frozen snapshot; the input is never modified and no lifecycle state
 * changes anywhere. Reads are not consumption.
 */
export function readResult(result: Result): Result {
  assertResultShape(result);
  return deepFreeze(clone(result)) as Result;
}

/**
 * Publish-once contract for the immutable Result: the first publication is
 * accepted, an exactly equal republication is replayed, and any different
 * content for the same result id is a conflict. Never mutates inputs.
 */
export function assertResultPublication(
  existing: Result | undefined,
  candidate: Result,
  authorization: AuthorizationContext,
  disposition?: ExchangeDisposition,
): Result {
  assertNotArchived(candidate.exchangeId, disposition);
  assertResultShape(candidate);
  assertAuthorized(authorization, "result_publish", {
    kind: "attempt", exchangeId: candidate.exchangeId, messageId: candidate.messageId,
    attemptId: candidate.attemptId, endpoint: candidate.source,
  });
  if (existing === undefined) {
    return deepFreeze(clone(candidate)) as Result;
  }
  assertResultShape(existing);
  if (!deepEqual(existing, candidate)) {
    throw new ResultConflictError(candidate.resultId);
  }
  return deepFreeze(clone(existing)) as Result;
}

function isSettlement(outcome: string | undefined): boolean {
  return outcome !== undefined && ["settled", "runtime_error", "cancelled", "interrupted"].includes(outcome);
}

function assertResultShape(result: Result): void {
  try {
    // Wire evidence is opaque JSON, not arbitrary mutable JavaScript objects.
    canonicalDigest(result);
  } catch {
    throw new InvalidResultError("result must contain only finite, acyclic plain JSON data");
  }
  if (!isSettlement(result.runtime)) {
    throw new InvalidResultError("result requires settlement-grade runtime evidence");
  }
  if (!Value.Check(ResultSchema, result)) {
    const errors = [...Value.Errors(ResultSchema, result)];
    const first = errors[0];
    throw new InvalidResultError(first ? `${first.path}: ${first.message}` : "unknown violation");
  }
}

function clone<T>(value: T): T {
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    return structuredClone(value);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    for (const key of Reflect.ownKeys(value as Record<string, unknown>)) {
      const child = (value as Record<PropertyKey, unknown>)[key];
      if (child !== null && typeof child === "object") deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const aKeys = Reflect.ownKeys(a as object);
  const bKeys = Reflect.ownKeys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Reflect.has(b as object, key)) return false;
    if (!deepEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key])) {
      return false;
    }
  }
  return true;
}
