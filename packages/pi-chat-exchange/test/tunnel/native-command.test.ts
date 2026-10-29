import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const homes: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it("registers management before Store startup and warns once per factory across sessions", async () => {
  const home = mkdtempSync(join(tmpdir(), "ce-native-command-")); homes.push(home);
  vi.stubEnv("HOME", home); vi.stubEnv("CE_ALLOWLIST", "/dev/null");
  const commands = new Map<string, { handler(args: string, ctx: any): unknown }>();
  const handlers: Array<(event: any, ctx: any) => unknown> = [];
  const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
  function create() {
    factory({ on: (name: string, fn: any) => { if (name === "session_start") handlers.push(fn); },
      registerCommand: (name: string, value: any) => commands.set(name, value), registerTool() {}, appendEntry() {} } as any);
  }
  create(); expect(commands.has("ce-native")).toBe(true); expect(commands.has("ce-tunnel")).toBe(true);
  const notify = vi.fn(); const ctx = { hasUI: true, mode: "tui", cwd: home, ui: { notify, setStatus() {} }, sessionManager: { getSessionId: () => "unbound", getEntries: () => [] } };
  for (let i = 0; i < 2; i++) for (const fn of handlers) await fn({ reason: "new" }, ctx);
  const warnings = () => notify.mock.calls.filter(call => call[0] === "Chat Exchange: Native Driver is not ready. Messaging is disabled. Run /ce-native to inspect or install the trusted driver.");
  expect(warnings()).toHaveLength(1);
  await commands.get("ce-native")!.handler("status", ctx);
  expect(notify.mock.calls.some(call => String(call[0]).includes("MISSING"))).toBe(true);
  handlers.length = 0; create(); for (const fn of handlers) await fn({ reason: "new" }, ctx);
  expect(warnings()).toHaveLength(2);
});
