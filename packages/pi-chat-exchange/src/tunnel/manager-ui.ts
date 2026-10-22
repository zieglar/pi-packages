/**
 * Domain-independent Tunnel Manager presentation. The extension supplies the
 * SAME operations as its direct commands; this module owns no process, Store,
 * configuration, credential, authorization, or recovery decisions.
 *
 * The Manager is a self-drawn `ui.custom` panel rather than a Kit menu screen:
 * Kit screen `lines` are sanitized to plain text and rendered in one muted
 * colour, and a screen context does not expose the terminal width, so a framed,
 * width-adaptive, state-coloured panel is only possible from a component that
 * receives the real render width and the host theme.
 */
import { isTunnelRefusalCode, type TunnelRefusalCode } from "./codes.js";
import {
  PLAIN_TUNNEL_PANEL_THEME, clipTunnelPanelText, renderTunnelPanel, tunnelPanelModel,
  type TunnelPanelTheme,
} from "./manager-panel.js";

export type TunnelManagerUiState =
  | "UNCONFIGURED" | "STOPPED" | "STARTING" | "CONNECTED" | "STOPPING"
  | "ERROR" | "UNKNOWN" | "DEGRADED";
export type TunnelManagerUiAction = "setup" | "edit" | "start" | "stop" | "refresh" | "details" | "close";
export type TunnelManagerUiEvidence = "none" | "process-identity" | "health-probe" | "offline-simulated" | "unavailable";

/** Safe projection only: never pass a key value or credential reference here. */
export interface TunnelManagerUiProjection {
  readonly state: TunnelManagerUiState;
  readonly profilePath: string;
  readonly tunnelIdAlreadyMasked?: string;
  readonly organizationConfigured: boolean;
  readonly binding: "configured" | "invalid" | "missing";
  readonly credentialConfigured: boolean;
  readonly evidence?: TunnelManagerUiEvidence;
  readonly errorCode?: TunnelRefusalCode;
  /** MESSAGING-INTEGRATION-01: configuration-only messaging facts for the
   *  Details view. Undefined means not determinable (renders Not configured).
   *  Never implies live messaging; runtime state is separate. */
  readonly messaging?: {
    readonly chatgptEndpointId?: string;
    readonly piEndpointId?: string;
    readonly piSessionId?: string;
    readonly storeDirectory?: string;
    readonly storeFile?: string;
    readonly exchangeNamespace?: string;
    readonly exchangeIdempotencyKey?: string;
    readonly configured: boolean;
    readonly payloadRead: boolean;
    readonly ack: boolean;
  };
}

export interface TunnelManagerUiPorts {
  read(): Promise<TunnelManagerUiProjection>;
  /** These closures retain caller-owned session cancellation and authorization. */
  setup(): Promise<unknown>;
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
}
export interface TunnelManagerUiContext {
  readonly mode: string;
  readonly hasUI: boolean;
  readonly ui: object;
}
export interface TunnelManagerUiOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly isCurrent?: () => boolean;
}
export type TunnelManagerUiOutcome =
  | { readonly status: "closed" | "cancelled" | "unsupported" }
  | { readonly status: "refused"; readonly code: TunnelRefusalCode };

/** Presentation is conservative; authorization remains in the injected ports.
 * Runtime UNKNOWN/ERROR must never be conflated with STOPPED, but they also
 * must not block repairing a configuration that is missing, invalid, or
 * incomplete: setup/edit is a configuration mutation, not a Start, and its
 * safety is governed by ownership/lock authority inside the setup port. */
export function tunnelManagerActions(projection: TunnelManagerUiProjection): readonly TunnelManagerUiAction[] {
  const state = projection.state;
  // Configuration-repair availability follows the configuration projection. A
  // STOPPED lifecycle still edits rather than re-setting-up a valid profile.
  const unconfigured = state === "UNCONFIGURED" ||
    (projection.tunnelIdAlreadyMasked === undefined && !projection.credentialConfigured && projection.binding !== "configured");
  const invalidOrIncomplete = projection.errorCode !== undefined || projection.binding === "invalid"
    || projection.binding === "missing" || !projection.credentialConfigured;
  const repair: TunnelManagerUiAction | undefined = unconfigured ? "setup" : invalidOrIncomplete ? "edit" : undefined;
  // Start/Stop authority follows the measured runtime lifecycle only.
  const lifecycle: readonly TunnelManagerUiAction[] = state === "STOPPED" ? ["start"]
    : state === "CONNECTED" ? ["stop"] : [];
  return [...(repair !== undefined ? [repair] : []), ...lifecycle, "refresh", "details", "close"];
}

