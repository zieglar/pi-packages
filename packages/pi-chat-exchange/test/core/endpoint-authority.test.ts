import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import * as rules from "../../src/core/rules.js";
import type { TransitionGuard } from "../../src/core/rules.js";
import { MessageSchema, type Message, type Result } from "../../src/protocol/entities.js";

import type { ActionGrant, AuthorizationContext, AuthorizationScope, ExchangeAction } from "../../src/protocol/capabilities.js";
const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = "2026-10-06T00:00:00Z";
const exchange = { exchangeId: `ho_${uid}`, state: "OPEN" as const, createdAt: now };
const endpoint = { adapter: "runtime", endpointId: "peer", instanceId: "live" };
const message: Message = { messageId: `msg_${uid}`, exchangeId: exchange.exchangeId, from: { adapter: "conversation", endpointId: "origin" }, to: endpoint, state: "DISPATCHING", payloadDigest: "a".repeat(64), payloadLength: 1, createdAt: now };
const lease = { consumerId: "worker", instanceId: "live", fencingToken: 2, expiresAt: "2026-10-06T01:00:00Z" };
const attempt = { attemptId: `att_${uid}`, messageId: message.messageId, endpoint, lease, dispatch: "started" as const, transport: "delivered" as const, createdAt: now };
const scope = { kind: "attempt" as const, exchangeId: exchange.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, endpoint };
const runtime = { exchangeId: exchange.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, endpoint, outcome: "accepted" as const, observedAt: now };
const result: Result = { resultId: `hr_${uid}`, exchangeId: exchange.exchangeId, messageId: message.messageId, attemptId: attempt.attemptId, source: endpoint, transport: "delivered", runtime: "settled", body: "processing output", resultDigest: "b".repeat(64), settledAt: now };
const authorization = (actions: readonly ExchangeAction[], grantedScope: AuthorizationScope = scope, principalId = "receiver"): AuthorizationContext => ({ principalId, grants: actions.map((action) => ({ action, principalId, scope: grantedScope } as ActionGrant)) });
const guard = (actions: readonly ExchangeAction[], overrides: Record<string, unknown> = {}): TransitionGuard => ({ now, lease, currentLease: lease, attempt, runtime, authorization: authorization(actions), ...overrides });
const owner = (action: "exchange_close" | "exchange_archive", ownerId = "owner") => authorization([action], { kind: "owner", exchangeId: exchange.exchangeId, ownerId }, ownerId);

