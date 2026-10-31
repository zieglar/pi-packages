import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { keychainAccountFor } from "../../src/tunnel/keychain.js";
import { ensureManagedBinding, managedBindingFileName } from "../../src/tunnel/managed-binding.js";
import { buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";

const body = "0123456789abcdef0123456789abcdef";
const legacy = `tunnel_${body}`;
const namespaced = `tunnel_ab12_${body}`;
const profileInput = {
  keyFile: "/fixtures/runtime-key",
  mcpCommand: "/fixtures/node /fixtures/mcp-stdio.js --config /fixtures/binding.json",
  healthUrlFile: "/fixtures/health.url",
};
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Tunnel ID compatibility", () => {
  it.each([legacy, "tunnel_LegacyABCD1234", namespaced])("preserves %s across profile, Manager, binding, MCP and keychain", (tunnelId) => {
    const dir = mkdtempSync(join(tmpdir(), "ce-id-compat-"));
    directories.push(dir);
    const profile = buildTunnelProfile({ ...profileInput, tunnelId });
    expect(profile.control_plane.tunnel_id).toBe(tunnelId);
    expect(parseTunnelProfile(serializeTunnelProfile(profile)).tunnelId).toBe(tunnelId);
    const binding = ensureManagedBinding(join(dir, "tunnel.yaml"), { tunnelId, organizationId: undefined, adapter: "chatgpt" });
    const parsed = parseMcpBindingConfig(JSON.parse(readFileSync(binding.path, "utf8")));
    expect(parsed.managed?.tunnelId).toBe(tunnelId);
    expect(keychainAccountFor({ origin: "https://api.openai.com", tunnelId })).toBe(
      `v1:${createHash("sha256").update(`https://api.openai.com\0${tunnelId}`, "utf8").digest("hex")}`,
    );
  });

  it("separates namespaces sharing the complete body and filename tail without overwriting", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-id-compat-"));
    directories.push(dir);
    const ids = [legacy, namespaced, `tunnel_cd34_${body}`];
    const bindings = ids.map(tunnelId => ensureManagedBinding(join(dir, "tunnel.yaml"), { tunnelId, organizationId: undefined, adapter: "chatgpt" }));
    expect(new Set(bindings.map(b => b.path)).size).toBe(3);
    expect(new Set(bindings.map(b => b.config.exchange.namespace)).size).toBe(3);
    expect(new Set(bindings.map(b => b.config.endpoint.endpointId)).size).toBe(3);
    expect(new Set(ids.map(tunnelId => keychainAccountFor({ origin: "https://api.openai.com", tunnelId }))).size).toBe(3);
    bindings.forEach((binding, index) => {
      expect(parseMcpBindingConfig(JSON.parse(readFileSync(binding.path, "utf8"))).managed?.tunnelId).toBe(ids[index]);
      expect(ensureManagedBinding(join(dir, "tunnel.yaml"), { tunnelId: ids[index]!, organizationId: undefined, adapter: "chatgpt" }).path).toBe(binding.path);
    });
  });

  it.each([
    `tunnel_abc_${body}`, `tunnel_abcde_${body}`, `tunnel_AB12_${body}`,
    `tunnel_ab12_${body.slice(1)}`, `tunnel_ab12_${body}0`, `tunnel_ab12_${body.toUpperCase()}`,
    `tunnel_ab12__${body}`, `tunnel__${body}`, `tunnel_ab12_${body}_`,
    `tunnel_ab12_${body}\n`, ` tunnel_ab12_${body}`, `tunnel_ab12_${body}/../x`,
    "tunnel_short", "sk-proj-not-a-tunnel", "tunnel_abcdefgh\0",
  ])("refuses malformed ID %j at every non-UI boundary", (tunnelId) => {
    expect(() => buildTunnelProfile({ ...profileInput, tunnelId })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    const profile = serializeTunnelProfile(buildTunnelProfile({ ...profileInput, tunnelId: legacy }));
    expect(() => parseTunnelProfile(profile.replace(legacy, tunnelId))).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    expect(() => keychainAccountFor({ origin: "https://api.openai.com", tunnelId })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    expect(() => managedBindingFileName({ tunnelId, organizationId: undefined, adapter: "chatgpt" })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    expect(() => parseMcpBindingConfig({ version: 1, store: { directory: "/fixtures/store" }, exchange: { namespace: "ce-test", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [], managed: { tunnelId, adapter: "chatgpt" } })).toThrow(expect.objectContaining({ field: "managed.tunnelId" }));
  });
});
