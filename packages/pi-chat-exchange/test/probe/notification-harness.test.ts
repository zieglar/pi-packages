import { describe, expect, it } from "vitest";

import { createProbeRun, evaluateProbeRun, parseProbeObservation, parseProbeRun, recordProbeObservation } from "../../src/probe/notification-harness.js";

describe("notification probe harness", () => {
  it("defaults to a non-sending dry run with a unique nonce", () => {
    const first = createProbeRun({});
    const second = createProbeRun({});
    expect(first.mode).toBe("dry-run");
    expect(first.sendAuthorized).toBe(false);
    expect(first.nonce).not.toBe(second.nonce);
    expect(evaluateProbeRun(first)).toBe("UNVERIFIED");
  });

  it("rejects an unknown mode at the CLI boundary", () => {
    expect(() => createProbeRun({ mode: "repeat" as never })).toThrow(/mode/i);
  });

  it("requires an explicit endpoint and authorization for a real direction", () => {
    expect(() => createProbeRun({ mode: "pi-to-chatgpt" })).toThrow(/endpoint/i);
    expect(() => createProbeRun({ mode: "pi-to-chatgpt", endpoint: "chatgpt/test" })).toThrow(/authorize/i);
    expect(createProbeRun({ mode: "pi-to-chatgpt", endpoint: "chatgpt/test", sendAuthorized: true })).toMatchObject({
      mode: "pi-to-chatgpt", endpoint: "chatgpt/test", sendAuthorized: true,
    });
  });

  it("keeps transport, MCP, client observation and wake as separate verdicts", () => {
    const base = createProbeRun({ mode: "pi-to-chatgpt", endpoint: "chatgpt/test", sendAuthorized: true });
    const transported = recordProbeObservation(base, { direction: "pi-to-chatgpt", sentAt: "2026-11-16T00:00:00.000Z", messageId: "msg_1", delivery: "DELIVERED" });
    expect(evaluateProbeRun(transported)).toBe("TRANSPORT_PASS");
    const mcp = recordProbeObservation(transported, { direction: "pi-to-chatgpt", receivedAt: "2026-11-16T00:00:01.000Z", mcpObserved: true });
    expect(evaluateProbeRun(mcp)).toBe("MCP_PASS");
    expect(evaluateProbeRun(recordProbeObservation(mcp, { direction: "pi-to-chatgpt", clientObserved: true }))).toBe("CLIENT_OBSERVED");
    expect(evaluateProbeRun(recordProbeObservation(mcp, { direction: "pi-to-chatgpt", wakeConfirmed: true }))).toBe("WAKE_CONFIRMED");
  });

  it("never upgrades an unknown delivery or an unobserved client", () => {
    const run = createProbeRun({ mode: "chatgpt-to-pi", endpoint: "pi/test", sendAuthorized: true });
    const unknown = recordProbeObservation(run, { direction: "chatgpt-to-pi", delivery: "DELIVERY_UNKNOWN" });
    expect(evaluateProbeRun(unknown)).toBe("UNVERIFIED");
    expect(unknown.retryAuthorized).toBe(false);
    expect(evaluateProbeRun(recordProbeObservation(run, { direction: "chatgpt-to-pi", mcpObserved: true }))).toBe("UNVERIFIED");
  });

  it("requires both directions before a both-mode verdict can pass", () => {
    const run = createProbeRun({ mode: "both", endpoint: "test/pair", sendAuthorized: true });
    const one = recordProbeObservation(run, { direction: "pi-to-chatgpt", messageId: "msg_1", delivery: "DELIVERED" });
    expect(evaluateProbeRun(one)).toBe("UNVERIFIED");
    const both = recordProbeObservation(one, { direction: "chatgpt-to-pi", messageId: "msg_2", delivery: "DELIVERED" });
    expect(evaluateProbeRun(both)).toBe("TRANSPORT_PASS");
  });

  it("validates evidence loaded at the CLI boundary", () => {
    const run = createProbeRun({});
    expect(parseProbeRun(JSON.parse(JSON.stringify(run)))).toEqual(run);
    expect(() => parseProbeRun({ ...run, retryAuthorized: true })).toThrow(/evidence/i);
    expect(parseProbeObservation({ direction: "pi-to-chatgpt", delivery: "DELIVERED", messageId: "msg_1" })).toEqual({
      direction: "pi-to-chatgpt", delivery: "DELIVERED", messageId: "msg_1",
    });
    expect(() => parseProbeObservation({ direction: "pi-to-chatgpt", wakeConfirmed: "yes" })).toThrow(/observation/i);
  });
});
