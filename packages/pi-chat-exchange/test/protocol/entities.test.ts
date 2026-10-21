import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
  EVENT_KINDS,
  ExchangeSchema,
  EndpointRefSchema,
  MessageSchema,
  DeliveryAttemptSchema,
  ResultSchema,
  ReceiptSchema,
  ConsumerSchema,
  LeaseSchema,
  EventSchema,
  SHA256_HEX_PATTERN,
} from "../../src/protocol/entities.js";

const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = "2026-10-06T00:00:00.000Z";
const from = { adapter: "client-adapter", endpointId: "durable-client" };
const to = { adapter: "agent-adapter", endpointId: "durable-agent", instanceId: "live-instance" };
const exchange = { exchangeId: `ho_${uid}`, state: "OPEN" as const, createdAt: now };
const message = {
  messageId: `msg_${uid}`,
  exchangeId: exchange.exchangeId,
  from,
  to,
  state: "RESULT_AVAILABLE" as const,
  payloadDigest: "a".repeat(64),
  payloadLength: 9,
  createdAt: now,
};
const lease = {
  consumerId: "consumer-1",
  instanceId: "live-instance",
  fencingToken: 3,
  expiresAt: "2026-10-06T00:01:00.000Z",
};
const attempt = {
  attemptId: `att_${uid}`,
  messageId: message.messageId,
  endpoint: to,
  lease,
  dispatch: "not_attempted" as const,
  transport: "pending" as const,
  createdAt: now,
};
const result = {
  resultId: `hr_${uid}`,
  exchangeId: exchange.exchangeId,
  messageId: message.messageId,
  attemptId: attempt.attemptId,
  source: to,
  transport: "delivered" as const,
  runtime: "settled" as const,
  body: "output",
  resultDigest: "b".repeat(64),
  settledAt: now,
  applicationEvidence: { taskState: "opaque-state", nested: [false, { vendorField: 42 }] },
};

