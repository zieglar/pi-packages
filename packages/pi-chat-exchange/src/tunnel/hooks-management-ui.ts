/** Native operator dialogs only; no model/MCP grant surface. */
import { isDeepStrictEqual } from "node:util";
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
  readonly saveWorkspaceDefault?: (candidate: HooksPreview, signal: AbortSignal) => Promise<HooksSaveResult>;
  readonly applyWorkspaceDefault?: (candidate: HooksPreview, signal: AbortSignal) => Promise<HooksSaveResult>;
  readonly workspaceProfile?: { readonly revision: number | null; readonly hooks?: readonly CeHookRule[]; readonly pendingOperationId?: string };
  readonly signal?: AbortSignal;
  readonly onProgress?: (text: string) => void;
  readonly piPreset?: CeHookRule;
}
export type HooksManagementUiOutcome =
  | { readonly status: "closed" | "inspect-only" }
  | { readonly status: "cancelled"; readonly reason: "user" | "timeout" | "superseded" }
  | ({ readonly status: "saved"; readonly saveMode: "session" | "workspace" | "apply" } & HooksSaveResult)
  | { readonly status: "tested"; readonly executed: boolean; readonly configuredCommandsExecuted: boolean }
  | { readonly status: "test-failed"; readonly detail: string }
  | { readonly status: "refused"; readonly detail: string };
