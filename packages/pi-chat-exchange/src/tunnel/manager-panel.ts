/**
 * Width-adaptive visual presentation for the Tunnel Manager.
 *
 * This module is pure presentation: it owns no process, Store, configuration,
 * credential, authorization, or recovery decision, and it never derives a second
 * state judgement. It consumes the SAME safe projection the action matrix uses.
 *
 * Styling arrives as an injected `TunnelPanelTheme` so this file stays free of
 * any `@earendil-works/*` import (frozen contract gate), exactly like the key
 * protocol seam used by the secret input.
 */
import { sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { isTunnelRefusalCode } from "./codes.js";
import type { TunnelManagerUiProjection } from "./manager-ui.js";

/** The foreground roles this presentation uses. A narrow structural subset of
 * the host theme: no theme object, construction, or palette is owned here. */
export type TunnelPanelRole = "accent" | "border" | "success" | "warning" | "error" | "muted" | "dim" | "text";

export interface TunnelPanelTheme {
  fg(role: TunnelPanelRole, text: string): string;
  bold(text: string): string;
}

/** Styling-free fallback used by tests and any non-themed host. */
export const PLAIN_TUNNEL_PANEL_THEME: TunnelPanelTheme = Object.freeze({
  fg: (_role: TunnelPanelRole, text: string) => text,
  bold: (text: string) => text,
});

export type TunnelPanelTone = "ok" | "warn" | "bad" | "neutral";

export interface TunnelPanelField {
  readonly label: string;
  readonly value: string;
  readonly tone: TunnelPanelTone;
}
export interface TunnelPanelSection {
  readonly title: string;
  readonly fields: readonly TunnelPanelField[];
}
export interface TunnelPanelModel {
  readonly title: string;
  readonly primary: { readonly text: string; readonly tone: TunnelPanelTone };
  readonly sections: readonly TunnelPanelSection[];
  /** Operator guidance (repair hint, transport caveat). Never diagnostics data. */
  readonly notices: readonly string[];
}

const STATES: readonly string[] = ["UNCONFIGURED", "STOPPED", "STARTING", "CONNECTED", "STOPPING", "ERROR", "UNKNOWN", "DEGRADED"];
const EVIDENCE: readonly string[] = ["none", "process-identity", "health-probe", "offline-simulated", "unavailable"];

/** One canonical read of the safe projection, mirroring the action matrix. */
function readProjection(projection: TunnelManagerUiProjection) {
  const state = STATES.includes(projection.state) ? projection.state : "UNKNOWN";
  // A caller accidentally passing an unmasked ID cannot disclose it here.
  const tunnel = typeof projection.tunnelIdAlreadyMasked === "string" && /^tunnel_(?:[A-Za-z0-9]{6}|[a-z0-9]{4}_[a-z0-9])…$/.test(projection.tunnelIdAlreadyMasked)
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

type View = ReturnType<typeof readProjection>;

/** Summarizes, never overrides, the measured runtime state. UNKNOWN and ERROR
 * are never presented as STOPPED or CONNECTED. */
function primaryState(view: View): { text: string; tone: TunnelPanelTone } {
  if (view.unconfigured) return { text: "● Not configured", tone: "warn" };
  if (view.needsRepair) return { text: "● Configuration incomplete", tone: "warn" };
  switch (view.state) {
    case "CONNECTED": return { text: "● Connected", tone: "ok" };
    case "STARTING": return { text: "● Starting", tone: "neutral" };
    case "STOPPING": return { text: "● Stopping", tone: "neutral" };
    case "STOPPED": return { text: "● Configured · not running", tone: "neutral" };
    case "DEGRADED": return { text: "● Degraded", tone: "warn" };
    case "ERROR": return { text: "● Error", tone: "bad" };
    default: return { text: "● State unknown", tone: "warn" };
  }
}

const configuredTone = (value: string): TunnelPanelTone =>
  value === "Configured" ? "ok" : value === "Invalid" ? "bad" : "warn";

/**
 * Build the panel model. The manager view stays decision-oriented; engineering
 * diagnostics (full profile path, evidence, raw codes, transport caveats) live
 * only in the details view so they never dominate the operator's decision.
 */

/** MESSAGING-INTEGRATION-01: Details-only messaging configuration fields.
 * Advisory: unknown/absent values render as "Not configured" and never
 * affect the action matrix or runtime section. */
function messagingFields(messaging: TunnelManagerUiProjection["messaging"]): TunnelPanelField[] {
  if (messaging === undefined) {
    return [{ label: "Messaging", value: "Not configured", tone: "neutral" }];
  }
  const endpoint = (adapter: string, id: string | undefined): string =>
    typeof id === "string" && id.length > 0 ? `${adapter}:${sanitizeTerminalText(id)}` : "Not configured";
  return [
    { label: "ChatGPT endpoint", value: endpoint("chatgpt", messaging.chatgptEndpointId), tone: messaging.chatgptEndpointId ? "ok" : "warn" },
    { label: "Pi endpoint", value: messaging.piEndpointId === undefined ? "Not configured" : endpoint("pi", messaging.piEndpointId), tone: messaging.piEndpointId ? "ok" : "warn" },
    { label: "Pi session", value: typeof messaging.piSessionId === "string" && messaging.piSessionId.length > 0 ? sanitizeTerminalText(messaging.piSessionId) : "Not mapped", tone: "neutral" },
    ...([
      ["Store directory", messaging.storeDirectory], ["Store file", messaging.storeFile],
      ["Exchange namespace", messaging.exchangeNamespace], ["Idempotency key", messaging.exchangeIdempotencyKey],
    ] as const).map(([label, value]) => ({ label, value: value === undefined ? "Not determined" : sanitizeTerminalText(value), tone: "neutral" as const })),
    { label: "Routing", value: messaging.configured ? "Bidirectional authorized (configuration)" : "Not configured", tone: messaging.configured ? "ok" : "warn" },
    { label: "Payload read", value: messaging.payloadRead ? "Enabled" : "Disabled", tone: messaging.payloadRead ? "ok" : "neutral" },
    { label: "ACK", value: messaging.ack ? "Enabled (reception only)" : "Disabled", tone: messaging.ack ? "ok" : "neutral" },
  ];
}
export function tunnelPanelModel(
  projection: TunnelManagerUiProjection,
  view: "manager" | "details" = "manager",
): TunnelPanelModel {
  const read = readProjection(projection);
  const identity: TunnelPanelField[] = [
    ...(view === "details"
      ? [{ label: "Profile", value: sanitizeTerminalText(projection.profilePath), tone: "neutral" as const }]
      : []),
    { label: "Tunnel", value: read.tunnel, tone: read.tunnel === "Not configured" ? "warn" as const : "ok" as const },
    { label: "Organization", value: read.organization, tone: "neutral" as const },
    { label: "MCP Binding", value: read.binding, tone: configuredTone(read.binding) },
    { label: "Credential", value: read.credential, tone: configuredTone(read.credential) },
  ];
  const runtime: TunnelPanelField[] = [
    { label: "State", value: read.state, tone: primaryState(read).tone },
    ...(view === "details" ? [{ label: "Evidence", value: read.evidence, tone: "neutral" as const }] : []),
    ...(view === "details" && read.errorCode !== undefined
      ? [{ label: "Error", value: read.errorCode, tone: "bad" as const }] : []),
  ];
  // MESSAGING-INTEGRATION-01: configuration-only messaging facts, Details view
  // only. Never implies live messaging; runtime state stays in its own section.
  const messaging: TunnelPanelField[] = view === "details" ? messagingFields(projection.messaging) : [];
  const notices = view === "details"
    ? ["Configured ≠ Connected", "Messaging Configured ≠ Pi-bound ≠ Connected ≠ real Gate. Explicit activation required.", "Transport only; not delivery/ACK/completion evidence."]
    : read.needsRepair
      ? [read.unconfigured
          ? "Tunnel is not configured. Run setup to continue."
          : "Configuration is invalid or incomplete. Edit configuration to continue."]
      : [];
  return Object.freeze({
    title: view === "details" ? "Tunnel Details" : "Chat Exchange Tunnel",
    primary: primaryState(read),
    sections: Object.freeze([
      Object.freeze({ title: "Configuration", fields: Object.freeze(identity) }),
      ...(view === "details" && messaging.length > 0 ? [Object.freeze({ title: "Messaging (configuration)", fields: Object.freeze(messaging) })] : []),
      Object.freeze({ title: "Runtime", fields: Object.freeze(runtime) }),
    ]),
    notices: Object.freeze(notices),
  });
}

const TONE_ROLE: Readonly<Record<TunnelPanelTone, TunnelPanelRole>> = Object.freeze({
  ok: "success", warn: "warning", bad: "error", neutral: "text",
});

/** Terminal cell width of one code point: zero for combining marks and
 * zero-width joiners/variation selectors, two for East Asian wide, fullwidth
 * and emoji ranges, one otherwise. Control characters never reach here
 * (model values are sanitized before rendering). ZWJ emoji clusters are NOT
 * folded into one cell: each base glyph counts individually, so a cluster is
 * over-counted relative to terminals that fold it. Over-counting pads more,
 * which can only leave the frame narrower than the terminal, never wider. */
function charCells(cp: number): number {
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff)
    || (cp >= 0x20d0 && cp <= 0x20ff) || cp === 0x200d || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f)
    || (cp >= 0xe0020 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef)) return 0;
  if (cp >= 0x1100 && (
    cp <= 0x115f || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xa000 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f)
    || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    // The whole SMP emoji/transport/symbol span: splitting it by block left
    // gaps (e.g. U+1F680) that measured a wide glyph as one cell.
    || (cp >= 0x1f000 && cp <= 0x1faff)
    || (cp >= 0x20000 && cp <= 0x2fffd) || (cp >= 0x30000 && cp <= 0x3fffd))) return 2;
  return 1;
}

