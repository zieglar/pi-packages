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

const LABELS: Readonly<Record<TunnelManagerUiAction, string>> = Object.freeze({
  setup: "Set Up Tunnel", edit: "Edit Configuration", start: "Start Tunnel", stop: "Stop Tunnel",
  refresh: "Refresh", details: "Details", close: "Close",
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

/** One canonical read of the safe projection. Presentation never invents a
 * second state judgement: every derived label comes from these fields. */
function readProjection(projection: TunnelManagerUiProjection) {
  const state = STATES.includes(projection.state) ? projection.state : "UNKNOWN";
  // A caller accidentally passing an unmasked ID cannot disclose it here.
  const tunnel = typeof projection.tunnelIdAlreadyMasked === "string" && /^tunnel_[A-Za-z0-9]{6}…$/.test(projection.tunnelIdAlreadyMasked)
    ? projection.tunnelIdAlreadyMasked : "Not configured";
  const binding = projection.binding === "configured" ? "Configured"
    : projection.binding === "invalid" ? "Invalid" : "Not configured";
  const credential = projection.credentialConfigured === true ? "Configured" : "Not configured";
  const organization = projection.organizationConfigured === true ? "Configured" : "Not configured";
  const evidence = EVIDENCE.includes(projection.evidence ?? "") ? projection.evidence! : "unavailable";
  const errorCode = isTunnelRefusalCode(projection.errorCode) ? projection.errorCode : undefined;
  const needsRepair = tunnel === "Not configured" || binding !== "Configured" || credential !== "Configured" || errorCode !== undefined;
  const unconfigured = state === "UNCONFIGURED" || tunnel === "Not configured";
  return { state, tunnel, binding, credential, organization, evidence, errorCode, needsRepair, unconfigured };
}

/** User-facing primary state. Derived from the same projection as the actions;
 * it summarizes, and never overrides, the measured runtime state. */
function primaryState(view: ReturnType<typeof readProjection>): string {
  if (view.unconfigured) return "● Not configured";
  if (view.needsRepair) return "● Configuration incomplete";
  switch (view.state) {
    case "CONNECTED": return "● Connected";
    case "STARTING": return "● Starting";
    case "STOPPING": return "● Stopping";
    case "STOPPED": return "● Configured · not running";
    case "DEGRADED": return "● Degraded";
    case "ERROR": return "● Error";
    default: return "● State unknown";
  }
}

/** Manager landing page: primary state, Configuration, Runtime. Engineering
 * diagnostics (full profile path, evidence, raw codes, transport caveats) live
 * behind Details so they never dominate the operator's decision. */
export function tunnelManagerRows(projection: TunnelManagerUiProjection): readonly string[] {
  const view = readProjection(projection);
  return [
    primaryState(view),
    "",
    "Configuration",
    `  Tunnel:        ${view.tunnel}`,
    `  Organization:  ${view.organization}`,
    `  MCP Binding:   ${view.binding}`,
    `  Credential:    ${view.credential}`,
    "",
    "Runtime",
    `  State:         ${view.state}`,
    ...(view.needsRepair
      ? ["", view.unconfigured
          ? "Tunnel is not configured. Run setup to continue."
          : "Configuration is invalid or incomplete. Edit configuration to continue."]
      : []),
  ];
}

/** Diagnostics view. Credential contents and any credential reference/path are
 * never projection fields, so they cannot appear here either. */
export function tunnelManagerDetailRows(projection: TunnelManagerUiProjection): readonly string[] {
  const view = readProjection(projection);
  return [
    "Configuration",
    `  Profile:       ${sanitizeTerminalText(projection.profilePath)}`,
    `  Tunnel:        ${view.tunnel}`,
    `  Organization:  ${view.organization}`,
    `  MCP Binding:   ${view.binding}`,
    `  Credential:    ${view.credential}`,
    "",
    "Runtime",
    `  State:         ${view.state}`,
    `  Evidence:      ${view.evidence}`,
    ...(view.errorCode !== undefined ? [`  Error:         ${view.errorCode}`] : []),
    "",
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
  const menu = defineMenu<TunnelManagerUiProjection, "manager" | "details", Exclude<TunnelManagerUiAction, "close" | "details">, Context>({
    start: "manager",
    screens: {
      manager: ({ state }) => ({
        kind: "actions", title: "Tunnel Manager", hint: "close",
        lines: [...tunnelManagerRows(state), ...(operationError === undefined ? [] : ["", `Last operation: ${operationError}`])],
        items: tunnelManagerActions(state).map((action) => action === "close"
          ? { id: action, label: LABELS[action], close: true as const }
          : action === "details"
            ? { id: action, label: LABELS[action], to: "details" as const }
            : { id: action, label: LABELS[action], action }),
      }),
      // Diagnostics only: navigation, never a domain operation.
      details: ({ state }) => ({
        kind: "actions", title: "Tunnel Details", hint: "close",
        lines: [...tunnelManagerDetailRows(state), ...(operationError === undefined ? [] : ["", `Last operation: ${operationError}`])],
        items: [{ id: "back", label: "Back", to: "manager" as const }, { id: "close", label: "Close", close: true as const }],
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