type Screen = "main" | "rules" | "rule" | "input" | "review" | "safeTest" | "recovery" | "loaded";
type Action = "pi" | "mcp" | "choose" | "add" | "preset" | "updatePreset" | "edit" | "input" | "toggle" | "remove" | "reviewSession" | "reviewWorkspace" | "applyWorkspace" | "upgrade" | "confirm" | "test" | "openTest" | "recovery" | "recoveryInput" | "loaded" | "cancel";
const safe = (value: string): string => sanitizeTerminalText(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
const sameRuleWithoutStatus = (current: CeHookRule, preset: CeHookRule): boolean => {
  const { status: _currentStatus, ...currentBase } = current;
  const { status: _presetStatus, ...presetBase } = preset;
  return isDeepStrictEqual(currentBase, presetBase);
};

export async function runHooksManagementUi(ctx: SetupUiContext, options: HooksManagementUiOptions): Promise<HooksManagementUiOutcome> {
  if (options.signal?.aborted) return { status: "cancelled", reason: "superseded" };
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") return { status: "inspect-only" };
  const controller = new AbortController();
  let cancellationReason: "user" | "timeout" | "superseded" = "superseded";
  // Preserve the first cancellation source, including disposal after an abort.
  const abort = (reason: typeof cancellationReason): void => {
    if (!controller.signal.aborted) { cancellationReason = reason; controller.abort(); }
  };
  const supersede = (): void => abort("superseded");
  const cancelled = (): HooksManagementUiOutcome => ({ status: "cancelled", reason: cancellationReason });
  options.signal?.addEventListener("abort", supersede, { once: true });
  const timer = setTimeout(() => abort("timeout"), 120_000); timer.unref?.();
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
      if (options.keys.matches(data, options.keys.escape) || options.keys.matches(data, options.keys.ctrlC) || configured.matches?.(data, "tui.select.cancel")) abort("user");
      handleInput?.(data);
    };
    component.dispose = () => { if (!disposed) { disposed = true; dispose?.(); } if (!completed) { supersede(); complete(undefined); } };
    return component;
  }, customOptions) } };
  let direction: "pi" | "mcp" = "pi";
  let rules: readonly CeHookRule[] = [];
  let selectedRule: CeHookRule | undefined;
  let editing = false;
  let error = "";
  let candidate: HooksPreview | undefined;
  let saveMode: "session" | "workspace" | "apply" = "session";
  let confirmed = false; let testConfirmed = false;
  const to = (screen: Screen): MenuTransition<Screen> => ({ kind: "to", screen });
  const close: MenuTransition<Screen> = { kind: "close" };
  try {
    let selected: ReturnType<ReturnType<typeof createHooksManagement>["inspect"]> | undefined;
    try { selected = options.management?.inspect(); } catch { /* A committed upgrade may intentionally invalidate the old v1 selection. */ }
    const v2 = selected?.snapshot.ref.kind === "ce-live-session-v2";
    const cancel = { id: "cancel", label: "Cancel", action: "cancel" as const };
    const screens: Record<Screen, () => MenuScreen<Screen, Action>> = {
      main: () => ({ kind: "actions", title: "Hooks · native configuration", hint: "close", lines: [
        "Configured != adopted != eligible != executed.",
        ...(selected ? [`Pi → ChatGPT (this session): ${selected.piHooks.length} rules`,
          `ChatGPT → Pi (sender binding): ${selected.mcpHooks.length} rules`, `Policy: ${selected.snapshot.ref.kind}`]
          : options.management ? ["Selected policy unavailable; a committed upgrade may be pending Profile selection.", "Restricted reconciliation only. Supply the exact candidate path and operation from the prior pending report."]
            : ["Live editing unavailable. Inspect the loaded rules for this Pi process."]),
        ...(options.workspaceProfile === undefined ? [] : [`Workspace default revision: ${options.workspaceProfile.revision ?? "none"}`,
          ...(options.workspaceProfile.pendingOperationId === undefined ? [] : [`Workspace save: PENDING (${safe(options.workspaceProfile.pendingOperationId)})`])]),
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
      rules: () => {
        const presetRule = direction === "pi" ? options.piPreset : undefined;
        const currentPreset = presetRule === undefined ? undefined : rules.find(rule => rule.id === presetRule.id);
        const presetNeedsStatusUpdate = presetRule !== undefined && currentPreset !== undefined
          && sameRuleWithoutStatus(currentPreset, presetRule)
          && !isDeepStrictEqual(currentPreset.status, presetRule.status);
        return ({ kind: "actions", title: direction === "pi" ? "Pi → ChatGPT · current Session" : "ChatGPT → Pi · sender binding", hint: "close", lines: [
        ...(direction === "mcp" ? ["Incoming authority is the sender binding; receiving Pi outbound rules do not grant it."] : []),
        ...rules.map(rule => safe(JSON.stringify(rule))),
        ...(!v2 ? ["Editing refused until explicit offline upgrade."] : []), ...(error ? [error] : []),
      ], items: [cancel, ...rules.map(rule => ({ id: `rule:${rule.id}`, label: safe(`${rule.id} · ${rule.enabled ? "enabled" : "disabled"}`), action: "choose" as const })),
        ...(v2 ? [{ id: "add", label: "Add rule", action: "add" as const }, ...(presetRule ? [presetNeedsStatusUpdate
          ? { id: "update-preset", label: "Update Agent Desktop status preset", action: "updatePreset" as const }
          : { id: "preset", label: "Add Agent Desktop wake preset", action: "preset" as const }] : []),
          { id: "review-session", label: "Save for this Session", action: "reviewSession" as const },
          ...(direction === "pi" ? [{ id: "review-workspace", label: "Save as workspace default", action: "reviewWorkspace" as const },
            ...(options.workspaceProfile?.hooks === undefined ? [] : [{ id: "apply-workspace", label: "Apply workspace Hooks to this Session", action: "applyWorkspace" as const }])] : [])] : []),
      ] }); },
      rule: () => ({ kind: "actions", title: `Hook · ${safe(selectedRule!.id)}`, hint: "close", lines: [safe(JSON.stringify(selectedRule))], items: [cancel,
        ...(v2 ? [{ id: "edit", label: "Edit rule", action: "edit" as const }, { id: "toggle", label: selectedRule!.enabled ? "Disable rule" : "Enable rule", action: "toggle" as const }, { id: "remove", label: "Remove rule", action: "remove" as const }] : []),
      ] }),
      input: () => ({ kind: "input", title: editing ? "Edit Hook · JSON rule" : "Add Hook · JSON rule", hint: "close", lines: [
        "Enter one static JSON rule: id, event, recipient, absolute command, args array, timeoutMs, enabled, scope.",
        "No command runs here. Every argument is literal; no shell evaluation.", ...(error ? [error] : []),
      ], initialValue: JSON.stringify(editing ? selectedRule : { id: "notify", event: "ce.message.committed.v1", recipient: direction === "pi" ? selected!.snapshot.manifest.chatgptEndpoint : { adapter: "pi", endpointId: "pi/REPLACE" }, command: "/absolute/path/to/executable", args: [], timeoutMs: 30000, enabled: false, scope: "session" }), action: "input" }),
      recovery: () => ({ kind: "input", title: "Reconcile pending publication · exact evidence", hint: "close", lines: [
        "Enter JSON with exactly bindingPath and operationId from the prior pending report.",
        "This reads evidence only. No scanning, new consent, upgrade replay or transport operation.", ...(error ? [error] : []),
      ], initialValue: '{"bindingPath":"/exact/private/messaging-HASH.yaml","operationId":"exact-operation"}', action: "recoveryInput" }),
      review: () => ({ kind: "review", title: candidate?.kind === "continuation" ? "Continue published configuration · exact evidence" : candidate?.kind === "upgrade" ? "Explicit offline upgrade · exact candidate" : saveMode === "workspace" ? "Hooks · workspace default consent" : saveMode === "apply" ? "Hooks · apply workspace default" : "Hooks · Session consent", hint: "close", content: [
        "The entire candidate below is the scope of this confirmation.",
        ...(candidate?.kind === "pi" && saveMode === "workspace" ? ["Workspace-scoped rules become defaults for future Sessions. Existing Sessions are not changed automatically."] : []),
        ...(candidate?.kind === "pi" && saveMode === "session" ? ["Only this Session policy changes. The workspace default remains unchanged."] : []),
        ...(candidate?.kind === "pi" && saveMode === "apply" ? ["The committed workspace revision is applied to this Session only. Other active Sessions remain unchanged."] : []),
        ...(candidate?.kind === "continuation" ? ["The operation is already PUBLISHED. Confirmation selects these exact bytes under a verified STOPPED Profile lock; no new chain fact is published."] : []),
        ...(candidate?.kind === "upgrade" ? ["Requires verified STOPPED Profile lock. Retains SAME history, tombstones and Pi Hook facts. Initializes empty MCP consent.", "An upgrade marker cannot be rolled back; Profile selection may remain pending after a crash."] : []),
        JSON.stringify(candidate, null, 2).split("\n").map(safe).join("\n"),
        "Configuration only. No reload, transport operation or configured-command execution.",
      ].join("\n"), format: { kind: "text" }, confirm: { id: "confirm", label: "Approve and save this exact candidate", action: "confirm" } }),
      safeTest: () => ({ kind: "actions", title: "Safe Hook test", hint: "close", lines: ["Run one fixed benign fixture with fixed argv and empty environment.", "Configured commands and personal scripts are never run. This does not test their behavior."], items: [cancel, { id: "run", label: "Run fixed benign fixture", action: "test" }] }),
    };
    const review = (mode: "session" | "workspace"): MenuTransition<Screen> => {
      if (mode === "workspace" && direction !== "pi") { error = "Workspace defaults are available only for Pi → ChatGPT rules."; return to("rules"); }
      saveMode = mode;
      try { candidate = options.management!.preview(direction, rules); error = ""; return to("review"); }
      catch { error = "Candidate refused; check rules, native Session and v2 policy selection."; return to("rules"); }
    };
    const menu = defineMenu<null, Screen, Action, SetupUiContext>({ start: "main", screens, actions: {
      pi: () => { direction = "pi"; rules = selected!.piHooks; return to("rules"); },
      mcp: () => { direction = "mcp"; rules = selected!.mcpHooks; return to("rules"); },
      choose: ({ itemId }) => { selectedRule = rules.find(rule => `rule:${rule.id}` === itemId); return selectedRule ? to("rule") : to("rules"); },
      add: () => { editing = false; return to("input"); }, edit: () => { editing = true; return to("input"); },
      preset: () => { try { rules = replaceHookRule(rules, { kind: "add", rule: options.piPreset! }); return review("workspace"); } catch { error = "Agent Desktop preset conflicts with an existing rule; inspect or edit the existing rule."; return to("rules"); } },
      updatePreset: () => {
        const preset = options.piPreset; const current = preset === undefined ? undefined : rules.find(rule => rule.id === preset.id);
        if (preset === undefined || current === undefined || !sameRuleWithoutStatus(current, preset)) {
          error = "Agent Desktop preset conflicts with the existing rule; inspect or edit it manually."; return to("rules");
        }
        rules = replaceHookRule(rules, { kind: "edit", id: current.id, rule: preset });
        return review("workspace");
      },
      input: ({ value = "" }) => {
        try {
          const rule = parseHookRules([JSON.parse(value)])[0]!;
          rules = replaceHookRule(rules, editing ? { kind: "edit", id: selectedRule!.id, rule } : { kind: "add", rule });
          return to("rules");
        } catch { error = "Invalid rule JSON; check the closed Hook schema."; return to("input"); }
      },
      toggle: () => { rules = replaceHookRule(rules, { kind: selectedRule!.enabled ? "disable" : "enable", id: selectedRule!.id }); return review("session"); },
      remove: () => { rules = replaceHookRule(rules, { kind: "remove", id: selectedRule!.id }); return review("session"); },
      reviewSession: () => review("session"),
      reviewWorkspace: () => review("workspace"),
      applyWorkspace: () => {
        try {
          rules = parseHookRules([...(options.workspaceProfile?.hooks ?? []), ...rules.filter(rule => rule.scope === "session")]);
          saveMode = "apply";
          candidate = options.management!.preview("pi", rules);
          error = ""; return to("review");
        } catch { error = "Workspace Hooks conflict with this Session; resolve duplicate IDs before applying."; return to("rules"); }
      },
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
      cancel: () => { abort("user"); return close; },
      openTest: () => to("safeTest"), test: () => { if (!controller.signal.aborted) testConfirmed = true; return close; },
    } });
    let menuFailed = false;
    const result = await runMenu(menuCtx, menu, { getState: () => null, signal: controller.signal, onError: () => { menuFailed = true; supersede(); } });
    if (menuFailed || result.kind === "error") return { status: "refused", detail: "Hooks configuration publication refused; check configuration and pending publication evidence." };
    if (controller.signal.aborted) return cancelled();
    // The native component has released the terminal. Never run a save or test
    // from a preview renderer, navigation action or a disposed/aborted dialog.
    if (confirmed && candidate) {
      options.onProgress?.("Saving and publishing the Hook candidate");
      const selectedSaveMode: "session" | "workspace" | "apply" = String(saveMode) === "workspace" ? "workspace" : String(saveMode) === "apply" ? "apply" : "session";
      const saved = selectedSaveMode === "workspace" && options.saveWorkspaceDefault !== undefined
        ? await options.saveWorkspaceDefault(candidate, controller.signal)
        : selectedSaveMode === "apply" && options.applyWorkspaceDefault !== undefined
          ? await options.applyWorkspaceDefault(candidate, controller.signal)
        : await options.management!.save(candidate, true, controller.signal);
      return { status: "saved", saveMode: selectedSaveMode, ...saved };
    }
    if (testConfirmed) {
      options.onProgress?.("Running the fixed benign fixture");
      try {
        const test = await options.safeTest();
        if (controller.signal.aborted) return cancelled();
        return { status: "tested", executed: test.executed, configuredCommandsExecuted: test.configuredCommandsExecuted };
      } catch {
        return { status: "test-failed", detail: "The fixed benign fixture test did not successfully complete; configured commands and personal scripts were not executed." };
      }
    }
    return { status: "closed" };
  } catch { return { status: "refused", detail: "Hooks configuration publication refused; check configuration and pending publication evidence." }; }
  finally { clearTimeout(timer); options.signal?.removeEventListener("abort", supersede); supersede(); }
}
