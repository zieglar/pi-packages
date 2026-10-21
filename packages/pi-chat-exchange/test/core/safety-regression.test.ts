import { describe, expect, it } from "vitest";
import { assertMessageTransition, readResult } from "../../src/core/rules.js";
import { canonicalDigest } from "../../src/protocol/idempotency.js";
import { InMemoryIdempotencyStore } from "../../src/core/reference.js";

import { fixtureAuthorization } from "../fixtures/authorization.js";
const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = "2026-10-06T00:00:00Z";
const endpoint = { adapter: "generic", endpointId: "durable", instanceId: "live" };
const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
const attempt = { attemptId: `att_${uid}`, messageId: `msg_${uid}`, endpoint, lease, dispatch: "started" as const, transport: "ambiguous" as const, createdAt: now };
const message = { messageId: attempt.messageId, exchangeId: `ho_${uid}`, to: endpoint, state: "DISPATCHING" as const };
const guard = { authorization: fixtureAuthorization(message.exchangeId, message.messageId, attempt.attemptId, endpoint), now, lease, currentLease: lease, attempt };
const result = { resultId: `hr_${uid}`, exchangeId: message.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, source: endpoint, transport: "delivered" as const, runtime: "settled" as const, body: "x", resultDigest: "a".repeat(64), settledAt: now };

describe("fail-closed review regressions", () => {
  it("quarantines a possibly attempted delivery after its lease expires", () => {
    expect(assertMessageTransition(message, "DELIVERY_UNKNOWN", { ...guard, now: "2026-10-06T02:00:00Z" })).toBe("DELIVERY_UNKNOWN");
  });
  it("preserves quarantine after cancellation of an ambiguous dispatch", () => {
    expect(assertMessageTransition({ ...message, state: "CANCEL_REQUESTED" }, "DELIVERY_UNKNOWN", guard)).toBe("DELIVERY_UNKNOWN");
    expect(() => assertMessageTransition({ ...message, state: "CANCEL_REQUESTED" }, "CANCELLED", guard)).toThrow();
  });
  it("requires explicit runtime acceptance, not a transport receipt", () => {
    expect(() => assertMessageTransition(message, "ACCEPTED", { ...guard, attempt: { ...attempt, transport: "delivered" } })).toThrow();
  });
  it("requires correlated runtime settlement evidence", () => {
    expect(() => assertMessageTransition({ ...message, state: "RUNNING" }, "SETTLED", guard)).toThrow();
  });
  it("requires an immutable correlated result before availability", () => {
    expect(() => assertMessageTransition({ ...message, state: "SETTLED" }, "RESULT_AVAILABLE", guard)).toThrow();
  });
  it("rejects historical matching leases after a newer fenced claim", () => {
    expect(() => assertMessageTransition({ ...message, state: "CLAIMED" }, "DISPATCHING", { ...guard, currentLease: { ...lease, fencingToken: 2 } })).toThrow();
  });
  it("rejects invalid timestamps instead of bypassing expiry", () => {
    expect(() => assertMessageTransition({ ...message, state: "CLAIMED" }, "DISPATCHING", { ...guard, now: "invalid" })).toThrow();
  });
  it.each([new Map([["x", 1]]), new Set([1]), new Date(now), { bad: Number.NaN }, { bad: undefined }])("rejects non-JSON application evidence %j", (applicationEvidence) => {
    expect(() => readResult({ ...result, applicationEvidence })).toThrow();
    expect(() => canonicalDigest(applicationEvidence)).toThrow();
  });
  it("rejects cyclic application evidence without recursive overflow", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => readResult({ ...result, applicationEvidence: cycle })).toThrow();
  });
  it("accepts independently correlated runtime and publication evidence", () => {
    const delivered = { ...attempt, transport: "delivered" as const };
    const observed = { exchangeId: message.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, endpoint, outcome: "accepted" as const, observedAt: now };
    expect(assertMessageTransition(message, "ACCEPTED", { ...guard, attempt: delivered, runtime: observed })).toBe("ACCEPTED");
    expect(assertMessageTransition({ ...message, state: "RUNNING" }, "SETTLED", { ...guard, attempt: delivered, runtime: { ...observed, outcome: "runtime_error" } })).toBe("SETTLED");
    expect(assertMessageTransition({ ...message, state: "SETTLED" }, "RESULT_AVAILABLE", { ...guard, attempt: delivered, result })).toBe("RESULT_AVAILABLE");
    expect(() => assertMessageTransition(message, "ACCEPTED", { ...guard, attempt: delivered, runtime: { ...observed, attemptId: `att_${"0".repeat(26)}` } })).toThrow();
    expect(() => assertMessageTransition({ ...message, state: "SETTLED" }, "RESULT_AVAILABLE", { ...guard, attempt: delivered, result: { ...result, messageId: `msg_${"0".repeat(26)}` } })).toThrow();
  });
  it("cannot requeue a historical no-attempt claim after newer fencing", () => {
    expect(() => assertMessageTransition({ ...message, state: "CLAIMED" }, "QUEUED", { ...guard, attempt: { ...attempt, dispatch: "not_attempted", transport: "pending" }, currentLease: { ...lease, fencingToken: 2 } })).toThrow();
  });
  it.each(["accepted", "running"] as const)("does not publish a progress-only %s result", (runtime) => {
    expect(() => readResult({ ...result, runtime })).toThrow();
  });
  it.each([new Array(2), Object.assign([1], { extra: 2 }), { [Symbol("secret")]: 1 }])("rejects lossy digest input %j", (value) => {
    expect(() => canonicalDigest(value)).toThrow();
  });
  it("keeps namespace and key tuples disjoint even with separators", () => {
    const store = new InMemoryIdempotencyStore();
    const record = { entityId: message.messageId, requestDigest: "a".repeat(64), createdAt: now };
    store.record("a", "b\0c", record);
    expect(store.get("a\0b", "c")).toBeUndefined();
  });
});