describe("generic entity schemas (protocol v2)", () => {
  it("accepts a neutral exchange and either message direction", () => {
    expect(Value.Check(ExchangeSchema, exchange)).toBe(true);
    expect(Value.Check(MessageSchema, message)).toBe(true);
    expect(Value.Check(MessageSchema, { ...message, from: to, to: from })).toBe(true);
    expect(Value.Check(ExchangeSchema, { ...exchange, state: "CLOSED", closedAt: now })).toBe(true);
  });

  it("rejects product-specific fields and credentials in routing identities", () => {
    for (const key of ["piSessionId", "chatgptConversationId", "token", "metadata"]) {
      expect(Value.Check(EndpointRefSchema, { ...to, [key]: "secret" })).toBe(false);
    }
    expect(Value.Check(MessageSchema, { ...message, piSessionId: "x" })).toBe(false);
    expect(Value.Check(EndpointRefSchema, { adapter: "", endpointId: "e" })).toBe(false);
    expect(Value.Check(EndpointRefSchema, { adapter: "a" })).toBe(false);
  });

  it("keeps endpoint identity bounded and non-secret", () => {
    expect(Value.Check(EndpointRefSchema, { adapter: "a".repeat(65), endpointId: "e" })).toBe(false);
    expect(Value.Check(EndpointRefSchema, { adapter: "a", endpointId: "e".repeat(257) })).toBe(false);
    expect(Value.Check(EndpointRefSchema, { adapter: "a", endpointId: "e", instanceId: "i".repeat(257) })).toBe(false);
  });

  it("validates messages, attempts, and leases with additive id prefixes", () => {
    expect(Value.Check(MessageSchema, { ...message, messageId: `ho_${uid}` })).toBe(false);
    expect(Value.Check(MessageSchema, { ...message, payloadDigest: "zz" })).toBe(false);
    expect(Value.Check(MessageSchema, { ...message, payloadLength: -1 })).toBe(false);
    expect(Value.Check(DeliveryAttemptSchema, attempt)).toBe(true);
    expect(Value.Check(DeliveryAttemptSchema, { ...attempt, dispatch: "maybe" })).toBe(false);
    expect(Value.Check(DeliveryAttemptSchema, { ...attempt, transport: "socket_delivered" })).toBe(false);
    expect(Value.Check(LeaseSchema, lease)).toBe(true);
    expect(Value.Check(LeaseSchema, { ...lease, fencingToken: 0 })).toBe(false);
    expect(Value.Check(LeaseSchema, { ...lease, consumerId: "" })).toBe(false);
  });

  it("separates transport from runtime outcome layers in results", () => {
    expect(Value.Check(ResultSchema, result)).toBe(true);
    expect(Value.Check(ResultSchema, { ...result, transport: "settled" })).toBe(false);
    expect(Value.Check(ResultSchema, { ...result, runtime: "delivered" })).toBe(false);
    expect(Value.Check(ResultSchema, { ...result, runtime: "runtime_error" })).toBe(true);
    expect(Value.Check(ResultSchema, { ...result, resultDigest: "short" })).toBe(false);
    expect(Value.Check(ResultSchema, { ...result, resultId: `ho_${uid}` })).toBe(false);
    // Legacy result identity prefix is preserved:
    expect(result.resultId).toMatch(/^hr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("keeps application evidence opaque to the protocol", () => {
    expect(Value.Check(ResultSchema, { ...result, applicationEvidence: { alternative: "schema" } })).toBe(true);
    const { applicationEvidence: _omit, ...withoutEvidence } = result;
    expect(Value.Check(ResultSchema, withoutEvidence)).toBe(true);
  });

  it("validates receipts, consumers, and bounded diagnostic events", () => {
    expect(Value.Check(ReceiptSchema, {
      receiptId: `rcpt_${uid}`,
      exchangeId: exchange.exchangeId,
      messageId: message.messageId,
      endpoint: from,
      kind: "read",
      createdAt: now,
    })).toBe(true);
    expect(Value.Check(ReceiptSchema, {
      receiptId: `rcpt_${uid}`,
      exchangeId: exchange.exchangeId,
      messageId: message.messageId,
      endpoint: from,
      kind: "definitely_consumed",
      createdAt: now,
    })).toBe(false);
    expect(Value.Check(ConsumerSchema, { consumerId: "consumer-1", createdAt: now })).toBe(true);
    expect(Value.Check(ConsumerSchema, { consumerId: "consumer-1" })).toBe(false);
    expect(Value.Check(EventSchema, {
      eventId: `evt_${uid}`,
      exchangeId: exchange.exchangeId,
      sequence: 1,
      kind: "message_created",
      subjectId: message.messageId,
      createdAt: now,
      digest: message.payloadDigest,
      length: message.payloadLength,
    })).toBe(true);
    // Raw bodies are never event payloads; diagnostics stay digests/lengths/outcomes.
    expect(Value.Check(EventSchema, {
      eventId: `evt_${uid}`,
      exchangeId: exchange.exchangeId,
      sequence: 1,
      kind: "message_created",
      subjectId: message.messageId,
      createdAt: now,
      payload: "do not log raw bodies",
    })).toBe(false);
    expect(Value.Check(EventSchema, {
      eventId: `evt_${uid}`,
      exchangeId: exchange.exchangeId,
      sequence: 0,
      kind: "message_created",
      subjectId: message.messageId,
      createdAt: now,
    })).toBe(false);
    expect(Value.Check(EventSchema, {
      eventId: `evt_${uid}`,
      exchangeId: exchange.exchangeId,
      sequence: 1,
      kind: "not_a_kind",
      subjectId: message.messageId,
      createdAt: now,
    })).toBe(false);
    expect(EVENT_KINDS).toContain("result_published");
  });

  it("digests stay sha256 hex everywhere", () => {
    expect(message.payloadDigest).toMatch(SHA256_HEX_PATTERN);
    expect(SHA256_HEX_PATTERN.test("A".repeat(64))).toBe(false);
  });
});
