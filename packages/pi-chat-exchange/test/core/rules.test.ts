import { describe, expect, it } from "vitest";
import type { EndpointRef, Exchange, Message, Result } from "../../src/protocol/entities.js";
import {
  CloseRejectedError,
  IllegalTransitionError,
  InvalidResultError,
  ResultConflictError,
  TransitionEvidenceError,
  assertMessageTransition,
  assertResultPublication,
  closeExchange,
  readResult,
} from "../../src/core/rules.js";

import { fixtureAuthorization } from "../fixtures/authorization.js";
import { CONTROL_OPERATIONS, ENDPOINT_OPERATIONS } from "../../src/protocol/capabilities.js";
const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = "2026-10-06T00:00:00.000Z";
const later = "2026-10-06T00:02:00.000Z";
const from: EndpointRef = { adapter: "client-adapter", endpointId: "durable-client" };
const to: EndpointRef = { adapter: "agent-adapter", endpointId: "durable-agent", instanceId: "live-instance" };
const exchange: Exchange = { exchangeId: `ho_${uid}`, state: "OPEN", createdAt: now };
const lease = { consumerId: "consumer-1", instanceId: "live-instance", fencingToken: 3, expiresAt: "2026-10-06T00:01:00.000Z" };
const attempt = {
  attemptId: `att_${uid}`,
  messageId: `msg_${uid}`,
  endpoint: to,
  lease,
  dispatch: "not_attempted" as const,
  transport: "pending" as const,
  createdAt: now,
};
const message = (overrides: Partial<Message> = {}): Message => ({
  messageId: `msg_${uid}`,
  exchangeId: exchange.exchangeId,
  from,
  to,
  state: "RESULT_AVAILABLE",
  payloadDigest: "a".repeat(64),
  payloadLength: 9,
  createdAt: now,
  ...overrides,
});
const result: Result = {
  resultId: `hr_${uid}`,
  exchangeId: exchange.exchangeId,
  messageId: `msg_${uid}`,
  attemptId: `att_${uid}`,
  source: to,
  transport: "delivered",
  runtime: "settled",
  body: "output",
  resultDigest: "b".repeat(64),
  settledAt: now,
  applicationEvidence: { taskState: "opaque-state", nested: [false, { vendorField: 42 }] },
};
const runtime = (outcome: "accepted" | "running" | "settled" | "cancelled") => ({
  exchangeId: exchange.exchangeId, messageId: attempt.messageId, attemptId: attempt.attemptId,
  endpoint: to, outcome, observedAt: now,
});
const execution = fixtureAuthorization(exchange.exchangeId, attempt.messageId, attempt.attemptId, to, "receiver", ENDPOINT_OPERATIONS);
const requests = fixtureAuthorization(exchange.exchangeId, attempt.messageId, attempt.attemptId, to, "owner", CONTROL_OPERATIONS);
const owner = fixtureAuthorization(exchange.exchangeId, attempt.messageId, attempt.attemptId, to);
const guard = (overrides: Record<string, unknown> = {}) => ({
  authorization: execution,
  now,
  lease,
  attempt,
  currentLease: lease,
  ...overrides,
});

