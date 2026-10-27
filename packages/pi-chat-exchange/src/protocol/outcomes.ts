/**
 * Generic outcome vocabularies (frozen v2).
 *
 * Transport and runtime outcomes are separate layers and never borrow each
 * other's vocabulary: a transport success is not runtime acceptance, and a
 * socket-level acknowledgment is never evidence of execution. Application
 * outcome is not modeled here at all — it stays opaque
 * (`applicationEvidence` on the Result).
 */
import { Type, type Static } from "@sinclair/typebox";

/**
 * Generic transport trichotomy for a dispatch attempt:
 * - `delivered`: the adapter boundary positively confirmed hand-off;
 * - `ambiguous`: the attempt may have taken effect (timeout, crash, unknown);
 * - `failed`: the adapter certifies the attempt provably had no effect.
 *
 * An adapter may report `failed` ONLY when it can prove no side effect
 * occurred; otherwise it must report `ambiguous`. `ambiguous` and `failed`
 * both fail closed in core rules (`DELIVERY_UNKNOWN` quarantine / terminal
 * FAILED with no automatic retry).
 */
export const TransportOutcomeSchema = Type.Union([
  Type.Literal("delivered"),
  Type.Literal("ambiguous"),
  Type.Literal("failed"),
]);

export type TransportOutcome = Static<typeof TransportOutcomeSchema>;

/** Transport state of a DeliveryAttempt; `pending` before any outcome is known. */
export const AttemptTransportSchema = Type.Union([
  Type.Literal("pending"),
  TransportOutcomeSchema,
]);

export type AttemptTransport = Static<typeof AttemptTransportSchema>;

/**
 * Durable dispatch marker on a DeliveryAttempt. `started` is written durably
 * BEFORE any adapter side effect; `not_attempted` is the only evidence that
 * licenses a safe requeue or clean release.
 */
export const DispatchMarkerSchema = Type.Union([
  Type.Literal("not_attempted"),
  Type.Literal("started"),
]);

export type DispatchMarker = Static<typeof DispatchMarkerSchema>;

/**
 * Generic runtime outcome ladder of the destination invocation. `settled` and
 * the failure kinds are settlement-grade; `accepted`/`running` describe
 * observed progress. A published immutable Result typically carries a
 * settlement-grade value.
 */
export const RuntimeOutcomeSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("settled"),
  Type.Literal("runtime_error"),
  Type.Literal("cancelled"),
  Type.Literal("interrupted"),
]);

export type RuntimeOutcome = Static<typeof RuntimeOutcomeSchema>;
