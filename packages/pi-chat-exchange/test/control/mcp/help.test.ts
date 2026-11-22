import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import { PING_PROTOCOL_VERSION } from "../../../src/control/mcp/ping.js";
import { CE_PROTOCOL_VERSION } from "../../../src/protocol/version.js";
import type { ExchangeMessagingPort } from "../../../src/control/mcp/messaging-tools.js";

const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../..", "package.json"), "utf8"));

function port(): ExchangeMessagingPort {
  return {
    send: () => ({ disposition: "CREATED", messageId: "msg_1", auditSequence: 1, recipient: "pi/main" }),
    listInbox: () => ({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false }),
    readPayload: () => ({ messageId: "msg_1", from: "pi/main", to: "chatgpt/main", payloadDigest: "a".repeat(64), payloadLength: 2, createdAt: "2026-01-01T00:00:00.000Z", auditSequence: 1, payloadText: "ok" }),
    acknowledge: () => ({ disposition: "CREATED", receipt: { receiptId: "rcpt_1", exchangeId: "exc_1", messageId: "msg_1", endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" }, kind: "delivery_ack", createdAt: "2026-01-01T00:00:00.000Z" }, receiptAuditSequence: 2 }),
  };
}

async function connected(binding?: Parameters<typeof createExchangeMcpServer>[1]) {
  const client = new Client({ name: "help-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createExchangeMcpServer("test", binding);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("ce_help", () => {
  const clients: Client[] = [];
  afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });

  it("describes the exact final registered tool surface and authoritative versions", async () => {
    const client = await connected(); clients.push(client);
    const listed = await client.listTools();
    const result = await client.callTool({ name: "ce_help", arguments: {} });
    const help = result.structuredContent as any;
    expect(help.registeredTools.map((tool: any) => tool.name)).toEqual(listed.tools.map(tool => tool.name));
    expect(help.softwareVersion).toBe(packageJson.version);
    expect(help.protocolVersion).toBe(CE_PROTOCOL_VERSION);
    expect(PING_PROTOCOL_VERSION).toBe(1);
    expect(help.protocolVersion).not.toBe(PING_PROTOCOL_VERSION);
    expect(listed.tools.find(tool => tool.name === "ce_help")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  });

  it("marks workflows unavailable when their required tools are not registered", async () => {
    const client = await connected({ port: port() }); clients.push(client);
    const result = await client.callTool({ name: "ce_help", arguments: {} });
    const workflows = new Map((result.structuredContent as any).workflows.map((item: any) => [item.id, item]));
    expect(workflows.get("reply-query")).toMatchObject({ status: "TOOL_NOT_REGISTERED", tools: [], missingTools: ["ce_find_replies"] });
    expect(workflows.get("task-owner-conversation")).toMatchObject({ status: "TOOL_NOT_REGISTERED", missingTools: ["ce_task_owner"] });
    expect(workflows.get("payload-read-and-ack")).toMatchObject({ status: "TOOL_NOT_REGISTERED", missingTools: ["ce_ack"] });
    expect(workflows.get("pi-to-chatgpt-receive")).toMatchObject({ status: "AVAILABLE", missingTools: [] });
  });

  it("is closed-input, deterministic, private, and does not call the messaging port", async () => {
    let calls = 0;
    const client = await connected({ port: { ...port(), listInbox: () => { calls++; return port().listInbox({}); } }, ackEnabled: true }); clients.push(client);
    await expect(client.callTool({ name: "ce_help", arguments: { unexpected: true } })).rejects.toMatchObject({ code: -32602 });
    const first = await client.callTool({ name: "ce_help", arguments: {} });
    const second = await client.callTool({ name: "ce_help", arguments: {} });
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(calls).toBe(0);
    const text = JSON.stringify(first);
    expect(text).not.toContain(process.cwd());
    expect(text).not.toMatch(/(?:token|secret|credential)[=:]/i);
  });
});
