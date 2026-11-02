import { describe, expect, it } from "vitest";
import { CE_MESSAGE_COMMITTED_EVENT, type CeCommittedMessageEvent } from "../../src/hooks/events.js";
import { matchesHookRule, parseHookRules } from "../../src/hooks/config.js";

const base = {
  id: "pi-notify",
  event: CE_MESSAGE_COMMITTED_EVENT,
  recipient: { adapter: "pi", endpointId: "pi/main" },
  command: "/opt/node/bin/node",
  args: ["/opt/hooks/notify.mjs", "--fixed"],
  timeoutMs: 5000,
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

  it.each([
    ["non-array", {}],
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
  ])("refuses %s", (_label, raw) => {
    expect(() => parseHookRules(raw)).toThrowError(expect.objectContaining({ code: "CE_HOOK_CONFIG_INVALID" }));
  });
});
