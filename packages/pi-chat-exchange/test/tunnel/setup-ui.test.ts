import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_KEYS } from "./keys-stub.js";
import type { SetupWizardOptions, SetupUiContext, SetupProposal, SetupUiOutcome } from "../../src/tunnel/setup-ui.js";

const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); vi.useRealTimers(); });
async function adapter() {
  const url = new URL("../../src/tunnel/setup-ui.js", import.meta.url).href;
  const mod = await import(url).catch(() => undefined);
  expect(mod, "approved reusable setup wizard is not implemented").toBeDefined();
  return mod as typeof import("../../src/tunnel/setup-ui.js");
}
const existing = { tunnelId: "tunnel_abcdefgh", organizationId: "org-old", bindingPath: "/fixtures/old.json", credentialConfigured: true };
function setup(overrides: Partial<SetupWizardOptions> = {}) {
  const h = createTuiHarness({ rows: 40, width: 120 }); live.push(h);
  const save = vi.fn(async (_proposal: SetupProposal) => undefined);
  const validateBinding = vi.fn(async (_path: string) => undefined);
  const notify = vi.fn(); const input = vi.fn(); const appendEntry = vi.fn();
  let disposeComponent: (() => void) | undefined;
  const custom: typeof h.custom = (factory, options) => h.custom((...args) => {
    const component = factory(...args);
    // Factory results may be promises in the official API. This adapter's
    // factories are synchronous; direct disposal models Pi's lifecycle rather
    // than harness.dispose(), which resolves undefined before disposing.
    if (!(component instanceof Promise)) disposeComponent = () => component.dispose?.();
    return component;
  }, options);
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify, input }, appendEntry } as unknown as SetupUiContext;
  const options: SetupWizardOptions = { profilePath: "/fixtures/tunnel.yaml", keys: TEST_KEYS, validateBinding, save, ...overrides };
  return { h, ctx, options, save, validateBinding, notify, input, appendEntry, disposeComponent: () => disposeComponent?.() };
}
async function tick() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
async function press(h: TuiHarness, key: Parameters<TuiHarness["press"]>[0] = "tui.select.confirm") { h.press(key); await tick(); }
async function choose(h: TuiHarness, index = 0) { for (let i = 0; i < index; i++) h.press("tui.select.down"); await press(h); }
async function enter(h: TuiHarness, text: string) { h.send("\x15"); h.type(text); await press(h, "tui.input.submit"); }
function frame(h: TuiHarness) { return h.render().join("\n"); }
async function start(s: ReturnType<typeof setup>) { const task = (await adapter()).runSetupWizard(s.ctx, s.options); await s.h.waitForOpen(); return { task }; }
async function firstToCredential(s: ReturnType<typeof setup>) {
  // The wizard opens directly at step 1 (Tunnel ID): no Profile/Continue step.
  await enter(s.h, "tunnel_12345678");
  await enter(s.h, "");
  await enter(s.h, "/fixtures/binding.json");
}
async function existingToCredential(s: ReturnType<typeof setup>) {
  await enter(s.h, existing.tunnelId); await enter(s.h, existing.organizationId);
  await choose(s.h); // Keep binding
}
async function capture(s: ReturnType<typeof setup>, value = "test-only-canary-PRIVATE") {
  await choose(s.h); // Capture / replace depending existing
  expect(frame(s.h)).toMatch(/masked/);
  s.h.type(value);
  expect(frame(s.h).includes(value)).toBe(false);
  s.h.send("\r"); await tick();
}
async function finish(s: ReturnType<typeof setup>) {
  await choose(s.h); // Review entry -> review document
  await press(s.h); // Review continue -> final save
  await choose(s.h); // Save configuration
}

