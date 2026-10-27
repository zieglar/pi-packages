import { describe, expect, it } from "vitest";
import * as profile from "../../dist/tunnel/profile.js";
import * as background from "../../dist/tunnel/background-manager.js";

const base = {
  tunnelId: "tunnel_abcdefgh1234", keyFile: "/abs/runtime-key",
  mcpCommand: "/abs/node /abs/mcp-stdio.js --config /abs/binding.json",
  healthUrlFile: "/abs/health.url",
};

describe("real setup profile boundary", () => {
  it("includes optional organization in the actual client profile", () => {
    expect(profile.buildTunnelProfile({ ...base, ...{ organizationId: "org-team123" } }).control_plane)
      .toMatchObject({ organization_id: "org-team123" });
  });
  it.each(["org-", "org-bad_name", "org-" + "x".repeat(129), "org-a\napi_key: injected"])(
    "refuses malformed organization %s", (organizationId) => {
      expect(() => profile.buildTunnelProfile({ ...base, ...{ organizationId } })).toThrow(profile.TunnelConfigError);
    },
  );
  it("exposes shared resolver and strict parser, not a second setup parser", () => {
    expect(Reflect.get(background, "resolveTunnelProfilePath")).toBeTypeOf("function");
    expect(Reflect.get(background, "parseTunnelProfile")).toBeTypeOf("function");
  });
  it("exposes safe command construction for a selected binding path", () => {
    expect(Reflect.get(profile, "buildTunnelMcpCommand")).toBeTypeOf("function");
  });
  it.each([
    "'/abs/node' /abs/mcp-stdio.js --config /abs/binding.json",
    "/abs/node '/abs/mcp-stdio.js' --config /abs/binding.json",
    "/abs/node /abs/mcp-stdio.js '--config' /abs/binding.json",
    "/abs/node /abs/mcp-stdio.js --config '/abs/binding.json'",
    "/abs/node /abs/mcp-stdio.js --config /abs/binding.json '--channel' main",
  ])("refuses non-canonical quoting without widening the existing grammar: %s", (mcpCommand) => {
    expect(() => profile.parseTunnelMcpCommand(mcpCommand)).toThrow();
  });
  it.each([
    "/abs/node /abs/mcp-stdio.js --config '/tmp/x -rf /etc/y.json'",
    "'/abs/node -x' /abs/mcp-stdio.js --config /abs/binding.json",
  ])("refuses a space-bearing path whose segment could be read as an option: %s", (mcpCommand) => {
    expect(() => profile.parseTunnelMcpCommand(mcpCommand)).toThrow();
  });
  it("still accepts an ordinary space-bearing path", () => {
    const command = "/abs/node /abs/mcp-stdio.js --config '/abs/My Bindings/binding.json'";
    expect(profile.parseTunnelMcpCommand(command).bindingPath).toBe("/abs/My Bindings/binding.json");
  });
});