// Plain contexts below stand in for authenticated HOST input, never caller authentication.
describe("scoped authority, not endpoint roles", () => {
  it("requires independent delivery and runtime-acceptance grants", () => {
    expect(rules.assertMessageTransition(message, "ACCEPTED", guard(["delivery_report", "activity_report"]))).toBe("ACCEPTED");
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard(["delivery_report"]))).toThrow();
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard(["activity_report"]))).toThrow();
  });
  it.each([
    { exchangeId: `ho_${"0".repeat(26)}` }, { messageId: `msg_${"0".repeat(26)}` },
    { attemptId: `att_${"0".repeat(26)}` }, { endpoint: { ...endpoint, instanceId: "stale" } },
    { endpoint: { ...endpoint, endpointId: "other" } },
  ])("rejects otherwise complete evidence with foreign grant scope %j", (change) => {
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard([], { authorization: authorization(["delivery_report", "activity_report"], { ...scope, ...change }) }))).toThrow();
  });
  it("rejects principal mismatch and untrusted role-only guards", () => {
    const context = authorization(["delivery_report", "activity_report"]);
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard([], { authorization: { ...context, principalId: "impostor" } }))).toThrow();
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", { now, lease, currentLease: lease, attempt, runtime, authority: "agent" } as unknown as TransitionGuard)).toThrow();
    expect(() => rules.closeExchange(exchange, [], "client" as never)).toThrow();
  });
  it("does not turn supported observation or delivery into missing evidence", () => {
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard(["delivery_report", "activity_report"], { runtime: undefined, capabilities: { observation: "supported" } }))).toThrow();
    expect(() => rules.assertMessageTransition(message, "DELIVERY_UNKNOWN", guard(["delivery_report"], { runtime: undefined }))).toThrow();
    expect(attempt.transport).toBe("delivered"); // Unknown runtime is not unknown transport.
  });
  it("does not let request permission authorize settlement or claiming", () => {
    const request = authorization(["exchange_send"], { kind: "exchange", exchangeId: exchange.exchangeId });
    expect(() => rules.assertMessageTransition({ ...message, state: "RUNNING" }, "SETTLED", guard([], { authorization: request, runtime: { ...runtime, outcome: "settled" } }))).toThrow();
    expect(() => rules.assertMessageTransition({ ...message, state: "QUEUED" }, "CLAIMED", guard([], { authorization: request }))).toThrow();
  });
  it("does not require a fabricated lease for a request-only transition", () => {
    const request = authorization(["exchange_send"], { kind: "exchange", exchangeId: exchange.exchangeId });
    expect(rules.assertMessageTransition({ ...message, state: "CREATED" }, "QUEUED", { authorization: request, now })).toBe("QUEUED");
    expect(() => rules.assertMessageTransition(message, "ACCEPTED", { authorization: authorization(["delivery_report", "activity_report"]), now, attempt, runtime })).toThrowError(rules.TransitionEvidenceError);
  });
  it("licenses claim by destination binding and request by exchange, irrespective of product", () => {
    const destination = { kind: "destination" as const, exchangeId: exchange.exchangeId, messageId: message.messageId, endpoint };
    expect(rules.assertMessageTransition({ ...message, state: "QUEUED" }, "CLAIMED", guard([], { authorization: authorization(["message_claim"], destination) }))).toBe("CLAIMED");
    expect(rules.assertMessageTransition({ ...message, state: "CREATED" }, "QUEUED", guard([], { authorization: authorization(["exchange_send"], { kind: "exchange", exchangeId: exchange.exchangeId }) }))).toBe("QUEUED");
  });
  it("separates progress, settlement and result publication", () => {
    expect(rules.assertMessageTransition({ ...message, state: "RUNNING" }, "SETTLED", guard(["settlement_report"], { runtime: { ...runtime, outcome: "settled" } }))).toBe("SETTLED");
    expect(() => rules.assertMessageTransition({ ...message, state: "RUNNING" }, "SETTLED", guard(["activity_report"], { runtime: { ...runtime, outcome: "settled" } }))).toThrow();
    expect(rules.assertResultPublication(undefined, result, authorization(["result_publish"]))).toEqual(result);
    expect(() => rules.assertResultPublication(undefined, result, authorization(["settlement_report"]))).toThrow();
  });
  it("keeps runtime authority separate from explicit owner close and archive", () => {
    expect(rules.closeExchange(exchange, [{ ...message, state: "RESULT_AVAILABLE" }], owner("exchange_close"))).toEqual({ ...exchange, state: "CLOSED" });
    expect(() => rules.closeExchange(exchange, [], authorization(["settlement_report"]))).toThrow();
    expect(() => rules.closeExchange(exchange, [], owner("exchange_archive"))).toThrow();
    const intent = { ownerId: "owner", recordedAt: now, reason: "investigation exhausted", reconciliation: { resolvedAt: now, basis: "effects remain unresolved" } };
    const unknown = { ...message, state: "DELIVERY_UNKNOWN" as const };
    const ambiguous = { ...attempt, transport: "ambiguous" as const };
    const disposition = rules.archiveUnresolvedExchange(exchange, [unknown], [ambiguous], intent, owner("exchange_archive"));
    expect(disposition.unresolved[0]!.transport).toBe("ambiguous");
    expect(unknown.state).toBe("DELIVERY_UNKNOWN");
    expect(() => rules.archiveUnresolvedExchange(exchange, [unknown], [ambiguous], { ...intent, ownerId: "other" }, owner("exchange_archive"))).toThrow();
  });
  it("does not treat cancellation confirmation as implicit runtime reporting", () => {
    const cancelling = { ...message, state: "CANCEL_REQUESTED" as const };
    const cancelled = { ...runtime, outcome: "cancelled" as const };
    expect(() => rules.assertMessageTransition(cancelling, "CANCELLED", guard(["cancel_confirm"], { runtime: cancelled }))).toThrow();
    expect(rules.assertMessageTransition(cancelling, "CANCELLED", guard(["cancel_confirm", "settlement_report"], { runtime: cancelled }))).toBe("CANCELLED");
    expect(rules.assertMessageTransition(cancelling, "CANCELLED", guard(["cancel_confirm"], { attempt: { ...attempt, dispatch: "not_attempted", transport: "pending" }, runtime: undefined }))).toBe("CANCELLED");
  });
  it("allows one authenticated principal to hold both request and recipient grants", () => {
    const request = authorization(["exchange_send"], { kind: "exchange", exchangeId: exchange.exchangeId });
    const delivery = authorization(["delivery_report", "activity_report"]);
    const combined = { principalId: delivery.principalId, grants: [...request.grants, ...delivery.grants] };
    expect(rules.assertMessageTransition({ ...message, state: "CREATED" }, "QUEUED", guard([], { authorization: combined }))).toBe("QUEUED");
    expect(rules.assertMessageTransition(message, "ACCEPTED", guard([], { authorization: combined }))).toBe("ACCEPTED");
  });
  it("requires runtime authority separately even during factual ambiguity reconciliation", () => {
    const unknown = { ...message, state: "DELIVERY_UNKNOWN" as const };
    const proof = { reconciliation: { resolvedAt: now, basis: "correlated receiver acceptance" } };
    expect(() => rules.assertMessageTransition(unknown, "ACCEPTED", guard(["ambiguity_resolve"], proof))).toThrow();
    expect(rules.assertMessageTransition(unknown, "ACCEPTED", guard(["ambiguity_resolve", "activity_report"], proof))).toBe("ACCEPTED");
  });
  it("rejects malformed, non-JSON or broad action/scope contexts", () => {
    const valid = authorization(["delivery_report", "activity_report"]);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const malformed of [undefined, { ...valid, authority: "agent" }, { ...valid, grants: new Map() }, cycle, authorization(["delivery_report", "activity_report"], { kind: "exchange", exchangeId: exchange.exchangeId })]) {
      expect(() => rules.assertMessageTransition(message, "ACCEPTED", guard([], { authorization: malformed }))).toThrowError(rules.TransitionEvidenceError);
    }
    expect(() => rules.assertResultPublication(undefined, result, authorization(["result_publish"], { ...scope, attemptId: `att_${"0".repeat(26)}` }))).toThrow();
  });
  it.each(["conversation", "runtime", "future"])("keeps ambiguity fail-closed for %s endpoints", (adapter) => {
    const target = { ...endpoint, adapter };
    const ambiguous = { ...attempt, endpoint: target, transport: "ambiguous" as const };
    const proof = guard([], { attempt: ambiguous, runtime: undefined, authorization: authorization(["delivery_report"], { ...scope, endpoint: target }) });
    const incoming = { ...message, to: target };
    expect(rules.assertMessageTransition(incoming, "DELIVERY_UNKNOWN", proof)).toBe("DELIVERY_UNKNOWN");
    for (const state of ["QUEUED", "CLAIMED", "DISPATCHING", "CANCELLED"] as const) expect(() => rules.assertMessageTransition({ ...incoming, state: "DELIVERY_UNKNOWN" }, state, proof)).toThrow();
    expect(() => rules.closeExchange(exchange, [{ ...incoming, state: "DELIVERY_UNKNOWN" }], owner("exchange_close"))).toThrow();
  });
  it("represents reply/follow-up as independent messages, not a Result or a read", () => {
    const reply = { ...message, messageId: `msg_${"0".repeat(26)}`, from: message.to, to: message.from, state: "CREATED" as const };
    expect(Value.Check(MessageSchema, reply)).toBe(true);
    expect(reply.exchangeId).toBe(result.exchangeId);
    expect(reply.messageId).not.toBe(result.messageId);
    const snapshot = structuredClone({ exchange, message, reply, result });
    expect(rules.readResult(result)).toEqual(rules.readResult(result));
    expect({ exchange, message, reply, result }).toEqual(snapshot);
    expect(() => rules.closeExchange(exchange, [{ ...message, state: "RESULT_AVAILABLE" }, reply], owner("exchange_close"))).toThrow();
  });
});
