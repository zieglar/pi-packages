import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";

it("observes registration and tool outcomes without changing the real SDK protocol", async () => {
  const file = resolve(import.meta.dirname, "../../../.debug-logs", `ce-debug-${process.pid}.jsonl`);
  const offset = existsSync(file) ? readFileSync(file, "utf8").length : 0;
  const server = createExchangeMcpServer("debug-test");
  const client = new Client({ name: "debug-test", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping"]);
    expect((await client.callTool({ name: "ping", arguments: {} })).isError).toBe(false);
    await expect(client.callTool({ name: "ping", arguments: { text: "BODY_CANARY" } })).rejects.toMatchObject({ code: -32602 });
    const raw = readFileSync(file, "utf8").slice(offset);
    for (const event of ["SERVER_CREATED", "TOOL_REGISTERED", "MCP_TOOLS_LIST", "TOOL_CALL_STARTED", "TOOL_CALL_COMPLETED", "TOOL_CALL_FAILED"]) expect(raw).toContain(event);
    expect(raw).not.toContain("BODY_CANARY");
  } finally { await client.close(); await server.close(); }
});
