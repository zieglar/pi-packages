import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { multiSessionFixture } from "../tunnel/support/multi-session-fixture.js";

const entries = [fileURLToPath(new URL("../../dist/bin/mcp-stdio.js", import.meta.url))];
if (process.env.CE_PUBLISHED_MCP_ENTRY) entries.push(process.env.CE_PUBLISHED_MCP_ENTRY);

it.each(entries)("MCP artifact %s loads the current conditional tool contract", { timeout: 20_000 }, async (entry) => {
  const fixture = await multiSessionFixture();
  await fixture.api.register({ expectedRevision: fixture.api.revision(), registration: {
    endpointId: "pi/B", runtimeSessionId: "artifact-contract-B", payloadRead: true, ack: true,
  } });
  const transport = new StdioClientTransport({ command: process.env.CE_TEST_NODE ?? process.execPath, args: [entry, "--config", fixture.selected().bindingPath], stderr: "pipe" });
  let diagnostics = "";
  transport.stderr?.on("data", data => { diagnostics += String(data); });
  const client = new Client({ name: "ce-artifact-contract", version: "1" });
  try {
    await client.connect(transport).catch(error => { throw new Error(`MCP_CONNECT_FAILED ${diagnostics}`, { cause: error }); });
    const tools = (await client.listTools()).tools;
    expect(tools.map(tool => tool.name)).toEqual([
      "ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack", "ce_find_replies", "ce_help",
    ]);
    const send = tools.find(tool => tool.name === "ce_send")!;
    expect((send.inputSchema.properties as Record<string, unknown>)).toHaveProperty("replyTo");
    // This v1 fixture has no endpoint-discovery port: conditional registration must stay absent.
    expect(tools.find(tool => tool.name === "ce_endpoints")).toBeUndefined();
    expect(tools.find(tool => tool.name === "ce_find_replies")?.inputSchema).toBeDefined();
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    fixture.cleanup();
  }
});
