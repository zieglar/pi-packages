import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { initializeLivePolicy, prepareLivePolicyUpgrade, createLivePolicyRegistration, readLivePolicy, type LiveSnapshot } from "../../../dist/tunnel/live-session-policy.js";
import { parseMcpBindingConfig } from "../../../dist/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../../dist/tunnel/profile.js";
import { readLiveSelectedSessionPolicy } from "../../../pi-extension/live-session-profile.js";
import { PiSessionPolicy } from "../../../pi-extension/live-session-runtime.js";
import { parseHookRules } from "../../../dist/hooks/config.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-real-hooks-v2-"))); dirs.push(dir); fs.chmodSync(dir, 0o700);
  const root = join(dir, "policy"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const keyFile = join(dir, "credential"); fs.writeFileSync(keyFile, "synthetic", { mode: 0o600 });
  const manifest = { kind: "ce-multi-session-v1" as const, version: 1 as const, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1, status: "active" as const, payloadRead: true, ack: true }] };
  const v1 = initializeLivePolicy({ root, manifest }); const ref = prepareLivePolicyUpgrade(v1, profilePath); const api = createLivePolicyRegistration({ ref, credentialFile: keyFile });
  const config = parseMcpBindingConfig({ version: 1, store: manifest.store, exchange: manifest.exchange, endpoint: manifest.chatgptEndpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
  api.upgrade({ expectedDigest: readLivePolicy(v1).digest, actorRuntimeSessionId: "native-A", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) });
  const text = serializeTunnelProfile(buildTunnelProfile({ tunnelId: manifest.identity.tunnelId, keyFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: pair.bindingPath }) }));
  fs.writeFileSync(profilePath, text, { mode: 0o600 });
  return { dir, ref, api, profilePath, text, load: () => readLiveSelectedSessionPolicy(profilePath, text)!, hooks: parseHookRules([{ id: "outgoing", event: "ce.message.committed.v1", recipient: manifest.chatgptEndpoint, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: true }]) };
}
it("selects a verified v2 launch and preserves real policy reads and same-Owner reload continuity", async () => {
  const f = fixture(); const loaded = f.load(); expect(loaded?.ref.kind).toBe("ce-live-session-v2");
  const mapping = { endpointId: "pi/A", participantId: "part-A", sessionId: "session-A", exchangeId: "exchange-A" };
  const original = new PiSessionPolicy(loaded, "native-A", () => "native-A", false, mapping);
  try {
    f.api.setPiHooks({ expectedDigest: readLivePolicy(f.ref).digest, runtimeSessionId: "native-A", endpointId: "pi/A", epoch: 1, hooks: f.hooks });
    expect(original.run("send", () => 42)).toBe(42); expect(original.registration().endpointId).toBe("pi/A"); expect(original.hookAllowed(f.hooks[0]!)).toBe(false);
    original.closeAdmission(); await original.drain(); original.transfer(mapping);
    const replacement = new PiSessionPolicy(f.load(), "native-A", () => "native-A", true, mapping);
    try {
      expect(replacement.hookAllowed(f.hooks[0]!)).toBe(true);
      f.api.setPiHooks({ expectedDigest: readLivePolicy(f.ref).digest, runtimeSessionId: "native-A", endpointId: "pi/A", epoch: 1, hooks: [] });
      f.api.setPiHooks({ expectedDigest: readLivePolicy(f.ref).digest, runtimeSessionId: "native-A", endpointId: "pi/A", epoch: 1, hooks: f.hooks });
      expect(replacement.hookAllowed(f.hooks[0]!)).toBe(false); expect(replacement.run("renew", () => 42)).toBe(42);
    } finally { replacement.closeAdmission(); await replacement.drain(); replacement.release({ released: true, detached: true }); }
  } finally { original.closeAdmission(); await original.drain(); }
});
it("rejects a v2 launch selected under a different Profile path", () => {
  const f = fixture(); const alternate = join(f.dir, "other.yaml"); fs.writeFileSync(alternate, f.text, { mode: 0o600 });
  expect(() => readLiveSelectedSessionPolicy(alternate, f.text)).toThrow();
});
