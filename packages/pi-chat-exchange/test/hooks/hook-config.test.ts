import { describe, expect, it } from "vitest";
import { CE_MESSAGE_COMMITTED_EVENT, type CeCommittedMessageEvent } from "../../src/hooks/events.js";
import { matchesHookRule, parseHookRules, parseStoredHookRules } from "../../src/hooks/config.js";

const base = {
  id: "pi-notify",
  event: CE_MESSAGE_COMMITTED_EVENT,
  recipient: { adapter: "pi", endpointId: "pi/main" },
  command: "/opt/node/bin/node",
  args: ["/opt/hooks/notify.mjs", "--fixed"],
  timeoutMs: 5000,
  scope: "session",
};

function event(recipient = { adapter: "pi", endpointId: "pi/main" }): CeCommittedMessageEvent {
  return {
    schemaVersion: 1,
    event: CE_MESSAGE_COMMITTED_EVENT,
    eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FA0",
    eventKey: "ho_01ARZ3NDEKTSV4RRFFQ69G5FA0/1",
    messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FA1",
    exchangeId: "ho_01ARZ3NDEKTSV4RRFFQ69G5FA0",
    sender: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipient,
    createdAt: "2026-10-10T00:00:00.000Z",
    payloadDigest: "a".repeat(64),
    payloadLength: 1,
  };
}

describe("local Hook configuration", () => {
  it("parses static rules with bounded defaults and exact Endpoint identity", () => {
    const [rule] = parseHookRules([{ ...base, args: undefined, timeoutMs: undefined }]);
    expect(rule).toMatchObject({ ...base, args: [], timeoutMs: 30_000, enabled: true });
    const disabled = parseHookRules([{ ...base, enabled: false }])[0]!;
    expect(disabled.enabled).toBe(false);
    expect(matchesHookRule(rule!, event())).toBe(true);
    expect(matchesHookRule(rule!, event({ adapter: "chatgpt", endpointId: "pi/main" }))).toBe(false);
    expect(matchesHookRule(rule!, event({ adapter: "pi", endpointId: "pi/other" }))).toBe(false);
    expect(matchesHookRule(disabled, event())).toBe(false);
    expect(matchesHookRule(rule!, { ...event(), event: "other" } as unknown as CeCommittedMessageEvent)).toBe(false);
  });

  it("keeps an explicitly empty configuration disabled", () => {
    expect(parseHookRules(undefined)).toEqual([]);
    expect(parseHookRules([])).toEqual([]);
  });

  it("parses an optional bounded status probe", () => {
    const status = { label: "Desktop", command: "/opt/hooks/status", args: ["--json"], timeoutMs: 2000 };
    const rule = parseHookRules([{ ...base, status }])[0]!;
    expect(rule.status).toEqual(status);
    expect(Object.isFrozen(rule.status)).toBe(true);
    expect(Object.isFrozen(rule.status?.args)).toBe(true);
    expect(parseHookRules([base])[0]).not.toHaveProperty("status");
  });

  it("accepts workspace scope only for Pi-to-ChatGPT rules", () => {
    expect(parseHookRules([{ ...base, scope: "workspace", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } }])[0]?.scope).toBe("workspace");
    expect(() => parseHookRules([{ ...base, scope: "workspace" }])).toThrowError(expect.objectContaining({ field: "hooks[0].scope" }));
  });

  it("keeps legacy storage readable without granting legacy rules runtime scope", () => {
    const legacy = { ...base } as Record<string, unknown>; delete legacy.scope;
    expect(() => parseHookRules([legacy])).toThrowError(expect.objectContaining({ field: "hooks[0].scope" }));
    const stored = parseStoredHookRules([legacy]);
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty("scope");
  });

  it.each([
    ["non-array", {}],
    ["missing scope", [{ ...base, scope: undefined }]],
    ["unknown scope", [{ ...base, scope: "global" }]],
    ["unknown rule field", [{ ...base, shell: true }]],
    ["unknown event", [{ ...base, event: "ce.other" }]],
    ["duplicate id", [base, base]],
    ["bad id", [{ ...base, id: "../remote" }]],
    ["relative command", [{ ...base, command: "node" }]],
    ["non-normalized command", [{ ...base, command: "/opt/node/../node" }]],
    ["NUL command", [{ ...base, command: "/opt/node\u0000bad" }]],
    ["non-array args", [{ ...base, args: "--shell" }]],
    ["non-string arg", [{ ...base, args: [1] }]],
    ["NUL arg", [{ ...base, args: ["bad\u0000arg"] }]],
    ["short timeout", [{ ...base, timeoutMs: 999 }]],
    ["long timeout", [{ ...base, timeoutMs: 60_001 }]],
    ["fraction timeout", [{ ...base, timeoutMs: 1.5 }]],
    ["missing adapter", [{ ...base, recipient: { endpointId: "pi/main" } }]],
    ["remote-shaped recipient", [{ ...base, recipient: "pi/main" }]],
    ["non-boolean enabled", [{ ...base, enabled: "true" }]],
    ["disabled but malformed", [{ ...base, enabled: false, command: "node" }]],
    ["unknown status field", [{ ...base, status: { label: "Desktop", command: "/usr/bin/true", extra: true } }]],
    ["empty status label", [{ ...base, status: { label: "", command: "/usr/bin/true" } }]],
    ["control status label", [{ ...base, status: { label: "Desk\nTop", command: "/usr/bin/true" } }]],
    ["relative status command", [{ ...base, status: { label: "Desktop", command: "status" } }]],
    ["root status command", [{ ...base, status: { label: "Desktop", command: "/" } }]],
    ["non-array status args", [{ ...base, status: { label: "Desktop", command: "/usr/bin/true", args: "--json" } }]],
    ["non-string status arg", [{ ...base, status: { label: "Desktop", command: "/usr/bin/true", args: [1] } }]],
    ["short status timeout", [{ ...base, status: { label: "Desktop", command: "/usr/bin/true", timeoutMs: 99 } }]],
    ["long status timeout", [{ ...base, status: { label: "Desktop", command: "/usr/bin/true", timeoutMs: 10_001 } }]],
  ])("refuses %s", (_label, raw) => {
    expect(() => parseHookRules(raw)).toThrowError(expect.objectContaining({ code: "CE_HOOK_CONFIG_INVALID" }));
  });
});
