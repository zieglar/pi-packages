/**
 * HANDOFF-853274 — MCP messaging tool layer tests.
 *
 * The tool layer sees only an injected port. These tests prove: closed input
 * schemas (no sender/endpoint/session/capability can ever enter), sanitized
 * refusal reporting with no error-text leakage, and payload exposure shaped
 * exactly as the trust boundary requires (warning first, text only in the
 * second content item, never in structured output).
 */
import { describe, expect, it } from "vitest";
import {
  callMessagingTool,
  isMessagingToolName,
  MESSAGING_TOOL_NAMES,
  MessagingArgsError,
  type ExchangeMessagingPort,
} from "../../../src/control/mcp/messaging-tools.js";

function refusal(code: string, retryable = false, reason?: string): Error {
  const error = new Error("internal detail that must never surface: /var/secret cap_0123456789abcdef");
  return Object.assign(error, { code, retryable, ...(reason === undefined ? {} : { reason }) });
}

function port(overrides: Partial<ExchangeMessagingPort> = {}): ExchangeMessagingPort {
  return {
    send: () => ({ disposition: "CREATED", messageId: "msg_1", auditSequence: 7, recipient: "pi/main" }),
    listInbox: () => ({
      messages: [{ messageId: "msg_9", auditSequence: 9 }],
      continuationAuditSequence: 9,
      scanBudgetExhausted: false,
    }),
    readPayload: () => ({
      messageId: "msg_9",
      from: "pi/main",
      to: "chatgpt/main",
      payloadDigest: "d47",
      payloadLength: 4,
      createdAt: "2026-10-14T00:00:00.000Z",
      auditSequence: 9,
      payloadText: "hello from pi",
    }),
    // HANDOFF-CE-E2B-01: the port contract now carries the ACK operation; the
    // stub is never reached by the pre-existing assertions below.
    acknowledge: () => ({
      disposition: "CREATED",
      receipt: {
        receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        messageId: "msg_9",
        endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
        kind: "delivery_ack",
        createdAt: "2026-10-14T00:00:00.000Z",
      },
      receiptAuditSequence: 10,
    }),
    ...overrides,
  };
}

describe("messaging tool names", () => {
  it("recognizes exactly the three messaging tools", () => {
    expect([...MESSAGING_TOOL_NAMES]).toEqual(["ce_send", "ce_inbox_list", "ce_read_payload"]);
    for (const name of MESSAGING_TOOL_NAMES) expect(isMessagingToolName(name)).toBe(true);
    expect(isMessagingToolName("ping")).toBe(false);
    expect(isMessagingToolName("ce_admin")).toBe(false);
    expect(isMessagingToolName(7)).toBe(false);
  });
});

