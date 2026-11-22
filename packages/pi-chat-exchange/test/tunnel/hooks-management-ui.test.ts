import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { SetupUiContext } from "../../src/tunnel/setup-ui.js";
import { runHooksManagementUi } from "../../src/tunnel/hooks-management-ui.js";
import type { CeHookRule } from "../../src/hooks/config.js";
import { TEST_KEYS } from "./keys-stub.js";
const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); });
const rule = { id: "personal", event: "ce.message.committed.v1" as const, recipient: { adapter: "pi", endpointId: "pi/A" }, command: "/personal/never-run", args: ["arg"], timeoutMs: 1000, enabled: true, scope: "session" as const };
const candidate = { kind: "mcp", profilePath: "/private/profile", profileRevision: "revision", expectedDigest: "tip", runtimeSessionId: "A", ref: { kind: "ce-live-session-v2" }, config: { hooks: [rule] }, document: {}, hooks: [rule], targets: [{ ruleId: "personal", endpointId: "pi/A", runtimeSessionId: "A", epoch: 7 }], bindingGeneration: "exact-pair-hash" };
async function start(mode = "tui", rules = [rule], piPreset?: CeHookRule, workspaceHooks?: readonly CeHookRule[], piHooks: readonly CeHookRule[] = []) {
  const h = createTuiHarness({ rows: 70, width: 140 }); live.push(h);
  const save = vi.fn(async () => ({ configured: true, adopted: false, eligible: false, executed: false, selection: "selected", policyDurability: "synced", profileDurability: "synced", operationId: "op" }));
  const fixture = vi.fn(async () => ({ executed: true, configuredCommandsExecuted: false, exitCode: 0 }));
  const preview = vi.fn(() => candidate);
  const saveWorkspaceDefault = vi.fn(async () => ({ configured: true, adopted: false as const, eligible: false as const, executed: false as const, selection: "unchanged" as const, policyDurability: "synced" as const, profileDurability: "synced" as const, operationId: "workspace-op", piHooks: [piPreset!] }));
  const applyWorkspaceDefault = vi.fn(async () => ({ configured: true, adopted: false as const, eligible: false as const, executed: false as const, selection: "unchanged" as const, policyDurability: "synced" as const, profileDurability: "synced" as const, operationId: "apply-op", piHooks: workspaceHooks ?? [] }));
  const management = { inspect: () => ({ snapshot: { ref: { kind: "ce-live-session-v2" }, manifest: { chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" } } }, piHooks, mcpHooks: rules }), preview, previewUpgrade: vi.fn(() => candidate), save };
  const ctx = { mode, hasUI: true, ui: { custom: h.custom } } as unknown as SetupUiContext;
  const task = runHooksManagementUi(ctx, { management: management as never, keys: TEST_KEYS, safeTest: fixture as never, saveWorkspaceDefault, applyWorkspaceDefault,
    ...(piPreset === undefined ? {} : { piPreset }), ...(workspaceHooks === undefined ? {} : { workspaceProfile: { revision: 3, hooks: workspaceHooks } }) });
  if (mode === "tui") { await h.waitForOpen(); for (let i = 0; i < 40; i++) await Promise.resolve(); }
  return { h, save, saveWorkspaceDefault, applyWorkspaceDefault, fixture, preview, management, task };
}
it("adds an Agent Desktop preset through the existing full review", async () => {
  const preset = { ...rule, id: "desktop", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, scope: "workspace" as const };
  const s = await start("tui", [], preset);
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("Add Agent Desktop wake preset");
  s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("workspace default consent"); expect(s.preview).toHaveBeenCalledWith("pi", [preset]);
  s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "saved", saveMode: "workspace", operationId: "workspace-op" });
  expect(s.saveWorkspaceDefault).toHaveBeenCalledWith(candidate, expect.any(AbortSignal));
  expect(s.save).not.toHaveBeenCalled();
});
it("offers an explicit workspace update for a canonical Agent Desktop rule with stale status", async () => {
  const preset = { ...rule, id: "desktop", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, scope: "workspace" as const,
    status: { label: "Desktop", command: "/personal/status", args: [], timeoutMs: 2000 } };
  const { status: _status, ...stale } = preset;
  const s = await start("tui", [], preset, [stale], [stale]);
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("Update Agent Desktop status preset");
  expect(s.h.render().join("\n")).not.toContain("Add Agent Desktop wake preset");
  s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("workspace default consent");
  expect(s.preview).toHaveBeenCalledWith("pi", [preset]);
  s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "saved", saveMode: "workspace" });
});
it("does not offer the Desktop status update for a conflicting rule with the same id", async () => {
  const preset = { ...rule, id: "desktop", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, scope: "workspace" as const,
    status: { label: "Desktop", command: "/personal/status", args: [], timeoutMs: 2000 } };
  const { status: _status, ...withoutStatus } = preset;
  const conflict = { ...withoutStatus, command: "/different/command" };
  const s = await start("tui", [], preset, [conflict], [conflict]);
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  const text = s.h.render().join("\n");
  expect(text).not.toContain("Update Agent Desktop status preset");
  expect(text).toContain("Add Agent Desktop wake preset");
  s.h.send("\x1b"); await s.task;
  expect(s.saveWorkspaceDefault).not.toHaveBeenCalled();
});
it("applies the committed workspace rules only to the current Session", async () => {
  const workspace = { ...rule, id: "desktop", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, scope: "workspace" as const };
  const s = await start("tui", [], undefined, [workspace]);
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("Apply workspace Hooks to this Session");
  for (let i = 0; i < 4; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("apply workspace default");
  expect(s.preview).toHaveBeenCalledWith("pi", [workspace]);
  s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "saved", saveMode: "apply", operationId: "apply-op" });
  expect(s.applyWorkspaceDefault).toHaveBeenCalledWith(candidate, expect.any(AbortSignal));
});
it("native manager defaults to close and lists both directions without saving or execution", async () => {
  const s = await start(); const text = s.h.render().join("\n");
  expect(text).toContain("Pi → ChatGPT"); expect(text).toContain("ChatGPT → Pi");
  expect(text).toContain("Configured != adopted != eligible != executed");
  s.h.press("tui.select.confirm"); expect(await s.task).toMatchObject({ status: "closed" });
  expect(s.save).not.toHaveBeenCalled(); expect(s.fixture).not.toHaveBeenCalled();
});
it("headless inspection opens no grant UI", async () => {
  const s = await start("print"); expect(await s.task).toMatchObject({ status: "inspect-only" });
  expect(s.save).not.toHaveBeenCalled(); expect(s.fixture).not.toHaveBeenCalled();
});
it("safe test has its own explicit confirmation and never previews configured commands", async () => {
  const s = await start();
  for (let i = 0; i < 3; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm");
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("fixed benign fixture");
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "tested", executed: true, configuredCommandsExecuted: false });
  expect(s.fixture).toHaveBeenCalledOnce(); expect(s.save).not.toHaveBeenCalled(); expect(s.preview).not.toHaveBeenCalled();
});
it("saving the reviewed candidate passes the exact candidate to the management surface", async () => {
  const s = await start();
  s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.confirm");
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("ChatGPT → Pi");
  for (let i = 0; i < 3; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm");
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(s.h.render().join("\n")).toContain("Session consent");
  for (let i = 0; i < 60; i++) s.h.press("tui.select.down");
  expect(s.h.render().join("\n")).toContain("exact-pair-hash");
  s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "saved", saveMode: "session", configured: true, adopted: false, eligible: false, executed: false });
  expect(s.preview).toHaveBeenCalledWith("mcp", [rule]);
  expect(s.save).toHaveBeenCalledWith(candidate, true, expect.any(AbortSignal));
});
it("offers restricted reconciliation when a published marker makes normal v1 inspect fail", async () => {
  const h = createTuiHarness({ rows: 70, width: 140 }); live.push(h);
  const continuation = { ...candidate, kind: "continuation", continuation: { bindingPath: "/exact/pair", operationId: "published-op", publicationKind: "upgrade", sequence: 1 } };
  const previewContinuation = vi.fn(() => continuation);
  const save = vi.fn(async () => ({ configured: true, adopted: false, eligible: false, executed: false, selection: "selected", policyDurability: "synced", profileDurability: "synced", operationId: "published-op" }));
  const management = { inspect() { throw Error("v1 reader correctly refused marker"); }, previewContinuation, save };
  const task = runHooksManagementUi({ mode: "tui", hasUI: true, ui: { custom: h.custom } } as unknown as SetupUiContext, { management: management as never, keys: TEST_KEYS, safeTest: vi.fn(), loadedAudit: { snapshot: { configured: 1, active: 1, rules: [rule] }, source: "loaded-process", invalid: false } });
  await h.waitForOpen(); for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(h.render().join("\n")).toContain("Restricted reconciliation only");
  expect(h.render().join("\n")).not.toContain("Safe test");
  expect(h.render().join("\n")).toContain("Loaded rules · this Pi process");
  h.press("tui.select.down"); h.press("tui.select.down"); h.press("tui.select.confirm");
  for (let i = 0; i < 40; i++) await Promise.resolve();
  h.send("\x15"); h.type(JSON.stringify({ bindingPath: "/exact/pair", operationId: "published-op" })); h.press("tui.input.submit");
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(h.render().join("\n")).toContain("Continue published configuration");
  expect(save).not.toHaveBeenCalled();
  h.press("tui.select.confirm"); expect(await task).toMatchObject({ status: "saved", operationId: "published-op" });
  expect(previewContinuation).toHaveBeenCalledWith({ bindingPath: "/exact/pair", operationId: "published-op" });
  expect(save).toHaveBeenCalledWith(continuation, true, expect.any(AbortSignal));
});

it.each(["cancel", "add", "review"])("valid Hook id %s remains selectable for toggle and remove", async id => {
  for (const operation of ["toggle", "remove"]) {
    const current = { ...rule, id }; const s = await start("tui", [current]);
    s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.confirm");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    s.h.press("tui.select.down"); s.h.press("tui.select.confirm");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(s.h.render().join("\n")).toContain(`Hook · ${id}`);
    for (let i = 0; i < (operation === "toggle" ? 2 : 3); i++) s.h.press("tui.select.down");
    s.h.press("tui.select.confirm"); for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(s.preview).toHaveBeenCalledWith("mcp", operation === "toggle" ? [{ ...current, enabled: false }] : []);
    s.h.send("\x1b"); await s.task; expect(s.save).not.toHaveBeenCalled();
  }
});
