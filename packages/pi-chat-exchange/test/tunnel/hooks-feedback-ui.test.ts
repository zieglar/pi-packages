import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, expect, it, vi } from "vitest";
import type { SetupUiContext } from "../../src/tunnel/setup-ui.js";
import { runHooksManagementUi, type HooksManagementUiOptions } from "../../src/tunnel/hooks-management-ui.js";
import { TEST_KEYS } from "./keys-stub.js";

const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const pending = { configured: true, adopted: false, eligible: false, executed: false, selection: "pending", policyDurability: "synced", profileDurability: "uncertain", bindingPath: "/private/candidate", detail: "pending publication", operationId: "op" };
async function start(overrides: Partial<HooksManagementUiOptions> = {}, save = vi.fn(async () => pending)) {
  const h = createTuiHarness({ rows: 70, width: 140 }); live.push(h);
  const candidate = { kind: "pi", config: { hooks: [] } };
  const management = { inspect: () => ({ snapshot: { ref: { kind: "ce-live-session-v2" } }, piHooks: [], mcpHooks: [] }), preview: () => candidate, save };
  const safeTest = vi.fn(async () => ({ executed: true, configuredCommandsExecuted: false, exitCode: 0 }));
  const onProgress = vi.fn();
  const task = runHooksManagementUi({ mode: "tui", hasUI: true, ui: { custom: h.custom } } as unknown as SetupUiContext,
    { management: management as never, keys: TEST_KEYS, safeTest, onProgress, ...overrides });
  await h.waitForOpen(); await flush();
  return { h, task, save, safeTest, onProgress };
}
async function testFixture(s: Awaited<ReturnType<typeof start>>) {
  for (let i = 0; i < 3; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm"); await flush();
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm");
}
async function saveCandidate(s: Awaited<ReturnType<typeof start>>) {
  s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); await flush();
  s.h.press("tui.select.down"); s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); await flush();
  for (let i = 0; i < 60; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm");
}
it.each(["\x1b", "\x03"])("classifies user cancellation %j", async key => {
  const s = await start(); s.h.send(key);
  expect(await s.task).toEqual({ status: "cancelled", reason: "user" });
});
it("classifies the internal timeout", async () => {
  vi.useFakeTimers(); const s = await start(); await vi.advanceTimersByTimeAsync(120_000);
  expect(await s.task).toEqual({ status: "cancelled", reason: "timeout" });
});
it("classifies external cancellation", async () => {
  const controller = new AbortController(); const s = await start({ signal: controller.signal }); controller.abort();
  expect(await s.task).toEqual({ status: "cancelled", reason: "superseded" });
});
it("classifies incomplete disposal", async () => {
  const s = await start(); s.h.dispose();
  expect(await s.task).toEqual({ status: "cancelled", reason: "superseded" });
});
it("refuses a rejected save without exposing the exception", async () => {
  const s = await start({}, vi.fn(async () => { throw new Error("SECRET /private/output"); })); await saveCandidate(s);
  const result = await s.task;
  expect(result).toMatchObject({ status: "refused", detail: expect.stringContaining("pending publication") });
  expect(JSON.stringify(result)).not.toContain("SECRET");
  expect(s.onProgress).toHaveBeenCalledWith("Saving and publishing the Hook candidate");
  expect(s.onProgress.mock.invocationCallOrder[0]).toBeLessThan(s.save.mock.invocationCallOrder[0]!);
});
it("reports fixture failure with safe execution facts", async () => {
  const s = await start({ safeTest: async () => { throw new Error("SECRET /private/output"); } }); await testFixture(s);
  const result = await s.task;
  expect(result).toEqual({ status: "test-failed", detail: expect.stringMatching(/fixed.*fixture.*not.*complet/i) });
  expect(JSON.stringify(result)).toMatch(/configured commands.*personal scripts.*not.*executed/i);
  expect(JSON.stringify(result)).not.toMatch(/SECRET|\/private\/output/);
});
it("reports fixture success after its honest progress message", async () => {
  const s = await start(); await testFixture(s);
  expect(await s.task).toEqual({ status: "tested", executed: true, configuredCommandsExecuted: false });
  expect(s.onProgress).toHaveBeenCalledWith("Running the fixed benign fixture");
  expect(s.onProgress.mock.invocationCallOrder[0]).toBeLessThan(s.safeTest.mock.invocationCallOrder[0]!);
});
it("does not report fixture success after external cancellation", async () => {
  const controller = new AbortController(); let finish!: (value: { executed: boolean; configuredCommandsExecuted: boolean; exitCode: number }) => void;
  const s = await start({ signal: controller.signal, safeTest: () => new Promise(resolve => { finish = resolve; }) });
  await testFixture(s); await flush(); controller.abort(); finish({ executed: true, configuredCommandsExecuted: false, exitCode: 0 });
  expect(await s.task).toEqual({ status: "cancelled", reason: "superseded" });
});
it("preserves all pending save evidence", async () => {
  const s = await start(); await saveCandidate(s);
  expect(await s.task).toEqual({ status: "saved", ...pending });
});
it("distinguishes the explicit Cancel action from ordinary Close", async () => {
  const s = await start();
  for (let i = 0; i < 3; i++) s.h.press("tui.select.down");
  s.h.press("tui.select.confirm"); await flush(); s.h.press("tui.select.confirm");
  expect(await s.task).toEqual({ status: "cancelled", reason: "user" });
  expect(s.safeTest).not.toHaveBeenCalled();
});
it("reports a native menu failure instead of silently treating it as superseded", async () => {
  const result = await runHooksManagementUi({ mode: "tui", hasUI: true, ui: { custom: async () => { throw new Error("private renderer error"); } } } as unknown as SetupUiContext,
    { keys: TEST_KEYS, safeTest: vi.fn() });
  expect(result).toMatchObject({ status: "refused" });
  expect(JSON.stringify(result)).not.toContain("private renderer error");
});
