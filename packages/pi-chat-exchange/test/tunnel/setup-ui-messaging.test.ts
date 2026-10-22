/**
 * HANDOFF-CE-TUNNEL-MESSAGING-INTEGRATION-01 — wizard messaging authorization:
 * explicit Advanced authorize for the current session only, unavailable when
 * the session identity is unknown, replace confirmation semantics, and the
 * exact proposal shape handed to the injected transaction.
 */
import { createTuiHarness, type TuiHarness } from "@narumitw/pi-tui-kit/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_KEYS } from "./keys-stub.js";
import type { SetupWizardOptions, SetupUiContext, SetupProposal, SetupUiOutcome, ExistingMessagingValues } from "../../src/tunnel/setup-ui.js";

const live: TuiHarness[] = [];
afterEach(() => { for (const h of live.splice(0)) h.dispose(); vi.useRealTimers(); });
async function adapter() {
  const url = new URL("../../src/tunnel/setup-ui.js", import.meta.url).href;
  const mod = await import(url).catch(() => undefined);
  expect(mod, "setup wizard is not implemented").toBeDefined();
  return mod as typeof import("../../src/tunnel/setup-ui.js");
}
const existing = { tunnelId: "tunnel_abcdefgh", organizationId: "org-old", bindingPath: "/fixtures/old.json", credentialConfigured: true };

function setup(overrides: Partial<SetupWizardOptions> = {}) {
  const h = createTuiHarness({ rows: 40, width: 120 }); live.push(h);
  const save = vi.fn(async (_proposal: SetupProposal) => undefined);
  const notify = vi.fn(); const input = vi.fn(); const appendEntry = vi.fn();
  let disposeComponent: (() => void) | undefined;
  const custom: typeof h.custom = (factory, options) => h.custom((...args) => {
    const component = factory(...args);
    if (!(component instanceof Promise)) disposeComponent = () => component.dispose?.();
    return component;
  }, options);
  const ctx = { mode: "tui", hasUI: true, ui: { custom, notify, input }, appendEntry } as unknown as SetupUiContext;
  const options: SetupWizardOptions = { profilePath: "/fixtures/tunnel.yaml", keys: TEST_KEYS, save, ...overrides };
  return { h, ctx, options, save, notify, disposeComponent: () => disposeComponent?.() };
}
async function tick() { for (let i = 0; i < 35; i++) await Promise.resolve(); }
async function press(h: TuiHarness, key: Parameters<TuiHarness["press"]>[0] = "tui.select.confirm") { h.press(key); await tick(); }
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
async function fullFrame(h: TuiHarness) { const parts = [frame(h)]; for (let i = 0; i < 20; i++) { h.press("tui.select.down"); await tick(); parts.push(frame(h)); } return parts.join("\n"); }
async function start(s: ReturnType<typeof setup>) { const task = (await adapter()).runSetupWizard(s.ctx, s.options); await s.h.waitForOpen(); return { task }; }
async function toEdit(s: ReturnType<typeof setup>) {
  await enter(s.h, existing.tunnelId); await enter(s.h, existing.organizationId);
  await selectLabel(s.h, "Keep existing credential");
  await selectLabel(s.h, "Back · Edit configuration");
}
async function finish(s: ReturnType<typeof setup>) {
  await selectLabel(s.h, "Review"); await press(s.h); await selectLabel(s.h, "Save configuration");
}
/** Edit screen -> reviewEntry ("Back · Review"), then the review document. */
async function editToReview(s: ReturnType<typeof setup>) {
  await selectLabel(s.h, "Back · Review");
  await selectLabel(s.h, "Review");
}

const SESSION = "pi-session-current-9";
const existingMessaging: ExistingMessagingValues = {
  chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: "pi-session-OLD",
  payloadRead: true, ack: true, configured: true,
};

