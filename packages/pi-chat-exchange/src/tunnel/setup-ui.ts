/**
 * Domain-independent CE setup adapter. Kit owns nonsecret navigation; API keys
 * only pass through CE custom masked secret input hosted through Pi 1.3.0
 * ctx.ui.custom(). Pi does not provide a native PasswordInput / SecretInput.
 *
 * The caller owns profile inspection, static binding validation and transaction
 * authority. No filesystem, Store, endpoint, Keychain, process or network work
 * occurs here. Only the final explicit Save calls the injected transaction.
 *
 * Secret references are invocation-local, never menu state/content/outcomes.
 * JavaScript strings cannot reliably be erased. Malicious same-process
 * extensions and external terminal/process recording are not isolated by this UI.
 */
import { defineMenu, runMenu, sanitizeTerminalText, type MenuContext, type MenuScreen, type MenuTransition } from "@narumitw/pi-tui-kit";
import { isTunnelRefusalCode, TunnelRefusal, type TunnelRefusalCode } from "./codes.js";
import { captureTunnelSecret, type SecureInputUiView, type TunnelKeyProtocol } from "./secure-input.js";
export interface SetupUiContext extends MenuContext { readonly ui: SecureInputUiView; }
export interface ExistingSetupValues {
  readonly tunnelId: string;
  readonly organizationId?: string;
  readonly bindingPath: string;
  readonly credentialConfigured: boolean;
}
export interface SetupProposal {
  readonly tunnelId: string;
  readonly organizationId?: string;
  readonly bindingPath: string;
  readonly credential: { readonly kind: "keep" } | { readonly kind: "replace"; readonly secret: string };
}
export interface SetupWizardOptions {
  readonly profilePath: string;
  /** Host-injected key protocol (no Pi import in `src/`). */
  readonly keys: TunnelKeyProtocol;
  readonly existing?: ExistingSetupValues;
  /** Static parser only; no Store/endpoint/child/network side effects. */
  readonly validateBinding: (path: string, signal?: AbortSignal) => Promise<void>;
  /** Borrowed secret: do not retain the proposal after the transaction settles. */
  readonly save: (proposal: SetupProposal, signal: AbortSignal) => Promise<void | { readonly kind: "cancelled" }>;
  readonly signal?: AbortSignal;
  /** Whole wizard budget, not reset per step. Owned work is always awaited. */
  readonly timeoutMs?: number;
}
export type SetupUiOutcome =
  | { readonly status: "saved" }
  | { readonly status: "cancelled" }
  | { readonly status: "refused"; readonly code: "CE_TUNNEL_INPUT_UNAVAILABLE" | "CE_TUNNEL_SETUP_FAILED" };

type Screen = "profile" | "tunnel" | "organization" | "bindingChoice" | "binding" | "credential" | "reviewEntry" | "review" | "changes" | "save" | "edit";
type Action = "tunnel" | "organization" | "binding" | "keepBinding" | "keepCredential" | "capture" | "review" | "save";
interface Draft { tunnelId: string; organizationId: string; bindingPath: string; error: string; credential: "keep" | "replace" | "missing"; }
const TUNNEL = /^tunnel_[A-Za-z0-9]{8,}$/;
const ORGANIZATION = /^org-[A-Za-z0-9]{1,128}$/;
const cancelled = (): SetupUiOutcome => ({ status: "cancelled" });
const failed = (): SetupUiOutcome => ({ status: "refused", code: "CE_TUNNEL_SETUP_FAILED" });
const to = (screen: Screen): MenuTransition<Screen> => ({ kind: "to", screen });
const close: MenuTransition<Screen> = { kind: "close" };

