/**
 * Handoff lifecycle state machine (frozen v1 contract).
 *
 * A handoff is a durable protocol entity, not a message. State transitions are
 * the only legal way to move through the lifecycle; the broker must reject any
 * transition not listed in {@link LEGAL_TRANSITIONS}.
 *
 * Semantic guarantees (frozen):
 * - QUEUED means only "the broker durably accepted the handoff", never "Pi
 *   received it".
 * - ACKNOWLEDGED means Pi accepted the prompt; it does not mean execution
 *   succeeded.
 * - SETTLED means the runtime invocation settled; it does not mean the
 *   requested task is semantically correct.
 *
 * Ambiguous delivery fails closed:
 * - CLAIMED with delivery definitely not attempted -> safe requeue to QUEUED
 *   (lease expiry only).
 * - DELIVERED with acknowledgement unknown -> DELIVERY_UNKNOWN, a quarantined
 *   state. There is deliberately NO transition back to QUEUED/CLAIMED/
 *   DELIVERED: a duplicated coding prompt may cause irreversible repository
 *   changes, so automatic retry is forbidden.
 */

export const HANDOFF_STATES = [
  "CREATED",
  "QUEUED",
  "CLAIMED",
  "DELIVERED",
  "ACKNOWLEDGED",
  "RUNNING",
  "SETTLED",
  "RESULT_AVAILABLE",
  "CONSUMED",
  "DELIVERY_UNKNOWN",
  "CANCELLED",
  "FAILED",
] as const;

export type HandoffState = (typeof HANDOFF_STATES)[number];

export const TERMINAL_STATES: readonly HandoffState[] = ["CONSUMED", "CANCELLED", "FAILED"];

/**
 * Quarantined states: the handoff is neither terminal nor safely retryable.
 * DELIVERY_UNKNOWN requires explicit, evidence-backed human-or-consumer
 * resolution to ACKNOWLEDGED (confirmed accepted), FAILED (confirmed not
 * executed), or CANCELLED (owner abandons).
 */
export const QUARANTINED_STATES: readonly HandoffState[] = ["DELIVERY_UNKNOWN"];

const LEGAL: Readonly<Record<HandoffState, readonly HandoffState[]>> = {
  CREATED: ["QUEUED"],
  QUEUED: ["CLAIMED", "CANCELLED"],
  // Safe requeue only when delivery was definitely not attempted (lease expiry
  // with a delivery record proving no attempt). Never from ambiguity.
  CLAIMED: ["DELIVERED", "QUEUED", "CANCELLED"],
  DELIVERED: ["ACKNOWLEDGED", "DELIVERY_UNKNOWN"],
  // Fail-closed quarantine: no exit to QUEUED/CLAIMED/DELIVERED.
  DELIVERY_UNKNOWN: ["ACKNOWLEDGED", "FAILED", "CANCELLED"],
  ACKNOWLEDGED: ["RUNNING", "SETTLED"],
  RUNNING: ["SETTLED"],
  SETTLED: ["RESULT_AVAILABLE"],
  RESULT_AVAILABLE: ["CONSUMED"],
  CONSUMED: [],
  CANCELLED: [],
  FAILED: [],
};

export const LEGAL_TRANSITIONS: Readonly<Record<HandoffState, readonly HandoffState[]>> = LEGAL;

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION" as const;
  readonly from: HandoffState;
  readonly to: HandoffState;

  constructor(from: HandoffState, to: HandoffState) {
    super(`illegal handoff state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: HandoffState, to: HandoffState): boolean {
  return LEGAL[from].includes(to);
}

/** Returns `to` when legal; throws {@link IllegalTransitionError} otherwise. */
export function assertTransition(from: HandoffState, to: HandoffState): HandoffState {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}

export function isTerminal(state: HandoffState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isQuarantined(state: HandoffState): boolean {
  return QUARANTINED_STATES.includes(state);
}