describe("MESSAGING-INTEGRATION-01 — wizard messaging authorization", () => {
  it("requests separate activation without saving", async () => {
    const s = setup({ existing, piSessionId: SESSION, existingMessaging: { ...existingMessaging, piSessionId: SESSION }, canActivateMessaging: true });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Activate current session");
    expect(await task).toEqual({ status: "activation-requested" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it.each([undefined, false])("hides activation without parent authorization (%s)", async (canActivateMessaging) => {
    const s = setup({ existing, piSessionId: SESSION, existingMessaging, ...(canActivateMessaging === undefined ? {} : { canActivateMessaging }) });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).not.toContain("Activate current session");
    await press(s.h, "tui.select.cancel"); expect((await task).status).toBe("cancelled");
  });

  it("keeps actual configuration visible even when runtime session is unknown", async () => {
    const s = setup({ existing, existingMessaging: { ...existingMessaging, storeFile: "/actual/ce.sqlite" } });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).toContain("/actual/ce.sqlite"); expect(frame(s.h)).toContain("pi-session-OLD");
    await press(s.h, "tui.select.cancel"); await task;
  });

  it.each(["unknown-session", "unconfigured"])("hides activation for %s even with the flag", async (reason) => {
    const s = setup({ existing, ...(reason === "unknown-session" ? {} : { piSessionId: SESSION }), existingMessaging: { ...existingMessaging, configured: reason !== "unconfigured" }, canActivateMessaging: true });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).not.toContain("Activate current session");
    await press(s.h, "tui.select.cancel"); expect((await task).status).toBe("cancelled"); expect(s.save).not.toHaveBeenCalled();
  });

  it("shows actual Store and Exchange values in Advanced and Review", async () => {
    const values = { ...existingMessaging, storeDirectory: "/fixtures/store", storeFile: "/fixtures/store/exchange.sqlite", exchangeNamespace: "actual-space", exchangeIdempotencyKey: "actual-key" };
    const s = setup({ existing, piSessionId: SESSION, existingMessaging: values });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    for (const value of [values.storeDirectory, values.storeFile, values.exchangeNamespace, values.exchangeIdempotencyKey]) expect(frame(s.h)).toContain(value);
    await selectLabel(s.h, "Back · Edit configuration"); await editToReview(s);
    const review = await fullFrame(s.h);
    for (const value of [values.storeDirectory, values.storeFile, values.exchangeNamespace, values.exchangeIdempotencyKey]) expect(review).toContain(value);
    await press(s.h, "tui.select.cancel"); await task;
  });
  async function editRouting(s: ReturnType<typeof setup>, field: string, revert = false) {
    if (field === "Recipients") {
      await selectLabel(s.h, "Advanced · Recipients");
      await enter(s.h, revert ? "mcp:ops/original" : "mcp:ops/alerts");
    } else {
      await selectLabel(s.h, field);
      if (field === "Tunnel ID") await enter(s.h, revert ? existing.tunnelId : "tunnel_newabcde");
      await enter(s.h, field === "Organization ID" && !revert ? "org-new" : existing.organizationId);
      await selectLabel(s.h, "Keep existing credential");
    }
  }

  it.each(["Tunnel ID", "Organization ID", "Recipients"])("%s edits require reauthorization, then permit explicit authorize and Save", async (field) => {
    const s = setup({ existing: { ...existing, recipients: [{ adapter: "mcp", endpointId: "ops/original" }] }, piSessionId: SESSION, existingMessaging });
    const { task } = await start(s); await toEdit(s);
    await editRouting(s, field);
    await selectLabel(s.h, "Review");
    const review = await fullFrame(s.h);
    expect(review).toContain("Requires reauthorization");
    expect(review).not.toContain("· unchanged");
    await press(s.h);
    expect(frame(s.h)).toContain("Edit configuration");
    expect(frame(s.h)).not.toContain("Save configuration");
    expect(s.save).not.toHaveBeenCalled();
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Re-authorize messaging for this session");
    await editToReview(s); await press(s.h); await press(s.h);
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging?.piSessionId).toBe(SESSION);
  });

  it.each(["Tunnel ID", "Organization ID", "Recipients"])("reverting %s edits keeps messaging unchanged without reauthorization", async (field) => {
    const s = setup({ existing: { ...existing, recipients: [{ adapter: "mcp", endpointId: "ops/original" }] }, piSessionId: SESSION, existingMessaging });
    const { task } = await start(s); await toEdit(s);
    await editRouting(s, field);
    await selectLabel(s.h, "Back · Edit configuration");
    await editRouting(s, field, true);
    await selectLabel(s.h, "Review");
    const review = await fullFrame(s.h);
    expect(review).toContain("· unchanged");
    expect(review).not.toContain("Requires reauthorization");
    await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toBeUndefined();
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it.each(["Tunnel ID", "Organization ID", "Recipients"])("%s edits without existing messaging still save without authorization", async (field) => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s); await editRouting(s, field);
    await selectLabel(s.h, "Review"); await fullFrame(s.h); await press(s.h); await press(s.h);
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toBeUndefined();
  });
  it("Advanced menu exposes Messaging; the screen shows both endpoints, the current session, capabilities, and the restart requirement", async () => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s);
    expect(frame(s.h)).toContain("Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    const screen = frame(s.h);
    expect(screen).toContain("chatgpt/main");
    expect(screen).toContain("pi/main");
    expect(screen).toContain(SESSION);
    expect(screen).toContain("Payload read: enabled · ACK: enabled");
    expect(screen).toContain("only these two endpoints");
    expect(screen).toContain("restart the Tunnel");
    expect(screen).toContain("Authorize messaging for this session");
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("authorize flows into Review and the proposal carries the exact session-bound messaging", async () => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Authorize messaging for this session");
    expect(frame(s.h)).toContain("Edit configuration");
    await editToReview(s);
    const review = await fullFrame(s.h);
    expect(review).toContain("Messaging (ChatGPT ↔ Pi)");
    expect(review).toContain("chatgpt/main");
    expect(review).toContain("pi/main");
    expect(review).toContain(SESSION);
    expect(review).toContain("Enabled (reception only, not completion)");
    await press(s.h); // review continue -> change confirmation (messaging authorize is a change)
    expect(frame(s.h)).toContain("Existing Tunnel configuration will be changed");
    expect(frame(s.h)).toContain("Messaging:");
    await press(s.h); // confirm changes -> save
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    const proposal = s.save.mock.calls[0]![0];
    expect(proposal.messaging).toEqual({
      chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: SESSION, replaceExisting: false,
    });
    expect(proposal.recipients).toBeUndefined(); // messaging derives the recipient list
  });

  it("without a session id the authorize action is hidden and messaging is refused — never guessed", async () => {
    const s = setup({ existing }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).toContain("Unavailable");
    expect(frame(s.h)).toContain("never guessed");
    expect(frame(s.h)).not.toContain("Authorize messaging");
    await selectLabel(s.h, "Back · Edit configuration");
    await selectLabel(s.h, "Back · Review");
    await finish(s);
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toBeUndefined();
  });

  it("an existing different session mapping requires the replace path: proposal carries replaceExisting true after the change review", async () => {
    const s = setup({ existing, piSessionId: SESSION, existingMessaging }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).toContain("pi-session-OLD"); // current mapping shown before replacing
    await selectLabel(s.h, "Re-authorize messaging for this session");
    await editToReview(s);
    await press(s.h);
    const confirm = frame(s.h).replace(/\s+/g, ""); // the panel wraps long lines
    expect(confirm).toContain("pi-session-OLD");
    expect(confirm).toContain(SESSION);
    await press(s.h);
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toEqual({
      chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: SESSION, replaceExisting: true,
    });
  });

  it("renders malicious messaging identities as single lines in Review and change confirmation while saving the raw accepted session", async () => {
    const rawSession = "pi-session-current\nCredential: forged\rRouting: forged\nACK: forged";
    const maliciousExisting: ExistingMessagingValues = {
      ...existingMessaging,
      chatgptEndpointId: "chatgpt/old\nCredential: forged",
      piEndpointId: "pi/old\rRouting: forged",
      piSessionId: "pi-session-old\nACK: forged",
    };
    const s = setup({ existing, piSessionId: rawSession, existingMessaging: maliciousExisting });
    const { task } = await start(s); await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Re-authorize messaging for this session");
    await editToReview(s);
    const review = await fullFrame(s.h);
    for (const forgedRow of ["Credential: forged", "Routing: forged", "ACK: forged"]) {
      expect(review.split("\n").map((line) => line.trim())).not.toContain(forgedRow);
    }
    await press(s.h);
    const confirmation = await fullFrame(s.h);
    for (const forgedRow of ["Credential: forged", "Routing: forged", "ACK: forged"]) {
      expect(confirmation.split("\n").map((line) => line.trim())).not.toContain(forgedRow);
    }
    await press(s.h);
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging?.piSessionId).toBe(rawSession);
  });

  it("re-authorizing the identical mapping for the same session is not an extra change", async () => {
    const same: ExistingMessagingValues = { ...existingMessaging, piSessionId: SESSION };
    const s = setup({ existing, piSessionId: SESSION, existingMessaging: same }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Re-authorize messaging for this session");
    await selectLabel(s.h, "Back · Review");
    await finish(s); // no change confirmation appears
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toEqual({
      chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: SESSION, replaceExisting: false,
    });
  });

  it("authorize replaces any edited Advanced recipient list", async () => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Recipients");
    await enter(s.h, "mcp:ops/alerts");
    await selectLabel(s.h, "Back · Edit configuration");
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Authorize messaging for this session");
    await editToReview(s);
    await press(s.h); await press(s.h);
    await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
    expect(s.save.mock.calls[0]![0].messaging?.piSessionId).toBe(SESSION);
  });

  it("Cancel at the messaging change confirmation never invokes save", async () => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Authorize messaging for this session");
    await editToReview(s); await press(s.h);
    expect(frame(s.h)).toContain("Messaging:");
    await press(s.h, "tui.select.cancel");
    expect(await task).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });

  it("after Messaging authorization Advanced Recipients is read-only and Review shows the actual derived recipient", async () => {
    const s = setup({ existing, piSessionId: SESSION }); const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    await selectLabel(s.h, "Authorize messaging for this session");
    await selectLabel(s.h, "Advanced · Recipients");
    expect(frame(s.h)).toContain("Recipients are derived from Messaging");
    expect(frame(s.h)).toContain("pi:pi/main");
    await selectLabel(s.h, "Back · Edit configuration");
    await editToReview(s);
    const review = await fullFrame(s.h);
    expect(review).toContain("pi:pi/main (derived from Messaging)");
    expect(review).toContain("New ChatGPT-side binding");
    await press(s.h); await press(s.h); await selectLabel(s.h, "Save configuration");
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging?.piEndpointId).toBe("pi/main");
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it("untouched messaging leaves an existing configuration completely out of the proposal", async () => {
    const s = setup({ existing, piSessionId: SESSION, existingMessaging }); const { task } = await start(s);
    await enter(s.h, existing.tunnelId); await enter(s.h, existing.organizationId);
    await selectLabel(s.h, "Keep existing credential");
    await finish(s);
    expect((await task).status).toBe("saved");
    expect(s.save.mock.calls[0]![0].messaging).toBeUndefined();
    expect(s.save.mock.calls[0]![0].recipients).toBeUndefined();
  });

  it.each(["abort", "timeout", "ctrl-c", "dispose"])("%s at the messaging screen cancels closed without saving", async (reason) => {
    vi.useFakeTimers(); const controller = new AbortController();
    const s = setup({ existing, piSessionId: SESSION, timeoutMs: 1000, signal: controller.signal });
    const { task } = await start(s);
    await toEdit(s);
    await selectLabel(s.h, "Advanced · Messaging (ChatGPT ↔ Pi)");
    expect(frame(s.h)).toContain("Messaging");
    if (reason === "abort") controller.abort();
    else if (reason === "timeout") await vi.advanceTimersByTimeAsync(1001);
    else if (reason === "ctrl-c") s.h.send("\x03");
    else s.disposeComponent();
    const outcome: SetupUiOutcome = await task;
    expect(outcome).toEqual({ status: "cancelled" });
    expect(s.save).not.toHaveBeenCalled();
  });
});
