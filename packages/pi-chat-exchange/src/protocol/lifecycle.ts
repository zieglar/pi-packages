/**
 * Message lifecycle state machine (frozen v2 contract).
 *
 * PH-0002 correction: a Message is an independent entity inside an Exchange
 * aggregate. Its lifecycle tracks delivery and runtime settlement; it does
 * NOT track reads. There is deliberately no CONSUMED state: reading a Result
 * is a non-mutating observation (see core `readResult`), never a lifecycle
 * event, and "no read" never means "not done".
 *
 * Outcome layers are never collapsed:
 * - transport: did the payload reach the adapter boundary of the destination?
 *   (generic trichotomy delivered | ambiguous | failed)
 * - runtime: did the destination invocation accept, run, and settle?
 * - application: is the requested task semantically correct? The protocol
 *   never decides this (opaque `applicationEvidence` on the Result).
 *
 * Fail-closed rules (frozen):
 * - Entering DISPATCHING requires the durable dispatch-start evidence on the
 *   attempt record BEFORE any adapter side effect can be attempted.
 * - Any potentially attempted dispatch that cannot be confirmed quarantines
 *   the message as DELIVERY_UNKNOWN. DELIVERY_UNKNOWN has NO transition back
 *   to QUEUED/CLAIMED/DISPATCHING and no automatic retry: a duplicated
 *   exchange payload may cause irreversible effects at the destination.
 * - Safe requeue (CLAIMED → QUEUED) is legal only with a validated
 *   definitely-not-attempted attempt record — evidence, not assertion.
 * - Cancellation is split: a request (CANCEL_REQUESTED) is never a
 *   confirmation. After dispatch may have begun, independently authorized
 *   runtime evidence must confirm CANCELLED. Owner abandonment is a separate administrative
 *   disposition; it never resolves execution ambiguity or cancels a runtime.
 *
 * Transitions split into two groups:
 * - evidence-free moves, licensed by state shape alone ({@link canTransition});
 * - evidence-gated moves, listed in {@link TRANSITION_REQUIREMENTS} and
 *   enforced by the pure core rules, which correlate the exact message,
 *   attempt, endpoint, and lease.
 */

import type { ExchangeAction } from "./capabilities.js";
export const MESSAGE_STATES = [
  "CREATED",
  "QUEUED",
  "CLAIMED",
  "DISPATCHING",
  "DELIVERY_UNKNOWN",
  "ACCEPTED",
  "RUNNING",
  "SETTLED",
  "RESULT_AVAILABLE",
  "CANCEL_REQUESTED",
  "CANCELLED",
  "FAILED",
] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

/**
 * Finished (terminal) message states: nothing further may happen to the
 * message and an Exchange may close over it. RESULT_AVAILABLE is reached by
 * publishing the immutable Result, never by reading it.
 */
export const FINISHED_MESSAGE_STATES: readonly MessageState[] = [
  "RESULT_AVAILABLE",
  "CANCELLED",
  "FAILED",
];

/** Quarantined: neither finished nor retryable; requires reconciliation. */
export const QUARANTINED_MESSAGE_STATES: readonly MessageState[] = ["DELIVERY_UNKNOWN"];

/** Each transition requires distinct scoped host grants, never a role label. */
/**
 * Lease evidence class required from the guard:
 * - "none": no attempt/lease correlation needed (administrative move);
 * - "recorded": the guard must present the lease recorded on the correlated
 *   attempt (identity match); expiry is irrelevant because the move is an
 *   after-the-fact reconciliation or release proof;
 * - "current": additionally `guard.now` must be before the lease expiry, so
 *   stale leases can never drive live dispatch progress.
 */
export type LeaseEvidence = "none" | "recorded" | "current";

/**
 * Evidence the correlated attempt must carry. "none" marks evidence-free
 * moves; every other kind is validated against the DeliveryAttempt record
 * (dispatch marker, transport outcome, or explicit reconciliation).
 */
export type TransitionEvidenceKind =
  | "none"
  | "not_attempted"
  | "dispatch_started"
  | "transport_delivered"
  | "transport_ambiguous"
  | "transport_failed"
  | "runtime_progress"
  | "result_published"
  | "cancel_confirmed"
  | "reconciled_delivered"
  | "reconciled_not_executed";
export interface TransitionRequirement {
  readonly actions: readonly ExchangeAction[];
  readonly lease: LeaseEvidence;
  readonly evidence: TransitionEvidenceKind;
}

/**
 * The single source of truth for transition legality, keyed `"FROM>TO"`.
 * Core rules validate every row's evidence; the shape-level helpers below
 * expose the two legality tiers.
 */
