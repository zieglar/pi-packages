import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { SetupUiContext } from "../../src/tunnel/setup-ui.js";
import { runHooksManagementUi } from "../../src/tunnel/hooks-management-ui.js";
import { TEST_KEYS } from "./keys-stub.js";
const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); });
const rule = { id: "personal", event: "ce.message.committed.v1" as const, recipient: { adapter: "pi", endpointId: "pi/A" }, command: "/personal/never-run", args: ["arg"], timeoutMs: 1000, enabled: true };
const candidate = { kind: "mcp", profilePath: "/private/profile", profileRevision: "revision", expectedDigest: "tip", runtimeSessionId: "A", ref: { kind: "ce-live-session-v2" }, config: { hooks: [rule] }, document: {}, hooks: [rule], targets: [{ ruleId: "personal", endpointId: "pi/A", runtimeSessionId: "A", epoch: 7 }], bindingGeneration: "exact-pair-hash" };
async function start(mode = "tui", rules = [rule]) {
  const h = createTuiHarness({ rows: 70, width: 140 }); live.push(h);
  const save = vi.fn(async () => ({ configured: true, adopted: false, eligible: false, executed: false, selection: "selected", policyDurability: "synced", profileDurability: "synced", operationId: "op" }));
  const fixture = vi.fn(async () => ({ executed: true, configuredCommandsExecuted: false, exitCode: 0 }));
  const preview = vi.fn(() => candidate);
  const management = { inspect: () => ({ snapshot: { ref: { kind: "ce-live-session-v2" }, manifest: { chatgptEndpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" } } }, piHooks: [], mcpHooks: rules }), preview, previewUpgrade: vi.fn(() => candidate), save };
  const ctx = { mode, hasUI: true, ui: { custom: h.custom } } as unknown as SetupUiContext;
  const task = runHooksManagementUi(ctx, { management: management as never, keys: TEST_KEYS, safeTest: fixture as never });
  if (mode === "tui") { await h.waitForOpen(); for (let i = 0; i < 40; i++) await Promise.resolve(); }
  return { h, save, fixture, preview, management, task };
}
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
  expect(s.h.render().join("\n")).toContain("full candidate consent");
  for (let i = 0; i < 60; i++) s.h.press("tui.select.down");
  expect(s.h.render().join("\n")).toContain("exact-pair-hash");
  s.h.press("tui.select.confirm");
  expect(await s.task).toMatchObject({ status: "saved", configured: true, adopted: false, eligible: false, executed: false });
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
