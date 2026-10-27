import { describe, expect, it } from "vitest";
import * as lifecycle from "../../src/protocol/lifecycle.js";
import { ResultSchema } from "../../src/protocol/entities.js";
import * as capabilities from "../../src/protocol/capabilities.js";

/**
 * PH-0002 architecture correction, restored as a permanent regression suite.
 * Originally run RED (4 failed) against the PH-0001 source on 2026-10-06
 * (/tmp/ph0002-red-restore.log); the assertions below are the same four, now
 * checked against the corrected contracts (modules renamed with the
 * correction: HANDOFF_STATES -> MESSAGE_STATES, HandoffResultSchema ->
 * ResultSchema, surfaces -> capabilities).
 */
describe("PH-0002 correction regression (was RED against PH-0001)", () => {
  it("does not make result reads semantic consumption", () => {
    expect(lifecycle.MESSAGE_STATES).not.toContain("CONSUMED");
  });
  it("uses opaque endpoint identity rather than a runtime-specific source", () => {
    expect(JSON.stringify(ResultSchema)).not.toContain("piSessionRef");
  });
  it("requires explicit delivery-start uncertainty handling", () => {
    // Safe requeue is never licensed by state shape alone: it requires
    // definitely-not-attempted evidence validated by the core rules.
    expect(lifecycle.canTransition("CLAIMED", "QUEUED")).toBe(false);
  });
  it("defines client capabilities without naming a client product", () => {
    expect(Object.keys(capabilities)).not.toContain("CHATGPT_TOOLS");
  });
});
