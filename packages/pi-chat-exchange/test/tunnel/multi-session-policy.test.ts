import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBackgroundTunnelManager } from "../../dist/tunnel/background-manager.js";
import { createTunnelProfileSetup, readGeneratedPiAllowlist } from "../../dist/tunnel/setup.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../dist/tunnel/profile.js";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";
import { publishMessagingPair } from "../../dist/tunnel/messaging-config.js";
import * as multi from "../../dist/tunnel/multi-session-policy.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-multi-policy-")); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml");
  const binding = ensureManagedBinding(profilePath, { tunnelId: "tunnel_abcdefgh123456", organizationId: undefined,
    adapter: "chatgpt", endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/A" }], capabilities: { payloadRead: true, ack: true } });
  const pair = publishMessagingPair(profilePath, binding.config, { chatgptEndpoint: binding.config.endpoint,
    piEndpoint: { adapter: "pi", endpointId: "pi/A" }, piSessionId: "real-A", store: binding.config.store,
    exchangeNamespace: binding.config.exchange.namespace, exchangeIdempotencyKey: binding.config.exchange.idempotencyKey, payloadRead: true, ack: true });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456",
    keyFile: join(dir, "NEVER-READ-CREDENTIAL"), healthUrlFile: join(dir, "health.url"),
    mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  let processes: "ok" | "unknown" | "running" = "ok";
  const manager = createBackgroundTunnelManager({ env: {}, profilePath,
    listProcesses: async () => processes === "unknown" ? { kind: "unknown" } : { kind: "ok", processes: processes === "running" ? [{ pid: 123, command: `synthetic --profile-file ${profilePath}`, startedKey: "synthetic" }] : [] },
    spawn: () => { throw Error("NO SPAWN"); }, signal: () => { throw Error("NO SIGNAL"); } });
  const api = multi.createMultiSessionRegistration({ profilePath, manager });
  return { dir, profilePath, binding, pair, manager, api, setProcesses: (p: typeof processes) => { processes = p; } };
}
const B = { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: true };
async function converted() { const f = fixture(); await f.api.convert({ expectedRevision: f.api.revision(), confirm: true }); return f; }

it("requires explicit conversion, preserving legacy mapping, store, exchange and opt-ins", async () => {
  const f = fixture(); const old = fs.readFileSync(f.profilePath);
  await expect(f.api.register({ expectedRevision: f.api.revision(), registration: B })).rejects.toThrow();
  expect(fs.readFileSync(f.profilePath)).toEqual(old);
  await f.api.convert({ expectedRevision: f.api.revision(), confirm: true });
  const selected = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(selected.manifest.registrations).toEqual([{ endpointId: "pi/A", runtimeSessionId: "real-A", epoch: 1, status: "active", payloadRead: true, ack: true }]);
  expect(selected.config.store).toEqual(f.binding.config.store);
  expect(selected.config.exchange).toEqual(f.binding.config.exchange);
  expect(selected.config.endpoint).toEqual(f.binding.config.endpoint);
  expect(fs.existsSync(join(selected.config.store.directory, selected.config.store.file))).toBe(false);
  expect(() => readGeneratedPiAllowlist(f.profilePath)).toThrow(); // old single projection refuses
});
it("preserves unchanged A on addition B; loaded MCP cannot gain B", async () => {
  const f = await converted(); const loaded = multi.readSelectedMultiSessionPolicy(f.profilePath);
  await f.api.register({ expectedRevision: f.api.revision(), registration: B });
  const current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(multi.intersectRegistration(loaded, current, "real-A")).toMatchObject({ endpointId: "pi/A", epoch: 1 });
  expect(() => multi.intersectRegistration(loaded, current, "real-B")).toThrow();
  expect(multi.intersectMcpRecipients(loaded, current)).toEqual([{ adapter: "pi", endpointId: "pi/A" }]);
  expect(multi.projectPiRegistration(current, "real-B")).toMatchObject({ sessions: { "real-B": { endpointId: "pi/B" } }, payloadRead: { enabled: false }, ack: { enabled: true } });
});
it("retains revoked tombstones and old handles never revive at a later epoch", async () => {
  const f = await converted(); const loaded = multi.readSelectedMultiSessionPolicy(f.profilePath);
  await f.api.register({ expectedRevision: f.api.revision(), registration: B });
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  let current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(() => multi.intersectRegistration(loaded, current, "real-A")).toThrow();
  expect(current.manifest.registrations[0]).toMatchObject({ status: "revoked", epoch: 1 });
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true } });
  current = multi.readSelectedMultiSessionPolicy(f.profilePath);
  expect(current.manifest.registrations[0]).toMatchObject({ status: "active", epoch: 2 });
  expect(() => multi.intersectRegistration(loaded, current, "real-A")).toThrow();
  expect(multi.intersectMcpRecipients(loaded, current)).toEqual([]);
});
it("linearizes at exactly the old pointer snapshot even when verification follows revoke", async () => {
  const f = await converted(); const loaded = multi.readSelectedMultiSessionPolicy(f.profilePath);
  const verifyOverlapping = multi.captureSelectedMultiSessionPolicy(f.profilePath);
  await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
  expect(multi.intersectRegistration(loaded, verifyOverlapping(), "real-A")).toMatchObject({ epoch: 1 });
  expect(() => multi.intersectRegistration(loaded, multi.readSelectedMultiSessionPolicy(f.profilePath), "real-A")).toThrow();
});
it("refuses stale revision, duplicate runtime/endpoint, remapping and missing opt-ins", async () => {
  const f = await converted(); const revision = f.api.revision();
  await f.api.register({ expectedRevision: revision, registration: B });
  await expect(f.api.revoke({ expectedRevision: revision, endpointId: "pi/A" })).rejects.toThrow();
  for (const registration of [{ ...B, endpointId: "pi/C" }, { ...B, runtimeSessionId: "real-C" }, { ...B, ack: undefined }, { ...B, extra: true }]) {
    await expect(f.api.register({ expectedRevision: f.api.revision(), registration: registration as typeof B })).rejects.toThrow();
  }
});
it.each(["unknown", "running"] as const)("publication refuses %s process state without lifecycle operations", async (state) => {
  const f = fixture(); f.setProcesses(state); const before = fs.readFileSync(f.profilePath);
  await expect(f.api.convert({ expectedRevision: f.api.revision(), confirm: true })).rejects.toThrow();
  expect(fs.readFileSync(f.profilePath)).toEqual(before);
});
it("old setup wizard cannot overwrite multi mode", async () => {
  const f = await converted(); const setup = createTunnelProfileSetup({ env: {}, profilePath: f.profilePath, manager: f.manager });
  await expect(setup.save({ expectedRevision: setup.inspect().revision, tunnelId: "tunnel_abcdefgh123456", credential: { kind: "replace", secret: "synthetic-only" }, binding: { kind: "managed" }, messaging: { chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/overwrite", piSessionId: "real-X", payloadRead: true, ack: true, replaceExisting: true } })).rejects.toThrow();
  expect(multi.readSelectedMultiSessionPolicy(f.profilePath).manifest.registrations).toHaveLength(1);
});
