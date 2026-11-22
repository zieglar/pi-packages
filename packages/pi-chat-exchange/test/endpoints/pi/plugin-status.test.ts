import { describe, expect, it, vi } from "vitest";
import type { CeHookRule } from "../../../src/hooks/config.js";
import type { CeHookStatusResult } from "../../../src/hooks/status-probe.js";
import { createPluginStatusController, desktopPendingMenuActions, desktopPluginDetailLines, formatPluginStatus, pluginSessionAnnotation, pluginStatusLines } from "../../../pi-extension/plugin-status.js";

const statusRule = (id: string, enabled = true): CeHookRule => ({
  id, event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" },
  command: "/usr/bin/true", args: [], timeoutMs: 1000, enabled, scope: "session",
  status: { label: id, command: "/usr/bin/true", args: [], timeoutMs: 1000 },
});
const result = (hookId: string, state: CeHookStatusResult["state"]): CeHookStatusResult => ({
  hookId, label: hookId, scope: "session", state, code: `${hookId.toUpperCase()}_${state}`,
});

describe("current-Session plugin status", () => {
  it("formats provider states independently", () => {
    expect(formatPluginStatus(result("Desktop", "READY"))).toBe("Desktop ● Ready");
    expect(formatPluginStatus(result("Desktop", "DEGRADED"))).toBe("Desktop ! Degraded");
    expect(formatPluginStatus(result("Desktop", "UNKNOWN"))).toBe("Desktop ? Unknown");
    expect(formatPluginStatus({ ...result("desktop", "UNKNOWN"), label: "Desktop", code: "NATIVE_SESSION_FILE_PENDING" })).toBe("Desktop ◐ Pending");
  });

  it("suggests the normal first message for a pending Pi Session file", () => {
    expect(pluginStatusLines([{ ...result("desktop", "UNKNOWN"), label: "Desktop", code: "NATIVE_SESSION_FILE_PENDING" }])).toEqual([
      "Session Plugins", "", "Desktop", "  Hook: desktop", "  Scope: session",
      "  State: UNKNOWN", "  Code: NATIVE_SESSION_FILE_PENDING",
      "  Suggestion: Send the first normal message in this Session; Desktop status will refresh automatically after Pi creates the Session file.",
    ]);
  });

  it("annotates the Pi Session line while its Desktop file is pending", () => {
    expect(pluginSessionAnnotation([{ ...result("desktop", "UNKNOWN"), code: "NATIVE_SESSION_FILE_PENDING" }])).toBe(" (Desktop pending)");
    expect(pluginSessionAnnotation([result("desktop", "READY")])).toBe("");
  });

  it("renders plugin details separately from Chat Exchange status", () => {
    expect(pluginStatusLines([])).toEqual(["Session Plugins: none"]);
    expect(pluginStatusLines([result("Desktop", "DEGRADED")])).toEqual([
      "Session Plugins", "", "Desktop", "  Hook: Desktop", "  Scope: session",
      "  State: DEGRADED", "  Code: DESKTOP_DEGRADED",
    ]);
  });

  it("labels current-Session pending Desktop deliveries without calling them CE messages", () => {
    const lines = desktopPluginDetailLines(2, { state: "DEGRADED", code: "COMPOSER_CLEANUP_UNKNOWN" });
    expect(lines).toEqual(["  Pending Desktop deliveries: 2", "  Desktop action state: DEGRADED (COMPOSER_CLEANUP_UNKNOWN)"]);
    expect(lines.join("\n")).not.toContain("undelivered CE messages");
  });

  it("never offers replay for UNKNOWN or an in-flight pending item", () => {
    expect(desktopPendingMenuActions("WAITING_FOR_OPERATOR")).toEqual(["Retry once", "Dismiss", "Back"]);
    expect(desktopPendingMenuActions("UNKNOWN")).toEqual(["Back"]);
    expect(desktopPendingMenuActions("READY_TO_RETRY")).toEqual(["Back"]);
  });

  it("publishes only enabled current rules and clears stale keys", async () => {
    const setStatus = vi.fn();
    const run = vi.fn(async (rules: readonly CeHookRule[]) => rules.map(rule => result(rule.id, "READY")));
    const controller = createPluginStatusController({ run });
    const port = { mode: "tui", ui: { setStatus } };
    const observed = await controller.refresh(port, [statusRule("desktop"), statusRule("disabled", false)]);
    expect(observed).toEqual([result("desktop", "READY")]);
    expect(run).toHaveBeenCalledWith([statusRule("desktop")], undefined);
    expect(setStatus).toHaveBeenCalledWith("ce-plugin:desktop", "desktop ● Ready");
    await controller.refresh(port, []);
    expect(setStatus).toHaveBeenCalledWith("ce-plugin:desktop", undefined);
    expect(controller.snapshot()).toEqual([]);
  });

  it("prevents a stale refresh from publishing after clear", async () => {
    let finish!: (value: readonly CeHookStatusResult[]) => void;
    const run = vi.fn(() => new Promise<readonly CeHookStatusResult[]>(resolve => { finish = resolve; }));
    const setStatus = vi.fn();
    const port = { mode: "tui", ui: { setStatus } };
    const controller = createPluginStatusController({ run });
    const pending = controller.refresh(port, [statusRule("desktop")]);
    controller.clear();
    finish([result("desktop", "READY")]);
    await pending;
    expect(setStatus).not.toHaveBeenCalledWith("ce-plugin:desktop", "desktop ● Ready");
    expect(setStatus).toHaveBeenCalledWith("ce-plugin:desktop", undefined);
  });

  it("keeps provider degradation separate from the CE key", async () => {
    const setStatus = vi.fn();
    const controller = createPluginStatusController({ run: async () => [result("desktop", "DEGRADED")] });
    await controller.refresh({ mode: "tui", ui: { setStatus } }, [statusRule("desktop")]);
    expect(setStatus).toHaveBeenCalledWith("ce-plugin:desktop", "desktop ! Degraded");
    expect(setStatus.mock.calls.some(([key]) => key === "ce")).toBe(false);
  });
});
