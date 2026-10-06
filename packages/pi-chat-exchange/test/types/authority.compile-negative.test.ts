import { describe, expect, it } from "vitest";
import { CONTROL_OPERATIONS, ENDPOINT_OPERATIONS, type ActionGrant, type AuthorizationContext, type ControlSurfaceDeclaration } from "../../src/protocol/capabilities.js";
import type { EndpointDeclaration } from "../../src/protocol/endpoint-capabilities.js";
import type { EndpointRef } from "../../src/protocol/entities.js";
import type { MessageState } from "../../src/protocol/lifecycle.js";
import type { RuntimeOutcome, TransportOutcome } from "../../src/protocol/outcomes.js";

// Development checks only: actual authentication belongs to the future host.
// @ts-expect-error implementing a control surface does not grant runtime actions
const controlWithRuntimeOps: ControlSurfaceDeclaration = { operations: ENDPOINT_OPERATIONS };
// @ts-expect-error role labels are not authorization contexts
const roleAuthority: AuthorizationContext = { authority: "agent" };
// @ts-expect-error result publication requires an attempt-scoped grant, not broad exchange scope
const broadPublication: ActionGrant = { action: "result_publish", principalId: "p", scope: { kind: "exchange", exchangeId: "x" } };
// @ts-expect-error owner close cannot use a delivery attempt grant
const runtimeClose: ActionGrant = { action: "exchange_close", principalId: "p", scope: { kind: "attempt", exchangeId: "x", messageId: "m", attemptId: "a", endpoint: { adapter: "generic", endpointId: "e" } } };
// @ts-expect-error endpoint declarations advertise support, not granted authority
const endpointAuthority: EndpointDeclaration = { kind: "generic", capabilities: { delivery: "unknown" }, authority: "agent" };
// @ts-expect-error support is tri-state, not a boolean or synthesized runtime outcome
const fabricatedObservation: EndpointDeclaration = { kind: "generic", capabilities: { delivery: "supported", observation: "settled" } };
// @ts-expect-error endpoint refs carry no product routing fields or credentials
const productEndpoint: EndpointRef = { adapter: "pi", endpointId: "session", piSessionId: "x" };
// @ts-expect-error the retired read-consumption state does not exist
const consumed: MessageState = "CONSUMED";
// @ts-expect-error transport outcomes are generic, not socket acknowledgements
const socketAck: TransportOutcome = "socket_delivered";
// @ts-expect-error runtime outcomes never borrow transport vocabulary
const transportAsRuntime: RuntimeOutcome = "delivered";
// @ts-expect-error runtime outcomes never borrow application vocabulary
const applicationAsRuntime: RuntimeOutcome = "succeeded";

describe("compile-negative capability/authority contracts", () => {
  it("keeps all annotated violations out of the compiled contract", () => {
    expect(CONTROL_OPERATIONS.length).toBeGreaterThan(0);
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThan(0);
    expect([controlWithRuntimeOps, roleAuthority, broadPublication, runtimeClose, endpointAuthority, fabricatedObservation, productEndpoint, consumed, socketAck, transportAsRuntime, applicationAsRuntime]).toHaveLength(11);
  });
});
