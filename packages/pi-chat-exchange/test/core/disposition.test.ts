import { beforeEach, describe, expect, it } from "vitest";
import * as rules from "../../src/core/rules.js";
import { Value } from "@sinclair/typebox/value";
import { ResultSchema, type DeliveryAttempt, type Exchange, type ExchangeDisposition, type Message } from "../../src/protocol/entities.js";

const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = "2026-10-06T00:00:00Z";
const endpoint = { adapter: "generic", endpointId: "target", instanceId: "live" };
const lease = { consumerId: "c", instanceId: "live", fencingToken: 1, expiresAt: "2026-10-06T01:00:00Z" };
const exchange: Exchange = { exchangeId: `ho_${uid}`, state: "OPEN", createdAt: now };
const message: Message = { messageId: `msg_${uid}`, exchangeId: exchange.exchangeId, from: { adapter: "generic", endpointId: "requester" }, to: endpoint, state: "DELIVERY_UNKNOWN", payloadDigest: "a".repeat(64), payloadLength: 1, createdAt: now };
const attempt: DeliveryAttempt = { attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease, dispatch: "started", transport: "ambiguous", createdAt: now };
const intent = { ownerId: "authenticated-owner", recordedAt: now, reason: "No further investigation is available", reconciliation: { resolvedAt: now, basis: "Investigation exhausted; execution remains unknown" } };
const result = { resultId: `hr_${uid}`, exchangeId: exchange.exchangeId, messageId: `msg_${"0".repeat(26)}`, attemptId: `att_${"0".repeat(26)}`, source: endpoint, transport: "delivered" as const, runtime: "settled" as const, body: "historical result of another finished message", resultDigest: "a".repeat(64), settledAt: now };

function archive(messages: readonly Message[] = [message], attempts: readonly DeliveryAttempt[] = [attempt], options: Partial<typeof intent> = {}, authority: "client" | "agent" = "client", existing?: ExchangeDisposition): ExchangeDisposition {
  return rules.archiveUnresolvedExchange(exchange, messages, attempts, { ...intent, ...options }, authority, existing);
}

