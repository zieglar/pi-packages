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
  const validateBinding = vi.fn(async (_path: string) => undefined); // legacy mock: must never be called
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
  const options: SetupWizardOptions = { profilePath: "/fixtures/tunnel.yaml", keys: TEST_KEYS, save, ...overrides };
  return { h, ctx, options, save, validateBinding, notify, input, appendEntry, disposeComponent: () => disposeComponent?.() };
}
async function tick() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
async function press(h: TuiHarness, key: Parameters<TuiHarness["press"]>[0] = "tui.select.confirm") { h.press(key); await tick(); }
async function choose(h: TuiHarness, index = 0) { for (let i = 0; i < index; i++) h.press("tui.select.down"); await press(h); }
/** Kit carries the cursor between screens, so pick an action by its label. */
async function selectLabel(h: TuiHarness, label: string) {
  const rows = h.render().filter((line) => /^(?:→|\s) /.test(line) && /[A-Za-z]/.test(line));
  const index = rows.findIndex((line) => line.includes(label));
  expect(index, `rendered items include ${label}`).toBeGreaterThanOrEqual(0);
  const cursor = Math.max(0, rows.findIndex((line) => line.trimStart().startsWith("→")));
  for (let i = cursor; i < index; i++) h.press("tui.select.down");
  for (let i = cursor; i > index; i--) h.press("tui.select.up");
  await press(h);
}
async function enter(h: TuiHarness, text: string) { h.send("\x15"); h.type(text); await press(h, "tui.input.submit"); }
function frame(h: TuiHarness) { return h.render().join("\n"); }
async function fullFrame(h: TuiHarness) { const first = frame(h); for (let i = 0; i < 20; i++) { h.press("tui.select.down"); await tick(); } return `${first}\n${frame(h)}`; }
async function start(s: ReturnType<typeof setup>) { const task = (await adapter()).runSetupWizard(s.ctx, s.options); await s.h.waitForOpen(); return { task }; }
/** First setup: Tunnel ID, Organization, then the masked input opens directly. */
async function firstToSecret(s: ReturnType<typeof setup>) {
  await enter(s.h, "tunnel_12345678");
  await enter(s.h, "");
}
/** Editing an existing profile stops at the Keep/Replace credential decision. */
async function existingToCredential(s: ReturnType<typeof setup>) {
  await enter(s.h, existing.tunnelId); await enter(s.h, existing.organizationId);
}
async function captureSecret(s: ReturnType<typeof setup>, value = "test-only-canary-PRIVATE") {
  // The masked view carries the step title: progress never disappears mid-flow.
  expect(frame(s.h)).toContain("Tunnel Setup · 3/4 · Credential");
  expect(frame(s.h)).toMatch(/masked/);
  s.h.type(value);
  expect(frame(s.h).includes(value)).toBe(false);
  s.h.send("\r"); await tick();
}
/** Recipients live behind Review -> Edit configuration -> Advanced only. */
async function toAdvancedRecipients(s: ReturnType<typeof setup>) {
  await selectLabel(s.h, "Back · Edit configuration");
  expect(frame(s.h)).toContain("Edit configuration");
  await selectLabel(s.h, "Advanced · Recipients");
  expect(frame(s.h)).toContain("Tunnel Setup · Advanced · Recipients");
}
async function finish(s: ReturnType<typeof setup>) {
  await selectLabel(s.h, "Review"); // Review entry -> review document
  await press(s.h); // Review continue -> final save
  await selectLabel(s.h, "Save configuration");
}

