import fs from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { multiSessionFixture } from "../../tunnel/support/multi-session-fixture.js";

it("projects multi-session Hooks into the actual Pi Host and audits current revocation", async () => {
  const f = await multiSessionFixture();
  const output = join(f.dir, "notification.json");
  const script = join(f.dir, "notify.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(process.argv[2], fs.readFileSync(0,'utf8'));`);
  await f.api.register({ expectedRevision: f.api.revision(), registration: {
    endpointId: "pi/A", runtimeSessionId: "real-A", payloadRead: true, ack: true,
    hooks: [{ id: "multi-notify", event: "ce.message.committed.v1", recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: process.execPath, args: [script, output], timeoutMs: 5000, enabled: true }],
  } });
  vi.stubEnv("CE_ALLOWLIST", ""); vi.stubEnv("CE_TUNNEL_PROFILE", f.profilePath);
  vi.stubEnv("CE_STORE_DIR", ""); vi.stubEnv("CE_STORE_FILE", "");
  const events = new Map<string, (event: { reason: string }, ctx: any) => Promise<void>>();
  const commands = new Map<string, { handler(args: string, ctx: any): unknown }>();
  const tools = new Map<string, { execute(...args: any[]): Promise<{ isError?: boolean }> }>();
  const entries: Array<Record<string, unknown>> = [];
  const ctx = { mode: "tui", hasUI: true, cwd: f.dir,
    sessionManager: { getSessionId: () => "real-A", getSessionFile: () => undefined, getBranch: () => entries },
    ui: { notify: vi.fn() } };
  const { default: factory } = await import(new URL("../../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: (name: string, handler: any) => events.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }) });
  try {
    await events.get("session_start")!({ reason: "startup" }, ctx);
    await commands.get("ce-hooks")!.handler("", ctx);
    expect(ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n")).toContain("active=1 configured=1 source=selected multi-session profile registration");
    const result = await tools.get("ce_send")!.execute("multi-send", { to: "chatgpt/main", text: "PAYLOAD_NOT_IN_HOOK", idempotencyKey: "multi-1" }, undefined, undefined, ctx);
    expect(result.isError).not.toBe(true);
    await vi.waitFor(() => {
      const rows = fs.readFileSync(join(f.selected().config.store.directory, "ce-hooks", "executions.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
      expect(rows).toContainEqual(expect.objectContaining({ hookId: "multi-notify", status: "SUCCEEDED" }));
    }, { timeout: 5000 });
    expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ sender: { adapter: "pi", endpointId: "pi/A" }, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } });
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
    ctx.ui.notify.mockClear();
    await commands.get("ce-hooks")!.handler("", ctx);
    expect(ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n")).toContain("active=0 configured=1");
    expect(ctx.ui.notify.mock.calls.map(([text]) => String(text)).join("\n")).toContain("disabled");
    expect((await tools.get("ce_send")!.execute("denied-send", { to: "chatgpt/main", text: "denied", idempotencyKey: "multi-2" }, undefined, undefined, ctx)).isError).toBe(true);
  } finally {
    await events.get("session_shutdown")!({ reason: "quit" }, ctx);
    vi.unstubAllEnvs(); f.cleanup();
  }
}, 15000);
