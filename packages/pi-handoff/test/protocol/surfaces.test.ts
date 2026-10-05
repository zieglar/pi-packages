import { describe, expect, it } from "vitest";
import {
  CHATGPT_TOOLS,
  CONSUMER_OPERATIONS,
  FORBIDDEN_CHATGPT_MUTATIONS,
  assertSurfaceDisjointness,
  isChatgptTool,
  isConsumerOperation,
} from "../../src/protocol/surfaces.js";

describe("surface ownership boundaries (frozen v1)", () => {
  it("ChatGPT surface exposes exactly the five agreed read/mutate-lifecycle tools", () => {
    expect([...CHATGPT_TOOLS]).toEqual([
      "handoff_create",
      "handoff_get",
      "handoff_list",
      "handoff_cancel",
      "handoff_result",
    ]);
  });

  it("ChatGPT surface cannot invoke Pi-side authoritative result mutations", () => {
    assertSurfaceDisjointness();
    for (const forbidden of FORBIDDEN_CHATGPT_MUTATIONS) {
      expect(CHATGPT_TOOLS).not.toContain(forbidden);
      expect(isChatgptTool(forbidden)).toBe(false);
    }
    for (const op of CONSUMER_OPERATIONS) {
      expect(CHATGPT_TOOLS).not.toContain(op);
      expect(isChatgptTool(op)).toBe(false);
    }
  });

  it("consumer operations exist only on the internal surface", () => {
    for (const op of CONSUMER_OPERATIONS) {
      expect(isConsumerOperation(op)).toBe(true);
    }
    expect(CONSUMER_OPERATIONS).toHaveLength(7);
  });
});
