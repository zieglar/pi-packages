import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

const pkg = resolve(import.meta.dirname, "../..");
it("POSIX debug launcher forwards piped stdin to its background child", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-debug-stdin-"));
  try {
    mkdirSync(join(root, "server")); mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "server/launch.mjs"), "");
    writeFileSync(join(root, "bin/version-guard.cjs"), "");
    const shim = join(root, "mise-fixture");
    writeFileSync(shim, '#!/bin/sh\nexec /bin/cat\n', { mode: 0o700 });
    const launcher = join(root, "bin/launch");
    writeFileSync(launcher, readFileSync(join(pkg, "scripts/debug-plugin/launch"), "utf8").replace("/opt/homebrew/bin/mise", shim), { mode: 0o700 });
    const input = '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n';
    const result = spawnSync("/bin/sh", [launcher], { input, encoding: "utf8", timeout: 5_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(input);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Debug-only launcher remains explicitly pinned to 24.21.0; production stdio is tested separately.
it.skipIf(process.version !== "v24.21.0")("real launcher preserves JSON-RPC, logs stages and survives unavailable log files with clean signal shutdown", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-debug-stdio-"));
  const children: ReturnType<typeof spawn>[] = [];
  try {
    mkdirSync(join(root, "server")); mkdirSync(join(root, "bin"));
    cpSync(join(pkg, "dist"), join(root, "server/dist"), { recursive: true });
    // Only the temporary test fixture uses a dependency link; deployable builder forbids links.
    symlinkSync(join(pkg, "node_modules"), join(root, "server/node_modules"));
    writeFileSync(join(root, "server/package.json"), '{"type":"module"}');
    cpSync(join(pkg, "plugin/pi-chat-exchange/server/launch-config.mjs"), join(root, "server/launch-config.mjs"));
    const launcher = readFileSync(join(pkg, "plugin/pi-chat-exchange/server/launch.mjs"), "utf8").replace('[entrypoint, "--config", configPath]', '["--require", join(pluginRoot, "bin/version-guard.cjs"), entrypoint, "--config", configPath]');
    writeFileSync(join(root, "server/launch.mjs"), launcher);
    cpSync(join(pkg, "scripts/debug-plugin/version-guard.cjs"), join(root, "bin/version-guard.cjs"));
    // Fixed-executable substitution only in this fixture, never an environment switch.
    const shim = join(root, "mise-fixture");
    writeFileSync(shim, `#!/bin/sh\nshift 3\nshift\nexec '${process.execPath}' "$@"\n`, { mode: 0o700 });
    writeFileSync(join(root, "bin/launch"), readFileSync(join(pkg, "scripts/debug-plugin/launch"), "utf8").replace("/opt/homebrew/bin/mise", shim), { mode: 0o700 });
    const configPath = join(root, "binding.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, store: { directory: join(root, "store") }, exchange: { namespace: "diag-stdio", idempotencyKey: "fixture" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, recipients: [{ adapter: "pi", endpointId: "pi/main" }], payloadRead: { enabled: true }, ack: { enabled: true } }));
    for (const fileUnavailable of [false, true]) {
      const logdir = join(root, "server/.debug-logs");
      if (fileUnavailable) { rmSync(logdir, { recursive: true, force: true }); writeFileSync(logdir, "not a directory"); }
      const child = spawn("/bin/sh", [join(root, "bin/launch"), "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] }); children.push(child);
      const exited = new Promise<number | null>((done) => child.once("exit", done));
      let stderr = ""; child.stderr!.on("data", (c) => { stderr += c.toString(); });
      const frames: any[] = []; const invalid: string[] = []; const waiters = new Map<number, (value: any) => void>();
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => { try { const frame = JSON.parse(line); frames.push(frame); waiters.get(frame.id)?.(frame); } catch { invalid.push(line); } });
      let id = 0;
      const call = (method: string, params: unknown): Promise<any> => new Promise((done, fail) => {
        const n = ++id; const timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 8_000);
        waiters.set(n, (value) => { clearTimeout(timer); waiters.delete(n); done(value); });
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      });
      const initialized = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "diag-fixture", version: "1" } });
      expect(initialized.result.serverInfo.name).toBe("pi-chat-exchange");
      child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const listed = await call("tools/list", {});
      expect(listed.result.tools.map((t: any) => t.name).sort()).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack"].sort());
      expect((await call("tools/call", { name: "ping", arguments: {} })).result.isError).not.toBe(true);
      expect((await call("tools/call", { name: "ping", arguments: { secret: "SECRET_CANARY" } })).error).toBeDefined();
      child.kill("SIGTERM"); expect(await exited).toBe(0); lines.close();
      expect(invalid).toEqual([]); expect(frames.every((f) => f.jsonrpc === "2.0")).toBe(true);
      for (const event of ["LAUNCH_STARTED", "SERVER_EXEC_STARTED", "VERSION_GUARD_PASSED", "SERVER_ENTRY", "STORE_OPEN_COMPLETED", "OWNERSHIP_ACQUIRED", "MCP_INITIALIZE", "MCP_INITIALIZED", "MCP_TOOLS_LIST", "MCP_TOOLS_CALL", "TOOL_CALL_COMPLETED", "TOOL_CALL_FAILED", "PROCESS_SIGNAL", "PROCESS_EXIT", "LAUNCH_EXITED"]) expect(stderr, event).toContain(event);
      expect(stderr).not.toContain("SECRET_CANARY");
      if (!fileUnavailable) {
        const logs = readdirSync(logdir).flatMap((name) => readFileSync(join(logdir, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
        expect(new Set(logs.filter((e) => e.event === "VERSION_GUARD_PASSED").map((e) => e.pid)).size).toBe(2);
        expect(logs.every((e) => e.ts && e.pid && e.component && e.event)).toBe(true);
        expect(JSON.stringify(logs)).not.toContain("SECRET_CANARY");
      }
    }
  } finally { for (const child of children) if (child.exitCode === null) child.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); }
});