describe("Kit setup interaction contract", () => {
  it("passes the invocation signal to Save and honors explicit precommit cancellation", async () => {
    let invocationSignal: AbortSignal | undefined;
    const s = setup({ existing, save: (async (_proposal: SetupProposal, signal: AbortSignal) => {
      invocationSignal = signal;
      return { kind: "cancelled" as const };
    }) as SetupWizardOptions["save"] });
    const { task } = await start(s);
    await existingToCredential(s); await selectLabel(s.h, "Keep existing credential"); await finish(s);
    expect(await task).toEqual({ status: "cancelled" });
    expect(invocationSignal).toBeInstanceOf(AbortSignal);
  });

  it("opens directly at step 1 with progress, field help and no profile-path noise", async () => {
    const s = setup(); const { task } = await start(s);
    const first = frame(s.h);
    // Step 1 is the first real input, not a decision-free Profile page.
    expect(first).toContain("Tunnel Setup · 1/4");
    expect(first).toContain("Tunnel ID");
    expect(first).toContain("Required · tunnel_ followed by at least 8 alphanumeric characters");
    expect(first).not.toContain("Continue");
    expect(first).not.toMatch(/Tunnel setup · Profile/i);
    // The write target is Review/Save context, not a per-step decoration.
    expect(first).not.toContain(s.options.profilePath);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("numbers every step, explains each field, and keeps validation on the current step", async () => {
    const s = setup(); const { task } = await start(s);
    await enter(s.h, "not-a-tunnel-id");
    // Invalid input must not advance the wizard.
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain("Invalid Tunnel ID");
    await enter(s.h, "tunnel_12345678");
    expect(frame(s.h)).toContain("Tunnel Setup · 2/4");
    expect(frame(s.h)).toMatch(/optional/i);
    expect(frame(s.h)).toContain("leave empty if not required");
    await enter(s.h, "");
    // Step 3 for a first setup IS the masked credential input: no extra choice.
    expect(frame(s.h)).toMatch(/masked/i);
    expect(frame(s.h)).not.toContain("Provide API key");
    await captureSecret(s);
    expect(frame(s.h)).toContain("Tunnel Setup · 4/4");
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("Review shows the full profile and credential intent, never the secret", async () => {
    const s = setup(); const { task } = await start(s);
    await firstToSecret(s);
    await captureSecret(s);
    await choose(s.h); // Review entry -> review document
    const review = await fullFrame(s.h);
    expect(review).toContain(s.options.profilePath);
    expect(review).toContain("tunnel_12345678");
    expect(review).toContain("Not configured");
    expect(review).toContain("MCP Binding");
    expect(review).toContain("CE-managed (generated automatically)");
    expect(review).toContain("Provided");
    expect(review.includes("test-only-canary-PRIVATE")).toBe(false);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("orders first-time steps, validates inline, captures only in CE custom, and saves only final explicit Save", async () => {
    const s = setup(); const { task } = await start(s);
    // Opens directly at step 1; no redundant Profile/Continue screen.
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain("Tunnel ID");
    await enter(s.h, "bad"); expect(frame(s.h)).toContain("Tunnel ID"); expect(frame(s.h)).toContain("Invalid Tunnel ID");
    await enter(s.h, "tunnel_12345678"); expect(frame(s.h)).toContain("Organization ID");
    await enter(s.h, "bad"); expect(frame(s.h)).toContain("Organization ID"); expect(frame(s.h)).toContain("Invalid Organization ID");
    await enter(s.h, "");
    // No binding/recipient file path is ever asked on the linear path.
    expect(frame(s.h)).not.toMatch(/\.ya?ml|\.json/i);
    expect(s.validateBinding).not.toHaveBeenCalled();
    await captureSecret(s);
    expect(frame(s.h)).toContain("Tunnel Setup · 4/4");
    await choose(s.h);
    const document = await fullFrame(s.h); expect(document).toContain("Not configured"); expect(document).toContain("Provided");
    expect(document).toContain("tunnel_12345678"); expect(document.includes("test-only-canary-PRIVATE")).toBe(false);
    expect(s.save).not.toHaveBeenCalled();
    await press(s.h); expect(s.save).not.toHaveBeenCalled();
    await selectLabel(s.h, "Save configuration"); expect(await task).toEqual({ status: "saved" });
    expect(s.save).toHaveBeenCalledTimes(1);
    const proposal = s.save.mock.calls[0]![0];
    expect(proposal.tunnelId).toBe("tunnel_12345678"); expect(proposal.recipients).toBeUndefined();
    expect(proposal.credential.kind).toBe("replace");
    for (const fn of [s.input, s.notify, s.appendEntry]) expect(fn).not.toHaveBeenCalled();
    expect(JSON.stringify(await task).includes("PRIVATE")).toBe(false);
  });

  it("existing nonsecret values prefill, Keep binding and Keep credential never capture or validate", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    expect(frame(s.h)).toContain("Tunnel Setup · 1/4");
    expect(frame(s.h)).toContain(existing.tunnelId);
    await press(s.h, "tui.input.submit"); expect(frame(s.h)).toContain(existing.organizationId);
    await enter(s.h, existing.organizationId); // Organization unchanged
    expect(frame(s.h)).toContain("Tunnel Setup · 3/4");
    expect(frame(s.h)).toContain("Keep existing credential");
    await selectLabel(s.h, "Keep existing credential"); await finish(s);
    expect(await task).toEqual({ status: "saved" });
    expect(s.validateBinding).not.toHaveBeenCalled();
    expect(s.save.mock.calls[0]![0].credential).toEqual({ kind: "keep" });
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it("existing credential Replace uses CE masked capture and displays intent only", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await existingToCredential(s); await selectLabel(s.h, "Replace credential");
    await captureSecret(s, "test-only-replacement-PRIVATE");
    await selectLabel(s.h, "Review"); const reviewFrame = await fullFrame(s.h); expect(reviewFrame).toContain("Replace"); expect(reviewFrame.includes("replacement-PRIVATE")).toBe(false);
    await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved"); expect(s.save.mock.calls[0]![0].credential.kind).toBe("replace");
  });

  it.each(["tunnel", "organization", "recipients"])("%s changes require an additional identity/routing review", async (field) => {
    const s = setup({ existing }); const { task } = await start(s);
    await enter(s.h, field === "tunnel" ? "tunnel_changed1" : existing.tunnelId);
    await enter(s.h, field === "organization" ? "org-new" : existing.organizationId);
    await selectLabel(s.h, "Keep existing credential");
    if (field === "recipients") { await toAdvancedRecipients(s); await enter(s.h, "chatgpt:chatgpt/main"); }
    await selectLabel(s.h, "Review"); await press(s.h);
    expect(frame(s.h)).toContain("Existing Tunnel configuration will be changed");
    expect(frame(s.h)).toContain("→"); expect(s.save).not.toHaveBeenCalled();
    await press(s.h); expect(frame(s.h)).toContain("Save configuration"); expect(s.save).not.toHaveBeenCalled();
    await selectLabel(s.h, "Save configuration"); expect((await task).status).toBe("saved");
  });

  it("Cancel at the extra identity confirmation never invokes save", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await enter(s.h, "tunnel_changed1"); await enter(s.h, existing.organizationId);
    await selectLabel(s.h, "Keep existing credential"); await selectLabel(s.h, "Review"); await press(s.h);
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
    await existingToCredential(s); await selectLabel(s.h, "Keep existing credential");
    await selectLabel(s.h, "Back · Edit configuration");
    expect(frame(s.h)).toContain("Edit configuration");
    // The write target is visible here, where it is decision context.
    expect(frame(s.h)).toContain(s.options.profilePath);
    await selectLabel(s.h, "Tunnel ID"); expect(frame(s.h)).toContain("Tunnel Setup · 1/4 · Tunnel ID");
    await press(s.h, "tui.select.cancel"); expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  const STEPS = ["tunnel", "organization", "secret", "review-entry", "review", "save"];
  /** Walk the linear first-setup flow to the named step. */
  async function walkTo(s: ReturnType<typeof setup>, step: string) {
    const target = STEPS.indexOf(step);
    if (target > 0) await enter(s.h, "tunnel_12345678");
    if (target > 1) await enter(s.h, "");
    if (target > 2) { s.h.type("isolated-canary"); s.h.send("\r"); await tick(); }
    if (target > 3) await choose(s.h);
    if (target > 4) await press(s.h);
  }

  it.each(STEPS)("Escape at %s leaves zero persistence side effects", async (step) => {
    const s = setup(); const { task } = await start(s);
    await walkTo(s, step);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled(); expect(s.notify).not.toHaveBeenCalled();
  });

  it.each(STEPS.flatMap((step) => ["timeout", "abort", "ctrl-c"].map((reason) => ({ step, reason }))))("$reason at $step owns and closes the current Kit/CE component", async ({ step, reason }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const s = setup({ timeoutMs: 1000, signal: controller.signal }); const { task } = await start(s);
    await walkTo(s, step);
    if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "abort") controller.abort();
    else s.h.send("\x03");
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
    expect(s.h.isOpen).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout", "ctrl-c", "dispose"])("%s cancels masked capture without saving or leaking", async (reason) => {
    vi.useFakeTimers(); const controller = new AbortController();
    const s = setup({ signal: controller.signal, timeoutMs: 1000 }); const { task } = await start(s);
    await firstToSecret(s); s.h.type("isolated-PRIVATE");
    if (reason === "abort") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "ctrl-c") s.h.send("\x03");
    else s.disposeComponent();
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("recipients are Advanced-only, never a linear step, and validate inline", async () => {
    const s = setup(); const { task } = await start(s);
    await firstToSecret(s); await captureSecret(s);
    // The linear flow reaches Review without ever asking for recipients.
    expect(frame(s.h)).toContain("Tunnel Setup · 4/4");
    expect(frame(s.h)).not.toContain("Recipients");
    await toAdvancedRecipients(s);
    // No binding-path prompt: the recipients step is a business choice, not YAML.
    expect(frame(s.h)).not.toMatch(/path|\.ya?ml|\.json/i);
    for (const bad of ["only-adapter", "pi:pi/self", "chatgpt:dup, chatgpt:dup", "chatgpt:cap_0123456789abcdef"]) {
      await enter(s.h, bad);
      expect(frame(s.h)).toContain("Recipients");
      expect(frame(s.h)).toContain("Invalid recipients");
    }
    expect(s.validateBinding).not.toHaveBeenCalled();
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" }); expect(s.save).not.toHaveBeenCalled();
  });

  it("entered Advanced recipients flow into the proposal", async () => {
    const s = setup(); const { task } = await start(s);
    await firstToSecret(s); await captureSecret(s);
    await toAdvancedRecipients(s);
    await enter(s.h, "chatgpt:chatgpt/main, mcp:ops/alerts");
    await selectLabel(s.h, "Review"); await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].recipients).toEqual([
      { adapter: "chatgpt", endpointId: "chatgpt/main" },
      { adapter: "mcp", endpointId: "ops/alerts" },
    ]);
  });

  it("untouched recipients keep a foreign/unknown binding (no silent empty replacement)", async () => {
    const legacy = { ...existing, bindingPath: "/fixtures/legacy.json" };
    const s = setup({ existing: legacy }); const { task } = await start(s);
    await existingToCredential(s);
    await selectLabel(s.h, "Keep existing credential");
    await toAdvancedRecipients(s);
    await enter(s.h, "   "); // blank recipients -> keep existing binding
    await selectLabel(s.h, "Review"); // Review entry -> review document
    const review = await fullFrame(s.h);
    expect(review).toContain("Keep existing (/fixtures/legacy.json)");
    expect(review).toContain("Unchanged (existing binding kept)");
    expect(review).not.toContain("CE-managed (generated automatically)");
    await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it("editing a known managed recipients list prefills and only real changes count", async () => {
    const managed = { ...existing, recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }] };
    const s = setup({ existing: managed }); const { task } = await start(s);
    await enter(s.h, managed.tunnelId); await enter(s.h, managed.organizationId);
    await selectLabel(s.h, "Keep existing credential");
    await toAdvancedRecipients(s);
    expect(frame(s.h)).toContain("chatgpt:chatgpt/main");
    await enter(s.h, "chatgpt:chatgpt/main"); // identical -> not a change
    await selectLabel(s.h, "Review"); await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it("identity change with a known managed binding shows Regenerate in Review (recipients kept)", async () => {
    const managed = { ...existing, recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }] };
    const s = setup({ existing: managed }); const { task } = await start(s);
    await enter(s.h, "tunnel_newidentity"); // Tunnel ID changed
    await enter(s.h, managed.organizationId);
    await selectLabel(s.h, "Keep existing credential");
    await selectLabel(s.h, "Review"); // Review entry
    const review = await fullFrame(s.h);
    // Identity changed + managed binding: must NOT say Keep existing.
    expect(review).toContain("Regenerate for new identity (recipients kept)");
    expect(review).not.toContain("Keep existing (/fixtures/old.json)");
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  // Every edit-flow view must cancel closed: Escape, owner abort, timeout, Ctrl-C
  // and direct disposal all write nothing. The first-setup matrix above covers
  // the linear path; these are the views it cannot reach.
  const EDIT_VIEWS = ["credential", "review-entry", "edit", "advanced", "changes"] as const;
  type EditView = (typeof EDIT_VIEWS)[number];
  /** Walk to the named edit view, asserting the reached view before returning. */
  async function walkToEditView(s: ReturnType<typeof setup>, view: EditView) {
    await enter(s.h, view === "changes" ? "tunnel_changed1" : existing.tunnelId);
    await enter(s.h, existing.organizationId);
    if (view === "credential") {
      expect(frame(s.h)).toContain("Tunnel Setup · 3/4 · Credential");
      expect(frame(s.h)).toContain("Keep existing credential");
      return;
    }
    await selectLabel(s.h, "Keep existing credential");
    expect(frame(s.h)).toContain("Tunnel Setup · 4/4 · Review");
    if (view === "review-entry") return;
    await selectLabel(s.h, "Back · Edit configuration");
    expect(frame(s.h)).toContain("Edit configuration");
    if (view === "edit") return;
    if (view === "advanced") {
      await selectLabel(s.h, "Advanced · Recipients");
      expect(frame(s.h)).toContain("Tunnel Setup · Advanced · Recipients");
      return;
    }
    await selectLabel(s.h, "Back · Review");
    await selectLabel(s.h, "Review");
    await press(s.h); // Review Continue -> identity/routing change confirmation
    expect(frame(s.h)).toContain("Existing Tunnel configuration will be changed");
  }

  it.each(EDIT_VIEWS)("Escape at edit view %s leaves zero persistence side effects", async (view) => {
    const s = setup({ existing }); const { task } = await start(s);
    await walkToEditView(s, view);
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it.each(EDIT_VIEWS.flatMap((view) => (["abort", "timeout", "ctrl-c", "dispose"] as const).map((reason) => ({ view, reason }))))("$reason at edit view $view closes the component without saving", async ({ view, reason }) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const s = setup({ existing, timeoutMs: 1000, signal: controller.signal }); const { task } = await start(s);
    await walkToEditView(s, view);
    if (reason === "abort") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "ctrl-c") s.h.send("\x03");
    else s.disposeComponent();
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
    expect(s.h.isOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Save has a completion barrier: abort after entry cannot report false cancellation", async () => {
    const controller = new AbortController(); let release!: () => void;
    const saving = new Promise<void>((resolve) => { release = resolve; });
    const s = setup({ existing, signal: controller.signal, save: () => saving }); const { task } = await start(s);
    await existingToCredential(s); await selectLabel(s.h, "Keep existing credential"); await selectLabel(s.h, "Review"); await press(s.h);
    s.h.press("tui.select.confirm"); await tick(); controller.abort();
    let settled = false; void task.then(() => { settled = true; }); await tick(); expect(settled).toBe(false);
    release(); expect(await task).toEqual({ status: "saved" });
  });

  it("refuses noninteractive mode and suppresses exception details", async () => {
    const s = setup(); const mod = await adapter();
    expect(await mod.runSetupWizard({ ...s.ctx, mode: "rpc" }, s.options)).toEqual({ status: "refused", code: "CE_TUNNEL_INPUT_UNAVAILABLE" });
    expect(s.h.openCount).toBe(0);
    const f = setup({ existing, save: async () => { throw new Error("test-only-PRIVATE"); } }); const { task } = await start(f);
    await existingToCredential(f); await selectLabel(f.h, "Keep existing credential"); await finish(f);
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
