/**
 * HANDOFF-853274 — MCP stdio entrypoint in `--config` mode (built artifact).
 *
 * Real two-context dogfood: a spawned `mcp-stdio.js --config …` process owns
 * the chatgpt/main Endpoint over the same durable store this test's Pi-side
 * host uses for pi/main. Proves: config-driven identity, four-tool surface,
 * bidirectional cross-adapter delivery, payload exposure shape, clean lease
 * release on SIGTERM, clean restart, and fail-closed restart after a crash.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { initializeStore, openStore } from "../../src/storage/store.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stdioEntry = resolve(packageRoot, "dist", "bin", "mcp-stdio.js");

interface Child {
  readonly process: ChildProcessWithoutNullStreams;
  readonly stderr: string[];
  readonly call: (method: string, params: unknown) => Promise<Record<string, unknown>>;
  readonly notify: (method: string) => void;
  readonly waitExit: () => Promise<number | null>;
}

function writeConfig(root: string): string {
  const config = {
    version: 1,
    store: { directory: join(root, "store") },
    exchange: { namespace: "ce-mcp-it", idempotencyKey: "exchange-1" },
    endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [{ adapter: "pi", endpointId: "pi/main" }],
    payloadRead: { enabled: true },
  };
  const path = join(root, "binding.json");
  writeFileSync(path, `${JSON.stringify(config, undefined, 2)}\n`);
  return path;
}

async function launch(configPath: string): Promise<Child> {
  const child = spawn(process.execPath, [stdioEntry, "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(...chunk.split("\n").filter(Boolean)));
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (line: string) => void>();
  let nextId = 0;
  rl.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (typeof message.id === "number" && pending.has(message.id)) {
      pending.get(message.id)!(line);
      pending.delete(message.id);
    }
  });
  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolvePromise) => {
      const id = nextId++;
      pending.set(id, (line) => resolvePromise(JSON.parse(line) as Record<string, unknown>));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  const waitExit = () =>
    new Promise<number | null>((resolvePromise) => child.on("exit", (code) => resolvePromise(code)));
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`server never started; stderr: ${stderr.join(" | ")}`)), 15_000);
    const poll = () => {
      if (stderr.some((line) => line.startsWith("CE_MCP_STARTED"))) {
        clearTimeout(timer);
        resolveReady();
      } else if (pending.size === 0 && !child.stdin.writable) {
        clearTimeout(timer);
        rejectReady(new Error(`server exited; stderr: ${stderr.join(" | ")}`));
      } else setTimeout(poll, 25);
    };
    poll();
  });
  const init = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "0.0.1" },
  });
  expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe("pi-chat-exchange");
  notify("notifications/initialized");
  return { process: child, stderr, call, notify, waitExit };
}

describe("MCP stdio entrypoint in --config mode (built artifact)", () => {
  it("requires the built artifact", () => {
    if (!existsSync(stdioEntry)) {
      throw new Error(`built stdio entrypoint missing: ${stdioEntry} — run "pnpm run build" first`);
    }
  });

  it("dogfoods bidirectional chatgpt<->pi messaging with clean lease release", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-mcp-it-"));
    try {
      const configPath = writeConfig(root);

      // Pi side first: register pi/main on the shared store before the child
      // sends to it, so the cross-adapter recipient is already durable.
      const storeOptions = { directory: join(root, "store"), filename: "ce-store.sqlite", busyTimeoutMs: 5_000 };
      const store = existsSync(join(storeOptions.directory, storeOptions.filename))
        ? openStore(storeOptions)
        : initializeStore(storeOptions);
      const pi = new CeEndpointHost(store, {
        adapter: "pi",
        exchangeNamespace: "ce-mcp-it",
        exchangeIdempotencyKey: "exchange-1",
        allowlist: [{ endpointId: "pi/main" }],
        recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
        leaseTtlSeconds: 600,
        payloadRead: { enabled: true },
      });
      pi.beginSession("pi/main");

      const server = await launch(configPath);

      const listed = (await server.call("tools/list", {})) as {
        result: { tools: Array<{ name: string }> };
      };
      expect(listed.result.tools.map((tool) => tool.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload"]);

      const sent = (await server.call("tools/call", {
        name: "ce_send",
        arguments: { to: "pi/main", text: "hello from chatgpt", idempotencyKey: "it-out-1" },
      })) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
      expect(sent.result.isError).not.toBe(true);
      const outboundId = (sent.result.structuredContent as { messageId: string }).messageId;

      const inbox = pi.listInbox("pi/main", {});
      expect(inbox.messages.map((message) => message.messageId)).toContain(outboundId);
      expect(pi.readPayload("pi/main", { messageId: outboundId }).payloadText).toBe("hello from chatgpt");

      const reply = pi.send("pi/main", { to: "chatgpt/main", text: "reply from pi", idempotencyKey: "it-in-1" });
      const childInbox = (await server.call("tools/call", { name: "ce_inbox_list", arguments: {} })) as {
        result: { structuredContent?: { messages: Array<{ messageId: string }> } };
      };
      const childIds = childInbox.result.structuredContent!.messages.map((message) => message.messageId);
      expect(childIds).toContain(reply.messageId);

      const readBack = (await server.call("tools/call", {
        name: "ce_read_payload",
        arguments: { messageId: reply.messageId },
      })) as { result: { content: Array<{ type: string; text: string }>; structuredContent?: unknown } };
      expect(readBack.result.content[0]!.text).toContain("UNTRUSTED");
      expect(readBack.result.content[1]!.text).toBe("reply from pi");
      expect(readBack.result.structuredContent).toBeUndefined();

      // Idempotent replay over the wire.
      const replay = (await server.call("tools/call", {
        name: "ce_send",
        arguments: { to: "pi/main", text: "hello from chatgpt", idempotencyKey: "it-out-1" },
      })) as { result: { structuredContent?: { disposition: string; messageId: string } } };
      expect(replay.result.structuredContent).toMatchObject({ disposition: "REPLAYED", messageId: outboundId });

      server.process.kill("SIGTERM");
      const code = await server.waitExit();
      expect(code).toBe(0);
      expect(server.stderr.some((line) => line.includes("CE_MCP_STOPPED released=true"))).toBe(true);

      pi.end("pi/main");
      store.close();

      // Clean restart after release: the same config binds again.
      const restarted = await launch(configPath);
      restarted.process.kill("SIGTERM");
      expect(await restarted.waitExit()).toBe(0);

      // Crash fail-closed: kill -9 leaves the ownership row; the next start
      // must refuse (no takeover, no adoption).
      const crashed = await launch(configPath);
      crashed.process.kill("SIGKILL");
      await crashed.waitExit();
      const refused = spawn(process.execPath, [stdioEntry, "--config", configPath], { stdio: ["pipe", "pipe", "pipe"] });
      let refusedErr = "";
      refused.stderr.setEncoding("utf8");
      refused.stderr.on("data", (chunk: string) => (refusedErr += chunk));
      const refusedCode = await new Promise<number | null>((resolvePromise) => refused.on("exit", (c) => resolvePromise(c)));
      expect(refusedCode).toBe(1);
      expect(refusedErr).toContain("CE_HOST_AUTHORITY_ABSENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses invalid launch arguments and configs before any durable write", { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-mcp-bad-"));
    try {
      const run = (args: string[]) =>
        new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
          const child = spawn(process.execPath, [stdioEntry, ...args], { stdio: ["pipe", "pipe", "pipe"] });
          let stderr = "";
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (chunk: string) => (stderr += chunk));
          child.on("exit", (code) => resolvePromise({ code, stderr }));
        });

      const badFlag = await run(["--config"]);
      expect(badFlag.code).toBe(1);
      expect(badFlag.stderr).toContain("CE_MCP_LAUNCH_INVALID");

      // A valid-looking config with a relative store directory must be
      // refused by the validator before the store is ever touched.
      const relativeConfig = join(root, "relative.json");
      writeFileSync(relativeConfig, `${JSON.stringify({
        version: 1,
        store: { directory: "relative/store" },
        exchange: { namespace: "n", idempotencyKey: "k" },
        endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
        recipients: [],
      })}\n`);
      const refusedRelative = await run(["--config", relativeConfig]);
      expect(refusedRelative.code).toBe(1);
      expect(refusedRelative.stderr).toContain("CE_MCP_CONFIG_INVALID store.directory");

      const missing = await run(["--config", join(root, "absent.json")]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("CE_MCP_CONFIG_INVALID config.unreadable");

      const malformed = join(root, "malformed.json");
      writeFileSync(malformed, "{not json");
      const bad = await run(["--config", malformed]);
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("CE_MCP_CONFIG_INVALID config.not_json");

      const secretShaped = join(root, "secret.json");
      writeFileSync(secretShaped, `${JSON.stringify({
        version: 1,
        store: { directory: root },
        exchange: { namespace: "n", idempotencyKey: "k" },
        endpoint: { adapter: "cap_0123456789abcdef", endpointId: "chatgpt/main" },
        recipients: [],
      })}\n`);
      const leaked = await run(["--config", secretShaped]);
      expect(leaked.code).toBe(1);
      expect(leaked.stderr).toContain("CE_MCP_CONFIG_INVALID endpoint.adapter");
      // The refusal names the field, never the value.
      expect(leaked.stderr).not.toContain("cap_0123456789abcdef");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
