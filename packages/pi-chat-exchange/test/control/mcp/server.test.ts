import { existsSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";

const HOST_LABEL = "test-host";
const EXPECTED_PING = {
  service: "pi-chat-exchange",
  protocolVersion: 1,
  host: HOST_LABEL,
  status: "reachable",
};

const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASS|PWD|AUTH|CRED|CERT|PRIVATE|SESSION|COOKIE)/i;

function sensitiveEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_NAME.test(name) && typeof value === "string" && value.length >= 4)
    .map(([, value]) => value as string);
}
describe("pi-chat-exchange MCP smoke server (in-memory transport)", () => {
  let client: Client;

  beforeEach(async () => {
    client = new Client({ name: "vitest", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createExchangeMcpServer(HOST_LABEL);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it("completes the MCP initialize handshake", async () => {
    // connect() already performed initialize; re-check server identity via ping.
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.isError).not.toBe(true);
  });

  it("advertises exactly one strictly read-only ping tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe("ping");
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.annotations?.destructiveHint).toBe(false);
    expect(tool.inputSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("ping returns the frozen deterministic envelope", async () => {
    const first = await client.callTool({ name: "ping", arguments: {} });
    const second = await client.callTool({ name: "ping", arguments: {} });
    expect(first.structuredContent).toEqual(EXPECTED_PING);
    expect(second.structuredContent).toEqual(EXPECTED_PING);
  });

  it("rejects malformed tool arguments with a JSON-RPC error, not a crash", async () => {
    await expect(
      client.callTool({ name: "ping", arguments: { unexpected: true } }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toMatchObject({
      code: -32601,
    });
    // Server is still healthy after rejected calls.
    const result = await client.callTool({ name: "ping", arguments: {} });
    expect(result.structuredContent).toEqual(EXPECTED_PING);
  });

  it("surfaces no credential or environment leakage in any server payload", async () => {
    const listed = await client.listTools();
    const called = await client.callTool({ name: "ping", arguments: {} });
    const serialized = JSON.stringify([listed, called]);
    for (const secret of sensitiveEnvValues()) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain(process.cwd());
    expect(() => JSON.parse(JSON.stringify(called))).not.toThrow();
  });

  it("surfaces JSON-RPC errors as McpError instances", async () => {
    const failure = await client.callTool({ name: "ping", arguments: { bad: 1 } }).catch((e) => e);
    expect(failure).toBeInstanceOf(McpError);
  });
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stdioEntry = resolve(packageRoot, "dist", "bin", "mcp-stdio.js");

describe("pi-chat-exchange MCP stdio entrypoint (built artifact)", () => {
  it("requires the built artifact before tests (no skipped smoke accepted)", () => {
    if (!existsSync(stdioEntry)) {
      throw new Error(
        `built stdio entrypoint missing: ${stdioEntry} — run "pnpm run build" before "pnpm test" (package verify runs build first; a skipped smoke is not accepted)`,
      );
    }
  });

  it("serves the MCP protocol over stdio JSON-RPC lines", async () => {
    const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [stdioEntry], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
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
        new Promise<string>((resolvePromise) => {
          const id = nextId++;
          pending.set(id, resolvePromise);
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });

      const init = JSON.parse(await call("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.1" },
      })) as { result: { serverInfo: { name: string } } };
      expect(init.result.serverInfo.name).toBe("pi-chat-exchange");

      child.stdin.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })}\n`);

      const listed = JSON.parse(await call("tools/list", {})) as {
        result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
      };
      expect(listed.result.tools).toHaveLength(1);
      expect(listed.result.tools[0]?.name).toBe("ping");
      expect(listed.result.tools[0]?.annotations?.readOnlyHint).toBe(true);

      const called = JSON.parse(await call("tools/call", { name: "ping", arguments: {} })) as {
        result: { structuredContent: Record<string, unknown> };
      };
      expect(called.result.structuredContent.service).toBe("pi-chat-exchange");
      expect(called.result.structuredContent.status).toBe("reachable");
      expect(called.result.structuredContent.protocolVersion).toBe(1);

      const malformed = JSON.parse(await call("tools/call", {
        name: "ping",
        arguments: { unexpected: 1 },
      })) as { error: { code: number } };
      expect(malformed.error.code).toBe(-32602);

      child.stdin.end();
    } finally {
      child.kill("SIGTERM");
    }
  }, 20_000);
});