export const TRANSITION_REQUIREMENTS: Readonly<Record<string, TransitionRequirement>> = {
  "CREATED>QUEUED": { actions: ["exchange_send"], lease: "none", evidence: "none" },
  "QUEUED>CLAIMED": { actions: ["message_claim"], lease: "none", evidence: "none" },
  "QUEUED>CANCELLED": { actions: ["exchange_cancel"], lease: "none", evidence: "none" },
  "CLAIMED>CANCEL_REQUESTED": { actions: ["exchange_cancel"], lease: "none", evidence: "none" },
  "DISPATCHING>CANCEL_REQUESTED": { actions: ["exchange_cancel"], lease: "none", evidence: "none" },
  "ACCEPTED>CANCEL_REQUESTED": { actions: ["exchange_cancel"], lease: "none", evidence: "none" },
  "RUNNING>CANCEL_REQUESTED": { actions: ["exchange_cancel"], lease: "none", evidence: "none" },

  // Safe release/cancellation still requires proven no attempt.
  "CLAIMED>QUEUED": { actions: ["lease_release"], lease: "recorded", evidence: "not_attempted" },
  "CLAIMED>CANCELLED": { actions: ["cancel_confirm"], lease: "recorded", evidence: "not_attempted" },

  // Pre-effect marker and live fencing remain required.
  "CLAIMED>DISPATCHING": { actions: ["dispatch_mark_started"], lease: "current", evidence: "dispatch_started" },
  "CLAIMED>DELIVERY_UNKNOWN": { actions: ["delivery_report"], lease: "recorded", evidence: "transport_ambiguous" },
  "DISPATCHING>ACCEPTED": { actions: ["delivery_report", "activity_report"], lease: "current", evidence: "transport_delivered" },
  "DISPATCHING>DELIVERY_UNKNOWN": { actions: ["delivery_report"], lease: "recorded", evidence: "transport_ambiguous" },
  "DISPATCHING>FAILED": { actions: ["delivery_report"], lease: "current", evidence: "transport_failed" },

  "ACCEPTED>RUNNING": { actions: ["activity_report"], lease: "current", evidence: "runtime_progress" },
  "ACCEPTED>SETTLED": { actions: ["settlement_report"], lease: "current", evidence: "runtime_progress" },
  "RUNNING>SETTLED": { actions: ["settlement_report"], lease: "current", evidence: "runtime_progress" },
  "SETTLED>RESULT_AVAILABLE": { actions: ["result_publish"], lease: "current", evidence: "result_published" },

  // Started cancellation additionally requires scoped runtime-settlement authority
  // in core; proven never-attempted cancellation does not create a runtime fact.
  "CANCEL_REQUESTED>CANCELLED": { actions: ["cancel_confirm"], lease: "current", evidence: "cancel_confirmed" },
  "CANCEL_REQUESTED>DELIVERY_UNKNOWN": { actions: ["delivery_report"], lease: "recorded", evidence: "transport_ambiguous" },
  "CANCEL_REQUESTED>FAILED": { actions: ["delivery_report"], lease: "current", evidence: "transport_failed" },
  "CANCEL_REQUESTED>SETTLED": { actions: ["settlement_report"], lease: "current", evidence: "runtime_progress" },

  // Factual reconciliation is never retry permission or owner abandonment.
  "DELIVERY_UNKNOWN>ACCEPTED": { actions: ["ambiguity_resolve", "activity_report"], lease: "recorded", evidence: "reconciled_delivered" },
  "DELIVERY_UNKNOWN>FAILED": { actions: ["ambiguity_resolve"], lease: "recorded", evidence: "reconciled_not_executed" },
};

/**
 * Shape-only legality: true when the move is licensed by the state machine
 * without any further evidence. Evidence-gated moves (safe requeue,
 * quarantine exits, dispatch and settlement progress) return false here and
 * must go through the core rule validation.
 */
export function canTransition(from: MessageState, to: MessageState): boolean {
  const requirement = TRANSITION_REQUIREMENTS[`${from}>${to}`];
  return requirement !== undefined && requirement.lease === "none" && requirement.evidence === "none";
}

/** Full legality: true when any requirement row licenses the move. */
export function isLegalTransition(from: MessageState, to: MessageState): boolean {
  return TRANSITION_REQUIREMENTS[`${from}>${to}`] !== undefined;
}

/** All legal targets from a state (evidence-free and evidence-gated). */
export function legalTargets(from: MessageState): readonly MessageState[] {
  return MESSAGE_STATES.filter((to) => isLegalTransition(from, to));
}

/** Requirement table indexed by origin state (documentation convenience). */
export const MESSAGE_TRANSITIONS: Readonly<Record<MessageState, readonly MessageState[]>> =
  Object.fromEntries(MESSAGE_STATES.map((state) => [state, legalTargets(state)])) as Readonly<
    Record<MessageState, readonly MessageState[]>
  >;

export function isFinishedMessageState(state: MessageState): boolean {
  return FINISHED_MESSAGE_STATES.includes(state);
}

export function isQuarantinedMessageState(state: MessageState): boolean {
  return QUARANTINED_MESSAGE_STATES.includes(state);
}
