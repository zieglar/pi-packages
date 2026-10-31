import { describe, expect, it } from "vitest";
import { parseMcpBindingConfig, McpBindingConfigError } from "../../src/host/mcp-binding-config.js";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";

function valid(hooks?: unknown) {
  return {
    version: 1,
    store: { directory: "/var/lib/chat-exchange" },
    exchange: { namespace: "ce-mcp", idempotencyKey: "exchange-1" },
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/main" }],
    ...(hooks === undefined ? {} : { hooks }),
  };
}

const rule = {
  id: "pi-notify",
  event: CE_MESSAGE_COMMITTED_EVENT,
  recipient: { adapter: "pi", endpointId: "pi/main" },
  command: "/opt/node/bin/node",
  args: ["/opt/hooks/notify.mjs"],
  timeoutMs: 5000,
};

describe("MCP binding Hook configuration", () => {
  it("keeps the legacy shape when hooks are absent and parses loaded rules when present", () => {
    expect(parseMcpBindingConfig(valid())).not.toHaveProperty("hooks");
    const config = parseMcpBindingConfig(valid([rule, { ...rule, id: "disabled", enabled: false }]));
    expect(config.hooks).toHaveLength(2);
    expect(config.hooks?.[0]).toMatchObject({ ...rule, enabled: true });
    expect(config.hooks?.[1]).toMatchObject({ enabled: false });
    expect(Object.isFrozen(config.hooks)).toBe(true);
  });

  it("maps invalid Hook configuration to the existing sanitized MCP refusal", () => {
    expect(() => parseMcpBindingConfig(valid([{ ...rule, command: "node" }]))).toThrow(McpBindingConfigError);
    try {
      parseMcpBindingConfig(valid([{ ...rule, command: "node" }]));
    } catch (error) {
      expect(error).toMatchObject({ code: "CE_MCP_CONFIG_INVALID", field: "hooks[0].command" });
    }
  });
});