/** Terminal cells, not code points and not UTF-16 units. */
export function tunnelPanelCells(text: string): number {
  let cells = 0;
  for (const ch of text) cells += charCells(ch.codePointAt(0) ?? 0);
  return cells;
}

/** Truncate to a visible cell budget. Panel text is plain (already sanitized)
 * and styling is applied only after measuring, so slicing cannot cut an escape.
 * A truncated row keeps one trailing cell for the ellipsis. */
function clip(text: string, max: number): string {
  if (max <= 0) return "";
  let cells = 0;
  let out = "";
  let truncated = false;
  for (const ch of text) {
    const c = charCells(ch.codePointAt(0) ?? 0);
    if (cells + c > max) { truncated = true; break; }
    cells += c;
    out += ch;
  }
  if (!truncated) return out;
  while (out !== "" && tunnelPanelCells(out) + 1 > max) out = [...out].slice(0, -1).join("");
  return max <= 1 ? "" : `${out}…`;
}

/** Shared with the Manager adapter so every rendered row obeys one clip rule. */
export const clipTunnelPanelText = (text: string, max: number): string => clip(text, max);

const pad = (text: string, width: number): string => {
  const cells = tunnelPanelCells(text);
  return cells >= width ? text : text + " ".repeat(width - cells);
};
/**
 * Render the model into exactly `width`-wide rows. Every row is a complete frame
 * row, so a narrow terminal shrinks the panel instead of shattering the border.
 */
