import fs from "node:fs";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { multiSessionFixture } from "../../tunnel/support/multi-session-fixture.js";
import { createBackgroundTunnelManager } from "../../../src/tunnel/background-manager.js";
import { prepareSessionOnboarding, SessionOnboardingRefusal } from "../../../pi-extension/session-onboarding.js";

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.unstubAllEnvs(); });
async function setup() {
  const f = await multiSessionFixture(); cleanups.push(f.cleanup);
  let session = "new-session";
  const confirm = vi.fn(async () => true);
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => session }, ui: { confirm, notify: vi.fn() } };
  const spawn = vi.fn((): never => { throw Error("NO SPAWN"); });
  const signalProcess = vi.fn((): never => { throw Error("NO SIGNAL"); });
  let inventory: "ok" | "unknown" = "ok";
  const manager = createBackgroundTunnelManager({ profilePath: f.profilePath, env: {},
    listProcesses: async () => inventory === "ok" ? { kind: "ok", processes: [] } : { kind: "unknown" }, spawn, signal: signalProcess });
  cleanups.push(() => { void manager.dispose(); });
  const options = { profilePath: f.profilePath, manager, signal: new AbortController().signal };
  return { ...f, ctx, options, confirm, spawn, signalProcess, session: (s: string) => { session = s; }, unknown: () => { inventory = "unknown"; } };
}

describe("session onboarding", () => {
  it("publishes a stable minimum-grant registration once, then returns ready without confirmation", async () => {
    const f = await setup();
    expect(await prepareSessionOnboarding(f.ctx, f.options)).toBe("registered");
    const endpointId = "pi/session-" + createHash("sha256").update(JSON.stringify(["ce-session-onboarding-v1", "new-session"])).digest("hex").slice(0, 32);
    expect(f.selected().manifest.registrations.find(r => r.runtimeSessionId === "new-session")).toEqual({ endpointId, runtimeSessionId: "new-session", epoch: 1, status: "active", payloadRead: false, ack: false });
    const preview = f.confirm.mock.calls[0] as unknown as [string, string];
    for (const value of [endpointId, "Store:", "Exchange:", "Peer:", "Payload read: disabled", "ACK: disabled", "Hooks: none"]) expect(preview[1]).toContain(value);
    const revision = f.selected().revision;
    expect(await prepareSessionOnboarding(f.ctx, f.options)).toBe("ready");
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.selected().revision).toBe(revision);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.signalProcess).not.toHaveBeenCalled();
  });
  it("cancellation publishes nothing", async () => {
    const f = await setup(); const before = fs.readFileSync(f.profilePath, "utf8");
    f.confirm.mockResolvedValue(false);
    expect(await prepareSessionOnboarding(f.ctx, f.options)).toBe("cancelled");
    expect(fs.readFileSync(f.profilePath, "utf8")).toBe(before);
    expect(f.selected().manifest.registrations).toHaveLength(1);
  });
  it("rejects session drift while confirmation is pending", async () => {
    const f = await setup(); const revision = f.selected().revision;
    f.confirm.mockImplementation(async () => { f.session("other-session"); return true; });
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "context-changed" });
    expect(f.selected().revision).toBe(revision);
  });
  it("rejects environment and revision drift after confirmation", async () => {
    const f = await setup(); const revision = f.selected().revision;
    f.confirm.mockImplementation(async () => { vi.stubEnv("CE_STORE_FILE", "changed.sqlite"); return true; });
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "context-changed" });
    expect(f.selected().revision).toBe(revision);
    vi.unstubAllEnvs();
    f.confirm.mockImplementation(async () => { fs.appendFileSync(f.profilePath, "\n"); return true; });
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "context-changed" });
    expect(f.selected().manifest.registrations).toHaveLength(1);
  });
  it("fences session drift inside the real configuration lock", async () => {
    const f = await setup(); const revision = f.selected().revision;
    const lock = f.options.manager.withProfileConfigurationLock.bind(f.options.manager);
    f.options.manager.withProfileConfigurationLock = operation => lock(guard => { f.session("drift-at-lock"); return operation(guard); });
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "context-changed" });
    expect(f.selected().revision).toBe(revision);
  });
  it("refuses a running transport without stopping or starting it", async () => {
    const f = await setup(); const revision = f.selected().revision;
    const measured = await f.options.manager.refresh();
    vi.spyOn(f.options.manager, "refresh").mockResolvedValue({ ...measured, state: "CONNECTED", running: true, evidence: "health-probe" });
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "transport-running", message: expect.stringContaining("Stop then Connect") });
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.selected().revision).toBe(revision);
    expect(f.spawn).not.toHaveBeenCalled(); expect(f.signalProcess).not.toHaveBeenCalled();
  });
  it("keeps UNKNOWN distinct from a running transport", async () => {
    const f = await setup(); f.unknown();
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "transport-unknown" });
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("never restores a revoked session", async () => {
    const f = await setup(); f.session("real-A");
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
    const revision = f.selected().revision;
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "registration-revoked" });
    expect(f.selected().revision).toBe(revision); expect(f.confirm).not.toHaveBeenCalled();
  });
  it("never overwrites a generated endpoint collision, including a tombstone", async () => {
    const f = await setup();
    const endpointId = "pi/session-" + createHash("sha256").update(JSON.stringify(["ce-session-onboarding-v1", "new-session"])).digest("hex").slice(0, 32);
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId, runtimeSessionId: "different-session", payloadRead: true, ack: true } });
    for (const revoked of [false, true]) {
      if (revoked) await f.api.revoke({ expectedRevision: f.api.revision(), endpointId });
      const revision = f.selected().revision;
      await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "endpoint-collision" });
      expect(f.selected().revision).toBe(revision);
    }
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("refuses legacy override and missing multi-session policy explicitly", async () => {
    const f = await setup(); vi.stubEnv("CE_ALLOWLIST", "/unused/legacy.json");
    await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "legacy-override" });
    vi.unstubAllEnvs();
    await expect(prepareSessionOnboarding(f.ctx, { ...f.options, profilePath: f.profilePath + ".missing" })).rejects.toMatchObject({ reason: "multi-session-policy-required" });
    expect(f.confirm).not.toHaveBeenCalled();
  });
  it("throws on uncertain post-commit durability without retrying publication", async () => {
    const f = await setup();
    const rename = fs.renameSync.bind(fs); const sync = fs.fsyncSync.bind(fs);
    let committed = false;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to); if (to === f.profilePath) committed = true;
    });
    const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { if (committed) throw Error("injected durability failure"); sync(fd); });
    try {
      await expect(prepareSessionOnboarding(f.ctx, f.options)).rejects.toMatchObject({ reason: "durability-uncertain" });
      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(f.selected().manifest.registrations.filter(r => r.runtimeSessionId === "new-session")).toHaveLength(1);
      expect(f.confirm).toHaveBeenCalledTimes(1);
    } finally { renameSpy.mockRestore(); syncSpy.mockRestore(); }
  });
  it("requires interactive confirmation and honors pre-cancellation", async () => {
    const f = await setup();
    await expect(prepareSessionOnboarding({ ...f.ctx, hasUI: false }, f.options)).rejects.toBeInstanceOf(SessionOnboardingRefusal);
    const controller = new AbortController(); controller.abort();
    expect(await prepareSessionOnboarding(f.ctx, { ...f.options, signal: controller.signal })).toBe("cancelled");
    expect(f.confirm).not.toHaveBeenCalled();
  });
});
