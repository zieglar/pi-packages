import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CeHookRunner } from "../../dist/hooks/runner.js";
import type { CeCommittedMessageEvent } from "../../dist/hooks/events.js";
import { parseMcpBindingConfig } from "../../dist/host/mcp-binding-config.js";
import { createLiveMcpComposition } from "../../dist/tunnel/live-mcp-composition.js";
import { publishMessagingGeneration } from "../../dist/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../dist/tunnel/profile.js";
import type { LiveSnapshot } from "../../dist/tunnel/live-session-policy.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function fixture(consented = true) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-mcp-hook-v2-"))); dirs.push(dir); fs.chmodSync(dir, 0o700);
  fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const keyFile = join(dir, "credential"); fs.writeFileSync(keyFile, "synthetic", { mode: 0o600 });
  const ref = { kind: "ce-live-session-v2" as const, root: dir, policyId: "policy-test", genesisDigest: "a".repeat(64), profilePath, upgradeSequence: 1 };
  const config = parseMcpBindingConfig({ version: 1, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [{ adapter: "pi", endpointId: "pi/A" }], payloadRead: { enabled: true }, ack: { enabled: true }, admissionPolicy: ref,
    hooks: [{ id: "incoming", event: "ce.message.committed.v1", recipient: { adapter: "pi", endpointId: "pi/A" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: true }] });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: keyFile });
  const profile = (bindingPath: string) => serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile, healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath }) }));
  fs.writeFileSync(profilePath, profile(pair.bindingPath), { mode: 0o600 });
  const bindingGeneration = basename(pair.bindingPath).slice("messaging-".length, -".yaml".length);
  let current = { ref, sequence: 2, digest: "b".repeat(64), manifest: { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: config.store, exchange: config.exchange, chatgptEndpoint: config.endpoint, mcp: { payloadRead: true, ack: true },
    registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1, status: "active", payloadRead: true, ack: true, payloadReadGeneration: 0, ackGeneration: 0, presenceDisclosure: false, hookGeneration: 1 }],
    mcpHookConsent: { generation: 2, bindingGeneration: consented ? bindingGeneration : null, targets: consented ? [{ ruleId: "incoming", endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1 }] : [] },
  } } as unknown as LiveSnapshot;
  return { dir, ref, config, pair, profilePath, profile, bindingGeneration, rule: config.hooks![0]!, get current() { return current; }, set current(value: LiveSnapshot) { current = value; }, load: () => createLiveMcpComposition(config, () => current, { bindingPath: pair.bindingPath }) };
}
it("requires sender consent and never borrows the receiving Pi outbound Hooks", () => {
  const f = fixture(false); const live = f.load();
  expect(live.hookAllowed(f.rule)).toBe(false);
  f.current = { ...f.current, manifest: { ...f.current.manifest, mcpHookConsent: { generation: 3, bindingGeneration: f.bindingGeneration, targets: [{ ruleId: "incoming", endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1 }] } } } as LiveSnapshot;
  expect(live.hookAllowed(f.rule)).toBe(false);
  expect(f.load().hookAllowed(f.rule)).toBe(true);
});
it("denies an unconfirmed new target incarnation even in a fresh MCP factory", () => {
  const f = fixture(); expect(f.load().hookAllowed(f.rule)).toBe(true);
  f.current = { ...f.current, manifest: { ...f.current.manifest, registrations: f.current.manifest.registrations.map(r => ({ ...r, epoch: 2 })) } } as LiveSnapshot;
  expect(f.load().hookAllowed(f.rule)).toBe(false);
});
it("same-binding consent ABA never revives an old MCP factory", () => {
  const f = fixture(); const live = f.load(); expect(live.hookAllowed(f.rule)).toBe(true);
  f.current = { ...f.current, manifest: { ...f.current.manifest, mcpHookConsent: { generation: 3, bindingGeneration: null, targets: [] } } } as LiveSnapshot;
  expect(live.hookAllowed(f.rule)).toBe(false);
  f.current = { ...f.current, manifest: { ...f.current.manifest, mcpHookConsent: { generation: 4, bindingGeneration: f.bindingGeneration, targets: [{ ruleId: "incoming", endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1 }] } } } as LiveSnapshot;
  expect(live.hookAllowed(f.rule)).toBe(false); expect(f.load().hookAllowed(f.rule)).toBe(true);
});
it("requires exact static rules and selected immutable generation without breaking message recipients", () => {
  const f = fixture(); const live = f.load(); expect(live.hookAllowed(f.rule)).toBe(true);
  expect(live.hookAllowed({ ...f.rule, args: ["unapproved"] })).toBe(false);
  const other = publishMessagingGeneration(f.profilePath, { ...f.config, hooks: [] }, { kind: "ce-live-launch-v2", version: 1, ref: f.ref });
  fs.writeFileSync(f.profilePath, f.profile(other.bindingPath), { mode: 0o600 });
  expect(live.hookAllowed(f.rule)).toBe(false);
  expect(live.recipients.snapshot().recipients).toEqual([{ adapter: "pi", endpointId: "pi/A" }]);
});
it("rechecks v2 consent after dequeue before starting queued work", async () => {
  const f = fixture(); const live = f.load();
  const runner = new CeHookRunner({ directory: f.dir, rules: f.config.hooks!, admit: rule => live.hookAllowed(rule) });
  const event = (id: string): CeCommittedMessageEvent => ({ schemaVersion: 1, event: "ce.message.committed.v1", eventId: `evt_${id}`, eventKey: `exchange/${id}`, messageId: `msg_${id}`, exchangeId: "exchange", sender: f.config.endpoint, recipient: f.rule.recipient, createdAt: new Date().toISOString(), payloadDigest: "a".repeat(64), payloadLength: 0 });
  try {
    runner.publish(event("first")); runner.publish(event("queued"));
    f.current = { ...f.current, manifest: { ...f.current.manifest, mcpHookConsent: { ...f.current.manifest.mcpHookConsent!, generation: 3 } } } as LiveSnapshot;
    await vi.waitFor(() => {
      const records = fs.readFileSync(join(f.dir, "ce-hooks/executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ messageId: "msg_queued", status: "SKIPPED_POLICY_DENIED" }));
      expect(records).toContainEqual(expect.objectContaining({ messageId: "msg_first", status: "SUCCEEDED" }));
      expect(records).not.toContainEqual(expect.objectContaining({ messageId: "msg_queued", status: "STARTED" }));
    });
  } finally { await runner.close(); }
});