/** Menu items include one navigation-only entry that is not a domain action. */
type TunnelManagerUiItem = TunnelManagerUiAction | "back";

const LABELS: Readonly<Record<TunnelManagerUiItem, string>> = Object.freeze({
  setup: "Set Up Tunnel", edit: "Edit Configuration", start: "Start Tunnel", stop: "Stop Tunnel",
  refresh: "Refresh", details: "Details", close: "Close", back: "Back",
});
const DETAIL_ITEMS: readonly TunnelManagerUiItem[] = Object.freeze(["back", "close"]);
const MANAGER_HINT = "↑↓ move · Enter select · Esc close";
const DETAILS_HINT = "↑↓ move · Enter select · Esc back";
/** Wide terminals keep a readable measure instead of stretching the frame. */
const PANEL_MAX_WIDTH = 78;

function closedCode(error: unknown): TunnelRefusalCode {
  try {
    const code: unknown = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (isTunnelRefusalCode(code)) return code;
  } catch { /* Accessors and arbitrary diagnostics are not display data. */ }
  return "CE_TUNNEL_HEALTH_UNAVAILABLE";
}

/** Narrow structural views of the `ui.custom` surface. The frozen contract gate
 * forbids `src/` from importing `@earendil-works/*`, so the runtime objects are
 * consumed structurally and validated at runtime before use. */
interface ManagerTuiView {
  requestRender?(): void;
}
interface ManagerComponentView {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
  dispose?(): void;
}
type ManagerCustomFn = <T>(
  factory: (
    tui: ManagerTuiView,
    theme: unknown,
    keybindings: unknown,
    done: (result: T) => void,
  ) => ManagerComponentView,
) => Promise<T>;

type ManagerKey = "up" | "down" | "confirm" | "cancel";
const BINDINGS: Readonly<Record<ManagerKey, string>> = Object.freeze({
  up: "tui.select.up", down: "tui.select.down", confirm: "tui.select.confirm", cancel: "tui.select.cancel",
});
/** Closed ASCII/CSI fallback used when the host supplies no key manager. */
const RAW_KEYS: Readonly<Record<ManagerKey, readonly string[]>> = Object.freeze({
  up: ["\x1b[A", "\x1bOA"], down: ["\x1b[B", "\x1bOB"],
  confirm: ["\r", "\n"], cancel: ["\x1b", "\x03"],
});
const KEY_ORDER: readonly ManagerKey[] = Object.freeze(["up", "down", "confirm", "cancel"]);

/** Structural views of the two host objects handed to a `ui.custom` factory.
 * Both are validated at runtime before use: the declared shapes describe what
 * the Pi runtime provides, not a trusted guarantee. */
interface HostKeyMatcher {
  matches(data: string, binding: string): boolean;
}
interface HostThemeView {
  fg(role: string, text: string): string;
  bold(text: string): string;
}

/** Resolve a key classifier from the injected keybindings manager, if any. */
function keyReader(keybindings: unknown): (data: string) => ManagerKey | undefined {
  const candidate = keybindings as { matches?: unknown } | null | undefined;
  // SAFETY: only the callable `matches` member is used, and it is reached solely
  // through this typeof check; a non-conforming host degrades to RAW_KEYS.
  const matcher: HostKeyMatcher | undefined = candidate != null && typeof candidate.matches === "function"
    ? (candidate as HostKeyMatcher) : undefined;
  return (data: string): ManagerKey | undefined => {
    for (const key of KEY_ORDER) {
      if (RAW_KEYS[key].includes(data)) return key;
    }
    if (matcher === undefined) return undefined;
    for (const key of KEY_ORDER) {
      try {
        if (matcher.matches(data, BINDINGS[key]) === true) return key;
      } catch { /* A host matcher failure must not insert or replay input. */ }
    }
    return undefined;
  };
}

