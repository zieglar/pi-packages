import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { expect, it, vi } from "vitest";

it("actual /ce-hooks native menu lists loaded CE_ALLOWLIST rules independently of live editing", async () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-hooks-legacy-"));
  const path = join(dir, "allowlist.json");
  const rules = [{ id: "legacy-loaded", event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: "/never/execute/personal-script", args: ["literal"], timeoutMs: 1000, enabled: false }];
  fs.writeFileSync(path, JSON.stringify({ sessions: { A: { endpointId: "pi/A" } }, hooks: rules }), { mode: 0o600 });
  vi.stubEnv("CE_ALLOWLIST", path); vi.stubEnv("CE_TUNNEL_OFFLINE_TEST", "1");
  const h = createTuiHarness({ rows: 60, width: 150 });
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const appendEntry = vi.fn();
  try {
    const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
    factory({ on: vi.fn(), registerTool: vi.fn(), registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, command), appendEntry });
    // Audit must show the captured process rules, even if the source changes.
    fs.writeFileSync(path, JSON.stringify({ sessions: { A: { endpointId: "pi/A" } }, hooks: [] }));
    const command = commands.get("ce-hooks")!;
    const task = command.handler("", { mode: "tui", hasUI: true, cwd: dir, ui: { custom: h.custom, notify: vi.fn() }, sessionManager: { getSessionId: () => "A", getSessionFile: () => undefined, getBranch: () => [] } });
    await h.waitForOpen(); for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(h.render().join("\n")).toContain("Loaded rules · this Pi process");
    h.press("tui.select.down"); h.press("tui.select.confirm");
    for (let i = 0; i < 40; i++) await Promise.resolve();
    const text = h.render().join("\n");
    expect(text).toContain("CE_ALLOWLIST"); expect(text).toContain("legacy-loaded"); expect(text).toContain("/never/execute/personal-script");
    expect(text).toContain("disabled"); expect(text).not.toContain("Approve and save");
    h.press("tui.select.cancel"); await task;
    expect(appendEntry).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["allowlist.json"]);
  } finally { h.dispose(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); }
});
