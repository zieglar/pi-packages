/**
 * HANDOFF-CE-E2B-01 — the bound endpoint treats ACK as a WRITE (clause 3).
 *
 * `acknowledge` must run through the same admission gating as `send`: the
 * Endpoint is fixed at construction, a permanently stopped heartbeat blocks it,
 * and a closing/closed endpoint refuses it. Reads (`listInbox`,
 * `readPayload`) stay unaffected, which is what proves ACK is gated as a write
 * rather than as a read.
 */
import { describe, expect, it } from "vitest";
import { CeHostRefusal, type CeEndpointHost } from "../../src/host/endpoint-host.js";
import { CeBoundEndpoint, type TimerSeams } from "../../src/host/bound-endpoint.js";

const ACK_INPUT = {
  messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  payloadDigest: "b".repeat(64),
  payloadLength: 6,
  messageCreatedAuditSequence: 4,
} as const;

const RECEIPT = {
  disposition: "CREATED",
  receipt: {
    receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    messageId: ACK_INPUT.messageId,
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    kind: "delivery_ack",
    createdAt: "2026-10-10T00:00:00.000Z",
  },
  receiptAuditSequence: 9,
} as const;

function refusal(code: string, retryable = false, reason?: string): CeHostRefusal {
  return new CeHostRefusal(code as never, retryable, reason);
}

function expectThrows(run: () => unknown, shape: Record<string, unknown>): void {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject(shape);
    return;
  }
  throw new Error("expected a refusal");
}

class ManualTimers implements TimerSeams {
  readonly intervals: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];

  setInterval = (callback: () => void, ms: number) => {
    const entry = { callback, ms, cleared: false };
    this.intervals.push(entry);
    return entry;
  };

  clearInterval = (handle: unknown) => {
    (handle as { cleared: boolean }).cleared = true;
  };

  tick(): void {
    for (const entry of [...this.intervals]) if (!entry.cleared) entry.callback();
  }
}

type Script = Partial<Record<"renew" | "acknowledge", (...args: never[]) => unknown>>;

function start(script: Script = {}) {
  const calls: Record<string, unknown[][]> = {};
  const host = {
    beginSession: (...args: unknown[]) => {
      (calls.beginSession ??= []).push(args);
      return { endpointId: args[0], participantId: "p", sessionId: "s", exchangeId: "e" };
    },
    renew: (...args: unknown[]) => {
      (calls.renew ??= []).push(args);
      const fn = script.renew;
      return fn ? fn(...(args as never[])) : { fencingToken: 1, expiresAt: "later" };
    },
    end: (...args: unknown[]) => {
      (calls.end ??= []).push(args);
      return { released: true, detached: true };
    },
    send: (...args: unknown[]) => {
      (calls.send ??= []).push(args);
      return { disposition: "CREATED", messageId: "m1", auditSequence: 1, recipient: "r" };
    },
    listInbox: (...args: unknown[]) => {
      (calls.listInbox ??= []).push(args);
      return { messages: [], continuationAuditSequence: null, scanBudgetExhausted: false };
    },
    readPayload: (...args: unknown[]) => {
      (calls.readPayload ??= []).push(args);
      return { messageId: "m1", payloadText: "hello" };
    },
    acknowledge: (...args: unknown[]) => {
      (calls.acknowledge ??= []).push(args);
      const fn = script.acknowledge;
      return fn ? fn(...(args as never[])) : RECEIPT;
    },
  };
  const timers = new ManualTimers();
  const bound = CeBoundEndpoint.start(host as unknown as CeEndpointHost, "chatgpt/main", {
    renewIntervalMs: 30_000,
    timers,
  });
  return { bound, calls, timers };
}

describe("bound endpoint ACK: delegation", () => {
  it("acknowledges through the fixed endpoint with exactly the four copied fields", () => {
    const { bound, calls } = start();
    const result = bound.acknowledge(ACK_INPUT);
    expect(calls.acknowledge).toEqual([["chatgpt/main", { ...ACK_INPUT }]]);
    expect(result).toEqual(RECEIPT);
  });

  it("carries no endpoint, session, or capability parameter of its own", () => {
    const { bound, calls } = start();
    bound.acknowledge(ACK_INPUT);
    const [, request] = calls.acknowledge![0]!;
    expect(Object.keys(request as object).sort()).toEqual([
      "messageCreatedAuditSequence",
      "messageId",
      "payloadDigest",
      "payloadLength",
    ]);
  });

  it("propagates a host refusal unchanged", () => {
    const { bound } = start({ acknowledge: () => { throw refusal("CE_HOST_ACK_DISABLED"); } });
    expectThrows(() => bound.acknowledge(ACK_INPUT), { code: "CE_HOST_ACK_DISABLED" });
  });
});

describe("bound endpoint ACK: write admission", () => {
  it("is blocked exactly like send after the heartbeat stops permanently", () => {
    const { bound, calls, timers } = start({
      renew: () => { throw refusal("CE_HOST_AUTHORITY_ABSENT", false, "OWNERSHIP_NOT_CURRENT"); },
    });
    timers.tick();
    expect(bound.state).toBe("WRITE_BLOCKED");

    expectThrows(() => bound.send({ to: "pi/main", text: "x", idempotencyKey: "k" }), {
      code: "CE_HOST_AUTHORITY_ABSENT",
      reason: "LEASE_RENEWAL_STOPPED",
    });
    expectThrows(() => bound.acknowledge(ACK_INPUT), {
      code: "CE_HOST_AUTHORITY_ABSENT",
      reason: "LEASE_RENEWAL_STOPPED",
    });
    // The host was never reached for the blocked ACK.
    expect(calls.acknowledge).toBeUndefined();
    // Reads stay admitted, which is what makes ACK a write and not a read.
    expect(() => bound.listInbox({})).not.toThrow();
    expect(() => bound.readPayload({ messageId: "m1" })).not.toThrow();
  });

  it("reports an uncertain renewal as uncertain for ACK too, never retried", () => {
    const { bound, timers } = start({ renew: () => { throw refusal("CE_HOST_UNCERTAIN"); } });
    timers.tick();
    expectThrows(() => bound.acknowledge(ACK_INPUT), {
      code: "CE_HOST_UNCERTAIN",
      reason: "LEASE_RENEWAL_STOPPED",
      retryable: false,
    });
  });

  it("refuses ACK once the endpoint is closing or closed", async () => {
    const { bound, calls } = start();
    await bound.shutdown();
    expectThrows(() => bound.acknowledge(ACK_INPUT), {
      code: "CE_HOST_UNAVAILABLE",
      reason: "ENDPOINT_CLOSING",
    });
    expect(calls.acknowledge).toBeUndefined();
  });
});