/** Adapt the host theme structurally; any non-string result degrades to plain. */
function panelTheme(theme: unknown): TunnelPanelTheme {
  const candidate = theme as { fg?: unknown; bold?: unknown } | null | undefined;
  if (candidate == null || typeof candidate.fg !== "function" || typeof candidate.bold !== "function") {
    return PLAIN_TUNNEL_PANEL_THEME;
  }
  // SAFETY: both members are confirmed callable above; their results are still
  // re-checked as strings because a foreign theme can return any value.
  const host = candidate as HostThemeView;
  const styled = (produce: () => string, fallback: string): string => {
    try {
      const value: string = produce();
      return typeof value === "string" ? value : fallback;
    } catch { return fallback; }
  };
  return {
    fg: (role, text) => styled(() => host.fg(role, text), text),
    bold: (text) => styled(() => host.bold(text), text),
  };
}

/** What the operator chose. `details`/`back` never leave the component: they are
 * internal views, so diagnostics never take a second component ownership. */
type ManagerSelection =
  | { readonly kind: "action"; readonly action: Exclude<TunnelManagerUiAction, "details" | "close"> }
  | { readonly kind: "close" };

const CLOSE_SELECTION: ManagerSelection = Object.freeze({ kind: "close" });

class TunnelManagerPanel implements ManagerComponentView {
  private view: "manager" | "details" = "manager";
  private cursor = 0;
  private finished = false;
  private readonly theme: TunnelPanelTheme;
  private readonly key: (data: string) => ManagerKey | undefined;

  constructor(
    private readonly tui: ManagerTuiView,
    theme: unknown,
    keybindings: unknown,
    private readonly done: (result: ManagerSelection) => void,
    private readonly projection: TunnelManagerUiProjection,
    private readonly operationError: TunnelRefusalCode | undefined,
  ) {
    this.theme = panelTheme(theme);
    this.key = keyReader(keybindings);
  }

  private items(): readonly TunnelManagerUiItem[] {
    return this.view === "details" ? DETAIL_ITEMS : tunnelManagerActions(this.projection);
  }

  render(width: number): string[] {
    const total = Math.max(1, Math.floor(width));
    const panelWidth = Math.min(total, PANEL_MAX_WIDTH);
    const lines = [...renderTunnelPanel(tunnelPanelModel(this.projection, this.view), panelWidth, this.theme)];
    if (this.operationError !== undefined) {
      lines.push("", this.theme.fg("error", clipTunnelPanelText(`Last operation: ${this.operationError}`, total)));
    }
    lines.push("");
    const items = this.items();
    for (const [index, item] of items.entries()) {
      const row = clipTunnelPanelText(`${index === this.cursor ? "❯ " : "  "}${LABELS[item]}`, total);
      lines.push(index === this.cursor ? this.theme.bold(this.theme.fg("accent", row)) : this.theme.fg("text", row));
    }
    lines.push("", this.theme.fg("dim", clipTunnelPanelText(this.view === "details" ? DETAILS_HINT : MANAGER_HINT, total)));
    return lines;
  }

  invalidate(): void {
    // Nothing is cached: every row is rebuilt from the same safe projection.
  }

  /** Disposal is cleanup only. The host settles its own `custom` promise, and an
   * adapter-initiated close always goes through `requestClose`. */
  dispose(): void {
    this.finished = true;
  }

  /** Owner abort / timeout closes the panel without choosing an action. */
  requestClose(): void {
    this.finish(CLOSE_SELECTION);
  }

  handleInput(data: string): void {
    if (this.finished || data === "") return;
    switch (this.key(data)) {
      case "up": this.move(-1); return;
      case "down": this.move(1); return;
      case "cancel": this.cancel(); return;
      case "confirm": this.confirm(); return;
      default: return;
    }
  }

  private move(delta: number): void {
    const items = this.items();
    if (items.length === 0) return;
    const next = Math.min(items.length - 1, Math.max(0, this.cursor + delta));
    if (next === this.cursor) return;
    this.cursor = next;
    this.requestRender();
  }

  private cancel(): void {
    // Escape in diagnostics returns to the landing panel; only the landing
    // panel closes the Manager, so a glance at Details cannot end the session.
    if (this.view === "details") {
      this.show("manager");
      return;
    }
    this.finish(CLOSE_SELECTION);
  }

  private confirm(): void {
    const item = this.items()[this.cursor];
    if (item === undefined) return;
    if (item === "details") { this.show("details"); return; }
    if (item === "back") { this.show("manager"); return; }
    if (item === "close") { this.finish(CLOSE_SELECTION); return; }
    this.finish({ kind: "action", action: item });
  }

