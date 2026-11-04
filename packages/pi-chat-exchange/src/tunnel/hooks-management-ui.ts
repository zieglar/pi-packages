/** Native operator dialogs only; no model/MCP grant surface. */
import { defineMenu, runMenu, sanitizeTerminalText, type MenuScreen, type MenuTransition } from "@narumitw/pi-tui-kit";
import type { CeHookAuditSnapshot } from "../hooks/runner.js";
import { parseHookRules, type CeHookRule } from "../hooks/config.js";
import { replaceHookRule, type createHooksManagement, type HooksPreview, type HooksSaveResult } from "./hooks-management.js";
import type { SetupUiContext } from "./setup-ui.js";
import type { TunnelKeyProtocol } from "./secure-input.js";

export interface HooksManagementUiOptions {
  readonly management?: ReturnType<typeof createHooksManagement>;
  readonly loadedAudit?: { readonly snapshot: CeHookAuditSnapshot; readonly source: string; readonly invalid: boolean };
  readonly keys: TunnelKeyProtocol;
  readonly safeTest: () => Promise<{ readonly executed: boolean; readonly configuredCommandsExecuted: boolean; readonly exitCode: number }>;
  readonly signal?: AbortSignal;
}
export type HooksManagementUiOutcome =
  | { readonly status: "closed" | "inspect-only" }
  | ({ readonly status: "saved" } & HooksSaveResult)
  | { readonly status: "tested"; readonly executed: boolean; readonly configuredCommandsExecuted: boolean }
  | { readonly status: "refused"; readonly detail: string };
