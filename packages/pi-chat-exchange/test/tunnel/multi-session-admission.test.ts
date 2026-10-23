import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBackgroundTunnelManager } from "../../src/tunnel/background-manager.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";
import { ensureManagedBinding } from "../../src/tunnel/managed-binding.js";
import { publishMessagingPair } from "../../src/tunnel/messaging-config.js";
import { createMultiSessionRegistration, readSelectedMultiSessionPolicy } from "../../src/tunnel/multi-session-policy.js";
import * as admission from "../../src/tunnel/multi-session-admission.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
async function fixture() {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-admission-")); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml");
  const binding = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined, adapter: "chatgpt", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/A" }], capabilities: { payloadRead: true, ack: true } });
  const pair = publishMessagingPair(profilePath, binding.config, { chatgptEndpoint: binding.config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "real-A", store: binding.config.store, exchangeNamespace: binding.config.exchange.namespace, exchangeIdempotencyKey: binding.config.exchange.idempotencyKey, payloadRead: true, ack: true });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: join(dir, "NEVER-READ-CREDENTIAL"), healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, listProcesses: async () => ({ kind: "ok", processes: [] }), spawn: () => { throw Error("NO SPAWN"); }, signal: () => { throw Error("NO SIGNAL"); } });
  const api = createMultiSessionRegistration({ profilePath, manager });
  await api.convert({ expectedRevision: api.revision(), confirm: true });
  return { dir, profilePath, api };
}
it("exports deny-only MCP composition", () => { expect(admission.createMcpPolicyAdmission).toBeTypeOf("function"); });
it("freshly intersects exact loaded recipients, preserving shared inbox/read/ACK when A is revoked", async () => {
  const f = await fixture();
  const old = readSelectedMultiSessionPolicy(f.profilePath);
  const oldGate = admission.createMcpPolicyAdmission(old.config, old.bindingPath)!;
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } });
  expect(() => oldGate({ kind: "send", to: "pi/B" })).toThrow();
  const loaded = readSelectedMultiSessionPolicy(f.profilePath);
  const gate = admission.createMcpPolicyAdmission(loaded.config, loaded.bindingPath)!;
  gate({ kind: "send", to: "pi/A" }); gate({ kind: "send", to: "pi/B" });
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  expect(() => gate({ kind: "send", to: "pi/A" })).toThrow();
  for (const kind of ["begin", "renew", "inbox", "readPayload", "ack"] as const) gate({ kind });
  gate({ kind: "send", to: "pi/B" });
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/B" });
  for (const kind of ["begin", "renew", "inbox", "readPayload", "ack"] as const) expect(() => gate({ kind })).toThrow();
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
  expect(() => gate({ kind: "send", to: "pi/A" })).toThrow();
  expect(() => oldGate({ kind: "begin" })).toThrow(); // old epoch never revives
});
it("refuses launch config mismatch and corrupt current policy including reads", async () => {
  const f = await fixture(); const loaded = readSelectedMultiSessionPolicy(f.profilePath);
  expect(() => admission.createMcpPolicyAdmission({ ...loaded.config, ack: { enabled: false } }, loaded.bindingPath)).toThrow();
  const gate = admission.createMcpPolicyAdmission(loaded.config, loaded.bindingPath)!;
  fs.writeFileSync(f.profilePath, "partial");
  for (const kind of ["begin", "renew", "inbox", "readPayload", "ack"] as const) expect(() => gate({ kind })).toThrow();
});
it("does not attach policy to legacy bindings", () => {
  expect(admission.createMcpPolicyAdmission({ admissionPolicy: undefined } as never, "/unused")).toBeUndefined();
});
