import { describe, expect, it } from "vitest";
import {
  renderTunnelPanel, tunnelPanelCells, tunnelPanelModel, type TunnelPanelTheme,
} from "../../src/tunnel/manager-panel.js";
import type { TunnelManagerUiProjection } from "../../src/tunnel/manager-ui.js";

/** Identity theme: asserts layout without ANSI noise. */
const PLAIN: TunnelPanelTheme = { fg: (_role, text) => text, bold: (text) => text };
/** Tagging theme: proves which role styles each region without real ANSI. */
const TAGGED: TunnelPanelTheme = { fg: (role, text) => `<${role}>${text}</${role}>`, bold: (text) => `*${text}*` };

const CONNECTED: TunnelManagerUiProjection = {
  state: "CONNECTED", profilePath: "/fixtures/tunnel.yaml",
  tunnelIdAlreadyMasked: "tunnel_abcdef…", organizationConfigured: true,
  binding: "configured", credentialConfigured: true, evidence: "health-probe",
};
const UNCONFIGURED: TunnelManagerUiProjection = {
  state: "UNCONFIGURED", profilePath: "/fixtures/tunnel.yaml",
  organizationConfigured: false, binding: "missing", credentialConfigured: false, evidence: "none",
};
const STOPPED: TunnelManagerUiProjection = {
  state: "STOPPED", profilePath: "/fixtures/tunnel.yaml",
  tunnelIdAlreadyMasked: "tunnel_abcdef…", organizationConfigured: false,
  binding: "configured", credentialConfigured: true, evidence: "process-identity",
};

function render(projection: TunnelManagerUiProjection, width: number, theme = PLAIN, view: "manager" | "details" = "manager") {
  return renderTunnelPanel(tunnelPanelModel(projection, view), width, theme);
}