type Screen = "main" | "rules" | "rule" | "input" | "review" | "safeTest" | "recovery" | "loaded";
type Action = "pi" | "mcp" | "choose" | "add" | "edit" | "input" | "toggle" | "remove" | "review" | "upgrade" | "confirm" | "test" | "openTest" | "recovery" | "recoveryInput" | "loaded";
const safe = (value: string): string => sanitizeTerminalText(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function runHooksManagementUi(ctx: SetupUiContext, options: HooksManagementUiOptions): Promise<HooksManagementUiOutcome> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function" || options.signal?.aborted) return { status: "inspect-only" };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 120_000); timer.unref?.();
  // Follow the existing native dialogs' disposal/cancellation convention.
  const open = ctx.ui.custom.bind(ctx.ui);
  const menuCtx: SetupUiContext = { ...ctx, ui: { ...ctx.ui, custom: (factory, customOptions) => open((tui, theme, keybindings, done) => {
    let completed = false; let disposed = false;
    const complete = (result: unknown): void => { if (!completed) { completed = true; done(result as never); } };
    const produced = factory(tui, theme, keybindings, complete);
    if (typeof (produced as { then?: unknown }).then === "function") throw new Error("Unsupported component");
    const component = produced as typeof produced & object;
    const handleInput = component.handleInput?.bind(component); const dispose = component.dispose?.bind(component);
    component.handleInput = data => {
      const configured = keybindings as { matches?(data: string, binding: string): boolean };
      if (options.keys.matches(data, options.keys.escape) || options.keys.matches(data, options.keys.ctrlC) || configured.matches?.(data, "tui.select.cancel")) abort();
      handleInput?.(data);
    };
    component.dispose = () => { if (!disposed) { disposed = true; dispose?.(); } if (!completed) { abort(); complete(undefined); } };
    return component;
  }, customOptions) } };
  let direction: "pi" | "mcp" = "pi";
  let rules: readonly CeHookRule[] = [];
  let selectedRule: CeHookRule | undefined;
  let editing = false;
  let error = "";
  let candidate: HooksPreview | undefined;
  let confirmed = false; let testConfirmed = false;
  const to = (screen: Screen): MenuTransition<Screen> => ({ kind: "to", screen });
  const close: MenuTransition<Screen> = { kind: "close" };
  try {
    let selected: ReturnType<ReturnType<typeof createHooksManagement>["inspect"]> | undefined;
    try { selected = options.management?.inspect(); } catch { /* A committed upgrade may intentionally invalidate the old v1 selection. */ }
    const v2 = selected?.snapshot.ref.kind === "ce-live-session-v2";
    const cancel = { id: "cancel", label: "Cancel", close: true as const };
    const screens: Record<Screen, () => MenuScreen<Screen, Action>> = {
      main: () => ({ kind: "actions", title: "Hooks · native configuration", hint: "close", lines: [
        "Configured != adopted != eligible != executed.",
        ...(selected ? [`Pi → ChatGPT (this session): ${selected.piHooks.length} rules`,
          `ChatGPT → Pi (sender binding): ${selected.mcpHooks.length} rules`, `Policy: ${selected.snapshot.ref.kind}`]
          : options.management ? ["Selected policy unavailable; a committed upgrade may be pending Profile selection.", "Restricted reconciliation only. Supply the exact candidate path and operation from the prior pending report."]
            : ["Live editing unavailable. Inspect the loaded rules for this Pi process."]),
        "Saving requires explicit confirmation. Reload/start remains a separate operator action.",
        ...(selected && !v2 ? ["v1 is inspect-only until an explicit offline upgrade. Close existing Pi bindings through their normal lifecycle first."] : []),
        ...(error ? [error] : []),
      ], items: [
        { id: "close", label: "Close", close: true },
        ...(selected ? [{ id: "pi", label: "Pi → ChatGPT · current native Session", action: "pi" as const },
          { id: "mcp", label: "ChatGPT → Pi · MCP sender binding", action: "mcp" as const },
          { id: "test", label: "Safe test · fixed benign fixture", action: "openTest" as const },
          ...(!v2 ? [{ id: "upgrade", label: "Explicit offline v1 → v2 upgrade", action: "upgrade" as const }] : [])] : []),
        ...(options.loadedAudit ? [{ id: "loaded", label: "Loaded rules · this Pi process", action: "loaded" as const }] : []),
        ...(options.management ? [{ id: "recovery", label: "Reconcile / continue exact pending publication", action: "recovery" as const }] : []),
      ] }),
      loaded: () => ({ kind: "detail", title: "Loaded Hook rules · this Pi process", hint: "close", lines: [
        `Source: ${safe(options.loadedAudit?.source ?? "unavailable")}`,
        `Configured=${options.loadedAudit?.snapshot.configured ?? 0} eligible=${options.loadedAudit?.snapshot.active ?? 0} executed=unverified`,
        ...(options.loadedAudit?.invalid ? ["Configuration invalid; Hooks refused."] : []),
        ...(options.loadedAudit?.snapshot.rules.map(rule => safe(`hook ${rule.id} | event=${rule.event} | recipient=${rule.recipient.adapter}/${rule.recipient.endpointId} | command=${rule.command} | args=${JSON.stringify(rule.args)} | timeout=${rule.timeoutMs}ms | ${rule.enabled ? "enabled" : "disabled"}`)) ?? []),
        "Loaded snapshot only. Viewing does not save configuration or execute commands.",
      ] }),
      rules: () => ({ kind: "actions", title: direction === "pi" ? "Pi → ChatGPT · current Session" : "ChatGPT → Pi · sender binding", hint: "close", lines: [
        ...(direction === "mcp" ? ["Incoming authority is the sender binding; receiving Pi outbound rules do not grant it."] : []),
        ...rules.map(rule => safe(JSON.stringify(rule))),
        ...(!v2 ? ["Editing refused until explicit offline upgrade."] : []), ...(error ? [error] : []),
      ], items: [cancel, ...rules.map(rule => ({ id: `rule:${rule.id}`, label: safe(`${rule.id} · ${rule.enabled ? "enabled" : "disabled"}`), action: "choose" as const })),
        ...(v2 ? [{ id: "add", label: "Add rule", action: "add" as const }, { id: "review", label: "Review full candidate", action: "review" as const }] : []),
      ] }),
      rule: () => ({ kind: "actions", title: `Hook · ${safe(selectedRule!.id)}`, hint: "close", lines: [safe(JSON.stringify(selectedRule))], items: [cancel,
        ...(v2 ? [{ id: "edit", label: "Edit rule", action: "edit" as const }, { id: "toggle", label: selectedRule!.enabled ? "Disable rule" : "Enable rule", action: "toggle" as const }, { id: "remove", label: "Remove rule", action: "remove" as const }] : []),
      ] }),
      input: () => ({ kind: "input", title: editing ? "Edit Hook · JSON rule" : "Add Hook · JSON rule", hint: "close", lines: [
        "Enter one static JSON rule: id, event, recipient, absolute command, args array, timeoutMs, enabled.",
        "No command runs here. Every argument is literal; no shell evaluation.", ...(error ? [error] : []),
      ], initialValue: JSON.stringify(editing ? selectedRule : { id: "notify", event: "ce.message.committed.v1", recipient: direction === "pi" ? selected!.snapshot.manifest.chatgptEndpoint : { adapter: "pi", endpointId: "pi/REPLACE" }, command: "/absolute/path/to/executable", args: [], timeoutMs: 30000, enabled: false }), action: "input" }),
      recovery: () => ({ kind: "input", title: "Reconcile pending publication · exact evidence", hint: "close", lines: [
        "Enter JSON with exactly bindingPath and operationId from the prior pending report.",
        "This reads evidence only. No scanning, new consent, upgrade replay or transport operation.", ...(error ? [error] : []),
      ], initialValue: '{"bindingPath":"/exact/private/messaging-HASH.yaml","operationId":"exact-operation"}', action: "recoveryInput" }),
      review: () => ({ kind: "review", title: candidate?.kind === "continuation" ? "Continue published configuration · exact evidence" : candidate?.kind === "upgrade" ? "Explicit offline upgrade · exact candidate" : "Hooks · full candidate consent", hint: "close", content: [
        "The entire candidate below is the scope of this confirmation.",
        ...(candidate?.kind === "continuation" ? ["The operation is already PUBLISHED. Confirmation selects these exact bytes under a verified STOPPED Profile lock; no new chain fact is published."] : []),
        ...(candidate?.kind === "upgrade" ? ["Requires verified STOPPED Profile lock. Retains SAME history, tombstones and Pi Hook facts. Initializes empty MCP consent.", "An upgrade marker cannot be rolled back; Profile selection may remain pending after a crash."] : []),
        JSON.stringify(candidate, null, 2).split("\n").map(safe).join("\n"),
        "Configuration only. No reload, transport operation or configured-command execution.",
      ].join("\n"), format: { kind: "text" }, confirm: { id: "confirm", label: "Approve and save this exact candidate", action: "confirm" } }),
      safeTest: () => ({ kind: "actions", title: "Safe Hook test", hint: "close", lines: ["Run one fixed benign fixture with fixed argv and empty environment.", "Configured commands and personal scripts are never run. This does not test their behavior."], items: [cancel, { id: "run", label: "Run fixed benign fixture", action: "test" }] }),
    };
    const review = (): MenuTransition<Screen> => {
      try { candidate = options.management!.preview(direction, rules); error = ""; return to("review"); }
      catch { error = "Candidate refused; check rules, native Session and v2 policy selection."; return to("rules"); }
    };
    const menu = defineMenu<null, Screen, Action, SetupUiContext>({ start: "main", screens, actions: {
      pi: () => { direction = "pi"; rules = selected!.piHooks; return to("rules"); },
      mcp: () => { direction = "mcp"; rules = selected!.mcpHooks; return to("rules"); },
      choose: ({ itemId }) => { selectedRule = rules.find(rule => `rule:${rule.id}` === itemId); return selectedRule ? to("rule") : to("rules"); },
      add: () => { editing = false; return to("input"); }, edit: () => { editing = true; return to("input"); },
      input: ({ value = "" }) => {
        try {
          const rule = parseHookRules([JSON.parse(value)])[0]!;
          rules = replaceHookRule(rules, editing ? { kind: "edit", id: selectedRule!.id, rule } : { kind: "add", rule });
          return review();
        } catch { error = "Invalid rule JSON; check the closed Hook schema."; return to("input"); }
      },
      toggle: () => { rules = replaceHookRule(rules, { kind: selectedRule!.enabled ? "disable" : "enable", id: selectedRule!.id }); return review(); },
      remove: () => { rules = replaceHookRule(rules, { kind: "remove", id: selectedRule!.id }); return review(); },
      review,
      loaded: () => to("loaded"),
      recovery: () => to("recovery"),
      recoveryInput: ({ value = "" }) => {
        try {
          const input: unknown = JSON.parse(value);
          if (!input || typeof input !== "object" || Array.isArray(input) || Reflect.ownKeys(input).length !== 2 || !Object.hasOwn(input, "bindingPath") || !Object.hasOwn(input, "operationId")) throw new Error("input");
          const fields = input as { bindingPath: unknown; operationId: unknown };
          if (typeof fields.bindingPath !== "string" || typeof fields.operationId !== "string") throw new Error("input");
          candidate = options.management!.previewContinuation({ bindingPath: fields.bindingPath, operationId: fields.operationId });
          error = ""; return to("review");
        } catch { candidate = undefined; error = "Pending publication refused: check exact evidence, current target scope and native Session."; return to("recovery"); }
      },
      upgrade: () => { try { candidate = options.management!.previewUpgrade(); return to("review"); } catch { error = "Upgrade preview refused; reconcile the selected policy first."; return to("main"); } },
      confirm: () => { if (!controller.signal.aborted && candidate) confirmed = true; return close; },
      openTest: () => to("safeTest"), test: () => { if (!controller.signal.aborted) testConfirmed = true; return close; },
    } });
    const result = await runMenu(menuCtx, menu, { getState: () => null, signal: controller.signal, onError: abort });
    if (controller.signal.aborted || result.kind === "error") return { status: "closed" };
    // The native component has released the terminal. Never run a save or test
    // from a preview renderer, navigation action or a disposed/aborted dialog.
    if (confirmed && candidate) return { status: "saved", ...await options.management!.save(candidate, true, controller.signal) };
    if (testConfirmed) { const test = await options.safeTest(); return { status: "tested", executed: test.executed, configuredCommandsExecuted: test.configuredCommandsExecuted }; }
    return { status: "closed" };
  } catch { return { status: "refused", detail: "Hooks operation refused; inspect configuration and pending publication evidence." }; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); abort(); }
}
