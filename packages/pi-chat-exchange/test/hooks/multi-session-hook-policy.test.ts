import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";
import { parseHookRules } from "../../src/hooks/config.js";
import * as policy from "../../src/tunnel/multi-session-policy.js";
import { publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { replaceTunnelMcpBindingPath } from "../../src/tunnel/profile.js";
import { multiSessionFixture } from "../tunnel/support/multi-session-fixture.js";

const rule = (adapter = "chatgpt", endpointId = "chatgpt/main", id = "notify") => parseHookRules([{ id, event: CE_MESSAGE_COMMITTED_EVENT, recipient: { adapter, endpointId }, command: "/usr/bin/true" }])[0]!;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
async function fixture() { const f = await multiSessionFixture(); cleanups.push(f.cleanup); return f; }
function publish(f: Awaited<ReturnType<typeof fixture>>, config: policy.MultiSessionSnapshot["config"], manifest: policy.MultiSessionManifest) {
  const pair = publishMessagingGeneration(f.profilePath, config, { ...manifest });
  const text = fs.readFileSync(f.profilePath, "utf8");
  const command = parseTunnelProfile(text).mcpCommand!;
  fs.writeFileSync(f.profilePath, text.replace(command, replaceTunnelMcpBindingPath(command, pair.bindingPath)));
}
function withRules(s: policy.MultiSessionSnapshot, hooks: ReturnType<typeof parseHookRules>): policy.MultiSessionSnapshot {
  return { ...s, manifest: { ...s.manifest, registrations: s.manifest.registrations.map(r => ({ ...r, hooks })) }, config: { ...s.config, hooks: hooks.map(r => ({ ...r, recipient: { adapter: "pi", endpointId: "pi/A" } })) } };
}

describe("multi-session hook policy", () => {
  it("preserves absent schema and projects only the selected registration hooks without grants", async () => {
    const f = await fixture();
    expect(f.selected().manifest.registrations[0]).not.toHaveProperty("hooks");
    const hooks = [rule()];
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: false, ack: false, hooks } });
    const selected = f.selected();
    expect(selected.manifest.registrations[0]!.hooks).toEqual(hooks);
    expect(policy.projectPiRegistration(selected, "real-A")).toMatchObject({ hooks, payloadRead: { enabled: false }, ack: { enabled: false } });
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: false, ack: false } });
    expect(f.selected().manifest.registrations[0]!.hooks).toEqual(hooks);
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: false } });
    expect(policy.projectPiRegistration(f.selected(), "real-B")).not.toHaveProperty("hooks");
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: false, ack: false, hooks: [] } });
    expect(f.selected().manifest.registrations[0]!.hooks).toEqual([]);
  });
  it("retains MCP rules through registration updates and rejects global hook schema", async () => {
    const f = await fixture(); const s = f.selected(); const hooks = [rule("pi", "pi/A")];
    publish(f, { ...s.config, hooks }, s.manifest);
    expect(f.selected().config.hooks).toEqual(hooks);
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: false } });
    expect(f.selected().config.hooks).toEqual(hooks);
    expect(() => policy.parseMultiSessionManifest({ ...s.manifest, hooks: [] })).toThrow();
    expect(() => policy.parseMultiSessionManifest({ ...s.manifest, mcp: { ...s.manifest.mcp, hooks: [] } })).toThrow();
  });
  it("revokes despite MCP hooks and retains only remaining recipient rules without enabling them", async () => {
    const f = await fixture();
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: false, ack: false } });
    const s = f.selected();
    const retained = { ...rule("pi", "pi/B", "retain"), enabled: false };
    publish(f, { ...s.config, hooks: [rule("pi", "pi/A"), retained] }, s.manifest);
    const loaded = f.selected();
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
    const current = f.selected();
    expect(current.manifest.registrations[0]!.status).toBe("revoked");
    expect(current.config.hooks).toEqual([retained]);
    expect(policy.effectiveMcpHookRules(loaded, current)).toEqual([]);
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/B" });
    expect(f.selected().config.hooks).toEqual([]);
    const absent = await fixture();
    await absent.api.revoke({ expectedRevision: absent.api.revision(), endpointId: "pi/A" });
    expect(absent.selected().config).not.toHaveProperty("hooks");
  });
  it.each([["pi", "pi/A"], ["chatgpt", "other"]])("rejects Pi hook recipient %s %s", async (adapter, endpointId) => {
    const f = await fixture(); const s = f.selected();
    expect(() => policy.parseMultiSessionManifest(withRules(s, [rule(adapter, endpointId)]).manifest)).toThrow();
  });
  it.each([["pi", "unknown", false], ["chatgpt", "pi/A", false], ["pi", "pi/A", true]])("rejects invalid MCP recipient %s %s revoked=%s", async (adapter, endpointId, revoked) => {
    const f = await fixture(); const s = f.selected();
    const manifest = { ...s.manifest, registrations: s.manifest.registrations.map(r => ({ ...r, status: revoked ? "revoked" as const : r.status })) };
    publish(f, { ...s.config, recipients: revoked ? [] : s.config.recipients, hooks: [rule(adapter, endpointId)] }, manifest);
    expect(() => f.selected()).toThrow();
  });
  it("intersects exact enabled static rules, returns loaded references and never revives epochs", async () => {
    const f = await fixture(); const a = withRules(f.selected(), [rule()]);
    expect(policy.effectivePiHookRules(a, a, "real-A")[0]).toBe(a.manifest.registrations[0]!.hooks![0]);
    expect(policy.effectiveMcpHookRules(a, a)[0]).toBe(a.config.hooks![0]);
    for (const hooks of [[], [{ ...rule(), enabled: false }], [{ ...rule(), command: "/usr/bin/false" }], [{ ...rule(), args: ["changed"] }], [{ ...rule(), timeoutMs: 1000 }], [rule("chatgpt", "chatgpt/main", "new")]]) {
      const b = withRules(a, hooks);
      expect(policy.effectivePiHookRules(a, b, "real-A")).toEqual([]);
      expect(policy.effectiveMcpHookRules(a, b)).toEqual([]);
    }
    const expanded = withRules(a, [rule(), rule("chatgpt", "chatgpt/main", "new")]);
    expect(policy.effectivePiHookRules(a, expanded, "real-A")).toEqual(a.manifest.registrations[0]!.hooks);
    expect(policy.effectiveMcpHookRules(a, expanded)).toEqual(a.config.hooks);
    const disabled = withRules(a, [{ ...rule(), enabled: false }]);
    expect(policy.effectivePiHookRules(disabled, a, "real-A")).toEqual([]);
    expect(policy.effectiveMcpHookRules(disabled, a)).toEqual([]);
    const different = { ...a, profilePath: `${a.profilePath}.other` };
    expect(() => policy.effectivePiHookRules(a, different, "real-A")).toThrow();
    expect(() => policy.effectiveMcpHookRules(a, different)).toThrow();
    const newer = { ...a, manifest: { ...a.manifest, registrations: a.manifest.registrations.map(r => ({ ...r, epoch: r.epoch + 1 })) } };
    expect(() => policy.effectivePiHookRules(a, newer, "real-A")).toThrow();
    expect(policy.effectiveMcpHookRules(a, newer)).toEqual([]);
    const revoked = { ...a, manifest: { ...a.manifest, registrations: a.manifest.registrations.map(r => ({ ...r, status: "revoked" as const })) } };
    expect(policy.effectiveMcpHookRules(a, revoked)).toEqual([]);
  });
});
