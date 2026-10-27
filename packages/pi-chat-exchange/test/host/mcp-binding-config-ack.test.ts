/**
 * HANDOFF-CE-E2B-01 — operator `ack` opt-in in the trusted MCP binding
 * configuration (clause 1).
 *
 * The ACK opt-in mirrors the committed `payloadRead` precedent exactly: an
 * optional section, exact-boolean validation, disabled by default, and
 * refusals that carry a fixed code plus a structural field path only — never a
 * configuration value.
 */
import { describe, expect, it } from "vitest";
import {
  McpBindingConfigError,
  parseMcpBindingConfig,
} from "../../src/host/mcp-binding-config.js";

const STORE_DIR = "/tmp/ce-mcp-ack-config";

function valid(): Record<string, unknown> {
  return {
    version: 1,
    store: { directory: STORE_DIR },
    exchange: { namespace: "local", idempotencyKey: "chatgpt-pi" },
    endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
    recipients: [{ adapter: "pi", endpointId: "pi/main" }],
  };
}

function expectField(raw: unknown, field: string): McpBindingConfigError {
  try {
    parseMcpBindingConfig(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(McpBindingConfigError);
    const refusal = error as McpBindingConfigError;
    expect(refusal.code).toBe("CE_MCP_CONFIG_INVALID");
    expect(refusal.field).toBe(field);
    return refusal;
  }
  throw new Error(`expected CE_MCP_CONFIG_INVALID at ${field}`);
}

describe("MCP binding configuration: ack opt-in", () => {
  it("defaults the ack opt-in to disabled when the section is absent", () => {
    const config = parseMcpBindingConfig(valid());
    expect(config.ack).toEqual({ enabled: false });
    expect(Object.isFrozen(config.ack)).toBe(true);
  });

  it("accepts an explicit boolean opt-in in both positions", () => {
    expect(parseMcpBindingConfig({ ...valid(), ack: { enabled: true } }).ack).toEqual({ enabled: true });
    expect(parseMcpBindingConfig({ ...valid(), ack: { enabled: false } }).ack).toEqual({ enabled: false });
  });

  it("refuses a non-boolean, missing, or unknown ack field with a structural path only", () => {
    expectField({ ...valid(), ack: { enabled: "true" } }, "ack.enabled");
    expectField({ ...valid(), ack: { enabled: 1 } }, "ack.enabled");
    expectField({ ...valid(), ack: { enabled: null } }, "ack.enabled");
    expectField({ ...valid(), ack: {} }, "ack.enabled");
    expectField({ ...valid(), ack: { enabled: true, mode: "auto" } }, "ack");
    expectField({ ...valid(), ack: "enabled" }, "ack");
    expectField({ ...valid(), ack: [] }, "ack");
    expectField({ ...valid(), ack: null }, "ack");
  });

  it("never echoes a configuration value in the refusal", () => {
    const refusal = expectField({ ...valid(), ack: { enabled: "cap_0123456789abcdef" } }, "ack.enabled");
    expect(refusal.message).not.toContain("cap_0123456789abcdef");
    expect(JSON.stringify({ message: refusal.message, field: refusal.field })).not.toContain("cap_");
  });

  it("still refuses unknown top-level fields next to a valid ack section", () => {
    expectField({ ...valid(), ack: { enabled: true }, acknowledge: { enabled: true } }, "config");
  });
});
