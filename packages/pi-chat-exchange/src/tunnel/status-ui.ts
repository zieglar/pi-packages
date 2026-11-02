/** Shared read-only status screen; the caller owns admission and status data. */
import { renderBoundedFrame, runCustomInteraction, sanitizeTerminalText } from "@narumitw/pi-tui-kit";
import { clipTunnelPanelText } from "./manager-panel.js";
import type { SetupUiContext } from "./setup-ui.js";

export async function presentCeStatus(
  ctx: SetupUiContext, title: string, lines: readonly string[], options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") return;
  const safeLines = lines.map(line => sanitizeTerminalText(line));
  await runCustomInteraction<void, SetupUiContext>(ctx, {
    ...options,
    onError: () => undefined,
    create: ({ tui, theme, keybindings, complete }) => ({
      render(width) {
        const columns = Math.max(1, Math.floor(width));
        // Match Kit's terminal reservation and reserve the close row before body.
        const budget = Math.max(1, Math.floor(tui.terminal.rows) - 2);
        const hint = theme.fg("accent", clipTunnelPanelText("Esc", columns))
          + theme.fg("muted", clipTunnelPanelText("  Close", Math.max(0, columns - 3)));
        if (budget <= 2) return [hint];
        const body = renderBoundedFrame({ width: columns, maxRows: budget - 2, rule: "",
          title: [theme.bold(theme.fg("accent", sanitizeTerminalText(title)))],
          content: safeLines.map(line => theme.fg("text", line)),
        });
        return [...body, theme.fg("border", "─".repeat(columns)), hint];
      },
      invalidate() {},
      handleInput(data) {
        if (data === "\x1b" || data === "\x03" || keybindings.matches(data, "tui.select.cancel")) complete();
      },
    }),
  });
}
