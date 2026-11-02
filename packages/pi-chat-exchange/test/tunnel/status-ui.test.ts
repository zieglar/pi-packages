import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { describe, expect, it } from "vitest";
import type { SetupUiContext } from "../../src/tunnel/setup-ui.js";

async function open(width = 80, rows = 24) {
  const h = createTuiHarness({ width, rows, theme: { fg: (role, text) => role === "accent" ? `\x1b[36m${text}\x1b[39m` : text, bold: text => text } });
  const mod = await import("../../src/tunnel/status-ui.js");
  const controller = new AbortController();
  const task = mod.presentCeStatus({ mode: "tui", hasUI: true, ui: { custom: h.custom } } as SetupUiContext,
    "Chat Exchange Status", Array.from({ length: 20 }, (_, i) => `Status ${i}: ${"x".repeat(100)}`), { signal: controller.signal });
  await h.waitForOpen();
  return { h, task, controller };
}
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("CE status close footer", () => {
  it("keeps an accented Esc and distinct footer below the body across resize", async () => {
    const f = await open();
    try {
      for (const size of [{ width: 80, rows: 24 }, { width: 24, rows: 8 }, { width: 12, rows: 4 }, { width: 10, rows: 1 }]) {
        const lines = f.h.resize(size);
        expect(lines.length).toBeLessThanOrEqual(Math.max(1, size.rows - 2));
        expect(plain(lines.at(-1)!)).toBe("Esc  Close");
        expect(lines.at(-1)).toContain("\x1b[36mEsc\x1b[39m");
        for (const line of lines) expect([...plain(line)].length).toBeLessThanOrEqual(size.width);
        if (size.rows >= 8) expect(plain(lines.at(-2)!)).toMatch(/^─+$/);
      }
      f.h.send("\x1b"); await f.task;
      expect(f.h.isOpen).toBe(false);
    } finally { f.h.dispose(); }
  });
  it.each(["cancel", "ctrl-c", "abort", "dispose"])("%s closes without an action", async reason => {
    const f = await open();
    if (reason === "cancel") f.h.press("tui.select.cancel");
    else if (reason === "ctrl-c") f.h.send("\x03");
    else if (reason === "abort") f.controller.abort();
    else f.h.dispose();
    await f.task; expect(f.h.isOpen).toBe(false);
  });
});
