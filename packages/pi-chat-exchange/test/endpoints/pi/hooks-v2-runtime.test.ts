import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { LiveSnapshot } from "../../../dist/tunnel/live-session-policy.js";
import { PiMultiSessionRuntime, assertLiveRegistrationContinuity } from "../../../pi-extension/multi-session-runtime.js";
import { parseHookRules } from "../../../dist/hooks/config.js";
import { PiSessionPolicy } from "../../../pi-extension/live-session-runtime.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-hook-continuity-"))); dirs.push(dir); fs.chmodSync(dir, 0o700);
  const hooks = parseHookRules([{ id: "notify", event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: true }]);
  const loaded = { ref: { kind: "ce-live-session-v2", profilePath: join(dir, "tunnel.yaml"), root: dir, policyId: "test", genesisDigest: "a".repeat(64), upgradeSequence: 1 }, sequence: 1, digest: "b".repeat(64), manifest: {
    kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: dir, file: "ce.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, mcp: { payloadRead: true, ack: true },
    mcpHookConsent: { generation: 1, bindingGeneration: null, targets: [] }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "native-A", epoch: 1, status: "active", payloadRead: true, ack: true, payloadReadGeneration: 0, ackGeneration: 0, presenceDisclosure: false, hooks, hookGeneration: 1 }],
  } } as unknown as LiveSnapshot;
  const changed = { ...loaded, sequence: 2, digest: "c".repeat(64), manifest: { ...loaded.manifest, registrations: loaded.manifest.registrations.map(r => ({ ...r, hooks: [], hookGeneration: 2 })) } } as LiveSnapshot;
  return { loaded, changed };
}
it("v2 Hook changes keep message registration continuity while v1 retains its equality gate", () => {
  const { loaded, changed } = fixture();
  expect(assertLiveRegistrationContinuity(loaded, changed, "native-A").endpointId).toBe("pi/A");
  const legacy = { kind: "ce-live-session-v1", root: loaded.ref.root, policyId: loaded.ref.policyId, genesisDigest: loaded.ref.genesisDigest } as const;
  expect(() => assertLiveRegistrationContinuity({ ...loaded, ref: legacy }, { ...changed, ref: legacy }, "native-A")).toThrow();
});
it("message operations and explicit same-mapping mutex transfer survive a v2 Hook-only update", async () => {
  const { loaded, changed } = fixture(); let current = loaded;
  const mapping = { endpointId: "pi/A", participantId: "part-A", sessionId: "session-A", exchangeId: "exchange-A" };
  const original = new PiMultiSessionRuntime(loaded, "native-A", () => "native-A", false, mapping, () => current);
  try {
    current = changed;
    for (const kind of ["metadata", "send", "payload", "ack", "renew"]) expect(original.run(kind, () => kind)).toBe(kind);
    original.closeAdmission(); await original.drain(); original.transfer(mapping);
    const replacement = new PiMultiSessionRuntime(changed, "native-A", () => "native-A", true, mapping, () => current);
    try { expect(replacement.run("send", () => 42)).toBe(42); expect(() => original.run("send", () => 42)).toThrow(); }
    finally { replacement.closeAdmission(); await replacement.drain(); replacement.release({ released: true, detached: true }); }
  } finally { original.closeAdmission(); await original.drain(); }
});
it("v2 still refuses a revoked or changed incarnation across Hook updates", () => {
  const { loaded, changed } = fixture();
  for (const update of [{ epoch: 2 }, { status: "revoked" }, { runtimeSessionId: "native-other" }]) {
    const other = { ...changed, manifest: { ...changed.manifest, registrations: changed.manifest.registrations.map(r => ({ ...r, ...update })) } } as LiveSnapshot;
    expect(() => assertLiveRegistrationContinuity(loaded, other, "native-A")).toThrow();
  }
});
it("captures Pi Hook eligibility once and denies ABA until official reload while messages continue", async () => {
  const { loaded, changed } = fixture(); let current = loaded;
  class SelectedPolicy extends PiSessionPolicy { override current() { return current; } }
  const mapping = { endpointId: "pi/A", participantId: "part-A", sessionId: "session-A", exchangeId: "exchange-A" };
  const original = new SelectedPolicy(loaded, "native-A", () => "native-A", false, mapping);
  const rule = loaded.manifest.registrations[0]!.hooks![0]!;
  try {
    expect(original.hookAllowed(rule)).toBe(true);
    expect(original.hookAllowed({ ...rule, args: ["unapproved"] })).toBe(false);
    current = changed;
    expect(original.registration().endpointId).toBe("pi/A");
    expect(original.hookAllowed(rule)).toBe(false);
    current = { ...changed, sequence: 3, manifest: { ...changed.manifest, registrations: changed.manifest.registrations.map(r => ({ ...r, hooks: [rule], hookGeneration: 3 })) } } as LiveSnapshot;
    expect(original.run("send", () => 42)).toBe(42);
    expect(original.hookAllowed(rule)).toBe(false);
    original.closeAdmission(); await original.drain(); original.transfer(mapping);
    const replacement = new SelectedPolicy(current, "native-A", () => "native-A", true, mapping);
    try { expect(replacement.hookAllowed(rule)).toBe(true); }
    finally { replacement.closeAdmission(); await replacement.drain(); replacement.release({ released: true, detached: true }); }
  } finally { original.closeAdmission(); await original.drain(); }
});
