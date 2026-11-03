import { beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({ selected: vi.fn(), register: vi.fn(), revision: "revision-1", live: undefined as any, publish: vi.fn(), revoke: vi.fn(), reauthorize: vi.fn(), reconcile: vi.fn(), ceilingBlocked: false }));
vi.mock("../../../dist/tunnel/multi-session-policy.js", () => ({ readSelectedMultiSessionPolicy: () => { if (seam.live) throw Error("live descriptor"); return seam.selected(); },
  createMultiSessionRegistration: () => ({ revision: () => seam.revision, register: seam.register }) }));
vi.mock("node:fs", () => ({ readFileSync: () => "selected-profile" }));
vi.mock("../../../pi-extension/live-session-profile.js", () => ({ readLiveSelectedSessionPolicy: () => { if (seam.ceilingBlocked) throw Error("ceiling"); return seam.live; } }));
vi.mock("../../../dist/tunnel/live-session-policy.js", () => ({ readLivePolicy: () => seam.live, createLivePolicyRegistration: () => ({ register: seam.publish, revoke: seam.revoke, reauthorize: seam.reauthorize, reconcile: seam.reconcile }) }));
vi.mock("../../../pi-extension/multi-session-runtime.js", () => ({ runtimeEnvironment: () => "fixed" }));
vi.mock("../../../dist/tunnel/setup.js", () => ({ readGeneratedPiAllowlist: vi.fn() }));
import { prepareSessionOnboarding } from "../../../pi-extension/session-onboarding.js";
import { runSessionConfiguration } from "../../../pi-extension/multi-session-commands.js";
function fixture() {
  const confirm = vi.fn(async (_title: string, _message: string) => true);
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "native-B" }, ui: { confirm, notify: vi.fn<(message: string, level: string) => void>() } };
  const manager = { refresh: vi.fn(async () => ({ state: "STOPPED", running: false })),
    withProfileConfigurationLock: vi.fn(async (operation: () => unknown) => operation()) };
  return { ctx, confirm, options: { profilePath: "/isolated/profile", signal: new AbortController().signal, manager } };
}
beforeEach(() => {
  vi.clearAllMocks(); seam.ceilingBlocked = false; seam.reconcile.mockReturnValue([]); seam.live = undefined; seam.revision = "revision-1";
  seam.selected.mockImplementation(() => ({ revision: seam.revision, config: {}, manifest: {
    mcp: { payloadRead: true, ack: true }, store: { directory: "/isolated", file: "store.sqlite" }, exchange: { namespace: "test", idempotencyKey: "test" },
    chatgptEndpoint: { endpointId: "chatgpt/main" }, registrations: [] } }));
  seam.register.mockImplementation(async () => { seam.revision = "revision-2"; return { revision: seam.revision, durability: "synced" }; });
});
it("first explicit live registration confirms read, ACK, labels and inherent first-send disclosure without Hooks", async () => {
  seam.live = { ref: { kind: "ce-live-session-v1" }, digest: "digest-1", manifest: seam.selected().manifest };
  seam.publish.mockImplementation(() => { seam.live = { ...seam.live, digest: "digest-2" }; return { durability: "synced", snapshot: seam.live }; });
  const f = fixture();
  expect(await prepareSessionOnboarding(f.ctx, f.options as never)).toBe("registered");
  expect(seam.publish).toHaveBeenCalledWith(expect.objectContaining({ registration: expect.objectContaining({ payloadRead: true, ack: true }) }));
  expect(f.confirm.mock.calls[0]?.[1]).toContain("first join");
  expect(f.confirm.mock.calls[0]?.[1]).toContain("Hooks: none");
});
it("legacy existing registration retains its original grants without another consent", async () => {
  seam.selected.mockReturnValue({ manifest: { registrations: [{ runtimeSessionId: "native-B", status: "active", payloadRead: false, ack: false }] } });
  const f = fixture(); expect(await prepareSessionOnboarding(f.ctx, f.options as never)).toBe("ready");
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.register).not.toHaveBeenCalled();
});
it("liveSessions discloses only the caller identity when discovery is unavailable", async () => {
  seam.selected.mockReturnValue({ manifest: { registrations: [
    { runtimeSessionId: "native-B", endpointId: "pi/B", status: "active", payloadRead: true, ack: true },
    { runtimeSessionId: "hidden-native-A", endpointId: "pi/hidden-A", status: "active" }] } });
  seam.live = { manifest: seam.selected().manifest };
  const f = fixture();
  await runSessionConfiguration("liveSessions", f.ctx, { ...f.options, withTargetAdmission: (operation: () => unknown) => operation() } as never);
  const text = f.ctx.ui.notify.mock.calls[0]?.[0];
  expect(text).toContain("pi/B"); expect(text).not.toContain("hidden"); expect(text).not.toContain("native-B");
  expect(text).toContain("unknown"); expect(seam.register).not.toHaveBeenCalled();
});
it("declining consent publishes nothing", async () => {
  const f = fixture(); f.confirm.mockResolvedValue(false);
  expect(await prepareSessionOnboarding(f.ctx, f.options as never)).toBe("cancelled");
  expect(seam.register).not.toHaveBeenCalled();
});
it("live true/true reuses grants without presence reconsent or publication", async () => {
  seam.live = { manifest: { mcp: { payloadRead: true, ack: true }, registrations: [{ runtimeSessionId: "native-B", status: "active", payloadRead: true, ack: true, presenceDisclosure: false }] } };
  const f = fixture(); expect(await prepareSessionOnboarding(f.ctx, f.options as never)).toBe("ready");
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.publish).not.toHaveBeenCalled();
});
it("live grant upgrade preserves Endpoint and omits Hooks, while presence decline masks telemetry", async () => {
  const hooks = [{ separatelyAuthorized: true }];
  seam.live = { ref: { kind: "ce-live-session-v1" }, digest: "before", manifest: { ...seam.selected().manifest,
    registrations: [{ endpointId: "pi/stable", runtimeSessionId: "native-B", status: "active", epoch: 7, payloadRead: false, ack: true, hooks, presenceDisclosure: false }] } };
  seam.publish.mockImplementation(() => { seam.live = { ...seam.live, digest: "after" }; return { durability: "synced", snapshot: seam.live }; });
  const f = fixture(); f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  expect(await prepareSessionOnboarding(f.ctx, f.options as never)).toBe("registered");
  expect(seam.publish).toHaveBeenCalledWith({ expectedDigest: "before", registration: { endpointId: "pi/stable", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
  expect(seam.live.manifest.registrations[0].hooks).toBe(hooks);
  expect(f.options.manager.refresh).not.toHaveBeenCalled(); expect(f.options.manager.withProfileConfigurationLock).not.toHaveBeenCalled();
});
it("live consent policy drift refuses publication", async () => {
  seam.live = { ref: {}, digest: "before", manifest: seam.selected().manifest };
  const f = fixture(); f.confirm.mockImplementation(async () => { seam.live = { ...seam.live, digest: "changed" }; return true; });
  await expect(prepareSessionOnboarding(f.ctx, f.options as never)).rejects.toMatchObject({ reason: "context-changed" });
  expect(seam.publish).not.toHaveBeenCalled();
});

it("unresolved live publication refuses before another consent or write", async () => {
  seam.live = { ref: {}, digest: "before", manifest: seam.selected().manifest };
  seam.reconcile.mockReturnValue([{ outcome: "NOT_OBSERVED" }]);
  const f = fixture(); await expect(prepareSessionOnboarding(f.ctx, f.options as never)).rejects.toMatchObject({ reason: "durability-uncertain" });
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.publish).not.toHaveBeenCalled();
});
it("selected live global ceiling refusal never publishes", async () => {
  seam.live = { ref: {}, manifest: seam.selected().manifest }; seam.ceilingBlocked = true;
  const f = fixture(); await expect(prepareSessionOnboarding(f.ctx, f.options as never)).rejects.toMatchObject({ reason: "multi-session-policy-required" });
  expect(seam.publish).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
});
it("advanced live register uses same chain and explicit grants without Hooks mutation", async () => {
  seam.live = { ref: {}, digest: "before", manifest: seam.selected().manifest };
  seam.publish.mockReturnValue({ durability: "synced", snapshot: { digest: "after" } });
  const f = fixture();
  await runSessionConfiguration("register pi/B --payload-read --ack", f.ctx, { ...f.options, withTargetAdmission: (op: () => unknown) => op() } as never);
  expect(seam.publish).toHaveBeenCalledWith({ expectedDigest: "before", registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
  expect(f.options.manager.withProfileConfigurationLock).not.toHaveBeenCalled();
});
it("advanced live revoke requires confirmation and publishes on same chain", async () => {
  seam.live = { ref: {}, digest: "before", manifest: { ...seam.selected().manifest, registrations: [{ endpointId: "pi/B", runtimeSessionId: "native-B", status: "active" }] } };
  seam.revoke.mockReturnValue({ durability: "synced", snapshot: { digest: "after" } });
  const f = fixture();
  await runSessionConfiguration("revoke pi/B", f.ctx, { ...f.options, withTargetAdmission: (op: () => unknown) => op() } as never);
  expect(seam.revoke).toHaveBeenCalledWith({ expectedDigest: "before", endpointId: "pi/B" });
});

it("explicit reauthorize confirms exact own tombstone epoch and independent presence", async () => {
  seam.live = { ref: {}, digest: "before", manifest: { ...seam.selected().manifest, registrations: [{ endpointId: "pi/B", runtimeSessionId: "native-B", status: "revoked", epoch: 7 }] } };
  seam.reauthorize.mockReturnValue({ durability: "synced" });
  const f = fixture(); f.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await runSessionConfiguration("reauthorize pi/B --payload-read --ack", f.ctx, { ...f.options, withTargetAdmission: (op: () => unknown) => op() } as never);
  expect(seam.reauthorize).toHaveBeenCalledWith({ expectedDigest: "before", registration: { endpointId: "pi/B", runtimeSessionId: "native-B", payloadRead: true, ack: true, presenceDisclosure: false } });
  expect(f.confirm.mock.calls[0]?.[1]).toContain("7 -> 8");
  expect(seam.publish).not.toHaveBeenCalled(); expect(f.options.manager.withProfileConfigurationLock).not.toHaveBeenCalled();
});
it.each(["active", "foreign", "different-label"])("reauthorize refuses %s before consent", async kind => {
  seam.live = { ref: {}, digest: "before", manifest: { ...seam.selected().manifest, registrations: [{ endpointId: kind === "different-label" ? "pi/other" : "pi/B", runtimeSessionId: kind === "foreign" ? "foreign" : "native-B", status: kind === "active" ? "active" : "revoked", epoch: 7 }] } };
  const f = fixture();
  await expect(runSessionConfiguration("reauthorize pi/B", f.ctx, { ...f.options, withTargetAdmission: (op: () => unknown) => op() } as never)).rejects.toThrow();
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.reauthorize).not.toHaveBeenCalled();
});

it.each([false, true])("disabled global ceiling refuses before confirmation including ready=%s", async ready => {
  seam.live = { manifest: { ...seam.selected().manifest, mcp: { payloadRead: true, ack: false }, registrations: ready ? [{ runtimeSessionId: "native-B", status: "active", payloadRead: true, ack: true }] : [] } };
  const f = fixture(); await expect(prepareSessionOnboarding(f.ctx, f.options as never)).rejects.toMatchObject({ reason: "global-ceiling-disabled" });
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.publish).not.toHaveBeenCalled();
});
it("advanced live registration rejects requested permission beyond global ceiling before consent", async () => {
  seam.live = { ref: {}, digest: "before", manifest: { ...seam.selected().manifest, mcp: { payloadRead: false, ack: true } } };
  const f = fixture(); await expect(runSessionConfiguration("register pi/B --payload-read", f.ctx, { ...f.options, withTargetAdmission: (op: () => unknown) => op() } as never)).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID", field: "messaging.livePolicy.globalCeiling" });
  expect(f.confirm).not.toHaveBeenCalled(); expect(seam.publish).not.toHaveBeenCalled();
});
