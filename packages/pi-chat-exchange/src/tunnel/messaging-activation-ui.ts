/** Pure operator confirmation. The caller revalidates identity/configuration and
 * owns all activation/release authority after this custom component closes. */
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import type { SetupUiContext } from "./setup-ui.js";
import type { TunnelKeyProtocol } from "./secure-input.js";

export interface MessagingActivationView {
  readonly piSessionId: string;
  readonly piEndpointId: string;
  readonly chatgptEndpointId: string;
  readonly storeDirectory: string;
  readonly storeFile: string;
  readonly exchangeNamespace: string;
  readonly exchangeIdempotencyKey: string;
  readonly payloadRead: boolean;
  readonly ack: boolean;
  readonly policyLoaded: boolean;
  readonly oldEndpointId?: string;
}

export async function confirmMessagingActivation(ctx: SetupUiContext, options: {
  readonly view: MessagingActivationView;
  readonly keys: TunnelKeyProtocol;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function" || options.signal?.aborted) return false;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 120_000);
  timer.unref?.();
  let confirmed = false;
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
    if (typeof (produced as { then?: unknown }).then === "function") throw new Error("Unsupported component");
    const component = produced as typeof produced & object;
    const handleInput = component.handleInput?.bind(component);
    const dispose = component.dispose?.bind(component);
    component.handleInput = (data) => {
      const configured = keybindings as { matches?(data: string, binding: string): boolean };
      if (options.keys.matches(data, options.keys.escape) || options.keys.matches(data, options.keys.ctrlC) || configured.matches?.(data, "tui.select.cancel")) abort();
      handleInput?.(data);
    };
    component.dispose = () => {
      if (!disposed) { disposed = true; dispose?.(); }
      if (!completed) { abort(); complete(undefined); }
    };
    return component;
  }, customOptions) } };
  const view = options.view;
  // One-line sanitization prevents externally supplied values from forging rows.
  const safe = (value: string): string => sanitizeTerminalText(value).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  const label = view.policyLoaded ? "Activate current session" : "Release current binding for policy reload";
  const menu = defineMenu<null, "confirm", "confirm", SetupUiContext>({
    start: "confirm",
    screens: { confirm: () => ({ kind: "actions", title: "Messaging · explicit confirmation", hint: "close", lines: [
      `Current Pi session: ${safe(view.piSessionId)}`,
      `Old Pi endpoint: ${view.oldEndpointId === undefined ? "None reported" : safe(view.oldEndpointId)}`,
      `Target Pi endpoint: ${safe(view.piEndpointId)}`,
      `ChatGPT endpoint: ${safe(view.chatgptEndpointId)}`,
      `Store directory: ${safe(view.storeDirectory)}`,
      `Store file: ${safe(view.storeFile)}`,
      `Exchange namespace: ${safe(view.exchangeNamespace)}`,
      `Exchange idempotency key: ${safe(view.exchangeIdempotencyKey)}`,
      `Payload read: ${view.payloadRead ? "enabled" : "disabled"}`,
      `ACK: ${view.ack ? "enabled" : "disabled"} (reception only, not completion)`,
      `Policy loaded: ${view.policyLoaded ? "yes" : "no"}`,
      "Configured != Pi-bound; Pi-bound != Connected != real Gate",
      ...(view.policyLoaded ? [] : ["Release only; reload policy before requesting activation again."]),
      "Only the explicit action below confirms. Cancel is the default.",
    ], items: [{ id: "cancel", label: "Cancel", close: true }, { id: "confirm", label, action: "confirm" }] }) },
    actions: { confirm: () => { if (!controller.signal.aborted) confirmed = true; return { kind: "close" }; } },
  });
  try {
    const result = await runMenu(menuCtx, menu, { getState: () => null, signal: controller.signal, onError: abort });
    return confirmed && !controller.signal.aborted && result.kind !== "error";
  } catch { return false; }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    abort();
  }
}
