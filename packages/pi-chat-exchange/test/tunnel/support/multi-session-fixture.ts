import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../../src/tunnel/background-manager.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile, replaceTunnelMcpBindingPath } from "../../../src/tunnel/profile.js";
import { ensureManagedBinding } from "../../../src/tunnel/managed-binding.js";
import { publishMessagingPair, publishMessagingGeneration } from "../../../src/tunnel/messaging-config.js";
import { createMultiSessionRegistration, readSelectedMultiSessionPolicy } from "../../../src/tunnel/multi-session-policy.js";

/** Synthetic operator profile only. Never reads a credential or starts transport. */
export async function multiSessionFixture() {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-multi-runtime-"));
  const profilePath = join(dir, "tunnel.yaml");
  const binding = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined, adapter: "chatgpt", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/A" }], capabilities: { payloadRead: true, ack: true } });
  const pair = publishMessagingPair(profilePath, binding.config, { chatgptEndpoint: binding.config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "real-A", store: binding.config.store, exchangeNamespace: binding.config.exchange.namespace, exchangeIdempotencyKey: binding.config.exchange.idempotencyKey, payloadRead: true, ack: true });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: join(dir, "NEVER-READ-CREDENTIAL"), healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(process.cwd(), "dist/bin/mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, listProcesses: async () => ({ kind: "ok", processes: [] }), spawn: () => { throw Error("NO SPAWN"); }, signal: () => { throw Error("NO SIGNAL"); } });
  const api = createMultiSessionRegistration({ profilePath, manager });
  await api.convert({ expectedRevision: api.revision(), confirm: true });
  return {
    dir, profilePath, api,
    selected: () => readSelectedMultiSessionPolicy(profilePath),
    /** Synthetic publication of narrowing global grants (no new product API). */
    narrowGlobal: (payloadRead: boolean, ack: boolean) => {
      const loaded = readSelectedMultiSessionPolicy(profilePath);
      const next = publishMessagingGeneration(profilePath, { ...loaded.config, payloadRead: { enabled: payloadRead }, ack: { enabled: ack } }, { ...loaded.manifest, mcp: { payloadRead, ack } });
      const before = fs.readFileSync(profilePath, "utf8");
      const command = parseTunnelProfile(before).mcpCommand!;
      const updated = replaceTunnelMcpBindingPath(command, next.bindingPath);
      fs.writeFileSync(profilePath, before.replace(command, updated));
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