  private show(view: "manager" | "details"): void {
    this.view = view;
    this.cursor = 0;
    this.requestRender();
  }

  private finish(selection: ManagerSelection): void {
    if (this.finished) return;
    this.finished = true;
    this.done(selection);
  }

  private requestRender(): void {
    try {
      this.tui.requestRender?.();
    } catch { /* Rendering is advisory; a failure must not replay an action. */ }
  }
}

export async function runTunnelManagerUi(
  ctx: TunnelManagerUiContext,
  ports: TunnelManagerUiPorts,
  options: TunnelManagerUiOptions = {},
): Promise<TunnelManagerUiOutcome> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !("custom" in ctx.ui) || typeof ctx.ui.custom !== "function") {
    return { status: "unsupported" };
  }
  // SAFETY: `custom<T>` resolves with exactly the value its factory hands to
  // `done`. The only factory installed below is `TunnelManagerPanel`, whose
  // `done` parameter is `(result: ManagerSelection) => void`, so the resolved
  // value is a `ManagerSelection` or the host's own unmounted `undefined`.
  // TypeScript cannot bind the caller-chosen T through a structural `object`.
  const custom = ctx.ui.custom as unknown as ManagerCustomFn;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.timeoutMs !== undefined) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      options.signal?.removeEventListener("abort", abort);
      return { status: "refused", code: "CE_TUNNEL_INPUT_UNAVAILABLE" };
    }
    timer = setTimeout(abort, options.timeoutMs);
    timer.unref?.();
  }
  let lastProjection: TunnelManagerUiProjection | undefined;
  let operationError: TunnelRefusalCode | undefined;
  const current = (): boolean => !controller.signal.aborted && (options.isCurrent?.() ?? true);
  /** Set while a panel owns the screen so an abort can close it immediately. */
  let closeActive: (() => void) | undefined;
  const closeOnAbort = (): void => closeActive?.();
  controller.signal.addEventListener("abort", closeOnAbort);

  /** One canonical read. A failed read never reuses the previous lifecycle: it
   * degrades to UNKNOWN so Start/Stop disappear instead of acting on a stale
   * snapshot. */
  const read = async (): Promise<TunnelManagerUiProjection> => {
    try {
      lastProjection = await ports.read();
    } catch (error) {
      lastProjection = {
        state: "UNKNOWN", profilePath: lastProjection?.profilePath ?? "Unavailable",
        organizationConfigured: false, binding: "missing", credentialConfigured: false,
        evidence: "unavailable", errorCode: closedCode(error),
      };
    }
    return lastProjection;
  };

  // The panel closes itself BEFORE the adapter performs an operation, so setup
  // can host its own Wizard without overlapping custom-component ownership.
  const perform = async (action: "setup" | "start" | "stop"): Promise<void> => {
    operationError = undefined;
    try { await ports[action](); }
    catch (error) { operationError = closedCode(error); }
    // The next loop iteration rereads even after a refused operation. No action
    // is automatically retried; no setup result is interpreted as permission.
  };

  try {
    while (current()) {
      const projection = await read();
      if (!current()) break;
      let selection: ManagerSelection | undefined;
      try {
        selection = await custom<ManagerSelection | undefined>((tui, theme, keybindings, done) => {
          const panel = new TunnelManagerPanel(tui, theme, keybindings, done, projection, operationError);
          closeActive = () => panel.requestClose();
          // Never call `done` synchronously inside the factory: the runtime has
          // not installed (and therefore cannot dispose) this component yet.
          if (controller.signal.aborted) {
            const deferred = setTimeout(() => panel.requestClose(), 0);
            deferred.unref?.();
          }
          return panel;
        });
      } catch {
        return current() ? { status: "refused", code: "CE_TUNNEL_HEALTH_UNAVAILABLE" } : { status: "cancelled" };
      } finally {
        closeActive = undefined;
      }
      if (!current()) break;
      // An externally disposed component resolves without a selection: that is
      // a close, never an implied action.
      if (selection === undefined || selection.kind === "close") return { status: "closed" };
      if (selection.action === "refresh") { operationError = undefined; continue; }
      await perform(selection.action === "edit" ? "setup" : selection.action);
    }
    return { status: "cancelled" };
  } catch {
    return current() ? { status: "refused", code: "CE_TUNNEL_HEALTH_UNAVAILABLE" } : { status: "cancelled" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", closeOnAbort);
    controller.abort();
  }
}