describe("core transition rules (protocol v2)", () => {
  it("walks the delivery and settlement ladder with correlated evidence", () => {
    const ladder: ReadonlyArray<readonly [Message["state"], Message["state"]]> = [
      ["CLAIMED", "DISPATCHING"],
      ["DISPATCHING", "ACCEPTED"],
      ["ACCEPTED", "RUNNING"],
      ["RUNNING", "SETTLED"],
      ["SETTLED", "RESULT_AVAILABLE"],
    ];
    for (const [from, to] of ladder) {
      const proof = guard({
        attempt: {
          ...attempt,
          dispatch: "started" as const,
          transport: to === "DISPATCHING" ? ("pending" as const) : ("delivered" as const),
        },
        runtime: runtime(to === "ACCEPTED" ? "accepted" : to === "RUNNING" ? "running" : "settled"),
        result: to === "RESULT_AVAILABLE" ? result : undefined,
      });
      expect(assertMessageTransition(message({ state: from }), to, proof)).toBe(to);
    }
  });

  it("requires the durable dispatch-start marker before any adapter effect", () => {
    // Entering DISPATCHING must be backed by an attempt whose dispatch start
    // was already durably recorded; a not-attempted marker is not a start.
    expect(() =>
      assertMessageTransition(message({ state: "CLAIMED" }), "DISPATCHING", guard()),
    ).toThrowError(TransitionEvidenceError);
  });

  it("permits safe requeue only with definitely-not-attempted evidence", () => {
    const notAttempted = guard({ attempt: { ...attempt, dispatch: "not_attempted" as const } });
    expect(assertMessageTransition(message({ state: "CLAIMED" }), "QUEUED", notAttempted)).toBe("QUEUED");
    expect(() =>
      assertMessageTransition(
        message({ state: "CLAIMED" }),
        "QUEUED",
        guard({ attempt: { ...attempt, dispatch: "started" as const } }),
      ),
    ).toThrowError(TransitionEvidenceError);
    expect(() =>
      assertMessageTransition(message({ state: "CLAIMED" }), "QUEUED", guard({ attempt: undefined })),
    ).toThrowError(TransitionEvidenceError);
  });

  it("quarantines potentially attempted dispatch instead of retrying", () => {
    const ambiguous = guard({ attempt: { ...attempt, dispatch: "started" as const, transport: "ambiguous" as const } });
    expect(
      assertMessageTransition(message({ state: "DISPATCHING" }), "DELIVERY_UNKNOWN", ambiguous),
    ).toBe("DELIVERY_UNKNOWN");
    // Crash after the durable start marker but before the state write:
    expect(
      assertMessageTransition(message({ state: "CLAIMED" }), "DELIVERY_UNKNOWN", ambiguous),
    ).toBe("DELIVERY_UNKNOWN");
  });

  it.each(["QUEUED", "CLAIMED", "DISPATCHING"] as const)(
    "never requeues ambiguity to %s",
    (target) => {
      expect(() =>
        assertMessageTransition(message({ state: "DELIVERY_UNKNOWN" }), target, guard()),
      ).toThrowError(IllegalTransitionError);
    },
  );

  it("resolves unknown delivery only with correlated evidence and reconciliation authority", () => {
    // Missing delivered evidence:
    expect(() =>
      assertMessageTransition(message({ state: "DELIVERY_UNKNOWN" }), "ACCEPTED", guard()),
    ).toThrowError(TransitionEvidenceError);
    // Correlated acceptance without explicit reconciliation (bare expired-lease
    // reuse) is not enough:
    expect(() =>
      assertMessageTransition(
        message({ state: "DELIVERY_UNKNOWN" }),
        "ACCEPTED",
        guard({ attempt: { ...attempt, dispatch: "started" as const, transport: "delivered" as const } }),
      ),
    ).toThrowError(TransitionEvidenceError);
    // Late correlated acceptance with explicit reconciliation authority:
    expect(
      assertMessageTransition(
        message({ state: "DELIVERY_UNKNOWN" }),
        "ACCEPTED",
        guard({
          attempt: { ...attempt, dispatch: "started" as const, transport: "delivered" as const },
          reconciliation: { resolvedAt: now, basis: "receiver receipt log correlation" },
          runtime: runtime("accepted"),
        }),
      ),
    ).toBe("ACCEPTED");
    // Clients never resolve quarantine toward runtime states:
    expect(() =>
      assertMessageTransition(
        message({ state: "DELIVERY_UNKNOWN" }),
        "ACCEPTED",
        guard({
          authorization: requests,
          attempt: { ...attempt, dispatch: "started" as const, transport: "delivered" as const },
          reconciliation: { resolvedAt: now, basis: "receiver receipt log correlation" },
        }),
      ),
    ).toThrowError(TransitionEvidenceError);
  });

  it("rejects uncorrelated attempts and endpoints", () => {
    const foreign = guard({ attempt: { ...attempt, messageId: `msg_${uid.slice(0, -1)}W` } });
    expect(() =>
      assertMessageTransition(message({ state: "CLAIMED" }), "DISPATCHING", foreign),
    ).toThrowError(TransitionEvidenceError);
    const wrongEndpoint = guard({
      attempt: {
        ...attempt,
        dispatch: "started" as const,
        endpoint: { adapter: "agent-adapter", endpointId: "other-endpoint", instanceId: "other-instance" },
      },
    });
    expect(() =>
      assertMessageTransition(message({ state: "CLAIMED" }), "DISPATCHING", wrongEndpoint),
    ).toThrowError(TransitionEvidenceError);
  });

  it.each([
    { lease: { ...lease, fencingToken: 2 } },
    { lease: { ...lease, consumerId: "other-consumer" } },
    { lease: { ...lease, instanceId: "other-instance" } },
    { now: later },
  ])("rejects stale or foreign lease evidence %j", (override) => {
    // The attempt keeps the recorded lease; only the guard's claim changes.
    const proof = guard({ ...override, attempt: { ...attempt, dispatch: "started" as const } });
    expect(() =>
      assertMessageTransition(message({ state: "CLAIMED" }), "DISPATCHING", proof),
    ).toThrowError(TransitionEvidenceError);
  });

  it("does not let request grants authorize execution or runtime grants authorize close", () => {
    expect(() =>
      assertMessageTransition(
        message({ state: "RUNNING" }),
        "SETTLED",
        guard({ authorization: requests, attempt: { ...attempt, dispatch: "started" as const } }),
      ),
    ).toThrowError(TransitionEvidenceError);
    expect(() =>
      assertMessageTransition(message({ state: "QUEUED" }), "CLAIMED", guard({ authorization: requests })),
    ).toThrowError(TransitionEvidenceError);
    expect(() => closeExchange(exchange, [message()], execution)).toThrowError(CloseRejectedError);
  });

  it("distinguishes cancellation requests from confirmations", () => {
    expect(
      assertMessageTransition(message({ state: "QUEUED" }), "CANCELLED", guard({ authorization: requests })),
    ).toBe("CANCELLED");
    expect(
      assertMessageTransition(message({ state: "DISPATCHING" }), "CANCEL_REQUESTED", guard({ authorization: requests })),
    ).toBe("CANCEL_REQUESTED");
    // A request is not a confirmation once dispatch may have begun:
    expect(() =>
      assertMessageTransition(
        message({ state: "CANCEL_REQUESTED" }),
        "CANCELLED",
        guard({ authorization: requests, attempt: { ...attempt, dispatch: "started" as const } }),
      ),
    ).toThrowError(TransitionEvidenceError);
    expect(
      assertMessageTransition(
        message({ state: "CANCEL_REQUESTED" }),
        "CANCELLED",
        guard({ attempt: { ...attempt, dispatch: "started" as const, transport: "delivered" as const }, runtime: runtime("cancelled") }),
      ),
    ).toBe("CANCELLED");
    // Owner disposition is not execution evidence, even with reconciliation text.
    expect(() =>
      assertMessageTransition(
        message({ state: "DELIVERY_UNKNOWN" }),
        "CANCELLED",
        guard({ authorization: requests, attempt: { ...attempt, dispatch: "started" as const } }),
      ),
    ).toThrowError(IllegalTransitionError);
    expect(() =>
      assertMessageTransition(
        message({ state: "DELIVERY_UNKNOWN" }),
        "CANCELLED",
        guard({
          authorization: requests,
          attempt: { ...attempt, dispatch: "started" as const },
          reconciliation: { resolvedAt: now, basis: "owner abandons after investigation" },
        }),
      ),
    ).toThrowError(IllegalTransitionError);
  });

  it("publishes results once, permits exact replay, rejects replacement", () => {
    expect(assertResultPublication(undefined, result, execution)).toEqual(result);
    expect(assertResultPublication(result, result, execution)).toEqual(result);
    expect(() => assertResultPublication(result, { ...result, body: "changed" }, execution)).toThrowError(
      ResultConflictError,
    );
    expect(() => assertResultPublication(undefined, { ...result, resultDigest: "zz" }, execution)).toThrowError(
      InvalidResultError,
    );
  });

  it("returns immutable result snapshots that never consume anything", () => {
    const first = readResult(result);
    const second = readResult(result);
    expect(first).toEqual(second);
    expect(first).toEqual(result);
    expect(first).not.toBe(result);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.applicationEvidence)).toBe(true);
    expect(() => readResult({ ...result, resultDigest: "zz" })).toThrowError(InvalidResultError);
    // Reads leave lifecycle state untouched:
    expect(message({ state: "RESULT_AVAILABLE" }).state).toBe("RESULT_AVAILABLE");
    expect(exchange.state).toBe("OPEN");
  });

  it("closes exchanges explicitly only when every message is finished", () => {
    const closed = closeExchange(exchange, [message()], owner);
    expect(closed).toEqual({ ...exchange, state: "CLOSED" });
    expect(exchange.state).toBe("OPEN");
    expect(() => closeExchange(closed, [], owner)).toThrowError(CloseRejectedError);
  });

  it.each([
    "CREATED",
    "QUEUED",
    "CLAIMED",
    "DISPATCHING",
    "DELIVERY_UNKNOWN",
    "ACCEPTED",
    "RUNNING",
    "SETTLED",
    "CANCEL_REQUESTED",
  ] as const)("blocks close while a message is %s", (state) => {
    expect(() => closeExchange(exchange, [message({ state })], owner)).toThrowError(CloseRejectedError);
  });

  it("rejects messages from other exchanges in close checks", () => {
    expect(() =>
      closeExchange(exchange, [message({ exchangeId: `ho_${uid.slice(0, -1)}W` })], owner),
    ).toThrowError(CloseRejectedError);
  });
});