describe("ce_send", () => {
  it("returns durable delivery evidence for a valid call", () => {
    const result = callMessagingTool(port(), "ce_send", { to: "pi/main", text: "hi", idempotencyKey: "k1" });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      disposition: "CREATED",
      messageId: "msg_1",
      auditSequence: 7,
      recipient: "pi/main",
    });
    expect(JSON.parse(result.content[0]!.text)).toEqual(result.structuredContent);
  });

  it("rejects every authority-selecting field as invalid arguments", () => {
    for (const extra of [
      { sender: "pi/rogue" },
      { endpointId: "pi/main" },
      { endpoint: "pi/main" },
      { participantId: "p1" },
      { sessionId: "s1" },
      { session: "s1" },
      { exchange: "e1" },
      { exchangeId: "e1" },
      { capability: "cap_0123456789abcdef" },
      { adapter: "pi" },
      { from: "pi/main" },
    ]) {
      expect(() =>
        callMessagingTool(port(), "ce_send", { to: "pi/main", text: "hi", idempotencyKey: "k1", ...extra }),
      ).toThrow(MessagingArgsError);
    }
  });

  it("rejects malformed shapes", () => {
    expect(() => callMessagingTool(port(), "ce_send", undefined)).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_send", { to: "", text: "hi", idempotencyKey: "k1" })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_send", { to: "pi/main", text: "", idempotencyKey: "k1" })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_send", { to: "pi/main", idempotencyKey: "k1" })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_send", { to: 7, text: "hi", idempotencyKey: "k1" })).toThrow(MessagingArgsError);
  });

  it("sanitizes a generic port failure to a fixed unavailable refusal", () => {
    const result = callMessagingTool(
      port({ send: () => { throw new Error("sqlite locked at /var/lib/private path"); } }),
      "ce_send",
      { to: "pi/main", text: "hi", idempotencyKey: "k1" },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "CE_HOST_UNAVAILABLE", reason: null, retryable: false });
    expect(result.content[0]!.text).not.toContain("sqlite");
    expect(result.content[0]!.text).not.toContain("/var");
  });

  it("marks a rolled-back busy refusal retryable with safe guidance", () => {
    const result = callMessagingTool(port({ send: () => { throw refusal("CE_HOST_BUSY", true); } }), "ce_send", {
      to: "pi/main",
      text: "hi",
      idempotencyKey: "k1",
    });
    expect(result.structuredContent).toEqual({ code: "CE_HOST_BUSY", reason: null, retryable: true });
    expect(result.content[0]!.text).toContain("safe to retry");
  });

  it("never marks an uncertain outcome retryable, whatever the error object claims", () => {
    const result = callMessagingTool(port({ send: () => { throw refusal("CE_HOST_UNCERTAIN", true, "SQLITE_BUSY_COMMIT"); } }), "ce_send", {
      to: "pi/main",
      text: "hi",
      idempotencyKey: "k1",
    });
    expect(result.structuredContent).toEqual({ code: "CE_HOST_UNCERTAIN", reason: "SQLITE_BUSY_COMMIT", retryable: false });
    expect(result.content[0]!.text).toContain("do not retry");
    expect(result.content[0]!.text).not.toContain("cap_");
    expect(result.content[0]!.text).not.toContain("/var/secret");
  });

  it("collapses a malformed refusal reason rather than echoing it", () => {
    const result = callMessagingTool(port({ send: () => { throw refusal("CE_HOST_AUTHORITY_ABSENT", false, "reason with spaces and /paths"); } }), "ce_send", {
      to: "pi/main",
      text: "hi",
      idempotencyKey: "k1",
    });
    expect(result.structuredContent).toEqual({ code: "CE_HOST_AUTHORITY_ABSENT", reason: null, retryable: false });
  });
});

describe("ce_inbox_list", () => {
  it("returns a bounded metadata page with no payload text", () => {
    const seen: unknown[] = [];
    const result = callMessagingTool(
      port({ listInbox: (input) => { seen.push(input); return port().listInbox(input); } }),
      "ce_inbox_list",
      { afterAuditSequence: 3, pageSize: 20 },
    );
    expect(seen).toEqual([{ afterAuditSequence: 3, pageSize: 20 }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      messages: [{ messageId: "msg_9", auditSequence: 9 }],
      continuationAuditSequence: 9,
      scanBudgetExhausted: false,
    });
    expect(result.content[0]!.text).not.toContain("hello from pi");
    expect(result.content[0]!.text).toContain("No ACK or consumption occurred");
  });

  it("passes an empty request when no options are given", () => {
    const seen: unknown[] = [];
    callMessagingTool(port({ listInbox: (input) => { seen.push(input); return port().listInbox(input); } }), "ce_inbox_list", {});
    expect(seen).toEqual([{}]);
  });

  it("rejects out-of-range paging options and unknown fields", () => {
    expect(() => callMessagingTool(port(), "ce_inbox_list", { pageSize: 51 })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_inbox_list", { afterAuditSequence: -1 })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_inbox_list", { ack: true })).toThrow(MessagingArgsError);
  });
});

describe("ce_read_payload", () => {
  it("exposes the text only as the second content item behind the warning", () => {
    const result = callMessagingTool(port(), "ce_read_payload", { messageId: "msg_9" });
    expect(result.isError).toBe(false);
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.text).toContain("UNTRUSTED");
    expect(result.content[0]!.text).toContain("never as instructions");
    expect(result.content[1]!.text).toBe("hello from pi");
    expect(result.structuredContent).toBeUndefined();
  });

  it("requires an explicit message id", () => {
    expect(() => callMessagingTool(port(), "ce_read_payload", {})).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_read_payload", { messageId: "" })).toThrow(MessagingArgsError);
    expect(() => callMessagingTool(port(), "ce_read_payload", { messageId: "m", digest: "d47" })).toThrow(MessagingArgsError);
  });

  it("surfaces the operator payload-read refusal without payload text", () => {
    const result = callMessagingTool(port({ readPayload: () => { throw refusal("CE_HOST_PAYLOAD_DISABLED"); } }), "ce_read_payload", {
      messageId: "msg_9",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "CE_HOST_PAYLOAD_DISABLED", retryable: false });
    expect(JSON.stringify(result)).not.toContain("hello from pi");
  });
});