describe("tunnel manager visual panel", () => {
  it("projects complete Store and Exchange facts separately from runtime", () => {
    const messaging = { configured: true, payloadRead: true, ack: true, storeDirectory: "/actual/store", storeFile: "/actual/store/ce.sqlite", exchangeNamespace: "namespace", exchangeIdempotencyKey: "idem-key" };
    const model = tunnelPanelModel({ ...CONNECTED, messaging }, "details");
    const fields = model.sections.find((s) => s.title === "Messaging (configuration)")!.fields;
    for (const value of [messaging.storeDirectory, messaging.storeFile, messaging.exchangeNamespace, messaging.exchangeIdempotencyKey]) expect(fields.some((f) => f.value === value)).toBe(true);
    expect(model.sections.find((s) => s.title === "Runtime")!.fields.some((f) => f.value === messaging.storeFile)).toBe(false);
  });
  it.each(["\n", "\r", "\t", "\x00", "\x07", "\x1b[31m", "\x7f", "\x85"])("sanitizes endpoint controls %j before measuring rows", (control) => {
    const projection: TunnelManagerUiProjection = { ...CONNECTED, messaging: {
      configured: true, chatgptEndpointId: `chat${control}gpt/main`, piEndpointId: `pi${control}/main`,
      piSessionId: "session", payloadRead: true, ack: true,
    } };
    const model = tunnelPanelModel(projection, "details");
    const fields = model.sections.flatMap((section) => section.fields).filter((field) => field.label.endsWith("endpoint"));
    expect(fields).toHaveLength(2);
    for (const field of fields) expect(field.value).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    for (const width of [1, 8, 28, 72, 120]) {
      for (const row of renderTunnelPanel(model, width, PLAIN)) {
        expect(row).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
        expect(tunnelPanelCells(row)).toBe(width);
      }
    }
  });
  it("draws a closed box whose every row is exactly the requested width", () => {
    for (const width of [72, 60, 48, 44, 36, 28]) {
      const lines = render(CONNECTED, width);
      expect(lines.length).toBeGreaterThan(3);
      // Width is measured in terminal cells, not code points or UTF-16 units.
      for (const line of lines) expect([line, tunnelPanelCells(line)]).toEqual([line, width]);
      expect(lines[0]!.startsWith("┌")).toBe(true);
      expect(lines[0]!.endsWith("┐")).toBe(true);
      expect(lines.at(-1)!.startsWith("└")).toBe(true);
      expect(lines.at(-1)!.endsWith("┘")).toBe(true);
      // Every interior row is a complete frame row (content │…│ or a rule ├…┤):
      // a narrow terminal shrinks the panel, it never shatters the border.
      for (const line of lines.slice(1, -1)) {
        expect([/^[│├]/u.test(line), /[│┤]$/u.test(line)]).toEqual([true, true]);
      }
    }
  });

  it("separates Configuration and Runtime with labeled rules, not blank lines", () => {
    const text = render(CONNECTED, 72).join("\n");
    expect(text).toContain("Configuration");
    expect(text).toContain("Runtime");
    expect(text).toMatch(/├─+ Configuration /);
    expect(text).toMatch(/├─+ Runtime /);
  });

  it("aligns field values into one column", () => {
    const lines = render(CONNECTED, 72);
    const fields = lines.filter((l) => /(Tunnel|Organization|MCP Binding|Credential)\s{2,}\S/.test(l));
    expect(fields.length).toBe(4);
    const columns = fields.map((l) => l.search(/\S+\s*│$/u) >= 0 ? l.indexOf(l.trimEnd().split(/\s{2,}/u).at(-1)!) : -1);
    expect(new Set(columns).size).toBe(1);
  });

  it("gives the primary state its own emphasized row with a state-appropriate tone", () => {
    // The tagged primary row itself: a screen-wide substring could match a
    // configured field even if the primary tone were wrong.
    expect(render(CONNECTED, 72, TAGGED).join("\n")).toContain("*<success>● Connected</success>*");
    expect(render(UNCONFIGURED, 72, TAGGED).join("\n")).toContain("*<warning>● Not configured</warning>*");
    const connected = render(CONNECTED, 72).join("\n");
    expect(connected).toContain("● Connected");
    expect(render(UNCONFIGURED, 72).join("\n")).toContain("● Not configured");
  });

  it("styles the frame with border and the title with accent, never raw", () => {
    const text = render(CONNECTED, 72, TAGGED).join("\n");
    expect(text).toContain("<border>");
    expect(text).toContain("<accent>");
  });

  it("truncates long values instead of breaking the frame", () => {
    const long: TunnelManagerUiProjection = { ...CONNECTED, profilePath: `/${"d".repeat(400)}/tunnel.yaml` };
    for (const width of [72, 40, 24]) {
      for (const line of render(long, width, PLAIN, "details")) expect(line.length).toBe(width);
    }
  });

  it("keeps the credential reference and raw path out of the manager view", () => {
    const text = render(CONNECTED, 72).join("\n");
    expect(text).not.toContain("/fixtures/tunnel.yaml");
    // Details is the diagnostics surface that may show the profile path.
    expect(render(CONNECTED, 72, PLAIN, "details").join("\n")).toContain("tunnel.yaml");
  });

  it("shows the exact repair notice row only when the configuration needs it", () => {
    expect(render(UNCONFIGURED, 72, TAGGED).join("\n")).toContain("<dim>Tunnel is not configured. Run setup to continue.</dim>");
    // Width 80: the full notice is 71 cells, beyond the 72-column budget.
    expect(render({ ...STOPPED, binding: "invalid" }, 80, TAGGED).join("\n")).toContain("<dim>Configuration is invalid or incomplete. Edit configuration to continue.</dim>");
    expect(render(CONNECTED, 72, TAGGED).join("\n")).not.toContain("<dim>");
  });

  it("never maps UNKNOWN to a stopped or connected presentation", () => {
    const unknown = render({ ...STOPPED, state: "UNKNOWN", evidence: "unavailable" }, 72).join("\n");
    expect(unknown).toContain("State unknown");
    expect(unknown).not.toMatch(/Connected|not running/);
  });

  it("MESSAGING-INTEGRATION-01: Details shows messaging configuration facts only — manager view and runtime stay untouched", () => {
    const withMessaging: TunnelManagerUiProjection = { ...CONNECTED, messaging: {
      chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: "session-1",
      configured: true, payloadRead: true, ack: true,
    } };
    const details = render(withMessaging, 78, PLAIN, "details").join("\n");
    expect(details).toContain("Messaging (configuration)");
    expect(details).toContain("chatgpt:chatgpt/main");
    expect(details).toContain("pi:pi/main");
    expect(details).toContain("session-1");
    expect(details).toContain("Bidirectional authorized (configuration)");
    expect(details).toContain("Enabled (reception only)");
    // Manager view never carries the messaging section.
    const manager = render(withMessaging, 78, PLAIN, "manager").join("\n");
    expect(manager).not.toContain("Messaging (configuration)");
    // Without messaging facts: explicit Not configured, never fabricated.
    const bare = render(CONNECTED, 78, PLAIN, "details").join("\n");
    expect(bare).toContain("Not configured");
    expect(bare).not.toContain("Bidirectional authorized");
  });

  it("MESSAGING-INTEGRATION-01: messaging rows stay inside the frame at every width", () => {
    const withMessaging: TunnelManagerUiProjection = { ...STOPPED, messaging: {
      chatgptEndpointId: "chatgpt/main", piEndpointId: "pi/main", piSessionId: "session-1",
      configured: true, payloadRead: true, ack: true,
    } };
    for (const width of [78, 48, 28]) {
      for (const line of render(withMessaging, width, PLAIN, "details")) expect(tunnelPanelCells(line)).toBe(width);
    }
  });

  it("degrades to a usable panel at very small widths without throwing", () => {
    for (const width of [12, 8, 4, 1]) {
      const lines = render(CONNECTED, width);
      for (const line of lines) expect(tunnelPanelCells(line)).toBe(width);
    }
  });

  it("measures East Asian wide, combining, and emoji characters in terminal cells", () => {
    // A Details Profile path containing CJK: a code-point implementation would
    // overflow the frame; every row must stay exactly `width` cells.
    const wide: TunnelManagerUiProjection = { ...STOPPED, profilePath: "/用户资料/密钥目录/tunnel.yaml" };
    for (const width of [48, 24]) {
      const lines = render(wide, width, PLAIN, "details");
      for (const line of lines) expect(tunnelPanelCells(line)).toBe(width);
      const profile = lines.find((l) => l.includes("Profile"));
      expect(profile, "Profile row").toBeDefined();
      // BMP wide chars occupy 2 cells per UTF-16 unit: the row's code-unit
      // length is strictly below its cell width, which a naive implementation
      // cannot satisfy while keeping the frame closed.
      expect(profile!.length).toBeLessThan(width);
      expect(profile!.endsWith("│")).toBe(true);
    }
    // Combining marks occupy zero cells; emoji (surrogate pairs) occupy two.
    const mixed: TunnelManagerUiProjection = { ...STOPPED, profilePath: "/tmp/cafe\u0301-🔐/tunnel.yaml" };
    for (const line of render(mixed, 40, PLAIN, "details")) expect(tunnelPanelCells(line)).toBe(40);
  });

  it("pins exact Details rows for wide, combining, and emoji values (independent of the cell helper)", () => {
    // Literal expectations: they must not share the production classifier.
    // Width 40 => budget 36, label cell 12, value budget 22.
    const emoji: TunnelManagerUiProjection = { ...STOPPED, profilePath: "/tmp/🚀/tunnel.yaml" };
    const emojiRow = render(emoji, 40, PLAIN, "details").find((l) => l.includes("Profile"));
    // 🚀 = 2 cells: value is 19 cells, so 3 fill cells precede the frame.
    expect(emojiRow).toBe("│ Profile       /tmp/🚀/tunnel.yaml    │");

    const combining: TunnelManagerUiProjection = { ...STOPPED, profilePath: "/tmp/cafe\u0301/tunnel.yaml" };
    const combiningRow = render(combining, 40, PLAIN, "details").find((l) => l.includes("Profile"));
    // cafe\u0301 = 4 cells / 5 code units: value is 21 cells, 1 fill cell.
    expect(combiningRow).toBe("│ Profile       /tmp/cafe\u0301/tunnel.yaml  │");

    // Width 24 => budget 20, value budget 6: CJK clipped to whole glyphs.
    const cjk: TunnelManagerUiProjection = { ...STOPPED, profilePath: "/用户资料/密钥目录/tunnel.yaml" };
    const cjkRow = render(cjk, 24, PLAIN, "details").find((l) => l.includes("Profile"));
    expect(cjkRow).toBe("│ Profile       /用户… │");
  });
});
