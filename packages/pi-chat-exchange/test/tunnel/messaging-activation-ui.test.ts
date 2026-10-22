import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_KEYS } from "./keys-stub.js";
import type { SetupUiContext } from "../../src/tunnel/setup-ui.js";

const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); vi.useRealTimers(); });
const view = { piSessionId: "exact-current-session", piEndpointId: "pi/target", chatgptEndpointId: "chatgpt/target", storeDirectory: "/actual/store", storeFile: "/actual/store/ce.sqlite", exchangeNamespace: "actual-namespace", exchangeIdempotencyKey: "actual-key", payloadRead: true, ack: true, policyLoaded: true, oldEndpointId: "pi/old" };
async function tick() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
async function start(overrides = {}, signal?: AbortSignal) {
  const url = new URL("../../src/tunnel/messaging-activation-ui.js", import.meta.url).href;
  const mod = await import(url).catch(() => undefined);
  expect(mod, "activation UI module exists").toBeDefined();
  const h = createTuiHarness({ rows: 60, width: 160 }); live.push(h);
  let dispose = () => {};
  const custom: typeof h.custom = (factory, options) => h.custom((...args) => {
    const component = factory(...args);
    if (!(component instanceof Promise)) dispose = () => component.dispose?.();
    return component;
  }, options);
  const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as SetupUiContext;
  const task = mod!.confirmMessagingActivation(ctx, { view: { ...view, ...overrides }, keys: TEST_KEYS, ...(signal ? { signal } : {}) });
  await h.waitForOpen(); await tick();
  return { h, task, dispose: () => dispose() };
}
describe("messaging activation confirmation", () => {
  it("shows all actual values and safety boundaries; Enter defaults to cancel", async () => {
    const s = await start(); const text = s.h.render().join("\n");
    for (const value of Object.values(view).filter((v) => typeof v === "string")) expect(text).toContain(value);
    expect(text).toContain("reception only"); expect(text).toContain("Pi-bound != Connected != real Gate");
    expect(text).toContain("Payload read: enabled"); expect(text).toContain("Policy loaded: yes");
    s.h.press("tui.select.confirm"); expect(await s.task).toBe(false);
  });
  it.each([true, false])("only explicitly chosen action confirms (policy loaded %s)", async (policyLoaded) => {
    const s = await start({ policyLoaded });
    expect(s.h.render().join("\n")).toContain(policyLoaded ? "Activate current session" : "Release current binding for policy reload");
    let settled = false; void s.task.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    s.h.press("tui.select.down"); s.h.press("tui.select.confirm"); expect(await s.task).toBe(true);
  });
  it.each(["escape", "ctrl-c", "abort", "dispose", "timeout"])("%s never confirms", async (reason) => {
    vi.useFakeTimers(); const controller = new AbortController(); const s = await start({}, controller.signal);
    if (reason === "abort") controller.abort();
    else if (reason === "dispose") s.dispose();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(120_001);
    else s.h.send(reason === "escape" ? "\x1b" : "\x03");
    expect(await s.task).toBe(false);
  });
  it("shows disabled permissions without implying authorization", async () => {
    const s = await start({ payloadRead: false, ack: false });
    const text = s.h.render().join("\n"); expect(text).toContain("Payload read: disabled"); expect(text).toContain("ACK: disabled (reception only");
    s.h.press("tui.select.confirm"); expect(await s.task).toBe(false);
  });
  it("pre-aborted and non-TUI requests never open confirmation", async () => {
    const url = new URL("../../src/tunnel/messaging-activation-ui.js", import.meta.url).href;
    const mod = await import(url);
    const custom = vi.fn();
    const ctx = { mode: "tui", hasUI: true, ui: { custom } } as unknown as SetupUiContext;
    expect(await mod.confirmMessagingActivation(ctx, { view, keys: TEST_KEYS, signal: AbortSignal.abort() })).toBe(false);
    expect(await mod.confirmMessagingActivation({ ...ctx, mode: "print" }, { view, keys: TEST_KEYS })).toBe(false);
    expect(custom).not.toHaveBeenCalled();
  });
  it("sanitizes hostile terminal values", async () => {
    const s = await start({ piSessionId: "session\n\x1b[31mforged", storeFile: "/store\r\x07file" });
    const text = s.h.render().join("\n");
    expect(text).not.toContain("\x1b[31m"); expect(text).not.toContain("\x07"); expect(text).toContain("Current Pi session: session forged"); expect(text).not.toContain("\nforged");
    s.h.press("tui.select.cancel"); expect(await s.task).toBe(false);
  });
});
