/**
 * HANDOFF-CE-E2B-01 — the `ce_ack` tool layer (clause 4).
 *
 * The tool layer sees only the injected, endpoint-bound port. These tests pin:
 * the closed four-field input (no authority field, no model-computed digest
 * shape), the honest description, CREATED/REPLAYED evidence projection,
 * sanitized refusal mapping (including `CE_HOST_ACK_DISABLED` and the
 * never-retryable `CE_HOST_UNCERTAIN`), and that invalid arguments never reach
 * the port. The three pre-existing tools stay untouched.
 */
import { describe, expect, it } from "vitest";
import {
  callMessagingTool,
  CE_ACK_TOOL_NAME,
  CE_ACK_TOOL,
  isAckToolName,
  isMessagingToolName,
  MESSAGING_TOOL_NAMES,
  MESSAGING_TOOLS,
  MessagingArgsError,
  type ExchangeMessagingPort,
} from "../../../src/control/mcp/messaging-tools.js";

const ACK_ARGS = {
  messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  payloadDigest: "a".repeat(64),
  payloadLength: 13,
  messageCreatedAuditSequence: 9,
} as const;

const ACK_RESULT = {
  disposition: "CREATED",
  receipt: {
    receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    messageId: ACK_ARGS.messageId,
    endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
    kind: "delivery_ack",
    createdAt: "2026-10-16T00:00:00.000Z",
  },
  receiptAuditSequence: 11,
} as const;

function refusal(code: string, retryable = false, reason?: string): Error {
  const error = new Error("internal detail that must never surface: /var/secret cap_0123456789abcdef");
  return Object.assign(error, { code, retryable, ...(reason === undefined ? {} : { reason }) });
}

function port(overrides: Partial<ExchangeMessagingPort> = {}): ExchangeMessagingPort {
  return {
    send: () => ({ disposition: "CREATED", messageId: "msg_1", auditSequence: 7, recipient: "pi/main" }),
    listInbox: () => ({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false }),
    readPayload: () => ({
      messageId: ACK_ARGS.messageId,
      from: "pi/main",
      to: "chatgpt-desktop",
      payloadDigest: ACK_ARGS.payloadDigest,
      payloadLength: ACK_ARGS.payloadLength,
      createdAt: "2026-10-16T00:00:00.000Z",
      auditSequence: ACK_ARGS.messageCreatedAuditSequence,
      payloadText: "hello from pi",
    }),
    acknowledge: () => ACK_RESULT,
    ...overrides,
  };
}

describe("ce_ack tool identity", () => {
  it("is named ce_ack and stays out of the three base messaging tool names", () => {
    expect(CE_ACK_TOOL_NAME).toBe("ce_ack");
    expect(isAckToolName(CE_ACK_TOOL_NAME)).toBe(true);
    expect(isAckToolName("ce_send")).toBe(false);
    expect(isAckToolName(7)).toBe(false);
    // The pre-existing surface is unchanged.
    expect([...MESSAGING_TOOL_NAMES]).toEqual(["ce_send", "ce_inbox_list", "ce_read_payload"]);
    expect(isMessagingToolName("ce_ack")).toBe(false);
    expect(MESSAGING_TOOLS.map((tool) => tool.name)).toEqual(["ce_send", "ce_inbox_list", "ce_read_payload"]);
  });

  it("declares a closed schema and write-but-idempotent annotations", () => {
    expect(CE_ACK_TOOL.name).toBe("ce_ack");
    expect(CE_ACK_TOOL.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    const schema = CE_ACK_TOOL.inputSchema as { additionalProperties?: unknown; required?: string[]; properties?: object };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "messageCreatedAuditSequence",
      "messageId",
      "payloadDigest",
      "payloadLength",
    ]);
    expect([...(schema.required ?? [])].sort()).toEqual([
      "messageCreatedAuditSequence",
      "messageId",
      "payloadDigest",
      "payloadLength",
    ]);
  });

  it("describes ACK honestly: reception receipt, idempotent, not completion, copied metadata", () => {
    const description = CE_ACK_TOOL.description.toLowerCase();
    expect(description).toContain("recipient");
    expect(description).toContain("idempotent");
    expect(description).toContain("not");
    for (const claim of ["delivery", "read", "processing", "task completion"]) {
      expect(description).toContain(claim);
    }
    expect(description).toContain("authorized read");
    expect(description).toContain("ce_host_uncertain");
    // No exactly-once or guarantee language.
    expect(description).not.toContain("exactly-once");
    expect(description).not.toContain("guarantee");
  });
});

