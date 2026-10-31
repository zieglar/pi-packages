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
import { TUNNEL_ID_PATTERN as TUNNEL } from "./tunnel-id.js";
import { captureTunnelSecret, type SecureInputUiView, type TunnelKeyProtocol } from "./secure-input.js";
import { formatRecipientList, parseRecipientList } from "./managed-binding.js";
import type { CeRecipientRef } from "../host/endpoint-host.js";
export interface SetupUiContext extends MenuContext { readonly ui: SecureInputUiView; }
export interface ExistingSetupValues {
  readonly tunnelId: string;
  readonly organizationId?: string;
  /** Existing binding reference, shown for transparency only — never edited as a path. */
  readonly bindingPath: string;
  /** Current managed recipients when known; empty means none. */
  readonly recipients?: readonly CeRecipientRef[];
  readonly credentialConfigured: boolean;
}
/** MESSAGING-INTEGRATION-01: current messaging facts for prefill/Review.
 * Configuration only; runtime state is shown separately. */
export interface ExistingMessagingValues {
  readonly chatgptEndpointId: string;
  readonly piEndpointId: string | undefined;
  readonly piSessionId: string | undefined;
  readonly payloadRead: boolean;
  readonly ack: boolean;
  readonly configured: boolean;
  readonly storeDirectory?: string;
  readonly storeFile?: string;
  readonly exchangeNamespace?: string;
  readonly exchangeIdempotencyKey?: string;
}
export interface SetupProposal {
  readonly tunnelId: string;
  readonly organizationId?: string;
  /** Present only when the operator changed the recipient list. Absent keeps the
   * existing binding unchanged; on first setup the domain derives the CE-managed
   * default (no recipients). Never a file path. */
  readonly recipients?: readonly CeRecipientRef[];
  readonly credential: { readonly kind: "keep" } | { readonly kind: "replace"; readonly secret: string };
  /** MESSAGING-INTEGRATION-01: present only when the operator explicitly
   * authorized messaging for THIS session in Advanced. Absent leaves any
   * existing messaging configuration untouched. */
  readonly messaging?: {
    readonly chatgptEndpointId: string;
    readonly piEndpointId: string;
    readonly piSessionId: string;
    readonly replaceExisting: boolean;
  };
}
export interface SetupWizardOptions {
  readonly profilePath: string;
  /** Host-injected key protocol (no Pi import in `src/`). */
  readonly keys: TunnelKeyProtocol;
  readonly existing?: ExistingSetupValues;
  /** MESSAGING-INTEGRATION-01: current Pi session id from the trusted Pi
   * runtime API (injected by the extension). Absent = messaging authorization
   * unavailable; the wizard must never guess it. */
  readonly piSessionId?: string;
  readonly existingMessaging?: ExistingMessagingValues;
  /** Parent-validated current-session activation eligibility; not authority. */
  readonly canActivateMessaging?: boolean;
  /** Borrowed secret: do not retain the proposal after the transaction settles. */
  readonly save: (proposal: SetupProposal, signal: AbortSignal) => Promise<void | { readonly kind: "cancelled" }>;
  readonly signal?: AbortSignal;
  /** Whole wizard budget, not reset per step. Owned work is always awaited. */
  readonly timeoutMs?: number;
}
export type SetupUiOutcome =
  | { readonly status: "saved" }
  | { readonly status: "activation-requested" }
  | { readonly status: "cancelled" }
  | { readonly status: "refused"; readonly code: "CE_TUNNEL_INPUT_UNAVAILABLE" | "CE_TUNNEL_SETUP_FAILED" };

type Screen = "tunnel" | "organization" | "recipients" | "credential" | "reviewEntry" | "review" | "changes" | "save" | "edit" | "messaging";
type Action = "tunnel" | "organization" | "recipients" | "keepCredential" | "capture" | "review" | "save" | "authorizeMessaging" | "activateMessaging";
interface Draft { tunnelId: string; organizationId: string; recipientsText: string; error: string; credential: "keep" | "replace" | "missing"; messaging: "keep" | "authorize"; }
/** MESSAGING-INTEGRATION-01: the single explicitly-confirmed endpoint pair.
 * Displayed for operator confirmation; never guessed from configuration. */
