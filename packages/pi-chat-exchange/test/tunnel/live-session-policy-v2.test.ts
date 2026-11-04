import fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as policy from "../../dist/tunnel/live-session-policy.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-live-v2-"))); roots.push(root); fs.chmodSync(root, 0o700);
  const ref = policy.initializeLivePolicy({ root, manifest: { kind: "ce-multi-session-v1", version: 1,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store: { directory: root, file: "ce.sqlite" },
    exchange: { namespace: "ce", idempotencyKey: "exchange" }, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "A", epoch: 1, status: "active", payloadRead: true, ack: true }] } });
  return { root, ref };
}
const rule = { id: "out", event: "ce.message.committed.v1" as const, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled: false };
function upgrade() {
  const f = fixture(); const before = policy.readLivePolicy(f.ref);
  const ref = policy.prepareLivePolicyUpgrade(f.ref, join(f.root, "profile.json"));
  const api = policy.createLivePolicyRegistration({ ref });
  const result = api.upgrade({ expectedDigest: before.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64), operationId: "upgrade" });
  return { ...f, v1: f.ref, ref, api, before, result };
}
it("upgrades the same history with pinned reader and preserves the v1 prefix", () => {
  expect(typeof policy.prepareLivePolicyUpgrade).toBe("function");
  const { ref, v1, before, result, api } = upgrade();
  expect(ref).toMatchObject({ kind: "ce-live-session-v2", root: v1.root, genesisDigest: v1.genesisDigest, policyId: v1.policyId, upgradeSequence: 1 });
  expect(result.snapshot.manifest.registrations[0]).toEqual({ ...before.manifest.registrations[0], hookGeneration: 1 });
  expect(result.snapshot.manifest.mcpHookConsent).toEqual({ generation: 1, bindingGeneration: null, targets: [] });
  expect(() => policy.readLivePolicy(v1)).toThrow();
  expect(api.reconcile({ runtimeSessionId: "operator" })[0]?.outcome).toBe("PUBLISHED");
  expect(() => api.upgrade({ expectedDigest: result.snapshot.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) })).toThrow();
});
it("stamps every own hook replacement including ABA and preserves hooks across ordinary updates", () => {
  const { api, result } = upgrade(); let s = result.snapshot;
  for (const hooks of [[rule], [], [rule]]) s = api.setPiHooks({ expectedDigest: s.digest, runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, hooks }).snapshot;
  expect(s.manifest.registrations[0]).toMatchObject({ hookGeneration: 4, payloadReadGeneration: 0, ackGeneration: 0, hooks: [rule] });
  s = api.register({ expectedDigest: s.digest, registration: { endpointId: "pi/A", runtimeSessionId: "A", payloadRead: false, ack: true, presenceDisclosure: true } }).snapshot;
  expect(s.manifest.registrations[0]).toMatchObject({ hookGeneration: 4, hooks: [rule] });
  for (const patch of [{ runtimeSessionId: "wrong" }, { epoch: 2 }, { endpointId: "pi/missing" }]) expect(() => api.setPiHooks({ expectedDigest: s.digest, runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, hooks: [], ...patch })).toThrow();
});
it("binds MCP consent to exact active targets without recipient hooks and refuses stale consent", () => {
  const { api, result } = upgrade(); const target = { ruleId: "in", endpointId: "pi/A", runtimeSessionId: "A", epoch: 1 };
  const input = { expectedDigest: result.snapshot.digest, actorRuntimeSessionId: "operator", bindingGeneration: "c".repeat(64), targets: [target] };
  for (const targets of [[{ ...target, ruleId: "r".repeat(65) }], Array.from({ length: 65 }, (_, n) => ({ ...target, ruleId: `r${n}` })), [target, target], [{ ...target, epoch: 2 }], [{ ...target, runtimeSessionId: "wrong" }], [{ ...target, command: "/bin/true" }]]) expect(() => api.setMcpHooks({ ...input, targets })).toThrow();
  const s = api.setMcpHooks(input).snapshot;
  expect(s.manifest.registrations).toEqual(result.snapshot.manifest.registrations);
  expect(s.manifest.mcpHookConsent).toEqual({ generation: 2, bindingGeneration: input.bindingGeneration, targets: [target] });
  expect(() => api.setMcpHooks(input)).toThrow();
});
it("uses the Hook ID grammar for sender targets while preserving identity guards", () => {
  const { api, ref, result } = upgrade();
  const target = { ruleId: "cap_0123456789abcdef", endpointId: "pi/A", runtimeSessionId: "A", epoch: 1 };
  const input = { expectedDigest: result.snapshot.digest, actorRuntimeSessionId: "operator", bindingGeneration: "c".repeat(64), targets: [target] };
  for (const ruleId of ["", "with space", "_leading", "slash/name", "r".repeat(65)]) expect(() => api.setMcpHooks({ ...input, targets: [{ ...target, ruleId }] })).toThrow();
  for (const patch of [{ endpointId: "cap_0123456789abcdef" }, { runtimeSessionId: "cap_0123456789abcdef" }]) expect(() => api.setMcpHooks({ ...input, targets: [{ ...target, ...patch }] })).toThrow();
  const publication = api.setMcpHooks(input);
  expect(publication.snapshot.manifest.mcpHookConsent?.targets).toEqual([target]);
  expect(policy.readLivePolicy(ref).manifest.mcpHookConsent?.targets).toEqual([target]);
});
it("refuses upgrade with unresolved original v1 requests from another actor", () => {
  const { ref, root } = fixture(); const tip = policy.readLivePolicy(ref);
  const v1 = policy.createLivePolicyRegistration({ ref, io: { linkSync(a, b) { if (String(b).endsWith("000001.json")) throw Error("injected before slot"); fs.linkSync(a, b); } } });
  expect(() => v1.register({ expectedDigest: tip.digest, registration: { endpointId: "pi/B", runtimeSessionId: "B", payloadRead: false, ack: false, presenceDisclosure: false } })).toThrow();
  const prepared = policy.prepareLivePolicyUpgrade(ref, join(root, "profile.json"));
  expect(() => policy.createLivePolicyRegistration({ ref: prepared }).upgrade({ expectedDigest: tip.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) })).toThrow();
  expect(policy.readLivePolicy(ref).digest).toBe(tip.digest);
});
it("reconciles upgrade link success followed by lost result through the pinned reader", () => {
  const { root, ref: v1 } = fixture(); const tip = policy.readLivePolicy(v1);
  const ref = policy.prepareLivePolicyUpgrade(v1, join(root, "profile.json"));
  const api = policy.createLivePolicyRegistration({ ref, io: { linkSync(a, b) { fs.linkSync(a, b); if (String(b).endsWith("000001.json")) throw Error("lost result"); } } });
  expect(() => api.upgrade({ expectedDigest: tip.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64), operationId: "lost" })).toThrow();
  expect(policy.readLivePolicy(ref).sequence).toBe(1);
  expect(() => policy.readLivePolicy(v1)).toThrow();
  expect(api.reconcile({ runtimeSessionId: "operator" })[0]).toMatchObject({ operationId: "lost", outcome: "PUBLISHED" });
});
it("classifies a v1 winner after upgrade final verification without adopting it", () => {
  const { root, ref: v1 } = fixture(); const tip = policy.readLivePolicy(v1);
  const ref = policy.prepareLivePolicyUpgrade(v1, join(root, "profile.json"));
  let injected = false;
  const api = policy.createLivePolicyRegistration({ ref, io: { linkSync(a, b) {
    if (String(b).endsWith("000001.json")) {
      injected = true;
      policy.createLivePolicyRegistration({ ref: v1 }).revoke({ expectedDigest: tip.digest, endpointId: "pi/A", operationId: "v1-winner" });
    }
    fs.linkSync(a, b);
  } } });
  expect(() => api.upgrade({ expectedDigest: tip.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64), operationId: "upgrade-loser" })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_CONFIG_CONFLICT" }));
  expect(injected).toBe(true);
  expect(api.reconcile({ runtimeSessionId: "operator" })).toContainEqual({ operationId: "upgrade-loser", sequence: 1, outcome: "COMPETING_COMMIT" });
  expect(policy.readLivePolicy(v1).manifest.registrations[0]!.status).toBe("revoked");
  expect(() => policy.readLivePolicy(ref)).toThrow();
  expect(fs.existsSync(join(root, "000002.json"))).toBe(false);
});
it("classifies a valid competing v2 marker and does not use the old reader", () => {
  const { root, ref: v1 } = fixture(); const tip = policy.readLivePolicy(v1);
  const ref = policy.prepareLivePolicyUpgrade(v1, join(root, "profile.json"));
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const api = policy.createLivePolicyRegistration({ ref, io: { linkSync(a, b) {
    if (String(b).endsWith("000001.json")) {
      // Model another already-prepared writer winning the exclusive slot. Its
      // marker and locator use the real publisher's bytes, with a distinct op.
      const marker = JSON.parse(fs.readFileSync(a, "utf8")); marker.operationId = "v2-winner";
      const bytes = JSON.stringify(marker);
      const originalLocator = join(root, fs.readdirSync(root).find(n => n.endsWith(`${hash("v2-loser")}.json`))!);
      const locator = JSON.parse(fs.readFileSync(originalLocator, "utf8"));
      locator.operationId = marker.operationId; locator.candidateDigest = hash(bytes);
      fs.writeFileSync(join(root, `.live-intent-${hash("operator")}-${hash(marker.operationId)}.json`), JSON.stringify(locator), { mode: 0o600 });
      fs.writeFileSync(b, bytes, { mode: 0o600, flag: "wx" });
    }
    fs.linkSync(a, b);
  } } });
  expect(() => api.upgrade({ expectedDigest: tip.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64), operationId: "v2-loser" })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_CONFIG_CONFLICT" }));
  const before = fs.readdirSync(root);
  expect(api.reconcile({ runtimeSessionId: "operator" })).toEqual(expect.arrayContaining([
    { operationId: "v2-loser", sequence: 1, outcome: "COMPETING_COMMIT" },
    { operationId: "v2-winner", sequence: 1, outcome: "PUBLISHED" },
  ]));
  expect(fs.readdirSync(root)).toEqual(before);
  expect(policy.readLivePolicy(ref).sequence).toBe(1);
  expect(() => policy.readLivePolicy(v1)).toThrow();
});
it.each([0, 2])("rejects wrong pinned upgrade sequence %s", upgradeSequence => {
  const { ref } = upgrade();
  expect(() => policy.readLivePolicy({ ...ref, upgradeSequence })).toThrow();
});
it.each(["malformed-marker", "second-marker", "v1-successor"])("rejects %s without reader fallback", kind => {
  const { root, ref, api, result } = upgrade();
  if (kind === "malformed-marker") {
    const path = join(root, "000001.json"); const e = JSON.parse(fs.readFileSync(path, "utf8")); e.intent.extra = true;
    fs.writeFileSync(path, JSON.stringify(e));
  } else {
    api.setPiHooks({ expectedDigest: result.snapshot.digest, runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, hooks: [] });
    const path = join(root, "000002.json"); const e = JSON.parse(fs.readFileSync(path, "utf8"));
    if (kind === "second-marker") e.intent = JSON.parse(fs.readFileSync(join(root, "000001.json"), "utf8")).intent;
    else e.kind = "ce-live-session-v1";
    fs.writeFileSync(path, JSON.stringify(e));
  }
  expect(() => policy.readLivePolicy(ref)).toThrow();
  expect(() => api.reconcile({ runtimeSessionId: "operator" })).toThrow();
});
it("refuses stale prepared upgrade after an original v1 writer wins", () => {
  const { root, ref: v1 } = fixture(); const tip = policy.readLivePolicy(v1);
  const ref = policy.prepareLivePolicyUpgrade(v1, join(root, "profile.json"));
  policy.createLivePolicyRegistration({ ref: v1 }).revoke({ expectedDigest: tip.digest, endpointId: "pi/A" });
  expect(() => policy.createLivePolicyRegistration({ ref }).upgrade({ expectedDigest: tip.digest, actorRuntimeSessionId: "operator", profileRevision: "a".repeat(64), bindingGeneration: "b".repeat(64) })).toThrow();
  expect(policy.readLivePolicy(v1).sequence).toBe(1);
  expect(() => policy.readLivePolicy(ref)).toThrow();
});
it("new registrations have no hooks, and reauthorization preserves approved hook facts", () => {
  const { api, result } = upgrade();
  let s = api.setPiHooks({ expectedDigest: result.snapshot.digest, runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, hooks: [rule] }).snapshot;
  const r = { endpointId: "pi/B", runtimeSessionId: "B", payloadRead: false, ack: false, presenceDisclosure: false };
  s = api.register({ expectedDigest: s.digest, registration: r }).snapshot;
  expect(s.manifest.registrations[1]).toMatchObject({ hookGeneration: 3, hooks: [] });
  s = api.revoke({ expectedDigest: s.digest, endpointId: "pi/A" }).snapshot;
  s = api.reauthorize({ expectedDigest: s.digest, registration: { ...r, endpointId: "pi/A", runtimeSessionId: "A" } }).snapshot;
  expect(s.manifest.registrations[0]).toMatchObject({ epoch: 2, hookGeneration: 2, hooks: [rule] });
});
it("detects missing operator and Pi hook locators", () => {
  const { root, api, result } = upgrade();
  api.setPiHooks({ expectedDigest: result.snapshot.digest, runtimeSessionId: "A", endpointId: "pi/A", epoch: 1, hooks: [] });
  for (const name of fs.readdirSync(root).filter(n => n.startsWith(".live-intent-"))) fs.unlinkSync(join(root, name));
  expect(() => api.reconcile({ runtimeSessionId: "operator" })).toThrow();
  expect(() => api.reconcile({ runtimeSessionId: "A" })).toThrow();
});
