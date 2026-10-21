import { describe, expect, it } from "vitest";
import {
  FINISHED_MESSAGE_STATES,
  MESSAGE_STATES,
  MESSAGE_TRANSITIONS,
  QUARANTINED_MESSAGE_STATES,
  TRANSITION_REQUIREMENTS,
  type MessageState,
  canTransition,
  isFinishedMessageState,
  isLegalTransition,
  isQuarantinedMessageState,
  legalTargets,
} from "../../src/protocol/lifecycle.js";

describe("message lifecycle (protocol v2)", () => {
  it("declares the approved lifecycle without a read-consumption state", () => {
    expect([...MESSAGE_STATES]).toEqual([
      "CREATED",
      "QUEUED",
      "CLAIMED",
      "DISPATCHING",
      "DELIVERY_UNKNOWN",
      "ACCEPTED",
      "RUNNING",
      "SETTLED",
      "RESULT_AVAILABLE",
      "CANCEL_REQUESTED",
      "CANCELLED",
      "FAILED",
    ]);
    expect(MESSAGE_STATES).not.toContain("CONSUMED");
  });

  it("canTransition licenses only evidence-free moves", () => {
    const unconditional: ReadonlyArray<readonly [MessageState, MessageState]> = [
      ["CREATED", "QUEUED"],
      ["QUEUED", "CLAIMED"],
      ["QUEUED", "CANCELLED"],
      ["CLAIMED", "CANCEL_REQUESTED"],
      ["DISPATCHING", "CANCEL_REQUESTED"],
      ["ACCEPTED", "CANCEL_REQUESTED"],
      ["RUNNING", "CANCEL_REQUESTED"],
    ];
    for (const [from, to] of unconditional) {
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it("safe requeue and quarantine exits are never evidence-free", () => {
    expect(canTransition("CLAIMED", "QUEUED")).toBe(false);
    for (const to of ["ACCEPTED", "FAILED", "CANCELLED"] as const) {
      expect(canTransition("DELIVERY_UNKNOWN", to)).toBe(false);
    }
    for (const state of MESSAGE_STATES) {
      // Every evidence-free target is also a legal target; legality is the
      // superset (evidence-checked moves included).
      if (canTransition(state, "CANCELLED")) {
        expect(isLegalTransition(state, "CANCELLED")).toBe(true);
      }
    }
  });

  it("no path out of quarantine leads back to retryable states", () => {
    const retryable: readonly MessageState[] = ["QUEUED", "CLAIMED", "DISPATCHING"];
    for (const to of retryable) {
      expect(isLegalTransition("DELIVERY_UNKNOWN", to)).toBe(false);
    }
    for (const to of legalTargets("DELIVERY_UNKNOWN")) {
      expect(retryable).not.toContain(to);
    }
    expect(isQuarantinedMessageState("DELIVERY_UNKNOWN")).toBe(true);
    expect([...QUARANTINED_MESSAGE_STATES]).toEqual(["DELIVERY_UNKNOWN"]);
  });

  it("finished states are terminal and closeable", () => {
    expect([...FINISHED_MESSAGE_STATES]).toEqual(["RESULT_AVAILABLE", "CANCELLED", "FAILED"]);
    for (const state of FINISHED_MESSAGE_STATES) {
      expect(isFinishedMessageState(state)).toBe(true);
      expect(legalTargets(state)).toEqual([]);
    }
    // Reading a result is not a lifecycle event: RESULT_AVAILABLE is already
    // finished when the immutable result is published, never by a read.
    expect(isFinishedMessageState("SETTLED")).toBe(false);
  });

  it("every legal transition declares exactly one requirement row", () => {
    const states = new Set<string>(MESSAGE_STATES);
    for (const key of Object.keys(TRANSITION_REQUIREMENTS)) {
      const [from, to] = key.split(">");
      expect(states.has(from!)).toBe(true);
      expect(states.has(to!)).toBe(true);
      expect(MESSAGE_TRANSITIONS[from as MessageState] as readonly string[]).toContain(to!);
    }
    const rowCount = Object.keys(TRANSITION_REQUIREMENTS).length;
    let edgeCount = 0;
    for (const from of MESSAGE_STATES) edgeCount += legalTargets(from).length;
    expect(rowCount).toBe(edgeCount);
  });

  it("evidence-bearing rows always require an attempt-backed lease", () => {
    for (const [key, requirement] of Object.entries(TRANSITION_REQUIREMENTS)) {
      if (requirement.evidence !== "none") {
        expect(requirement.lease).not.toBe("none");
      }
      if (requirement.lease !== "none") {
        expect(requirement.evidence).not.toBe("none");
      }
      expect(requirement.actions.length).toBeGreaterThan(0);
      expect(["none", "recorded", "current"]).toContain(requirement.lease);
    }
  });

  it("separates request, dispatch, acceptance and settlement grants", () => {
    expect(TRANSITION_REQUIREMENTS["CLAIMED>DISPATCHING"]?.actions).toEqual(["dispatch_mark_started"]);
    expect(TRANSITION_REQUIREMENTS["DISPATCHING>ACCEPTED"]?.actions).toEqual(["delivery_report", "activity_report"]);
    expect(TRANSITION_REQUIREMENTS["RUNNING>SETTLED"]?.actions).toEqual(["settlement_report"]);
    expect(TRANSITION_REQUIREMENTS["DISPATCHING>CANCEL_REQUESTED"]?.actions).toEqual(["exchange_cancel"]);
    expect(TRANSITION_REQUIREMENTS["QUEUED>CANCELLED"]?.actions).toEqual(["exchange_cancel"]);
  });

  it("quarantine resolution requires reconciliation-grade authority", () => {
    expect(TRANSITION_REQUIREMENTS["DELIVERY_UNKNOWN>ACCEPTED"]?.actions).toEqual(["ambiguity_resolve", "activity_report"]);
    expect(TRANSITION_REQUIREMENTS["DELIVERY_UNKNOWN>FAILED"]?.actions).toEqual(["ambiguity_resolve"]);
    expect(isLegalTransition("DELIVERY_UNKNOWN", "CANCELLED")).toBe(false);
    expect(TRANSITION_REQUIREMENTS["DELIVERY_UNKNOWN>CANCELLED"]).toBeUndefined();
    for (const key of ["DELIVERY_UNKNOWN>ACCEPTED", "DELIVERY_UNKNOWN>FAILED"]) {
      expect(TRANSITION_REQUIREMENTS[key]?.evidence).toMatch(/^reconciled/);
      expect(TRANSITION_REQUIREMENTS[key]?.lease).toBe("recorded");
    }
  });
});
