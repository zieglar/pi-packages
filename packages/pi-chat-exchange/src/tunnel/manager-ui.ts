/**
 * Domain-independent Tunnel Manager presentation. The extension supplies the
 * SAME operations as its direct commands; this module owns no process, Store,
 * configuration, credential, authorization, or recovery decisions.
 */
import { defineMenu, runMenu, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { isTunnelRefusalCode, type TunnelRefusalCode } from "./codes.js";

export type TunnelManagerUiState =
  | "UNCONFIGURED" | "STOPPED" | "STARTING" | "CONNECTED" | "STOPPING"
  | "ERROR" | "UNKNOWN" | "DEGRADED";
export type TunnelManagerUiAction = "setup" | "edit" | "start" | "stop" | "refresh" | "close";
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
  return [...(repair !== undefined ? [repair] : []), ...lifecycle, "refresh", "close"];
}

const LABELS: Readonly<Record<TunnelManagerUiAction, string>> = Object.freeze({
  setup: "Set Up Tunnel", edit: "Edit Configuration", start: "Start Tunnel", stop: "Stop Tunnel", refresh: "Refresh", close: "Close",
});
const STATES: readonly string[] = ["UNCONFIGURED", "STOPPED", "STARTING", "CONNECTED", "STOPPING", "ERROR", "UNKNOWN", "DEGRADED"];
const EVIDENCE: readonly string[] = ["none", "process-identity", "health-probe", "offline-simulated", "unavailable"];

function closedCode(error: unknown): TunnelRefusalCode {
  try {
    const code: unknown = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (isTunnelRefusalCode(code)) return code;
  } catch { /* Accessors and arbitrary diagnostics are not display data. */ }
  return "CE_TUNNEL_HEALTH_UNAVAILABLE";
}

/** Shared safe rows for a manager or an independently wired status view. */
export function tunnelManagerRows(projection: TunnelManagerUiProjection): readonly string[] {
  const state = STATES.includes(projection.state) ? projection.state : "UNKNOWN";
  // A caller accidentally passing an unmasked ID cannot disclose it here.
  const tunnel = typeof projection.tunnelIdAlreadyMasked === "string" && /^tunnel_[A-Za-z0-9]{6}…$/.test(projection.tunnelIdAlreadyMasked)
    ? projection.tunnelIdAlreadyMasked : "Not configured / unavailable";
  return [
    `Profile: ${sanitizeTerminalText(projection.profilePath)}`,
    `Tunnel: ${tunnel}`,
    `Organization: ${projection.organizationConfigured === true ? "configured" : "not configured"}`,
    `MCP binding: ${projection.binding === "configured" ? "configured" : projection.binding === "invalid" ? "invalid" : "missing"}`,
    `Credential: ${projection.credentialConfigured === true ? "configured" : "not configured"}`,
    `Runtime State: ${state}`,
    `Evidence: ${EVIDENCE.includes(projection.evidence ?? "") ? projection.evidence : "unavailable"}`,
    ...(isTunnelRefusalCode(projection.errorCode) ? [`Error: ${projection.errorCode}`] : []),
    // Configuration guidance is separate from (and never overrides) runtime. A
    // missing/invalid/incomplete profile is the actionable problem even when the
    // runtime is UNKNOWN; setup/edit is how it is repaired, never an auto-start.
    ...(tunnel === "Not configured / unavailable" || projection.binding !== "configured" || !projection.credentialConfigured
      ? [state === "UNCONFIGURED" || projection.tunnelIdAlreadyMasked === undefined
          ? "Tunnel is not configured. Run setup to continue."
          : "Configuration is invalid or incomplete. Edit configuration to continue."]
      : []),
    "Configured != Connected",
    "Transport only; not delivery/ACK/completion evidence.",
  ];
}

export async function runTunnelManagerUi(
  ctx: TunnelManagerUiContext,
  ports: TunnelManagerUiPorts,
  options: TunnelManagerUiOptions = {},
): Promise<TunnelManagerUiOutcome> {
  if (ctx.mode !== "tui" || !ctx.hasUI || !("custom" in ctx.ui) || typeof ctx.ui.custom !== "function") {
    return { status: "unsupported" };
  }
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
  const menuContext = { mode: "tui" as const, hasUI: true, ui: ctx.ui };
  type Context = typeof menuContext;
  const menu = defineMenu<TunnelManagerUiProjection, "manager", Exclude<TunnelManagerUiAction, "close">, Context>({
    start: "manager",
    screens: {
      manager: ({ state }) => ({
        kind: "actions", title: "Tunnel Manager", hint: "close",
        lines: [...tunnelManagerRows(state), ...(operationError === undefined ? [] : [`Last operation: ${operationError}`])],
        items: tunnelManagerActions(state).map((action) => action === "close"
          ? { id: action, label: LABELS[action], close: true as const }
          : { id: action, label: LABELS[action], action }),
      }),
    },
    actions: {
      setup: () => perform("setup"), edit: () => perform("setup"),
      start: () => perform("start"), stop: () => perform("stop"),
      refresh: () => { operationError = undefined; return { kind: "stay" }; },
    },
  });

  // Kit closes an action screen before invoking these handlers, allowing setup
  // to host its own Wizard without overlapping custom-component ownership.
  async function perform(action: "setup" | "start" | "stop"): Promise<{ kind: "stay" | "close" }> {
    if (!current()) return { kind: "close" };
    operationError = undefined;
    try { await ports[action](); }
    catch (error) { operationError = closedCode(error); }
    // runMenu's next getState rereads even after a refused operation. No action
    // is automatically retried; no setup result is interpreted as permission.
    return { kind: current() ? "stay" : "close" };
  }

  try {
    const result = await runMenu(menuContext, menu, {
      signal: controller.signal, isCurrent: current,
      onError: () => { /* Never delegate raw exceptions to notifications. */ },
      getState: async () => {
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
      },
    });
    if (!current() || result.kind === "stale") return { status: "cancelled" };
    if (result.kind === "error") return { status: "refused", code: "CE_TUNNEL_HEALTH_UNAVAILABLE" };
    return { status: "closed" };
  } catch {
    return current() ? { status: "refused", code: "CE_TUNNEL_HEALTH_UNAVAILABLE" } : { status: "cancelled" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
