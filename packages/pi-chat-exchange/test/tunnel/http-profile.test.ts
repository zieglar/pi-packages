import { describe, expect, it } from "vitest";
import { parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { captureBackgroundAuthorizationScope } from "../../src/tunnel/background-scope.js";
import { buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";

const stdio = serializeTunnelProfile(buildTunnelProfile({
  tunnelId: "tunnel_0123456789abcdef0123456789abcdef",
  keyFile: "/fixtures/key", healthUrlFile: "/fixtures/health",
  mcpCommand: "/fixtures/node /fixtures/mcp-stdio.js --config /fixtures/binding.json",
}));
const http = stdio.replace(/  commands:\n    - channel: main\n      command: .*\n$/, [
  "  server_urls:", "    - channel: main", '      url: "http://localhost/mcp"', '      unix_socket: "/fixtures/private/mcp.sock"', "",
].join("\n"));

describe("local HTTP Tunnel profiles", () => {
  it("parses the official main-channel Unix socket shape while preserving stdio", () => {
    expect(parseTunnelProfile(stdio).mcpCommand).toContain("mcp-stdio.js");
    expect(parseTunnelProfile(http)).toMatchObject({ mcpHttp: { url: "http://localhost/mcp", unixSocket: "/fixtures/private/mcp.sock" } });
  });
  it("does not grant background authority based on a socket path alone", () => {
    const facts = parseTunnelProfile(http);
    expect(() => captureBackgroundAuthorizationScope({
      profilePath: "/fixtures/profile.yaml", profileText: http, credentialPath: facts.keyFile,
      clientPath: "/fixtures/tunnel-client", mcpCommand: facts.mcpCommand,
    })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
  it.each([
    http.replace("http://localhost/mcp", "http://example.com/mcp"),
    http.replace("/fixtures/private/mcp.sock", "relative.sock"),
    http.replace('      unix_socket: "/fixtures/private/mcp.sock"\n', ""),
    http.replace("channel: main", "channel: other"),
    http.replace('      url: "http://localhost/mcp"', '      url: "http://localhost/mcp"\n      url: "http://localhost/mcp"'),
    http.replace('      unix_socket: "/fixtures/private/mcp.sock"', '      unix_socket: "/fixtures/private/mcp.sock"\n      http_proxy: "http://example.com"'),
    http + '    - channel: main\n      url: "http://localhost/mcp"\n      unix_socket: "/tmp/other.sock"\n',
  ])("rejects an unsupported or ambiguous HTTP profile", (profile) => {
    expect(() => parseTunnelProfile(profile)).toThrow();
  });
});
