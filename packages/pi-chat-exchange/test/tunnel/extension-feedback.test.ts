import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  refresh: vi.fn(), stop: vi.fn(), hooks: vi.fn(), configure: vi.fn(),
  native: vi.fn(), onboarding: vi.fn(), live: false,
  manager: vi.fn(),
}));
vi.mock("../../dist/runtime/native-readiness.js", async original => ({
  ...await original<object>(), assertNativeReadyForTunnel: vi.fn(),
  runNativeCommandOutcome: (...args: unknown[]) => seam.native(...args),
}));
vi.mock("../../dist/tunnel/background-manager.js", async original => ({
  ...await original<object>(), createBackgroundTunnelManager: () => ({
    kind: "real-background", profilePath: () => process.env.CE_TUNNEL_PROFILE,
    authorizationStatus: () => "environment", runId: () => "owned-test-run",
    status: () => ({ label: "Tunnel · measured", state: "STOPPED" }),
    refresh: seam.refresh, stop: seam.stop,
  }),
}));
vi.mock("../../dist/tunnel/manager-ui.js", async original => ({
  ...await original<object>(), runTunnelManagerUi: (...args: unknown[]) => seam.manager(...args),
}));
vi.mock("../../dist/tunnel/hooks-management-ui.js", () => ({ runHooksManagementUi: (...args: unknown[]) => seam.hooks(...args) }));
vi.mock("../../pi-extension/multi-session-commands.js", () => ({ runSessionConfiguration: (...args: unknown[]) => seam.configure(...args) }));
vi.mock("../../pi-extension/session-onboarding.js", async original => ({
  ...await original<object>(), prepareSessionOnboarding: (...args: unknown[]) => seam.onboarding(...args),
}));
vi.mock("../../pi-extension/live-session-profile.js", async original => ({
  ...await original<object>(), readLiveSelectedSessionPolicy: () => seam.live ? {
    ref: { kind: "ce-live-session-v2" }, digest: "test-digest",
    manifest: { registrations: [], mcp: {}, chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" } },
  } : undefined,
  projectLivePiRegistration: () => ({}),
}));
vi.mock("../../dist/tunnel/live-session-policy.js", async original => ({
  ...await original<object>(), readLivePolicy: () => ({ ref: {}, digest: "new-digest", manifest: { registrations: [] } }),
}));
const dirs: string[] = [];
beforeEach(() => {
  seam.live = false; seam.refresh.mockReset().mockResolvedValue({ state: "STOPPED", evidence: "none" });
  seam.stop.mockReset().mockResolvedValue(undefined); seam.hooks.mockReset(); seam.configure.mockReset();
  seam.native.mockReset().mockResolvedValue({ kind: "failed", message: "Native command failed (CE_NATIVE_DISCOVERY_FAILED). Current selection was not changed." });
  seam.onboarding.mockReset().mockResolvedValue("registered");
  seam.manager.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function pending<T>() { let resolve!: (x: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(live = false) {
  const dir = mkdtempSync(join(tmpdir(), "ce-feedback-")); dirs.push(dir);
  const profile = join(dir, "profile.yaml"); writeFileSync(profile, "fixture", { mode: 0o600 });
  vi.stubEnv("CE_ALLOWLIST", "/dev/null"); vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", ""); vi.stubEnv("CE_TUNNEL_PROFILE", profile);
  if (live) { seam.live = true; vi.stubEnv("CE_ALLOWLIST", ""); }
  const commands = new Map<string, any>(); const events = new Map<string, any>(); const appendEntry = vi.fn();
  const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: (n: string, h: unknown) => events.set(n, h), registerCommand: (n: string, c: unknown) => commands.set(n, c), registerTool() {}, appendEntry } as any);
  let session = "test-session";
  const ui = { notify: vi.fn(), setStatus: vi.fn(), custom: vi.fn(async () => undefined), confirm: vi.fn(async () => false) };
  const ctx = { mode: "tui", hasUI: true, cwd: dir, ui, reload: vi.fn(async () => undefined),
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => [], getEntries: () => [] } };
  return { ui, ctx, events, appendEntry, commands, changeSession: () => { session = "replacement"; }, command: commands.get("ce-tunnel") };
}
const active = (ui: any) => ui.setStatus.mock.calls.filter(([key, text]: [string, unknown]) => key.startsWith("ce-operation") && typeof text === "string");

it("shows Stop activity while exit verification is pending and clears it at completion", async () => {
  const f = await fixture(); const wait = pending<void>(); seam.stop.mockReturnValue(wait.promise);
  const task = f.command.handler("stop", f.ctx); await Promise.resolve();
  expect(active(f.ui).map(([, text]: any) => text).join(" ")).toMatch(/stop|exit/i);
  wait.resolve(); await task;
  const [key] = active(f.ui)[0]; expect(f.ui.setStatus).toHaveBeenLastCalledWith(key, undefined);
  expect(seam.stop).toHaveBeenCalledOnce();
});
it("reports a declined Disconnect exactly once without stopping transport", async () => {
  const f = await fixture(); await f.command.handler("disconnect", f.ctx);
  expect(f.ui.notify.mock.calls.filter(([s]) => /disconnect cancelled/i.test(s))).toHaveLength(1);
  expect(seam.stop).not.toHaveBeenCalled();
});
it("shows Status measurement activity while refresh is pending", async () => {
  const f = await fixture(); const wait = pending<any>(); seam.refresh.mockReturnValue(wait.promise);
  const task = f.command.handler("status", f.ctx); await Promise.resolve();
  expect(active(f.ui).map(([, text]: any) => text).join(" ")).toMatch(/measur|status/i);
  wait.resolve({ state: "STOPPED", evidence: "none" }); await task;
});
it("maps a Native failure to warning/error and clears activity", async () => {
  const f = await fixture(); await f.commands.get("ce-native").handler("check-updates", f.ctx);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Native command failed"), "warning");
  expect(active(f.ui)).not.toHaveLength(0);
});
it("classifies Hooks fixture failure as test failure", async () => {
  const f = await fixture(); seam.hooks.mockResolvedValue({ status: "test-failed", detail: "Fixed benign fixture test failed; configured commands were not executed." });
  await f.commands.get("ce-hooks").handler("", f.ctx);
  expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("fixture test failed"), "warning");
});
it("suppresses late Hooks test success after the session changes", async () => {
  const f = await fixture(); const wait = pending<any>(); seam.hooks.mockReturnValue(wait.promise);
  const task = f.commands.get("ce-hooks").handler("", f.ctx); await Promise.resolve(); f.changeSession();
  wait.resolve({ status: "tested", executed: true, configuredCommandsExecuted: false }); await task;
  expect(f.ui.notify.mock.calls.some(([text]) => /fixed fixture executed=true/.test(text))).toBe(false);
});
it("gives live configuration errors a recovery hint without suggesting Stop", async () => {
  const f = await fixture(); const { TunnelRefusal } = await import("../../dist/tunnel/codes.js");
  seam.configure.mockRejectedValue(new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "messaging.livePolicy"));
  await f.command.handler("register pi/test", f.ctx);
  const message = f.ui.notify.mock.calls.map(([text]) => text).join(" ");
  expect(message).toMatch(/live policy/i); expect(message).not.toMatch(/explicit Stop|verified STOPPED/i);
});
it("reports the saved registration before Reload and retains that fact if Reload fails", async () => {
  const f = await fixture(true); f.ctx.reload.mockRejectedValue(new Error("private reload failure"));
  await f.command.handler("connect", f.ctx);
  const messages = f.ui.notify.mock.calls.map(([text]) => String(text));
  expect(messages.some(text => /configuration saved; reloading Pi policy/i.test(text)), messages.join("\n")).toBe(true);
  expect(messages.some(text => /configuration was saved, but Pi reload failed/i.test(text))).toBe(true);
  expect(messages.join(" ")).not.toContain("private reload failure");
  expect(f.ctx.reload).toHaveBeenCalledOnce(); expect(seam.stop).not.toHaveBeenCalled();
});
it("clears in-flight feedback on teardown and suppresses late Native success", async () => {
  const f = await fixture(); const wait = pending<any>(); seam.native.mockReturnValue(wait.promise);
  const task = f.commands.get("ce-native").handler("check-updates", f.ctx); await Promise.resolve();
  await f.events.get("session_shutdown")({ reason: "exit" }, f.ctx);
  const writes = f.ui.setStatus.mock.calls.length; const notices = f.ui.notify.mock.calls.length;
  wait.resolve({ kind: "ok", message: "late native success" }); await task;
  expect(f.ui.setStatus).toHaveBeenCalledTimes(writes); expect(f.ui.notify).toHaveBeenCalledTimes(notices);
});
it("clears Stop activity and suppresses its late result after teardown", async () => {
  const f = await fixture(); const wait = pending<void>(); seam.stop.mockReturnValue(wait.promise);
  const task = f.command.handler("stop", f.ctx); await Promise.resolve();
  await f.events.get("session_shutdown")({ reason: "exit" }, f.ctx);
  const notices = f.ui.notify.mock.calls.length; const writes = f.ui.setStatus.mock.calls.length;
  wait.resolve(); await task;
  expect(f.ui.notify).toHaveBeenCalledTimes(notices); expect(f.ui.setStatus).toHaveBeenCalledTimes(writes);
});
it("suppresses a late configuration refusal after the session changes", async () => {
  const f = await fixture(); const wait = pending<any>(); seam.configure.mockReturnValue(wait.promise);
  const task = f.command.handler("register pi/test", f.ctx); await Promise.resolve(); f.changeSession();
  const notices = f.ui.notify.mock.calls.length;
  wait.reject(new Error("private configuration failure")); await task;
  expect(f.ui.notify).toHaveBeenCalledTimes(notices);
  expect(f.ui.notify.mock.calls.map(([text]) => String(text)).join(" ")).not.toMatch(/explicit Stop|verified STOPPED/);
});
it("suppresses Status state writes and notifications after teardown while Manager is open", async () => {
  const f = await fixture();
  seam.manager.mockImplementation((_ctx, _ports, options) => new Promise(resolve => {
    options.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true });
  }));
  const managerTask = f.command.handler("", f.ctx); await Promise.resolve();
  const wait = pending<any>(); seam.refresh.mockReturnValue(wait.promise);
  const statusTask = f.command.handler("status", f.ctx); await Promise.resolve();
  await f.events.get("session_shutdown")({ reason: "exit" }, f.ctx); await managerTask;
  const notices = f.ui.notify.mock.calls.length; const writes = f.ui.setStatus.mock.calls.length;
  wait.resolve({ state: "STOPPED", evidence: "none" }); await statusTask;
  expect(f.ui.notify).toHaveBeenCalledTimes(notices); expect(f.ui.setStatus).toHaveBeenCalledTimes(writes);
});