const CHATGPT_ENDPOINT_ID = "chatgpt/main";
const PI_ENDPOINT_ID = "pi/main";
/** Render untrusted identity/storage text as one terminal line. This projection
 * never normalizes the raw values later passed to the authorized transaction. */
const terminalLine = (value: string): string => sanitizeTerminalText(value).replace(/[\r\n\x00-\x1F\x7F]/g, " ");
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
  const existingRecipientsText = existing?.recipients === undefined ? undefined : formatRecipientList(existing.recipients);
  const draft: Draft = { tunnelId: existing?.tunnelId ?? "", organizationId: existing?.organizationId ?? "", recipientsText: existingRecipientsText ?? "", error: "", credential: existing?.credentialConfigured ? "keep" : "missing", messaging: "keep" };
  let secret: string | undefined;
  let outcome: SetupUiOutcome = cancelled();
  // Deliberately not a Kit state field: neither Kit renderers nor errors see it.
  let saved = false;
  // Profile path is the write target, not a decision: it appears in Review and in
  // the Save confirmation, never as a step of its own and never on every screen.
  const STEPS = 4;
  /** Per-field help: what is required, in what format, and what empty means. */
  const HELP = Object.freeze({
    tunnel: "Required · tunnel_ followed by at least 8 alphanumeric characters, or a 4-character namespace and 32-character ID",
    organization: "Optional · org- followed by 1-128 alphanumeric characters · leave empty if not required",
    recipients: "Optional · adapter:endpointId, comma-separated · empty keeps the CE-managed default",
    credential: "Existing credential configured · Replace opens a masked input",
  });
  const lines = (help: string): string[] => [help, ...(draft.error ? [draft.error] : [])];
  const step = (n: number, name: string): string => `Tunnel Setup · ${n}/${STEPS} · ${name}`;
  const existingMessaging = options.existingMessaging;
  /** Messaging authorization change: only an explicit Advanced authorize sets
   * it. Re-authorizing an already-configured identical mapping is no change. */
  const messagingChanged = (): boolean => {
    if (draft.messaging !== "authorize") return false;
    return !(existingMessaging?.configured === true && existingMessaging.piSessionId === options.piSessionId &&
      existingMessaging.chatgptEndpointId === CHATGPT_ENDPOINT_ID && existingMessaging.piEndpointId === PI_ENDPOINT_ID);
  };
  const changes = (): string[] => {
    if (!existing) return messagingChanged() ? [`Messaging: Not configured → Authorized ${CHATGPT_ENDPOINT_ID} ↔ ${PI_ENDPOINT_ID} (this session)`] : [];
    const result: string[] = [];
    for (const [label, oldValue, newValue] of [
      ["Tunnel ID", existing.tunnelId, draft.tunnelId],
      ["Organization", existing.organizationId || "Not configured", draft.organizationId || "Not configured"],
      ...(draft.messaging !== "authorize" && recipientsChanged() ? [["Recipients", existingRecipientsText ?? "Keep existing binding", draft.recipientsText || "None"] as const] : []),
    ]) if (oldValue !== newValue) result.push(`${label}: ${terminalLine(oldValue)} → ${terminalLine(newValue)}`);
    if (messagingChanged()) {
      const before = existingMessaging?.configured === true
        ? `${terminalLine(existingMessaging.chatgptEndpointId)} ↔ ${terminalLine(existingMessaging.piEndpointId ?? "?")} (session ${terminalLine(existingMessaging.piSessionId ?? "?")})`
        : "Not configured";
      result.push(`Messaging: ${before} → Authorized ${CHATGPT_ENDPOINT_ID} ↔ ${PI_ENDPOINT_ID} (session ${terminalLine(options.piSessionId ?? "?")})`);
    }
    return result;
  };
  // Recipients change detection: a known (managed) list compares by text; a
  // legacy binding with unknown recipients is kept unless the operator enters
  // a new list (empty text can never mean "clear" for an unknown existing set).
  const normalizeRecipients = (text: string): string => {
    try { return formatRecipientList(parseRecipientList(text, { adapter: "pi", endpointId: "ce-self" })); } catch { return text.trim(); }
  };
  const recipientsChanged = (): boolean => {
    if (existing === undefined) return draft.recipientsText.trim() !== "";
    // Unknown existing recipients: any blank/whitespace input keeps the binding
    // untouched; only a concrete new list changes it.
    if (existingRecipientsText === undefined) return draft.recipientsText.trim() !== "";
    // Known list: compare normalized values, not raw text.
    return normalizeRecipients(existingRecipientsText) !== normalizeRecipients(draft.recipientsText);
  };
  // Identity change detection mirrors setup.save: only Tunnel ID / Organization.
  const identityChanged = (): boolean => existing !== undefined &&
    (draft.tunnelId !== existing.tunnelId ||
      (draft.organizationId || undefined) !== (existing.organizationId || undefined));
  const messagingRequiresReauthorization = (): boolean => existingMessaging?.configured === true &&
    draft.messaging !== "authorize" && (identityChanged() || recipientsChanged());
  const reauthorizationNotice = "Requires reauthorization: Tunnel / Organization / Recipients changed. Use Advanced · Messaging or revert the edits before Save.";
  const bindingSummary = (): string => {
    if (draft.messaging === "authorize") return "MCP Binding\nNew ChatGPT-side binding (single Pi recipient; read/ACK authorized)";
    if (existing !== undefined && !recipientsChanged()) {
      // D-R3: identity change + known CE-managed binding regenerates it for the
      // new identity (carrying existing recipients) — never "Keep existing".
      if (identityChanged() && existingRecipientsText !== undefined) {
        return `MCP Binding\nRegenerate for new identity (recipients kept)`;
      }
      return `MCP Binding\nKeep existing (${terminalLine(existing.bindingPath)})`;
    }
    return `MCP Binding\nCE-managed (generated automatically)`;
  };
  /** Messaging section: configuration facts only. "Configured" here never
   *  means live messaging — the wizard's save notice states the restart requirement. */
  const configuredStorage = (): string[] => [
    `Store directory: ${terminalLine(existingMessaging?.storeDirectory ?? "Not determined")}`,
    `Store file: ${terminalLine(existingMessaging?.storeFile ?? "Not determined")}`,
    `Exchange namespace: ${terminalLine(existingMessaging?.exchangeNamespace ?? "Not determined")}`,
    `Exchange idempotency key: ${terminalLine(existingMessaging?.exchangeIdempotencyKey ?? "Not determined")}`,
  ];
  const canActivate = (): boolean => options.canActivateMessaging === true && existingMessaging?.configured === true &&
    typeof options.piSessionId === "string" && options.piSessionId.length > 0 && draft.messaging === "keep" && !identityChanged() && !recipientsChanged();
  const messagingSummary = (): string => {
    if (draft.messaging === "authorize") {
      return [`Messaging (ChatGPT ↔ Pi)`,`ChatGPT endpoint\n${CHATGPT_ENDPOINT_ID} (Tunnel side)`,`Pi endpoint\n${PI_ENDPOINT_ID} (session ${terminalLine(options.piSessionId ?? "?")})`,`Send\nBoth directions — only these two endpoints`,`Payload read\nEnabled · ACK\nEnabled (reception only, not completion)`,`Store / Exchange (proposed)\nShared with the proposed Tunnel binding; final values determined at Save. No future paths are assumed.\nCurrent configured values (not the proposal):\n${configuredStorage().join("\n")}`].join("\n\n");
    }
    if (messagingRequiresReauthorization()) return `Messaging (ChatGPT ↔ Pi)\n${reauthorizationNotice}\nCurrent configured values (pending reauthorization):\n${configuredStorage().join("\n")}`;
    if (existingMessaging?.configured === true) {
      return `Messaging (ChatGPT ↔ Pi)\nConfigured: ${terminalLine(existingMessaging.chatgptEndpointId)} ↔ ${terminalLine(existingMessaging.piEndpointId ?? "?")} (session ${terminalLine(existingMessaging.piSessionId ?? "?")}) · unchanged\n${configuredStorage().join("\n")}`;
    }
    return "Messaging (ChatGPT ↔ Pi)\nNot configured (Advanced · Messaging to authorize)";
  };
  const summary = (): string => [
    `Profile\n${terminalLine(options.profilePath)}`, `Tunnel\n${terminalLine(draft.tunnelId)}`,
    `Organization\n${terminalLine(draft.organizationId || "Not configured")}`,
    `Recipients\n${draft.messaging === "authorize" ? `pi:${PI_ENDPOINT_ID} (derived from Messaging)`
      : existing !== undefined && !recipientsChanged() && existingRecipientsText === undefined
        ? "Unchanged (existing binding kept)" : terminalLine(draft.recipientsText || "None (default)")}`,
    bindingSummary(),
    messagingSummary(),
    `Credential\n${draft.credential === "keep" ? "Keep existing" : existing?.credentialConfigured ? "Replace" : "Provided"}`,
    ...changes(),
  ].join("\n\n");
  const input = (title: string, value: string, action: Action, help: string): MenuScreen<Screen, Action> => ({ kind: "input", title, lines: lines(help), initialValue: value, action, hint: "close" });
  const cancelItem = { id: "cancel", label: "Cancel", close: true } as const;
  /** Deferred masked capture. The Kit menu closes first so the CE secret
   * component owns the terminal alone: the first-time path therefore enters the
   * masked input directly, with no intermediate credential choice. */
  let pendingCapture = false;
  const credentialItem = existing?.credentialConfigured
    ? { id: "credential", label: "Credential", to: "credential" as const }
    : { id: "credential", label: "Credential · enter API key (masked)", action: "capture" as const };
  const screens: Readonly<Record<Screen, (state: { state: Draft }) => MenuScreen<Screen, Action>>> = {
    tunnel: () => input(step(1, "Tunnel ID"), draft.tunnelId, "tunnel", HELP.tunnel),
    organization: () => input(step(2, "Organization ID"), draft.organizationId, "organization", HELP.organization),
    // Advanced: reachable from Edit configuration only. CE has no trusted
    // endpoint discovery, so recipients are never a linear setup step.
    recipients: () => draft.messaging === "authorize"
      ? { kind: "actions", title: "Tunnel Setup · Advanced · Recipients",
          lines: ["Recipients are derived from Messaging", `pi:${PI_ENDPOINT_ID}`, "Only the explicitly confirmed ChatGPT ↔ Pi relationship is authorized.", "Cancel this wizard to discard that authorization before choosing different routing."],
          hint: "close", items: [{ id: "back", label: "Back · Edit configuration", to: "edit" }, cancelItem] }
      : input("Tunnel Setup · Advanced · Recipients", draft.recipientsText, "recipients", HELP.recipients),
    // MESSAGING-INTEGRATION-01: explicit messaging authorization. Shows the
    // exact endpoint pair, the current session, and the capability set before
    // the operator confirms. Hidden authorize when the session id is unknown.
    messaging: () => {
      const available = typeof options.piSessionId === "string" && options.piSessionId.length > 0;
      const current = existingMessaging?.configured === true
        ? `Current: ${terminalLine(existingMessaging.chatgptEndpointId)} ↔ ${terminalLine(existingMessaging.piEndpointId ?? "?")} (session ${terminalLine(existingMessaging.piSessionId ?? "?")})`
        : "Current: not configured";
      const body = available
        ? [current, ...configuredStorage(), `ChatGPT endpoint: ${CHATGPT_ENDPOINT_ID} (Tunnel side)`, `Pi endpoint: ${PI_ENDPOINT_ID} (session ${terminalLine(options.piSessionId)})`,
           "Send: both directions — only these two endpoints; every other recipient stays refused",
           "Payload read: enabled · ACK: enabled (reception only, not completion)",
           "Proposed Store / Exchange: shared with the proposed Tunnel binding; final values determined at Save.",
           "Authorizing replaces any Advanced recipient list with the Pi endpoint.",
           "After Save: restart the Tunnel, reload policy, then explicitly activate the current Pi session. Configured != Pi-bound != Connected != real Gate."]
        : [current, ...configuredStorage(), "Unavailable: the current Pi session identity could not be determined.", "Messaging authorization is refused — it is never guessed from logs or paths."];
      const items = available
        ? [...(canActivate() ? [{ id: "activate", label: "Activate current session", action: "activateMessaging" as const }] : []), { id: "authorize", label: existingMessaging?.configured === true ? "Re-authorize messaging for this session" : "Authorize messaging for this session", action: "authorizeMessaging" as const }, { id: "back", label: "Back · Edit configuration", to: "edit" as const }, cancelItem]
        : [{ id: "back", label: "Back · Edit configuration", to: "edit" as const }, cancelItem];
      return { kind: "actions", title: "Tunnel Setup · Advanced · Messaging (ChatGPT ↔ Pi)", lines: body, hint: "close", items };
    },
    // Only an already-configured credential needs a decision; otherwise the
    // capture component is opened directly instead of this screen.
    credential: () => ({ kind: "actions", title: step(3, "Credential"), lines: lines(HELP.credential), hint: "close", items: [
      { id: "keep", label: "Keep existing credential", action: "keepCredential" as const },
      { id: "replace", label: "Replace credential (masked input)", action: "capture" as const },
      { id: "back", label: "Back · Organization ID", to: "organization" as const }, cancelItem,
    ] }),
    reviewEntry: () => ({ kind: "actions", title: step(4, "Review"), lines: lines("Nothing is written until you confirm Save configuration."), hint: "close", items: [{ id: "review", label: "Review", to: "review" }, { id: "edit", label: "Back · Edit configuration", to: "edit" }, cancelItem] }),
    review: () => ({ kind: "review", title: "Review · Tunnel configuration", content: summary(), format: { kind: "text" }, hint: "close", confirm: { id: "continue", label: "Continue", action: "review" } }),
    changes: () => ({ kind: "review", title: "Existing Tunnel configuration will be changed", content: changes().join("\n\n"), format: { kind: "text" }, hint: "close", confirm: { id: "confirm-change", label: "Confirm identity / routing changes", action: "review" } }),
    save: () => ({ kind: "actions", title: "Save confirmation", lines: ["Only Save configuration writes the proposed configuration.", `Profile: ${terminalLine(options.profilePath)}`, ...(draft.error ? [draft.error] : [])], hint: "close", items: [{ id: "save", label: "Save configuration", action: "save" }, { id: "back", label: "Back · Edit configuration", to: "edit" }, cancelItem] }),
    edit: () => ({ kind: "actions", title: "Edit configuration", lines: lines(`Profile: ${terminalLine(options.profilePath)}`), hint: "close", items: [{ id: "tunnel", label: "Tunnel ID", to: "tunnel" }, { id: "organization", label: "Organization ID", to: "organization" }, credentialItem, { id: "messaging", label: "Advanced · Messaging (ChatGPT ↔ Pi)", to: "messaging" }, { id: "recipients", label: "Advanced · Recipients", to: "recipients" }, { id: "back", label: "Back · Review", to: "reviewEntry" }, cancelItem] }),
  };
  const actions = {
    tunnel: ({ value = "" }: { value?: string }) => {
      draft.tunnelId = value; draft.error = "";
      if (!TUNNEL.test(value)) { draft.error = "Invalid Tunnel ID"; return to("tunnel"); }
      return to("organization");
    },
    organization: ({ value = "" }: { value?: string }) => {
      draft.organizationId = value; draft.error = "";
      if (value && !ORGANIZATION.test(value)) { draft.error = "Invalid Organization ID"; return to("organization"); }
      if (signal.aborted) return close;
      // An existing credential is a decision; a missing one is captured now;
      // an already captured one needs neither screen again.
      if (existing?.credentialConfigured) return to("credential");
      if (draft.credential === "replace") return to("reviewEntry");
      pendingCapture = true;
      return close;
    },
    recipients: ({ value = "" }: { value?: string }) => {
      draft.recipientsText = value; draft.error = "";
      try {
        // Parse now so a malformed list never leaves this step. The domain
        // re-parses at Save; nothing here grants send eligibility.
        parseRecipientList(value, { adapter: "pi", endpointId: "ce-self" });
      } catch { draft.error = "Invalid recipients (use adapter:endpointId, comma-separated)"; return to("recipients"); }
      return signal.aborted ? close : to("reviewEntry");
    },
    keepCredential: () => { secret = undefined; draft.credential = "keep"; return to("reviewEntry"); },
    // Defer the masked capture: an action cannot open a second custom component
    // while the Kit screen it was invoked from still owns the terminal.
    capture: () => { secret = undefined; pendingCapture = true; return close; },
    // MESSAGING-INTEGRATION-01: explicit authorization for THIS session. It
    // replaces any Advanced recipient list with the derived Pi endpoint.
    activateMessaging: () => {
      if (!signal.aborted && canActivate()) outcome = { status: "activation-requested" };
      return close;
    },
    authorizeMessaging: () => {
      if (typeof options.piSessionId !== "string" || options.piSessionId.length === 0) { draft.error = "Messaging unavailable: session identity unknown"; return to("messaging"); }
      draft.messaging = "authorize"; draft.recipientsText = ""; draft.error = "";
      return to("edit");
    },
    review: ({ itemId }: { itemId?: string }) => {
      if (messagingRequiresReauthorization()) { draft.error = reauthorizationNotice; return to("edit"); }
      return to(itemId === "confirm-change" || changes().length === 0 ? "save" : "changes");
    },
    save: async () => {
      if (signal.aborted) return close;
      if (messagingRequiresReauthorization()) { draft.error = reauthorizationNotice; return to("edit"); }
      if (!TUNNEL.test(draft.tunnelId) || (draft.organizationId !== "" && !ORGANIZATION.test(draft.organizationId)) || (draft.credential === "keep" && !existing?.credentialConfigured) || (draft.credential !== "keep" && !secret)) {
        outcome = failed(); return close;
      }
      if (draft.messaging === "authorize" && (typeof options.piSessionId !== "string" || options.piSessionId.length === 0)) {
        outcome = failed(); return close;
      }
      try {
        const credential = draft.credential === "keep" ? { kind: "keep" as const } : { kind: "replace" as const, secret: secret! };
        const recipients = draft.messaging === "authorize" ? undefined : recipientsChanged() ? parseRecipientList(draft.recipientsText, { adapter: "pi", endpointId: "ce-self" }) : undefined;
        const messaging = draft.messaging === "authorize" ? {
          chatgptEndpointId: CHATGPT_ENDPOINT_ID,
          piEndpointId: PI_ENDPOINT_ID,
          piSessionId: options.piSessionId!,
          // Replace is authorized only when an existing mapping differs — the
          // operator saw the old→new change in the confirmation review.
          replaceExisting: existingMessaging !== undefined &&
            (existingMessaging.piSessionId !== options.piSessionId || !existingMessaging.configured ||
             existingMessaging.chatgptEndpointId !== CHATGPT_ENDPOINT_ID || existingMessaging.piEndpointId !== PI_ENDPOINT_ID),
        } : undefined;
        const result = await options.save({ tunnelId: draft.tunnelId, ...(draft.organizationId ? { organizationId: draft.organizationId } : {}), ...(recipients === undefined ? {} : { recipients }), ...(messaging === undefined ? {} : { messaging }), credential }, signal);
        if (result?.kind === "cancelled") { outcome = cancelled(); return close; }
        saved = true;
        outcome = { status: "saved" };
      } catch { outcome = failed(); }
      finally { secret = undefined; }
      return close;
    },
  };
  /** One masked capture with no Kit screen mounted. Cancellation, timeout and
   * writer failure stay closed: only a stored secret continues the wizard. */
  const runCapture = async (): Promise<boolean> => {
    secret = undefined;
    const result = await captureTunnelSecret(ctx, { store: async (value) => { if (!signal.aborted) secret = value; } }, { signal, keys: options.keys, preamble: [step(3, "Credential")] });
    if (result.status === "cancelled" || signal.aborted) { secret = undefined; outcome = cancelled(); controller.abort(); return false; }
    if (result.status !== "stored" || secret === undefined) { outcome = failed(); controller.abort(); return false; }
    draft.credential = "replace";
    return true;
  };
  try {
    // The wizard is a sequence of Kit menus interleaved with at most one masked
    // capture. Each iteration owns the screen alone; `startScreen` resumes the
    // flow after a capture or an Edit navigation.
    let startScreen: Screen = "tunnel";
    for (;;) {
      pendingCapture = false;
      const definition = defineMenu<Draft, Screen, Action, SetupUiContext>({ start: startScreen, screens, actions });
      const result = await runMenu(menuCtx, definition, { getState: () => draft, signal, onError: () => { outcome = failed(); controller.abort(); } });
      if (saved) return { status: "saved" }; // Do not falsely cancel an entered transaction.
      if (result.kind === "error") return failed();
      if (!pendingCapture || signal.aborted) return outcome;
      if (!(await runCapture())) return outcome;
      startScreen = "reviewEntry";
    }
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
    `Tunnel: ${view.maskedTunnel === undefined ? "Not configured" : closed(view.maskedTunnel, /^tunnel_(?:[A-Za-z0-9]{1,16}|[a-z0-9]{4}_[a-z0-9]{1,11})…?$/)}`,
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