describe("ce_ack routing", () => {
  it("passes exactly the four copied fields to the port and returns the receipt evidence", () => {
    const seen: unknown[] = [];
    const result = callMessagingTool(
      port({ acknowledge: (input) => { seen.push(input); return ACK_RESULT; } }),
      CE_ACK_TOOL_NAME,
      { ...ACK_ARGS },
    );
    expect(seen).toEqual([{ ...ACK_ARGS }]);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      disposition: "CREATED",
      receipt: { ...ACK_RESULT.receipt },
      receiptAuditSequence: 11,
    });
    expect(result.content[0]!.text).toContain("rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV");
  });

  it("reports a duplicate ACK as REPLAYED with identical receipt identity", () => {
    const replayed = { ...ACK_RESULT, disposition: "REPLAYED" as const };
    const result = callMessagingTool(port({ acknowledge: () => replayed }), CE_ACK_TOOL_NAME, { ...ACK_ARGS });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      disposition: "REPLAYED",
      receipt: { receiptId: ACK_RESULT.receipt.receiptId },
      receiptAuditSequence: ACK_RESULT.receiptAuditSequence,
    });
  });

  it("states in the result text that ACK is reception only, not processing or completion", () => {
    const text = callMessagingTool(port(), CE_ACK_TOOL_NAME, { ...ACK_ARGS }).content[0]!.text.toLowerCase();
    expect(text).toContain("not");
    expect(text).toContain("completion");
    expect(text).not.toContain("exactly-once");
  });
});

