import { expect, it } from "vitest";
import { assertMessageTransition, closeExchange, IllegalTransitionError } from "../../src/core/rules.js";

import { fixtureAuthorization } from "../fixtures/authorization.js";
it("PH-0003 preserved invariant: owner cancellation cannot finish unresolved ambiguous delivery", () => {
  const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const now = "2026-10-06T00:00:00Z";
  const endpoint = { adapter: "generic", endpointId: "durable", instanceId: "live" };
  const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
  const exchange = { exchangeId: `ho_${uid}`, state: "OPEN" as const, createdAt: now };
  const message = {
    messageId: `msg_${uid}`, exchangeId: exchange.exchangeId,
    from: { adapter: "generic", endpointId: "requester" }, to: endpoint,
    state: "DELIVERY_UNKNOWN" as const,
    payloadDigest: "a".repeat(64), payloadLength: 1, createdAt: now,
  };
  const attempt = {
    attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease,
    dispatch: "started" as const, transport: "ambiguous" as const, createdAt: now,
  };
  // Original RED accepted CANCELLED and CLOSED while transport stayed ambiguous.
  // Owner reconciliation text is not no-effect or runtime cancellation proof.
  expect(() => assertMessageTransition(message, "CANCELLED", {
    authorization: fixtureAuthorization(exchange.exchangeId, message.messageId, attempt.attemptId, endpoint), now, lease, currentLease: lease, attempt,
    reconciliation: { resolvedAt: now, basis: "owner requests abandonment; delivery remains unknown" },
  })).toThrowError(IllegalTransitionError);
  expect(() => closeExchange(exchange, [message], fixtureAuthorization(exchange.exchangeId, message.messageId, attempt.attemptId, endpoint))).toThrow();
  expect(message.state).toBe("DELIVERY_UNKNOWN");
  expect(attempt.transport).toBe("ambiguous");
  expect(exchange.state).toBe("OPEN");
});

it.each(["ambiguous", "delivered", "failed"] as const)("no-attempt cancellation/requeue cannot launder contradictory %s transport", (transport) => {
  const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const now = "2026-10-06T00:00:00Z";
  const endpoint = { adapter: "generic", endpointId: "durable" };
  const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
  const message = { messageId: `msg_${uid}`, exchangeId: `ho_${uid}`, to: endpoint, state: "CLAIMED" as const };
  const attempt = { attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease, dispatch: "not_attempted" as const, transport, createdAt: now };
  for (const to of ["CANCELLED", "QUEUED"] as const) {
    expect(() => assertMessageTransition(message, to, { authorization: fixtureAuthorization(message.exchangeId, message.messageId, attempt.attemptId, endpoint), now, lease, currentLease: lease, attempt })).toThrow();
  }
});

it("queued cancellation rejects presented possibly-delivered evidence", () => {
  const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const now = "2026-10-06T00:00:00Z";
  const endpoint = { adapter: "generic", endpointId: "durable" };
  const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
  const message = { messageId: `msg_${uid}`, exchangeId: `ho_${uid}`, to: endpoint, state: "QUEUED" as const };
  const attempt = { attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease, dispatch: "started" as const, transport: "ambiguous" as const, createdAt: now };
  expect(() => assertMessageTransition(message, "CANCELLED", { authorization: fixtureAuthorization(message.exchangeId, message.messageId, attempt.attemptId, endpoint), now, lease, attempt })).toThrow();
});

it("runtime cancellation cannot bless a contradictory unstarted delivered attempt", () => {
  const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const now = "2026-10-06T00:00:00Z";
  const endpoint = { adapter: "generic", endpointId: "durable" };
  const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
  const message = { messageId: `msg_${uid}`, exchangeId: `ho_${uid}`, to: endpoint, state: "CANCEL_REQUESTED" as const };
  const attempt = { attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease, dispatch: "not_attempted" as const, transport: "delivered" as const, createdAt: now };
  const runtime = { exchangeId: message.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, endpoint, outcome: "cancelled" as const, observedAt: now };
  expect(() => assertMessageTransition(message, "CANCELLED", { authorization: fixtureAuthorization(message.exchangeId, message.messageId, attempt.attemptId, endpoint), now, lease, currentLease: lease, attempt, runtime })).toThrow();
});
