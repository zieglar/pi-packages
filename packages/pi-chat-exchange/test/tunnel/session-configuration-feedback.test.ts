import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTunnelManager } from "../../dist/tunnel/background-manager.js";
import { TunnelRefusal } from "../../dist/tunnel/codes.js";

const boundary = vi.hoisted(() => ({
  read: vi.fn(), selected: vi.fn(), live: vi.fn(), legacy: vi.fn(),
  register: vi.fn(), revoke: vi.fn(), reauthorize: vi.fn(), reconcile: vi.fn(), convert: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: boundary.read }));
vi.mock("../../pi-extension/live-session-profile.js", () => ({ readLiveSelectedSessionPolicy: boundary.selected }));
vi.mock("../../dist/tunnel/live-session-policy.js", () => ({ createLivePolicyRegistration: boundary.live }));
vi.mock("../../dist/tunnel/multi-session-policy.js", () => ({
  createMultiSessionRegistration: boundary.legacy,
  readSelectedMultiSessionPolicy: () => ({ manifest: { registrations: [], store: { directory: "store", file: "db" }, exchange: { namespace: "exchange", idempotencyKey: "key" }, chatgptEndpoint: { endpointId: "peer" } } }),
}));
import { runSessionConfiguration } from "../../pi-extension/multi-session-commands.js";

function fixture() {
  const controller = new AbortController();
  const ctx = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { confirm: vi.fn().mockResolvedValue(false), notify: vi.fn() } };
  const options = { profilePath: "/controlled/profile", manager: {} as BackgroundTunnelManager, signal: controller.signal, withTargetAdmission: <T>(operation: () => T): T => operation() };
  return { ctx, options, controller };
}
function selectLive(revoked = false) {
  boundary.selected.mockReturnValue({ ref: {}, digest: "digest", manifest: { mcp: { payloadRead: true, ack: true }, registrations: revoked ? [{ runtimeSessionId: "session", endpointId: "endpoint", status: "revoked", epoch: 1 }] : [] } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("CE_ALLOWLIST", "");
  boundary.read.mockReturnValue("controlled profile");
  boundary.reconcile.mockReturnValue([]);
  boundary.live.mockReturnValue({ register: boundary.register, revoke: boundary.revoke, reauthorize: boundary.reauthorize, reconcile: boundary.reconcile });
  boundary.legacy.mockReturnValue({ revision: () => "revision", register: boundary.register, revoke: boundary.revoke, convert: boundary.convert });
  boundary.reauthorize.mockResolvedValue({ durability: "durable" });
});

describe("session configuration feedback", () => {
  it.each([new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "old.field"), new Error("private failure")])("marks live register refusals without exposing underlying details: %s", async error => {
    selectLive();
    boundary.register.mockRejectedValue(error);
    const { ctx, options } = fixture();
    ctx.ui.confirm.mockResolvedValue(true);
    const result = await runSessionConfiguration("register endpoint", ctx, options).catch((failure: unknown) => failure);
    expect(result).toBeInstanceOf(TunnelRefusal);
    expect(result).toMatchObject({ field: "messaging.livePolicy", code: error instanceof TunnelRefusal ? error.code : "CE_TUNNEL_CONFIG_CONFLICT" });
    expect((result as Error).message).not.toContain("private failure");
  });
  it("notifies exactly once when legacy register is declined without publishing", async () => {
    const { ctx, options } = fixture();
    await runSessionConfiguration("register endpoint", ctx, options);
    expect(ctx.ui.notify.mock.calls).toEqual([["ce-tunnel: register cancelled; no configuration was published", "info"]]);
    expect(boundary.register).not.toHaveBeenCalled();
  });
  it.each([false, true])("silently returns after abort during confirmation (live=%s)", async live => {
    if (live) selectLive();
    const { ctx, options, controller } = fixture();
    ctx.ui.confirm.mockImplementation(async () => { controller.abort(); return false; });
    await expect(runSessionConfiguration("register endpoint", ctx, options)).resolves.toBeUndefined();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(boundary.register).not.toHaveBeenCalled();
  });
  it("continues reauthorization when optional presence disclosure is declined", async () => {
    selectLive(true);
    const { ctx, options } = fixture();
    ctx.ui.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await runSessionConfiguration("reauthorize endpoint", ctx, options);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
    expect(boundary.reauthorize).toHaveBeenCalledExactlyOnceWith({ expectedDigest: "digest", registration: { endpointId: "endpoint", runtimeSessionId: "session", payloadRead: false, ack: false, presenceDisclosure: false } });
    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain("reauthorization saved");
  });
  it("preserves the specific global-ceiling recovery field", async () => {
    selectLive();
    boundary.selected.mockReturnValue({ ref: {}, digest: "digest", manifest: { mcp: { payloadRead: false, ack: false }, registrations: [] } });
    const { ctx, options } = fixture();
    await expect(runSessionConfiguration("register endpoint --payload-read", ctx, options)).rejects.toMatchObject({ field: "messaging.livePolicy.globalCeiling" });
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });
});