/** Escape, Ctrl-C, cancellation and timeout cancel the invocation, never go Back. */
export async function runSetupWizard(ctx: SetupUiContext, options: SetupWizardOptions): Promise<SetupUiOutcome> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
    return { status: "refused", code: "CE_TUNNEL_INPUT_UNAVAILABLE" };
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(onAbort, Math.max(0, options.timeoutMs ?? 120_000));
  timer.unref?.();
  const signal = controller.signal;
  // Kit 0.66 waits for input validation before closing. Promote cancel to the
  // invocation signal before delegating so a pending handler cannot advance
  // instead of cancelling. This wraps Pi's component contract, not raw stdin.
  const open = ctx.ui.custom.bind(ctx.ui);
  const menuCtx: SetupUiContext = { ...ctx, ui: { ...ctx.ui, custom: (factory, customOptions) => open((tui, theme, keybindings, done) => {
    let completed = false;
    let disposed = false;
    const complete = (result: unknown): void => {
      if (completed) return;
      completed = true;
      done(result as never);
    };
    const produced = factory(tui, theme, keybindings, complete);
    if (typeof (produced as { then?: unknown }).then === "function") {
      // Pi's contract allows a promised component. Rather than silently losing
      // cancel promotion and dispose completion, refuse this unsupported shape.
      throw new TunnelRefusal("CE_TUNNEL_INPUT_UNAVAILABLE");
    }
    const component = produced as typeof produced & object;
    const handleInput = component.handleInput?.bind(component);
    const dispose = component.dispose?.bind(component);
    component.handleInput = (data) => {
      const configuredCancel = keybindings as { matches?(data: string, binding: string): boolean };
      if (options.keys.matches(data, options.keys.escape) || options.keys.matches(data, options.keys.ctrlC) || configuredCancel.matches?.(data, "tui.select.cancel")) controller.abort();
      handleInput?.(data);
    };
    component.dispose = () => {
      if (!disposed) { disposed = true; dispose?.(); }
      if (!completed) { controller.abort(); complete(undefined); }
    };
    return component;
  }, customOptions) } };
  const existing = options.existing;
  const draft: Draft = { tunnelId: existing?.tunnelId ?? "", organizationId: existing?.organizationId ?? "", bindingPath: existing?.bindingPath ?? "", error: "", credential: existing?.credentialConfigured ? "keep" : "missing" };
  let secret: string | undefined;
  let outcome: SetupUiOutcome = cancelled();
  // Deliberately not a Kit state field: neither Kit renderers nor errors see it.
  let saved = false;
  const lines = (): string[] => [`Profile: ${options.profilePath}`, ...(draft.error ? [draft.error] : [])];
  const changes = (): string[] => {
    if (!existing) return [];
    const result: string[] = [];
    for (const [label, oldValue, newValue] of [
      ["Tunnel ID", existing.tunnelId, draft.tunnelId],
      ["Organization", existing.organizationId || "Not configured", draft.organizationId || "Not configured"],
      ["MCP binding", existing.bindingPath, draft.bindingPath],
    ]) if (oldValue !== newValue) result.push(`${label}: ${oldValue} → ${newValue}`);
    return result;
  };
  const summary = (): string => [
    `Profile\n${options.profilePath}`, `Tunnel\n${draft.tunnelId}`,
    `Organization\n${draft.organizationId || "Not configured"}`,
    `MCP binding\n${draft.bindingPath}`,
    `Credential\n${draft.credential === "keep" ? "Existing credential configured (Keep existing)" : existing?.credentialConfigured ? "Provided — Replace existing" : "Provided"}`,
    ...changes(),
  ].join("\n\n");
  const input = (title: string, value: string, action: Action): MenuScreen<Screen, Action> => ({ kind: "input", title, lines: lines(), initialValue: value, action, hint: "close" });
  const cancelItem = { id: "cancel", label: "Cancel", close: true } as const;
  const definition = defineMenu<Draft, Screen, Action, SetupUiContext>({
    start: "profile",
    screens: {
      profile: () => ({ kind: "actions", title: "Tunnel setup · Profile", hint: "close", lines: [...lines(), ...(existing ? [`Tunnel: ${existing.tunnelId}`, `Organization: ${existing.organizationId || "Not configured"}`, `MCP binding: ${existing.bindingPath}`, existing.credentialConfigured ? "Existing credential configured" : "Credential: Not configured"] : ["Create a real Tunnel profile. Configured != Connected."])], items: [{ id: "continue", label: "Continue", to: "tunnel" }, cancelItem] }),
      tunnel: () => input("Tunnel ID", draft.tunnelId, "tunnel"),
      organization: () => input("Organization ID (optional)", draft.organizationId, "organization"),
      bindingChoice: () => ({ kind: "actions", title: "MCP binding config", lines: [...lines(), draft.bindingPath], hint: "close", items: [{ id: "keep", label: "Keep existing MCP binding", action: "keepBinding" }, { id: "change", label: "Change MCP binding", to: "binding" }, { id: "back", label: "Back", to: "organization" }, cancelItem] }),
      binding: () => input("MCP binding config", draft.bindingPath, "binding"),
      credential: () => ({ kind: "actions", title: "Credential · API key", lines: [...lines(), ...(existing?.credentialConfigured ? ["Existing credential configured"] : ["A masked API key is required."])], hint: "close", items: [
        ...(existing?.credentialConfigured ? [{ id: "keep", label: "Keep existing credential", action: "keepCredential" as const }] : []),
        { id: "replace", label: existing?.credentialConfigured ? "Replace credential" : "Provide API key (masked)", action: "capture" },
        { id: "back", label: "Back", to: existing ? "bindingChoice" : "binding" }, cancelItem,
      ] }),
      reviewEntry: () => ({ kind: "actions", title: "Review configuration", lines: lines(), hint: "close", items: [{ id: "review", label: "Review", to: "review" }, { id: "edit", label: "Back · Edit configuration", to: "edit" }, cancelItem] }),
      review: () => ({ kind: "review", title: "Review · Tunnel configuration", content: summary(), format: { kind: "text" }, hint: "close", confirm: { id: "continue", label: "Continue", action: "review" } }),
      changes: () => ({ kind: "review", title: "Existing Tunnel configuration will be changed", content: changes().join("\n\n"), format: { kind: "text" }, hint: "close", confirm: { id: "confirm-change", label: "Confirm identity / routing changes", action: "review" } }),
      save: () => ({ kind: "actions", title: "Save confirmation", lines: ["Only Save configuration writes the proposed configuration.", ...lines()], hint: "close", items: [{ id: "save", label: "Save configuration", action: "save" }, { id: "back", label: "Back · Edit configuration", to: "edit" }, cancelItem] }),
      edit: () => ({ kind: "actions", title: "Edit configuration", lines: lines(), hint: "close", items: [{ id: "tunnel", label: "Tunnel ID", to: "tunnel" }, { id: "organization", label: "Organization ID", to: "organization" }, { id: "binding", label: "MCP binding", to: "binding" }, { id: "credential", label: "Credential", to: "credential" }, { id: "back", label: "Back · Review", to: "reviewEntry" }, cancelItem] }),
    },
    actions: {
      tunnel: ({ value = "" }) => {
        draft.tunnelId = value; draft.error = "";
        if (!TUNNEL.test(value)) { draft.error = "Invalid Tunnel ID"; return to("tunnel"); }
        return to("organization");
      },
      organization: ({ value = "" }) => {
        draft.organizationId = value; draft.error = "";
        if (value && !ORGANIZATION.test(value)) { draft.error = "Invalid Organization ID"; return to("organization"); }
        return to(existing ? "bindingChoice" : "binding");
      },
      binding: async ({ value = "" }) => {
        draft.bindingPath = value; draft.error = "";
        try {
          if (!value.startsWith("/") || /[\x00-\x1f\x7f]/.test(value)) throw new Error();
          await options.validateBinding(value, signal);
        } catch { draft.error = "Invalid MCP binding config"; return to("binding"); }
        return signal.aborted ? close : to("credential");
      },
      keepBinding: () => { draft.error = ""; return to("credential"); },
      keepCredential: () => { secret = undefined; draft.credential = "keep"; return to("reviewEntry"); },
      capture: async () => {
        secret = undefined;
        // An actions screen has already resolved before Kit invokes this action.
        // Never run this from an in-place input/settings handler (nested custom).
        const result = await captureTunnelSecret(ctx, { store: async (value) => { if (!signal.aborted) secret = value; } }, { signal, keys: options.keys });
        if (result.status === "cancelled" || signal.aborted) { secret = undefined; controller.abort(); return close; }
        if (result.status !== "stored" || !secret) { outcome = failed(); controller.abort(); return close; }
        draft.credential = "replace";
        return to("reviewEntry");
      },
      review: ({ itemId }) => to(itemId === "confirm-change" || changes().length === 0 ? "save" : "changes"),
      save: async () => {
        if (signal.aborted) return close;
        if (!TUNNEL.test(draft.tunnelId) || (draft.organizationId !== "" && !ORGANIZATION.test(draft.organizationId)) || !draft.bindingPath || (draft.credential === "keep" && !existing?.credentialConfigured) || (draft.credential !== "keep" && !secret)) {
          outcome = failed(); return close;
        }
        try {
          const credential = draft.credential === "keep" ? { kind: "keep" as const } : { kind: "replace" as const, secret: secret! };
          const result = await options.save({ tunnelId: draft.tunnelId, ...(draft.organizationId ? { organizationId: draft.organizationId } : {}), bindingPath: draft.bindingPath, credential }, signal);
          if (result?.kind === "cancelled") { outcome = cancelled(); return close; }
          saved = true;
          outcome = { status: "saved" };
        } catch { outcome = failed(); }
        finally { secret = undefined; }
        return close;
      },
    },
  });
  try {
    const result = await runMenu(menuCtx, definition, { getState: () => draft, signal, onError: () => { outcome = failed(); controller.abort(); } });
    if (saved) return { status: "saved" }; // Do not falsely cancel an entered transaction.
    if (result.kind === "error") return failed();
    return outcome;
  } catch { return failed(); }
  finally {
    secret = undefined;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export interface TunnelStatusPresentation {
  readonly profilePath: string;
  /** Already masked by the domain's existing masking policy. */
  readonly maskedTunnel?: string;
  readonly organization: "configured" | "not configured";
  readonly binding: "configured" | "invalid" | "missing";
  readonly credential: "configured" | "not configured";
  /** Runtime ownership/health state stays separate from profile configuration. */
  readonly runtimeState: string;
  readonly configurationState: string;
  readonly errorCode?: TunnelRefusalCode;
  /** Only trusted, nonsecret closed evidence supplied by the runtime adapter. */
  readonly evidence: string;
}
/** No credential path/reference/content belongs in this projection. */
export async function presentTunnelStatus(ctx: SetupUiContext, view: TunnelStatusPresentation, options: { signal?: AbortSignal } = {}): Promise<{ lines: readonly string[] }> {
  // Plain-string fields are clamped here even when callers pass closed unions;
  // organization/binding/credential are closed literal-union types, already safe.
  const closed = (value: string, pattern: RegExp): string => (pattern.test(value) ? value : "UNKNOWN");
  const configurationState = closed(view.configurationState, /^[A-Z_]{1,32}$/);
  const lines = [
    `Profile: ${sanitizeTerminalText(view.profilePath)}`,
    `Tunnel: ${view.maskedTunnel === undefined ? "Not configured" : closed(view.maskedTunnel, /^tunnel_[A-Za-z0-9]{1,16}\u2026?$/)}`,
    `Organization: ${view.organization}`, `MCP binding: ${view.binding}`, `Credential: ${view.credential}`,
    `Configuration State: ${configurationState}`, `Runtime state: ${closed(view.runtimeState, /^[A-Z_]{1,32}$/)}`,
    `Evidence: ${sanitizeTerminalText(view.evidence).slice(0, 120)}`,
    ...(isTunnelRefusalCode(view.errorCode) ? [`Error: ${view.errorCode}`] : []),
    "Configured != Connected", "transport only; not delivery/ACK/completion evidence.",
  ];
  if (ctx.mode === "tui" && ctx.hasUI && typeof ctx.ui.custom === "function") {
    const menu = defineMenu<null, "status", never, SetupUiContext>({ start: "status", screens: { status: () => ({ kind: "detail", title: "Tunnel status", lines, hint: "close" }) }, actions: {} });
    await runMenu(ctx, menu, { getState: () => null, ...(options.signal ? { signal: options.signal } : {}), onError: () => undefined });
  }
  return { lines };
}
