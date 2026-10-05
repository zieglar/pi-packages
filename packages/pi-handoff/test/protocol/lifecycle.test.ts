import { describe, expect, it } from "vitest";
import {
  HANDOFF_STATES,
  type HandoffState,
  IllegalTransitionError,
  LEGAL_TRANSITIONS,
  assertTransition,
  canTransition,
  isQuarantined,
  isTerminal,
} from "../../src/protocol/lifecycle.js";

const HAPPY_PATH: readonly HandoffState[] = [
  "CREATED",
  "QUEUED",
  "CLAIMED",
  "DELIVERED",
  "ACKNOWLEDGED",
  "RUNNING",
  "SETTLED",
  "RESULT_AVAILABLE",
  "CONSUMED",
];

describe("handoff lifecycle (frozen v1)", () => {
  it("allows the full happy path", () => {
    for (let i = 0; i < HAPPY_PATH.length - 1; i += 1) {
      const from = HAPPY_PATH[i]!;
      const to = HAPPY_PATH[i + 1]!;
      expect(canTransition(from, to)).toBe(true);
      expect(assertTransition(from, to)).toBe(to);
    }
  });

  it("rejects illegal direct jumps", () => {
    const illegal: ReadonlyArray<readonly [HandoffState, HandoffState]> = [
      ["QUEUED", "RUNNING"],
      ["QUEUED", "SETTLED"],
      ["CREATED", "CONSUMED"],
      ["CREATED", "CLAIMED"],
      ["CLAIMED", "RUNNING"],
      ["DELIVERED", "QUEUED"],
      ["DELIVERED", "RUNNING"],
      ["ACKNOWLEDGED", "RESULT_AVAILABLE"],
      ["SETTLED", "CONSUMED"],
      ["RESULT_AVAILABLE", "QUEUED"],
      ["RUNNING", "RESULT_AVAILABLE"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrowError(IllegalTransitionError);
      try {
        assertTransition(from, to);
        expect.unreachable("expected an IllegalTransitionError");
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalTransitionError);
        expect((error as IllegalTransitionError).code).toBe("ILLEGAL_TRANSITION");
      }
    }
  });

  it("terminal states have no exits", () => {
    for (const state of HANDOFF_STATES) {
      if (isTerminal(state)) {
        expect(LEGAL_TRANSITIONS[state]).toEqual([]);
        for (const to of HANDOFF_STATES) {
          expect(canTransition(state, to)).toBe(false);
        }
      }
    }
  });

  it("fail-closed: DELIVERY_UNKNOWN can never return to retryable states", () => {
    const retryable: readonly HandoffState[] = ["QUEUED", "CLAIMED", "DELIVERED"];
    for (const to of retryable) {
      expect(canTransition("DELIVERY_UNKNOWN", to)).toBe(false);
    }
    // Explicit, evidence-backed resolution paths only:
    for (const to of ["ACKNOWLEDGED", "FAILED", "CANCELLED"] as const) {
      expect(canTransition("DELIVERY_UNKNOWN", to)).toBe(true);
    }
    expect(isQuarantined("DELIVERY_UNKNOWN")).toBe(true);
  });

  it("CLAIMED supports safe requeue only via the recorded no-delivery path", () => {
    expect(canTransition("CLAIMED", "QUEUED")).toBe(true);
    expect(canTransition("CLAIMED", "DELIVERED")).toBe(true);
    expect(canTransition("CLAIMED", "CANCELLED")).toBe(true);
    expect(canTransition("CLAIMED", "DELIVERY_UNKNOWN")).toBe(false);
  });

  it("CANCELLED is reachable from QUEUED, CLAIMED, and DELIVERY_UNKNOWN only", () => {
    for (const state of HANDOFF_STATES) {
      const expected = ["QUEUED", "CLAIMED", "DELIVERY_UNKNOWN"].includes(state);
      expect(canTransition(state, "CANCELLED")).toBe(expected);
    }
  });

  it("every declared state has an explicit legal-transition entry", () => {
    for (const state of HANDOFF_STATES) {
      expect(LEGAL_TRANSITIONS[state]).toBeDefined();
    }
  });
});