export function renderTunnelPanel(
  model: TunnelPanelModel,
  width: number,
  theme: TunnelPanelTheme = PLAIN_TUNNEL_PANEL_THEME,
): readonly string[] {
  const total = Math.max(1, Math.floor(width));
  const border = (text: string): string => theme.fg("border", text);
  // Below the minimum frame budget, emit width-exact plain rows rather than a
  // broken box: presentation degrades, it never throws or overflows.
  if (total < 8) {
    return Object.freeze([
      border("─".repeat(total)),
      ...[model.primary.text, ...model.sections.flatMap((s) => s.fields.map((f) => f.value))]
        .map((text) => clip(text, total))
        .map((text) => pad(text, total)),
      border("─".repeat(total)),
    ]);
  }

  const inner = total - 2; // the two vertical rules
  const lines: string[] = [];

  // Top rule carries the panel title.
  const titleText = clip(model.title, Math.max(0, inner - 4));
  const titled = titleText.length > 0 ? `─ ${titleText} ` : "";
  const styledTitle = titleText.length > 0
    ? border("─ ") + theme.fg("accent", theme.bold(titleText)) + border(" ")
    : "";
  lines.push(border("┌") + styledTitle + border("─".repeat(Math.max(0, inner - tunnelPanelCells(titled)))) + border("┐"));

  const budget = inner - 2;
  /** `visible` must already fit `budget`; `styled` renders the same characters.
   * Padding is computed from the visible length so styling never widens a row. */
  const row = (visible: string, styled?: string): string => {
    const text = clip(visible, budget);
    const fill = " ".repeat(Math.max(0, budget - tunnelPanelCells(text)));
    const body = (styled === undefined ? text : styled) + fill;
    return `${border("│")} ${body} ${border("│")}`;
  };

  // Primary status: its own emphasized row, visually above the detail sections.
  const primaryText = clip(model.primary.text, budget);
  lines.push(row(primaryText, theme.bold(theme.fg(TONE_ROLE[model.primary.tone], primaryText))));

  const labelWidth = Math.max(
    0,
    ...model.sections.flatMap((section) => section.fields.map((field) => tunnelPanelCells(field.label))),
  );

  for (const section of model.sections) {
    if (section.fields.length === 0) continue;
    const label = clip(section.title, Math.max(0, inner - 4));
    const head = label.length > 0 ? `─ ${label} ` : "";
    lines.push(border("├") + border(head) + border("─".repeat(Math.max(0, inner - tunnelPanelCells(head)))) + border("┤"));
    // One aligned value column. A narrow terminal shrinks the label cell and
    // then the value; the frame itself is never sacrificed.
    const labelCellWidth = Math.min(labelWidth, Math.max(0, budget - 2));
    const valueBudget = Math.max(0, budget - labelCellWidth - 2);
    for (const field of section.fields) {
      const labelCell = pad(clip(field.label, labelCellWidth), labelCellWidth);
      const value = clip(field.value, valueBudget);
      const visible = `${labelCell}  ${value}`;
      lines.push(row(visible, theme.fg("muted", labelCell) + "  " + theme.fg(TONE_ROLE[field.tone], value)));
    }
  }

  for (const notice of model.notices) {
    lines.push(border("├") + border("─".repeat(inner)) + border("┤"));
    const text = clip(notice, budget);
    lines.push(row(text, theme.fg("dim", text)));
  }

  lines.push(border("└") + border("─".repeat(inner)) + border("┘"));
  return Object.freeze(lines);
}