describe("ce_ack closed input", () => {
  const rejected: [string, object][] = [
    ["unknown field", { extra: 1 }],
    ["capability", { capability: "cap_0123456789abcdef" }],
    ["sessionId", { sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["participantId", { participantId: "par_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["fencingToken", { fencingToken: 1 }],
    ["exchangeId", { exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
    ["endpointId", { endpointId: "pi/rogue" }],
    ["uppercase digest", { payloadDigest: "A".repeat(64) }],
    ["short digest", { payloadDigest: "a".repeat(63) }],
    ["long digest", { payloadDigest: "a".repeat(65) }],
    ["non-hex digest", { payloadDigest: "g".repeat(64) }],
    ["numeric digest", { payloadDigest: 12 }],
    ["negative length", { payloadLength: -1 }],
    ["fractional length", { payloadLength: 2.5 }],
    ["string length", { payloadLength: "13" }],
    ["zero sequence", { messageCreatedAuditSequence: 0 }],
    ["negative sequence", { messageCreatedAuditSequence: -1 }],
    ["fractional sequence", { messageCreatedAuditSequence: 1.5 }],
    ["empty messageId", { messageId: "" }],
    ["numeric messageId", { messageId: 5 }],
  ];

  for (const [label, mutation] of rejected) {
    it(`rejects ${label} as invalid arguments without calling the port`, () => {
      const calls: unknown[] = [];
      const guarded = port({ acknowledge: (input) => { calls.push(input); return ACK_RESULT; } });
      expect(() => callMessagingTool(guarded, CE_ACK_TOOL_NAME, { ...ACK_ARGS, ...mutation })).toThrow(MessagingArgsError);
      expect(calls).toEqual([]);
    });
  }

  it("requires every field and rejects malformed request shapes", () => {
    const calls: unknown[] = [];
    const guarded = port({ acknowledge: (input) => { calls.push(input); return ACK_RESULT; } });
    const { messageId, payloadDigest, payloadLength, messageCreatedAuditSequence } = ACK_ARGS;
    for (const args of [
      {},
      undefined,
      { payloadDigest, payloadLength, messageCreatedAuditSequence },
      { messageId, payloadLength, messageCreatedAuditSequence },
      { messageId, payloadDigest, messageCreatedAuditSequence },
      { messageId, payloadDigest, payloadLength },
    ]) {
      expect(() => callMessagingTool(guarded, CE_ACK_TOOL_NAME, args)).toThrow(MessagingArgsError);
    }
    expect(calls).toEqual([]);
  });
});

describe("ce_ack refusal sanitization", () => {
  it("surfaces the disabled-policy refusal as a sanitized isError result", () => {
    const result = callMessagingTool(
      port({ acknowledge: () => { throw refusal("CE_HOST_ACK_DISABLED"); } }),
      CE_ACK_TOOL_NAME,
      { ...ACK_ARGS },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "CE_HOST_ACK_DISABLED", reason: null, retryable: false });
    expect(JSON.stringify(result)).not.toContain("cap_");
    expect(JSON.stringify(result)).not.toContain("/var/secret");
  });

  it("never marks an uncertain ACK retryable and tells the caller not to retry", () => {
    const result = callMessagingTool(
      port({ acknowledge: () => { throw refusal("CE_HOST_UNCERTAIN", true, "SQLITE_BUSY_COMMIT"); } }),
      CE_ACK_TOOL_NAME,
      { ...ACK_ARGS },
    );
    expect(result.structuredContent).toEqual({
      code: "CE_HOST_UNCERTAIN",
      reason: "SQLITE_BUSY_COMMIT",
      retryable: false,
    });
    expect(result.content[0]!.text).toContain("do not retry");
  });

  it("collapses an unexpected internal failure to a fixed unavailable refusal", () => {
    const result = callMessagingTool(
      port({ acknowledge: () => { throw new Error("sqlite error: UNIQUE constraint failed at /var/lib/ce/store.sqlite"); } }),
      CE_ACK_TOOL_NAME,
      { ...ACK_ARGS },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "CE_HOST_UNAVAILABLE", reason: null, retryable: false });
    const serialized = JSON.stringify(result);
    for (const leak of ["sqlite", "UNIQUE", "/var/lib", "cap_", "SELECT"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it.each([true, false])("withholds retry permission for a rolled-back busy ACK (port retryable=%s)", (retryable) => {
    const result = callMessagingTool(
      port({ acknowledge: () => { throw refusal("CE_HOST_BUSY", retryable, "STORAGE_TRANSACTION_BUSY"); } }),
      CE_ACK_TOOL_NAME,
      { ...ACK_ARGS },
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: "CE_HOST_BUSY", reason: "STORAGE_TRANSACTION_BUSY", retryable: false });
    const text = result.content[0]!.text;
    expect(text).toContain("rolled back");
    expect(text).toContain("does not authorize retry");
    expect(text).toContain("explicit operator or upper-layer approval");
    expect(text).not.toMatch(/safe to retry|may be retried/);
    expect(JSON.stringify(result)).not.toContain("/var/secret");
    expect(JSON.stringify(result)).not.toContain("cap_");
  });
});

describe("existing tools are unchanged by the ACK addition", () => {
  it("still routes ce_send, ce_inbox_list, and ce_read_payload exactly as before", () => {
    expect(callMessagingTool(port(), "ce_send", { to: "pi/main", text: "hi", idempotencyKey: "k1" }).structuredContent)
      .toEqual({ disposition: "CREATED", messageId: "msg_1", auditSequence: 7, recipient: "pi/main" });
    const listed = callMessagingTool(port(), "ce_inbox_list", {});
    expect(listed.content[0]!.text).toContain("No ACK or consumption occurred");
    const read = callMessagingTool(port(), "ce_read_payload", { messageId: ACK_ARGS.messageId });
    expect(read.content).toHaveLength(2);
    expect(read.content[1]!.text).toBe("hello from pi");
    expect(read.structuredContent).toBeUndefined();
  });
});
