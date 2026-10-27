import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import * as protocol from "../../src/protocol/index.js";

// Namespace access keeps RED a missing contract assertion, not a loader error.
const declarations = protocol as unknown as {
  endpointCapabilitySupport: (caps: Record<string, string>, capability: string) => string;
  EndpointCapabilitiesSchema: Parameters<typeof Value.Check>[0];
};
describe("endpoint capability declarations do not manufacture evidence", () => {
  it("keeps missing, unknown and unsupported capabilities distinct from supported", () => {
    expect(declarations).toHaveProperty("endpointCapabilitySupport");
    expect(declarations.endpointCapabilitySupport({ delivery: "supported" }, "observation")).toBe("unknown");
    expect(declarations.endpointCapabilitySupport({ delivery: "unsupported" }, "delivery")).toBe("unsupported");
    expect(declarations.endpointCapabilitySupport({ delivery: "unknown" }, "delivery")).toBe("unknown");
    expect(declarations.endpointCapabilitySupport({ delivery: "supported" }, "delivery")).toBe("supported");
  });
  it("does not require observation or cancellation parity", () => {
    expect(declarations).toHaveProperty("EndpointCapabilitiesSchema");
    expect(Value.Check(declarations.EndpointCapabilitiesSchema, { delivery: "supported" })).toBe(true);
    expect(Value.Check(declarations.EndpointCapabilitiesSchema, { delivery: "supported", observation: "unsupported", cancellation: "unknown" })).toBe(true);
    expect(Value.Check(declarations.EndpointCapabilitiesSchema, { delivery: "supported", runtime: "settled" })).toBe(false);
    expect(Value.Check(declarations.EndpointCapabilitiesSchema, { delivery: "supported", observation: true })).toBe(false);
  });
});
