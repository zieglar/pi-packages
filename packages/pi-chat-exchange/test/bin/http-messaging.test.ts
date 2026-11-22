import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGING_TOOL_NAMES } from "../../src/control/mcp/messaging-tools.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { readCurrentOwnership, readSessionBindings } from "../../src/storage/ownership.js";
import { readParticipantByEndpoint } from "../../src/storage/participant.js";
import { initializeStore } from "../../src/storage/store.js";

const entry = resolve("dist/bin/mcp-stdio.js");
function rpc(socketPath: string, method: string, params: unknown): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: {
      host: "localhost", "content-type": "application/json", accept: "application/json, text/event-stream",
    } }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try { resolvePromise(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  });
}
async function launch(config: string, socket: string): Promise<{ child: ChildProcess; exited: Promise<number | null> }> {
  const child = spawn(process.execPath, [entry, "--config", config, "--http-socket", socket], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr!.setEncoding("utf8");
  const exited = new Promise<number | null>(resolvePromise => child.once("exit", resolvePromise));
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runtime did not start: ${errors}`)), 10_000);
    child.stderr!.on("data", (chunk: string) => {
      errors += chunk;
      if (errors.includes("CE_MCP_STARTED")) { clearTimeout(timeout); resolvePromise(); }
    });
    child.once("exit", () => { clearTimeout(timeout); reject(new Error(`runtime exited: ${errors}`)); });
  });
  return { child, exited };
}

describe("HTTP MCP bound runtime", () => {
  it("preserves messaging authorization, cleans ownership, and increments fencing across restart", { timeout: 30_000 }, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-http-bound-"));
    const socket = join(root, "mcp.sock");
    const config = join(root, "binding.json");
    const store = initializeStore({ directory: join(root, "store"), filename: "ce-store.sqlite", busyTimeoutMs: 5_000 });
    const pi = new CeEndpointHost(store, {
      adapter: "pi", exchangeNamespace: "ce-http-test", exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: "pi/main" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
      leaseTtlSeconds: 600, payloadRead: { enabled: true },
    });
    pi.beginSession("pi/main");
    writeFileSync(config, JSON.stringify({ version: 1, store: { directory: join(root, "store") },
      exchange: { namespace: "ce-http-test", idempotencyKey: "exchange-1" },
      endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
      recipients: [{ adapter: "pi", endpointId: "pi/main" }], payloadRead: { enabled: true },
    }));
    let running: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      running = await launch(config, socket);
      const participant = readParticipantByEndpoint(store, "chatgpt", "chatgpt/main")!;
      const first = readCurrentOwnership(store, participant.participantId)!;
      const init = await rpc(socket, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(init.result.serverInfo.name).toBe("pi-chat-exchange");
      const list = await rpc(socket, "tools/list", {});
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["ping", ...MESSAGING_TOOL_NAMES, "ce_find_replies", "ce_help"]);
      const denied = await rpc(socket, "tools/call", { name: "ce_send", arguments: { to: "pi/not-allowed", text: "no", idempotencyKey: "deny" } });
      expect(denied.result.isError).toBe(true);
      const sent = await rpc(socket, "tools/call", { name: "ce_send", arguments: { to: "pi/main", text: "hello", idempotencyKey: "once" } });
      expect(sent.result.isError).not.toBe(true);
      expect(pi.readPayload("pi/main", { messageId: sent.result.structuredContent.messageId }).payloadText).toBe("hello");
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      running = undefined;
      expect(readCurrentOwnership(store, participant.participantId)).toBeUndefined();
      expect(readSessionBindings(store, participant.participantId)).toEqual([]);
      running = await launch(config, socket);
      const second = readCurrentOwnership(store, participant.participantId)!;
      expect(second.fencingToken).toBeGreaterThan(first.fencingToken);
      expect(second.sessionId).not.toBe(first.sessionId);
      const reinit = await rpc(socket, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      expect(reinit.result.serverInfo.name).toBe("pi-chat-exchange");
      const ping = await rpc(socket, "tools/call", { name: "ping", arguments: {} });
      expect(ping.result.isError).not.toBe(true);
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      running = undefined;
      expect(readCurrentOwnership(store, participant.participantId)).toBeUndefined();
      expect(readSessionBindings(store, participant.participantId)).toEqual([]);
    } finally {
      if (running !== undefined) { running.child.kill("SIGTERM"); await running.exited; }
      pi.end("pi/main");
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