describe("Kit setup interaction contract", () => {
  it("passes the invocation signal to Save and honors explicit precommit cancellation", async () => {
    let invocationSignal: AbortSignal | undefined;
    const s = setup({ existing, save: (async (_proposal: SetupProposal, signal: AbortSignal) => {
      invocationSignal = signal;
      return { kind: "cancelled" as const };
    }) as SetupWizardOptions["save"] });
    const { task } = await start(s);
    await existingToCredential(s); await choose(s.h); await finish(s);
    expect(await task).toEqual({ status: "cancelled" });
    expect(invocationSignal).toBeInstanceOf(AbortSignal);
  });

  it("opens directly at step 1 with progress, no redundant Profile/Continue screen", async () => {
    const s = setup(); const { task } = await start(s);
    const first = frame(s.h);
    // Step 1 is the first real input, not a decision-free Profile page.
    expect(first).toContain("Tunnel Setup · 1/4");
    expect(first).toContain("Tunnel ID");
    expect(first).not.toContain("Continue");
    expect(first).not.toMatch(/Tunnel setup · Profile/i);
    // Profile path stays as wizard context only.
    expect(first).toContain(s.options.profilePath);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("numbers every step and keeps validation failures on the current step", async () => {
    const s = setup(); const { task } = await start(s);
    await enter(s.h, "not-a-tunnel-id");
    // Invalid input must not advance the wizard.
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain("Invalid Tunnel ID");
    await enter(s.h, "tunnel_12345678");
    expect(frame(s.h)).toContain("Tunnel Setup · 2/4");
    expect(frame(s.h)).toMatch(/optional/i);
    await enter(s.h, "");
    expect(frame(s.h)).toContain("Tunnel Setup · 3/4");
    await enter(s.h, "/fixtures/binding.json");
    expect(frame(s.h)).toContain("Tunnel Setup · 4/4");
    expect(frame(s.h)).toMatch(/masked/i);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("Review shows the full profile and credential intent, never the secret", async () => {
    const s = setup(); const { task } = await start(s);
    await firstToCredential(s);
    await capture(s);
    await choose(s.h); // Review entry -> review document
    const review = frame(s.h);
    expect(review).toContain(s.options.profilePath);
    expect(review).toContain("tunnel_12345678");
    expect(review).toContain("Not configured");
    expect(review).toContain("MCP Binding");
    expect(review).toContain("Provided");
    expect(review.includes("test-only-canary-PRIVATE")).toBe(false);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("orders first-time steps, validates inline, captures only in CE custom, and saves only final explicit Save", async () => {
    const s = setup(); const { task } = await start(s);
    expect(frame(s.h)).toContain(s.options.profilePath);
    // Opens directly at step 1; no redundant Profile/Continue screen.
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain("Tunnel ID");
    await enter(s.h, "bad"); expect(frame(s.h)).toContain("Tunnel ID"); expect(frame(s.h)).toContain("Invalid Tunnel ID");
    await enter(s.h, "tunnel_12345678"); expect(frame(s.h)).toContain("Organization ID");
    await enter(s.h, "bad"); expect(frame(s.h)).toContain("Organization ID"); expect(frame(s.h)).toContain("Invalid Organization ID");
    await enter(s.h, ""); expect(frame(s.h)).toContain("MCP Binding");
    s.validateBinding.mockRejectedValueOnce(new Error("private parser diagnostic"));
    await enter(s.h, "/fixtures/bad.json"); expect(frame(s.h)).toContain("MCP Binding"); expect(frame(s.h)).toContain("Invalid MCP binding config");
    expect(frame(s.h)).not.toContain("private parser diagnostic");
    await enter(s.h, "/fixtures/binding.json");
    await capture(s);
    await choose(s.h);
    const review = frame(s.h); expect(review).toContain("Not configured"); expect(review).toContain("Provided");
    expect(review).toContain("tunnel_12345678"); expect(review.includes("test-only-canary-PRIVATE")).toBe(false);
    expect(s.save).not.toHaveBeenCalled();
    await press(s.h); expect(s.save).not.toHaveBeenCalled();
    await choose(s.h); expect(await task).toEqual({ status: "saved" });
    expect(s.save).toHaveBeenCalledTimes(1);
    const proposal = s.save.mock.calls[0]![0];
    expect(proposal.tunnelId).toBe("tunnel_12345678"); expect(proposal.bindingPath).toBe("/fixtures/binding.json");
    expect(proposal.credential.kind).toBe("replace");
    for (const fn of [s.input, s.notify, s.appendEntry]) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify(await task).includes("PRIVATE")).toBe(false);
  });

  it("existing nonsecret values prefill, Keep binding and Keep credential never capture or validate", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain(existing.tunnelId);
    await press(s.h, "tui.input.submit"); expect(frame(s.h)).toContain(existing.organizationId);
    await press(s.h, "tui.input.submit"); await choose(s.h); // keep binding
    expect(frame(s.h)).toContain("Keep existing credential");
    await choose(s.h); await finish(s);
    expect(await task).toEqual({ status: "saved" });
    expect(s.validateBinding).not.toHaveBeenCalled();
    expect(s.save.mock.calls[0]![0].credential).toEqual({ kind: "keep" });
    expect(s.save.mock.calls[0]![0].bindingPath).toBe(existing.bindingPath);
  });

  it("existing credential Replace uses CE masked capture and displays intent only", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await existingToCredential(s); await choose(s.h, 1);
    s.h.type("test-only-replacement-PRIVATE"); s.h.send("\r"); await tick();
    await choose(s.h); expect(frame(s.h)).toContain("Replace"); expect(frame(s.h).includes("replacement-PRIVATE")).toBe(false);
    await press(s.h); await choose(s.h);
    expect((await task).status).toBe("saved"); expect(s.save.mock.calls[0]![0].credential.kind).toBe("replace");
  });

  it.each(["tunnel", "organization", "binding"])("%s changes require an additional identity/routing review", async (field) => {
    const s = setup({ existing }); const { task } = await start(s);
    await enter(s.h, field === "tunnel" ? "tunnel_changed1" : existing.tunnelId);
    await enter(s.h, field === "organization" ? "org-new" : existing.organizationId);
    if (field === "binding") { await choose(s.h, 1); await enter(s.h, "/fixtures/new.json"); }
    else await choose(s.h);
    await choose(s.h); await choose(s.h); await press(s.h);
    expect(frame(s.h)).toContain("Existing Tunnel configuration will be changed");
    expect(frame(s.h)).toContain("→"); expect(s.save).not.toHaveBeenCalled();
    await press(s.h); expect(frame(s.h)).toContain("Save configuration"); expect(s.save).not.toHaveBeenCalled();
    await choose(s.h); expect((await task).status).toBe("saved");
  });

  it("Cancel at the extra identity confirmation never invokes save", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await enter(s.h, "tunnel_changed1"); await enter(s.h, existing.organizationId);
    await choose(s.h); await choose(s.h); await choose(s.h); await press(s.h);
    expect(frame(s.h)).toContain("Existing Tunnel configuration will be changed");
    await press(s.h, "tui.select.cancel"); expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  it("direct disposal of a nonsecret Kit page resolves cancelled without saving", async () => {
    const s = setup(); const { task } = await start(s);
    s.disposeComponent();
    await tick();
    let outcome: SetupUiOutcome | undefined;
    void task.then((result) => { outcome = result; });
    await tick();
    expect(outcome).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("explicit Cancel action leaves no save and already-aborted entry opens no TUI", async () => {
    const s = setup(); const { task } = await start(s);
    await press(s.h, "tui.select.cancel"); expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    const aborted = setup({ signal: controller.signal });
    expect(await (await adapter()).runSetupWizard(aborted.ctx, aborted.options)).toEqual({ status: "cancelled" });
    expect(aborted.h.openCount).toBe(0);
  });

  it("explicit Back from review edits nonsecret values while Escape cancels the whole invocation", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await existingToCredential(s); await choose(s.h);
    await choose(s.h, 1); // Back/edit
    expect(frame(s.h)).toContain("Edit configuration");
    await choose(s.h); expect(frame(s.h)).toContain("Tunnel ID");
    await press(s.h, "tui.select.cancel"); expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  it.each(["profile", "tunnel", "organization", "binding", "credential", "secret", "review-entry", "review", "save"])("Escape at %s leaves zero persistence side effects", async (step) => {
    const s = setup(); const { task } = await start(s);
    const steps = ["profile", "tunnel", "organization", "binding", "credential", "secret", "review-entry", "review", "save"];
    const target = steps.indexOf(step);
    if (target > 0) await choose(s.h);
    if (target > 1) await enter(s.h, "tunnel_12345678");
    if (target > 2) await enter(s.h, "");
    if (target > 3) await enter(s.h, "/fixtures/binding.json");
    if (target > 4) await choose(s.h);
    if (target > 5) { s.h.type("isolated-canary"); s.h.send("\r"); await tick(); }
    if (target > 6) await choose(s.h);
    if (target > 7) await press(s.h);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled(); expect(s.notify).not.toHaveBeenCalled();
  });

  it.each(["profile", "tunnel", "organization", "binding", "credential", "secret", "review-entry", "review", "save"].flatMap((step) => ["timeout", "abort", "ctrl-c"].map((reason) => ({ step, reason }))))("$reason at $step owns and closes the current Kit/CE component", async ({ step, reason }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const s = setup({ timeoutMs: 1000, signal: controller.signal }); const { task } = await start(s);
    const target = ["profile", "tunnel", "organization", "binding", "credential", "secret", "review-entry", "review", "save"].indexOf(step);
    if (target > 0) await choose(s.h);
    if (target > 1) await enter(s.h, "tunnel_12345678");
    if (target > 2) await enter(s.h, "");
    if (target > 3) await enter(s.h, "/fixtures/binding.json");
    if (target > 4) await choose(s.h);
    if (target > 5) { s.h.type("isolated-canary"); s.h.send("\r"); await tick(); }
    if (target > 6) await choose(s.h);
    if (target > 7) await press(s.h);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "abort") controller.abort();
    else s.h.send("\x03");
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
    expect(s.h.isOpen).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout", "ctrl-c", "dispose"])("%s cancels masked capture without saving or leaking", async (reason) => {
    vi.useFakeTimers(); const controller = new AbortController();
    const s = setup({ signal: controller.signal, timeoutMs: 1000 }); const { task } = await start(s);
    await firstToCredential(s); await choose(s.h); s.h.type("isolated-PRIVATE");
    if (reason === "abort") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "ctrl-c") s.h.send("\x03");
    else s.disposeComponent();
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits owned validation on abort, without detached work or saving", async () => {
    const controller = new AbortController(); let release!: () => void;
    const validation = new Promise<void>((resolve) => { release = resolve; });
    const s = setup({ signal: controller.signal, validateBinding: () => validation }); const { task } = await start(s);
    await choose(s.h); await enter(s.h, "tunnel_12345678"); await enter(s.h, "");
    s.h.type("/fixtures/binding.json"); s.h.press("tui.input.submit"); await tick(); controller.abort();
    let settled = false; void task.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    release(); expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  it("Escape during pending binding validation cancels instead of advancing after validation completes", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const s = setup({ validateBinding: () => pending }); const { task } = await start(s);
    await choose(s.h); await enter(s.h, "tunnel_12345678"); await enter(s.h, "");
    s.h.type("/fixtures/binding.json"); s.h.press("tui.input.submit"); await tick();
    s.h.press("tui.select.cancel"); await tick(); release(); await tick();
    expect(s.h.isOpen, "Escape must not advance to Credential after pending validation").toBe(false);
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  it("Save has a completion barrier: abort after entry cannot report false cancellation", async () => {
    const controller = new AbortController(); let release!: () => void;
    const saving = new Promise<void>((resolve) => { release = resolve; });
    const s = setup({ existing, signal: controller.signal, save: () => saving }); const { task } = await start(s);
    await existingToCredential(s); await choose(s.h); await choose(s.h); await press(s.h);
    s.h.press("tui.select.confirm"); await tick(); controller.abort();
    let settled = false; void task.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    release(); expect(await task).toEqual({ status: "saved" });
  });

  it("refuses noninteractive mode and suppresses exception details", async () => {
    const s = setup(); const mod = await adapter();
    expect(await mod.runSetupWizard({ ...s.ctx, mode: "rpc" }, s.options)).toEqual({ status: "refused", code: "CE_TUNNEL_INPUT_UNAVAILABLE" });
    expect(s.h.openCount).toBe(0);
    const f = setup({ existing, save: async () => { throw new Error("test-only-PRIVATE"); } }); const { task } = await start(f);
    await existingToCredential(f); await choose(f.h); await finish(f);
    const outcome: SetupUiOutcome = await task; expect(outcome.status).toBe("refused"); expect(JSON.stringify(outcome).includes("PRIVATE")).toBe(false); expect(f.notify).not.toHaveBeenCalled();
  });

  it("status uses a Kit detail view and keeps configuration distinct from runtime authority", async () => {
    const s = setup(); const mod = await adapter();
    const view = { profilePath: "/fixtures/tunnel.yaml", maskedTunnel: "tunnel_abc…", organization: "configured", binding: "invalid", credential: "configured", configurationState: "ERROR", runtimeState: "STOPPED", evidence: "no owner" } as const;
    const task = mod.presentTunnelStatus(s.ctx, view); await s.h.waitForOpen();
    const text = frame(s.h); for (const title of ["Profile", "Tunnel", "Organization", "Runtime state", "STOPPED", "Configured != Connected"]) expect(text).toContain(title);
    expect(text).not.toContain("CONNECTED"); await press(s.h, "tui.select.cancel"); await task;
    const fallback = await mod.presentTunnelStatus({ ...s.ctx, mode: "print" }, view); expect(fallback.lines.join("\n")).toContain("transport only");
  });
});
