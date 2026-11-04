import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import * as policy from "../../src/tunnel/live-session-policy.js";
import { createBackgroundTunnelManager } from "../../src/tunnel/background-manager.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";
import { createHooksManagement, replaceHookRule, runSafeHookFixture, type HooksManagementOptions } from "../../src/tunnel/hooks-management.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const rule = { id: "notify", event: "ce.message.committed.v1" as const, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/never-execute-personal-command", args: [], timeoutMs: 1000, enabled: false };
function fixture(io?: HooksManagementOptions["io"]) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-hooks-ui-"))); roots.push(dir); fs.chmodSync(dir, 0o700);
  const root = join(dir, "history"); fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(join(dir, ".ce-bindings"), { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml"); const store = { directory: dir, file: "ce.sqlite" }; const exchange = { namespace: "ce", idempotencyKey: "exchange" };
  const endpoint = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const ref = policy.initializeLivePolicy({ root, manifest: { kind: "ce-multi-session-v1", version: 1, identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null }, store, exchange, chatgptEndpoint: endpoint, mcp: { payloadRead: true, ack: true }, registrations: [{ endpointId: "pi/A", runtimeSessionId: "A", epoch: 1, status: "active", payloadRead: true, ack: true }] } });
  const config = parseMcpBindingConfig({ version: 1, store, exchange, endpoint, recipients: [{ adapter: "pi", endpointId: "pi/A" }], lease: { ttlSeconds: 120, renewIntervalSeconds: 30 }, payloadRead: { enabled: true }, ack: { enabled: true }, debugExecutionGuard: { enabled: false }, admissionPolicy: ref });
  const pair = publishMessagingGeneration(profilePath, config, { kind: "ce-live-launch-v1", version: 1, ref });
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456", keyFile: join(dir, "NEVER-READ"), healthUrlFile: join(dir, "health"), mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(dir, "mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const forbidden = () => { throw Error("transport forbidden"); };
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, stateFilePath: join(dir, "state.json"), authorizationDirectory: join(dir, "authorization"), clientPath: join(dir, "client"), listProcesses: async () => ({ kind: "ok", processes: [] }), inspectProcess: async () => ({ kind: "absent" }), spawn: forbidden as never, signal: forbidden as never });
  const api = createHooksManagement({ profilePath, manager, runtimeSessionId: "A", assertCurrent() {}, ...(io === undefined ? {} : { io }) });
  return { dir, ref, profilePath, api, manager };
}
it("validates complete CRUD candidates and never mutates the original array", () => {
  const added = replaceHookRule([], { kind: "add", rule });
  expect(added).toHaveLength(1);
  const enabled = replaceHookRule(added, { kind: "enable", id: rule.id });
  expect(enabled[0]?.enabled).toBe(true); expect(added[0]?.enabled).toBe(false);
  expect(replaceHookRule(enabled, { kind: "disable", id: rule.id })[0]?.enabled).toBe(false);
  expect(replaceHookRule(enabled, { kind: "edit", id: rule.id, rule: { ...rule, args: ["fixed"] } })[0]?.args).toEqual(["fixed"]);
  expect(replaceHookRule(enabled, { kind: "remove", id: rule.id })).toEqual([]);
  expect(() => replaceHookRule(added, { kind: "add", rule })).toThrow();
  expect(() => replaceHookRule(added, { kind: "remove", id: "missing" })).toThrow();
});
it("refuses v1 editing and upgrades the exact history only after explicit confirmation", async () => {
  const f = fixture(); const before = f.api.inspect();
  expect(() => f.api.preview("pi", [rule])).toThrow();
  const upgrade = f.api.previewUpgrade();
  await expect(f.api.save(upgrade, false)).rejects.toThrow();
  expect(f.api.inspect().snapshot.digest).toBe(before.snapshot.digest);
  const result = await f.api.save(upgrade, true);
  expect(result).toMatchObject({ configured: true, adopted: false, eligible: false, executed: false, selection: "selected", policyDurability: "synced" });
  const current = f.api.inspect();
  expect(current.snapshot.ref).toMatchObject({ kind: "ce-live-session-v2", root: f.ref.root, genesisDigest: f.ref.genesisDigest });
  expect(current.snapshot.manifest.registrations[0]?.endpointId).toBe("pi/A");
  const candidate = f.api.preview("pi", [rule]);
  await f.api.save(candidate, true);
  expect(f.api.inspect().piHooks).toEqual([rule]);
});
it("publishes sender consent for full binding and exact target tuples, not receiving hooks", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const incoming = { ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } };
  const candidate = f.api.preview("mcp", [incoming]);
  expect(candidate.targets).toEqual([{ ruleId: "notify", endpointId: "pi/A", runtimeSessionId: "A", epoch: 1 }]);
  const result = await f.api.save(candidate, true);
  expect(result.selection).toBe("selected");
  const current = f.api.inspect(); expect(current.mcpHooks).toEqual([incoming]); expect(current.piHooks).toEqual([]);
  expect(current.snapshot.manifest.mcpHookConsent?.bindingGeneration).toBe(candidate.bindingGeneration);
});
it("saves an enabled MCP rule whose legal ID resembles an identity credential", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const incoming = { ...rule, id: "cap_0123456789abcdef", enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } };
  const candidate = f.api.preview("mcp", [incoming]);
  expect(await f.api.save(candidate, true)).toMatchObject({ configured: true, selection: "selected", policyDurability: "synced" });
  const current = f.api.inspect();
  expect(current.mcpHooks).toEqual([incoming]);
  expect(current.snapshot.manifest.mcpHookConsent?.targets).toEqual([{ ruleId: incoming.id, endpointId: "pi/A", runtimeSessionId: "A", epoch: 1 }]);
});
it("refuses stale preview without rebasing or changing Profile", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const first = f.api.preview("pi", [rule]); const stale = f.api.preview("pi", []);
  await f.api.save(first, true); const profile = fs.readFileSync(f.profilePath, "utf8");
  await expect(f.api.save(stale, true)).rejects.toThrow();
  expect(fs.readFileSync(f.profilePath, "utf8")).toBe(profile);
  expect(f.api.inspect().piHooks).toEqual([rule]);
});
it("safe test runs only its fixed benign fixture", async () => {
  expect(await runSafeHookFixture()).toMatchObject({ executed: true, configuredCommandsExecuted: false, metadataOnly: true, exitCode: 0 });
});
it("retains marker and staged pair when checked Profile rename is uncertain, without retry", async () => {
  let renames = 0;
  const f = fixture({ renameSync() { renames++; throw Error("uncertain rename"); } });
  const original = fs.readFileSync(f.profilePath, "utf8"); const preview = f.api.previewUpgrade();
  const result = await f.api.save(preview, true);
  expect(result).toMatchObject({ configured: true, selection: "pending", policyDurability: "synced", profileDurability: "uncertain" });
  expect(renames).toBe(1); expect(fs.readFileSync(f.profilePath, "utf8")).toBe(original);
  expect(policy.readLivePolicy(preview.ref).manifest.mcpHookConsent?.bindingGeneration).toBe(null);
  expect(fs.existsSync(result.bindingPath!)).toBe(true);
  await expect(f.api.save(preview, true)).rejects.toThrow(); expect(renames).toBe(1);
});
it("reports publication result loss separately and never activates a linked upgrade marker", async () => {
  const f = fixture({ linkSync(source, destination) {
    fs.linkSync(source, destination);
    if (String(destination).endsWith("000001.json")) throw Error("result lost after link");
  } });
  const original = fs.readFileSync(f.profilePath, "utf8"); const preview = f.api.previewUpgrade();
  const result = await f.api.save(preview, true);
  expect(result).toMatchObject({ configured: false, selection: "pending", policyDurability: "unknown", profileDurability: "not-attempted" });
  expect(policy.readLivePolicy(preview.ref).sequence).toBe(1);
  expect(fs.readFileSync(f.profilePath, "utf8")).toBe(original);
  expect(policy.createLivePolicyRegistration({ ref: preview.ref }).reconcile({ runtimeSessionId: "A" })).toContainEqual(expect.objectContaining({ operationId: result.operationId, outcome: "PUBLISHED" }));
});
it("refuses changed target incarnation after consent and leaves published consent inactive", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const original = fs.readFileSync(f.profilePath, "utf8");
  let changed = false; let captures = 0;
  const racing = createHooksManagement({ profilePath: f.profilePath, manager: f.manager, runtimeSessionId: "A", assertCurrent() {
    captures++;
    // Called again in activation verification after successful consent publication.
    if (!changed && captures >= 7) {
      const snapshot = f.api.inspect().snapshot;
      if (snapshot.manifest.mcpHookConsent?.bindingGeneration !== null) {
        changed = true;
        policy.createLivePolicyRegistration({ ref: snapshot.ref }).revoke({ expectedDigest: snapshot.digest, endpointId: "pi/A" });
      }
    }
  } });
  const incoming = { ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } };
  const candidate = racing.preview("mcp", [incoming]);
  const result = await racing.save(candidate, true);
  expect(changed).toBe(true); expect(result).toMatchObject({ configured: true, selection: "pending" });
  expect(fs.readFileSync(f.profilePath, "utf8")).toBe(original);
});
it("rejects cloned or mutated preview handles and profile drift before publication", async () => {
  const f = fixture(); const preview = f.api.previewUpgrade();
  await expect(f.api.save({ ...preview }, true)).rejects.toThrow();
  fs.appendFileSync(f.profilePath, "\n");
  await expect(f.api.save(preview, true)).rejects.toThrow();
  expect(policy.readLivePolicy(f.ref).sequence).toBe(0);
});
it("cancelled native save refuses before any configuration publication", async () => {
  const f = fixture(); const preview = f.api.previewUpgrade();
  const original = fs.readFileSync(f.profilePath, "utf8");
  await expect(f.api.save(preview, true, AbortSignal.abort())).rejects.toThrow();
  expect(policy.readLivePolicy(f.ref).sequence).toBe(0);
  expect(fs.readFileSync(f.profilePath, "utf8")).toBe(original);
});
it("real STOPPED lock refuses externally running Profile without publication", async () => {
  const f = fixture(); const preview = f.api.previewUpgrade();
  const manager = createBackgroundTunnelManager({ env: {}, profilePath: f.profilePath, stateFilePath: join(f.dir, "external-state.json"), authorizationDirectory: join(f.dir, "external-auth"), clientPath: join(f.dir, "client"),
    listProcesses: async () => ({ kind: "ok", processes: [{ pid: 4242, command: `client run --profile-file ${f.profilePath}` }] }) as never,
    inspectProcess: async () => ({ kind: "absent" }), spawn: (() => { throw Error("forbidden"); }) as never, signal: (() => { throw Error("forbidden"); }) as never });
  const blocked = createHooksManagement({ profilePath: f.profilePath, manager, runtimeSessionId: "A", assertCurrent() {} });
  // An external/uncertain process list must never be interpreted as STOPPED.
  const candidate = blocked.previewUpgrade();
  await expect(blocked.save(candidate, true)).rejects.toThrow();
  expect(policy.readLivePolicy(f.ref).sequence).toBe(0);
  expect(preview.expectedDigest).toBe(policy.readLivePolicy(f.ref).digest);
});
function fresh(f: ReturnType<typeof fixture>, io?: HooksManagementOptions["io"]) {
  return createHooksManagement({ profilePath: f.profilePath, manager: f.manager, runtimeSessionId: "A", assertCurrent() {}, ...(io ? { io } : {}) });
}
it("continues a committed upgrade after restart without reading old v1 history or publishing a new slot", async () => {
  const f = fixture({ renameSync() { throw Error("crash"); } });
  const pending = await f.api.save(f.api.previewUpgrade(), true);
  const api = fresh(f); expect(() => api.inspect()).toThrow();
  const preview = api.previewContinuation({ bindingPath: pending.bindingPath!, operationId: pending.operationId });
  const before = fs.readdirSync(f.ref.root).sort();
  expect(preview.kind).toBe("continuation");
  expect(await api.save(preview, true)).toMatchObject({ selection: "selected", operationId: pending.operationId });
  expect(fs.readdirSync(f.ref.root).sort()).toEqual(before);
  const selected = api.inspect(); expect(selected.bindingPath).toBe(pending.bindingPath);
  const again = api.previewContinuation({ bindingPath: pending.bindingPath!, operationId: pending.operationId });
  expect(await api.save(again, true)).toMatchObject({ selection: "unchanged" });
});
it("continues exact sender consent after restart and refuses wrong operation or candidate", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const api = fresh(f, { renameSync() { throw Error("crash"); } });
  const pending = await api.save(api.preview("mcp", [{ ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } }]), true);
  const restart = fresh(f);
  expect(() => restart.previewContinuation({ bindingPath: pending.bindingPath!, operationId: "wrong" })).toThrow();
  expect(() => restart.previewContinuation({ bindingPath: restart.inspect().bindingPath, operationId: pending.operationId })).toThrow();
  const preview = restart.previewContinuation({ bindingPath: pending.bindingPath!, operationId: pending.operationId });
  const before = fs.readdirSync(f.ref.root).sort();
  expect(await restart.save(preview, true)).toMatchObject({ selection: "selected" });
  expect(fs.readdirSync(f.ref.root).sort()).toEqual(before);
});
it("continuation refuses reauthorized targets and superseded consent, including after preview", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const api = fresh(f, { renameSync() { throw Error("crash"); } });
  const pending = await api.save(api.preview("mcp", [{ ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } }]), true);
  const restart = fresh(f); const input = { bindingPath: pending.bindingPath!, operationId: pending.operationId };
  const preview = restart.previewContinuation(input);
  let s = restart.inspect().snapshot; const writer = policy.createLivePolicyRegistration({ ref: s.ref });
  s = writer.revoke({ expectedDigest: s.digest, endpointId: "pi/A" }).snapshot;
  s = writer.reauthorize({ expectedDigest: s.digest, registration: { endpointId: "pi/A", runtimeSessionId: "A", payloadRead: true, ack: true, presenceDisclosure: false } }).snapshot;
  expect(() => restart.previewContinuation(input)).toThrow();
  await expect(restart.save(preview, true)).rejects.toThrow();
  writer.setMcpHooks({ expectedDigest: s.digest, actorRuntimeSessionId: "A", bindingGeneration: "c".repeat(64), targets: [] });
  expect(() => restart.previewContinuation(input)).toThrow();
});
it("continuation refuses missing locator, wrong actor and changed original Profile revision", async () => {
  const f = fixture({ renameSync() { throw Error("crash"); } });
  const pending = await f.api.save(f.api.previewUpgrade(), true);
  const input = { bindingPath: pending.bindingPath!, operationId: pending.operationId };
  const wrongActor = createHooksManagement({ profilePath: f.profilePath, manager: f.manager, runtimeSessionId: "other", assertCurrent() {} });
  expect(() => wrongActor.previewContinuation(input)).toThrow();
  fs.appendFileSync(f.profilePath, "\n"); expect(() => fresh(f).previewContinuation(input)).toThrow();
  const text = fs.readFileSync(f.profilePath, "utf8"); fs.writeFileSync(f.profilePath, text.slice(0, -1));
  for (const name of fs.readdirSync(f.ref.root).filter(n => n.startsWith(".live-intent-"))) fs.unlinkSync(join(f.ref.root, name));
  expect(() => fresh(f).previewContinuation(input)).toThrow();
});
it("explicit continuation reports rename result loss without retry and recognizes selected bytes on another restart", async () => {
  const f = fixture({ renameSync() { throw Error("crash"); } }); const pending = await f.api.save(f.api.previewUpgrade(), true);
  let renames = 0;
  const api = fresh(f, { renameSync(source, destination) { renames++; fs.renameSync(source, destination); throw Error("result lost"); } });
  const input = { bindingPath: pending.bindingPath!, operationId: pending.operationId };
  const preview = api.previewContinuation(input); const before = fs.readdirSync(f.ref.root).sort();
  expect(await api.save(preview, true)).toMatchObject({ selection: "pending", profileDurability: "uncertain" });
  expect(renames).toBe(1); expect(fs.readdirSync(f.ref.root).sort()).toEqual(before);
  const restart = fresh(f); expect(await restart.save(restart.previewContinuation(input), true)).toMatchObject({ selection: "unchanged" });
});
it("continuation rechecks native context and policy-directory durability before selecting", async () => {
  const f = fixture({ renameSync() { throw Error("crash"); } }); const pending = await f.api.save(f.api.previewUpgrade(), true);
  let valid = true;
  const native = createHooksManagement({ profilePath: f.profilePath, manager: f.manager, runtimeSessionId: "A", assertCurrent() { if (!valid) throw Error("native replaced"); } });
  const input = { bindingPath: pending.bindingPath!, operationId: pending.operationId };
  const preview = native.previewContinuation(input); valid = false;
  await expect(native.save(preview, true)).rejects.toThrow();
  const uncertain = fresh(f, { fsyncSync() { throw Error("fsync unavailable"); } });
  expect(await uncertain.save(uncertain.previewContinuation(input), true)).toMatchObject({ selection: "pending", policyDurability: "uncertain", profileDurability: "not-attempted" });
  expect(() => fresh(f).inspect()).toThrow();
});
it("continuation refuses superseded consent even when binding and targets return to identical bytes", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  const pendingApi = fresh(f, { renameSync() { throw Error("crash"); } });
  const incoming = { ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/A" } };
  const pending = await pendingApi.save(pendingApi.preview("mcp", [incoming]), true);
  const api = fresh(f); const input = { bindingPath: pending.bindingPath!, operationId: pending.operationId };
  const preview = api.previewContinuation(input); const s = api.inspect().snapshot;
  policy.createLivePolicyRegistration({ ref: s.ref }).setMcpHooks({ expectedDigest: s.digest, actorRuntimeSessionId: "A", bindingGeneration: preview.bindingGeneration, targets: preview.targets });
  expect(() => api.previewContinuation(input)).toThrow();
  await expect(api.save(preview, true)).rejects.toThrow();
});
it("approves a dynamically registered B without changing static A routing; exact incarnation gates fresh factories", async () => {
  const f = fixture(); await f.api.save(f.api.previewUpgrade(), true);
  let s = f.api.inspect().snapshot; const writer = policy.createLivePolicyRegistration({ ref: s.ref });
  s = writer.register({ expectedDigest: s.digest, registration: { endpointId: "pi/B", runtimeSessionId: "B", payloadRead: true, ack: true, presenceDisclosure: false } }).snapshot;
  const incoming = { ...rule, enabled: true, recipient: { adapter: "pi", endpointId: "pi/B" } };
  const candidate = f.api.preview("mcp", [incoming]);
  expect(candidate.config.recipients).toEqual([{ adapter: "pi", endpointId: "pi/A" }]);
  expect(candidate.targets).toEqual([{ ruleId: rule.id, endpointId: "pi/B", runtimeSessionId: "B", epoch: 1 }]);
  const saved = await f.api.save(candidate, true);
  const { readMessagingGeneration } = await import("../../src/tunnel/messaging-config.js");
  const { createLiveMcpComposition } = await import("../../src/tunnel/live-mcp-composition.js");
  const config = readMessagingGeneration(f.profilePath, saved.bindingPath!)!.config;
  const load = () => createLiveMcpComposition(config, () => policy.readLivePolicy(s.ref), { bindingPath: saved.bindingPath! });
  const original = load(); expect(original.hookAllowed(incoming)).toBe(true);
  s = writer.revoke({ expectedDigest: policy.readLivePolicy(s.ref).digest, endpointId: "pi/B" }).snapshot;
  expect(original.hookAllowed(incoming)).toBe(false); expect(load().hookAllowed(incoming)).toBe(false);
  writer.reauthorize({ expectedDigest: s.digest, registration: { endpointId: "pi/B", runtimeSessionId: "B", payloadRead: true, ack: true, presenceDisclosure: false } });
  expect(load().hookAllowed(incoming)).toBe(false);
});
