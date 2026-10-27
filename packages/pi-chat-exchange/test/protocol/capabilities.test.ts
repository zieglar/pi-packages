import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { CONTROL_OPERATIONS, ENDPOINT_OPERATIONS, OPTIONAL_CONTROL_CAPABILITIES, assertOperationSeparation, isControlOperation, isEndpointOperation, AuthorizationContextSchema } from "../../src/protocol/capabilities.js";
import { fixtureAuthorization } from "../fixtures/authorization.js";

describe("action catalogs and trusted-host contexts", () => {
  it("preserves the generic future control surface", () => {
    expect([...CONTROL_OPERATIONS]).toEqual(["exchange_send", "exchange_get", "exchange_list", "exchange_cancel", "exchange_result"]);
  });
  it("defines separate endpoint evidence/dispatch actions", () => {
    expect([...ENDPOINT_OPERATIONS]).toEqual(["message_claim", "dispatch_mark_started", "delivery_report", "activity_report", "settlement_report", "result_publish", "lease_release", "ambiguity_resolve", "cancel_confirm"]);
    expect(CONTROL_OPERATIONS.filter((name) => (ENDPOINT_OPERATIONS as readonly string[]).includes(name))).toEqual([]);
  });
  it("keeps normal close and unresolved archive as distinct optional capabilities", () => {
    expect([...OPTIONAL_CONTROL_CAPABILITIES]).toEqual(["exchange_close", "exchange_archive"]);
    expect(CONTROL_OPERATIONS).not.toContain("exchange_close");
    expect(CONTROL_OPERATIONS).not.toContain("exchange_archive");
    expect(ENDPOINT_OPERATIONS).not.toContain("exchange_archive");
  });
  it("recognizes only declared operations", () => {
    for (const operation of CONTROL_OPERATIONS) expect(isControlOperation(operation)).toBe(true);
    for (const operation of ENDPOINT_OPERATIONS) expect(isEndpointOperation(operation)).toBe(true);
    expect(isControlOperation("message_claim")).toBe(false);
    expect(isEndpointOperation("exchange_send")).toBe(false);
    expect(isControlOperation("handoff_create")).toBe(false);
  });
  it("keeps operation catalogs separate without imposing endpoint roles", () => {
    expect(() => assertOperationSeparation()).not.toThrow();
  });
  it("validates action-specific scope rather than broad client/agent labels", () => {
    const uid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const context = fixtureAuthorization(`ho_${uid}`, `msg_${uid}`, `att_${uid}`, { adapter: "generic", endpointId: "target" });
    expect(Value.Check(AuthorizationContextSchema, context)).toBe(true);
    expect(Value.Check(AuthorizationContextSchema, { authority: "agent" })).toBe(false);
    expect(Value.Check(AuthorizationContextSchema, { ...context, grants: [{ action: "settlement_report", principalId: "owner", scope: { kind: "exchange", exchangeId: `ho_${uid}` } }] })).toBe(false);
  });
});
