import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

interface Context {
  mode: string; hasUI: boolean; cwd: string;
  sessionManager: { getSessionId(): string; getSessionFile(): undefined; getBranch(): Array<Record<string, unknown>> };
  ui: { notify: ReturnType<typeof vi.fn> };
}
interface Tool { name: string; execute(id: string, input: unknown, signal: undefined, update: undefined, ctx: Context): Promise<{ isError?: boolean }> }

it("runs the real Pi extension Hook after a normal allowlist session switch", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ce-pi-hooks-real-")));
  const output = join(root, "notified.json");
  const script = join(root, "notify.mjs");
  writeFileSync(script, `import fs from 'node:fs'; const event=JSON.parse(fs.readFileSync(0,'utf8')); fs.writeFileSync(process.argv[2], JSON.stringify(event));`);
  const configPath = join(root, "allowlist.json");
  writeFileSync(configPath, JSON.stringify({
    store: { directory: join(root, "store"), file: "store.sqlite" },
    sessions: { first: { endpointId: "pi/A" }, second: { endpointId: "pi/B" } },
    hooks: [{ id: "notify", event: "ce.message.committed.v1", recipient: { adapter: "pi", endpointId: "pi/A" }, command: process.execPath, args: [script, output] }],
  }));
  vi.stubEnv("CE_ALLOWLIST", configPath);
  vi.stubEnv("CE_STORE_DIR", ""); vi.stubEnv("CE_STORE_FILE", "");
  const events = new Map<string, (event: { reason: string }, ctx: Context) => Promise<void>>();
  const tools = new Map<string, Tool>();
  let session = "first";
  let entries: Array<Record<string, unknown>> = [];
  const ctx: Context = { mode: "tui", hasUI: true, cwd: root,
    sessionManager: { getSessionId: () => session, getSessionFile: () => undefined, getBranch: () => entries }, ui: { notify: vi.fn() } };
  const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: (name: string, handler: (event: { reason: string }, ctx: Context) => Promise<void>) => events.set(name, handler),
    registerTool: (tool: Tool) => tools.set(tool.name, tool), registerCommand: vi.fn(),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) });
  try {
    await events.get("session_start")!({ reason: "startup" }, ctx);
    await events.get("session_shutdown")!({ reason: "quit" }, ctx);
    session = "second"; entries = [];
    await events.get("session_start")!({ reason: "new" }, ctx);
    const result = await tools.get("ce_send")!.execute("hook-call", { to: "pi/A", text: "original text", idempotencyKey: "switch-send" }, undefined, undefined, ctx);
    expect(result.isError).not.toBe(true);
    await vi.waitFor(() => expect(existsSync(output)).toBe(true), { timeout: 3000 });
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ event: "ce.message.committed.v1", sender: { adapter: "pi", endpointId: "pi/B" }, recipient: { adapter: "pi", endpointId: "pi/A" } });
  } finally {
    await events.get("session_shutdown")!({ reason: "quit" }, ctx);
    vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
  }
});