describe("administrative disposition is not execution evidence", () => {
  beforeEach(() => {
    expect(rules).toHaveProperty("archiveUnresolvedExchange");
    expect(rules).toHaveProperty("assertExchangeActive");
  });
  it("archives unresolved activity without changing any execution facts", () => {
    const disposition = archive();
    expect(disposition.status).toBe("ABANDONED_UNRESOLVED");
    expect(disposition.ownerId).toBe(intent.ownerId);
    expect(disposition.recordedAt).toBe(now);
    expect(disposition.reason).toBe(intent.reason);
    expect(disposition.reconciliation).toEqual(intent.reconciliation);
    expect(disposition.unresolved).toEqual([{ messageId: message.messageId, originalState: "DELIVERY_UNKNOWN", transport: "ambiguous", unresolvedSideEffects: true, attempt }]);
    expect(disposition.unresolved[0]!.attempt).not.toBe(attempt);
    expect(Object.isFrozen(disposition.unresolved[0]!.attempt.lease)).toBe(true);
    expect(message.state).toBe("DELIVERY_UNKNOWN");
    expect(attempt.transport).toBe("ambiguous");
    expect(exchange.state).toBe("OPEN");
    expect(Value.Check(ResultSchema, disposition)).toBe(false);
    expect(() => rules.closeExchange(exchange, [message], "client")).toThrow();
  });
  it("prohibits subsequent protocol activity, but historical result reads remain repeatable", () => {
    const disposition = archive();
    expect(() => rules.assertExchangeActive(exchange, disposition)).toThrow();
    expect(() => rules.assertMessageTransition({ ...message, state: "CREATED" }, "QUEUED", { authority: "client", now, lease, disposition })).toThrow();
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", { authority: "agent", now, lease, attempt: { ...attempt, transport: "delivered" }, reconciliation: intent.reconciliation, runtime: { exchangeId: exchange.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, endpoint, outcome: "accepted", observedAt: now }, disposition })).toThrow();
    expect(() => rules.assertResultPublication(undefined, result, disposition)).toThrow();
    expect(() => rules.closeExchange(exchange, [{ ...message, state: "RESULT_AVAILABLE" }], "client", disposition)).toThrow();
    expect(rules.readResult(result)).toEqual(rules.readResult(result));
    expect(disposition.unresolved[0]!.transport).toBe("ambiguous");
  });
  it("permits exact disposition replay but rejects replacement", () => {
    const disposition = archive();
    expect(archive([message], [attempt], {}, "client", disposition)).toEqual(disposition);
    expect(() => archive([message], [attempt], { reason: "replace history" }, "client", disposition)).toThrow();
  });
  it("rejects runtime authority as administrative owner authority", () => {
    expect(() => archive([message], [attempt], {}, "agent")).toThrow();
  });
  it.each(["CREATED", "QUEUED", "CLAIMED", "DISPATCHING", "ACCEPTED", "RUNNING", "SETTLED", "CANCEL_REQUESTED"] as const)("does not abandon an in-flight %s message", (state) => {
    expect(() => archive([message, { ...message, messageId: `msg_${"0".repeat(26)}`, state }])).toThrow();
  });
  it("allows a mix of finished and unresolved messages, preserving only unresolved snapshots", () => {
    expect(archive([message, { ...message, messageId: `msg_${"0".repeat(26)}`, state: "RESULT_AVAILABLE" }]).unresolved).toHaveLength(1);
  });
  it("rejects empty/unresolved-free aggregates, foreign or duplicated messages", () => {
    expect(() => archive([], [])).toThrow();
    expect(() => archive([{ ...message, state: "RESULT_AVAILABLE" }], [])).toThrow();
    expect(() => archive([{ ...message, exchangeId: `ho_${"0".repeat(26)}` }])).toThrow();
    expect(() => archive([message, message])).toThrow();
  });
  it("rejects missing, foreign, duplicate, unstarted or nonambiguous active attempts", () => {
    expect(() => archive([message], [])).toThrow();
    expect(() => archive([message], [attempt, attempt])).toThrow();
    expect(() => archive([message], [{ ...attempt, messageId: `msg_${"0".repeat(26)}` }])).toThrow();
    expect(() => archive([message], [{ ...attempt, endpoint: { ...endpoint, endpointId: "foreign" } }])).toThrow();
    expect(() => archive([message], [{ ...attempt, dispatch: "not_attempted" }])).toThrow();
    for (const transport of ["delivered", "failed", "pending"] as const) expect(() => archive([message], [{ ...attempt, transport }])).toThrow();
  });
  it("rejects malformed attempt input through the disposition error boundary", () => {
    expect(() => archive([message], [null as unknown as DeliveryAttempt])).toThrowError(rules.ExchangeDispositionError);
  });
  it("rejects invalid owner/reason/time and future reconciliation evidence", () => {
    expect(() => archive([message], [attempt], { ownerId: "" })).toThrow();
    expect(() => archive([message], [attempt], { reason: "" })).toThrow();
    expect(() => archive([message], [attempt], { recordedAt: "invalid" })).toThrow();
    expect(() => archive([message], [attempt], { reconciliation: { ...intent.reconciliation, resolvedAt: "2026-10-07T00:00:00Z" } })).toThrow();
  });
  it("keeps closed exchanges inactive and rejects foreign disposition guards", () => {
    expect(rules).toHaveProperty("assertExchangeActive");
    expect(() => rules.assertExchangeActive({ ...exchange, state: "CLOSED" })).toThrow();
    const disposition = archive();
    expect(() => rules.assertExchangeActive({ ...exchange, exchangeId: `ho_${"0".repeat(26)}` }, disposition)).toThrow();
    expect(() => rules.assertExchangeActive(exchange)).not.toThrow();
  });
});
