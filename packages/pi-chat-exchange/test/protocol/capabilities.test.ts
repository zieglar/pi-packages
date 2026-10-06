import { describe, expect, it } from "vitest";
import {
  AGENT_OPERATIONS,
  CLIENT_OPERATIONS,
  OPTIONAL_CLIENT_CAPABILITIES,
  assertPortDisjointness,
  isAgentOperation,
  isClientOperation,
} from "../../src/protocol/capabilities.js";

describe("capability ports (protocol v2)", () => {
  it("defines the generic future client surface without product names", () => {
    expect([...CLIENT_OPERATIONS]).toEqual([
      "exchange_send",
      "exchange_get",
      "exchange_list",
      "exchange_cancel",
      "exchange_result",
    ]);
  });

  it("defines disjoint agent-side execution operations", () => {
    expect([...AGENT_OPERATIONS]).toEqual([
      "message_claim",
      "dispatch_mark_started",
      "delivery_report",
      "activity_report",
      "settlement_report",
      "result_publish",
      "lease_release",
      "ambiguity_resolve",
      "cancel_confirm",
    ]);
    expect(
      CLIENT_OPERATIONS.filter((name) => (AGENT_OPERATIONS as readonly string[]).includes(name)),
    ).toEqual([]);
  });

  it("keeps normal close and unresolved archive as distinct optional capabilities", () => {
    expect([...OPTIONAL_CLIENT_CAPABILITIES]).toEqual(["exchange_close", "exchange_archive"]);
    expect(CLIENT_OPERATIONS).not.toContain("exchange_close");
    expect(CLIENT_OPERATIONS).not.toContain("exchange_archive");
    expect(AGENT_OPERATIONS).not.toContain("exchange_archive");
  });

  it("recognizes only declared operations", () => {
    for (const operation of CLIENT_OPERATIONS) expect(isClientOperation(operation)).toBe(true);
    for (const operation of AGENT_OPERATIONS) expect(isAgentOperation(operation)).toBe(true);
    expect(isClientOperation("message_claim")).toBe(false);
    expect(isAgentOperation("exchange_send")).toBe(false);
    expect(isClientOperation("handoff_create")).toBe(false);
  });

  it("upholds port disjointness as a frozen invariant", () => {
    expect(() => assertPortDisjointness()).not.toThrow();
  });
});
