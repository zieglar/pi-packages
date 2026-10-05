import { describe, expect, it } from "vitest";
import {
  AGENT_OPERATIONS,
  CLIENT_OPERATIONS,
  type AgentPort,
  type ClientPort,
} from "../../src/protocol/capabilities.js";
import type { EndpointRef } from "../../src/protocol/entities.js";
import type { MessageState } from "../../src/protocol/lifecycle.js";
import type { RuntimeOutcome, TransportOutcome } from "../../src/protocol/outcomes.js";

/**
 * Compile-negative capability tests: every `@ts-expect-error` below marks a
 * shape that MUST NOT compile against the frozen contracts. `pnpm typecheck`
 * fails if any directive stops guarding a real error (unused directive) or if
 * an unguarded violation appears. These are development-time aids only —
 * compile-time checks are never an authorization mechanism; runtime authority
 * is enforced by the core rules.
 */

// @ts-expect-error agent authority is not assignable to the client port
const wrongAuthority: ClientPort = { authority: "agent", operations: CLIENT_OPERATIONS };

// @ts-expect-error client ports cannot carry agent operations
const clientWithAgentOps: ClientPort = { authority: "client", operations: AGENT_OPERATIONS };

// @ts-expect-error agent ports cannot carry client operations
const agentWithClientOps: AgentPort = { authority: "agent", operations: CLIENT_OPERATIONS };

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

describe("compile-negative authority contracts", () => {
  it("keeps the annotated negative shapes out of the compiled contract", () => {
    expect(CLIENT_OPERATIONS.length).toBeGreaterThan(0);
    expect(AGENT_OPERATIONS.length).toBeGreaterThan(0);
    expect([wrongAuthority, clientWithAgentOps, agentWithClientOps, productEndpoint, consumed, socketAck, transportAsRuntime, applicationAsRuntime].length).toBe(8);
  });
});
