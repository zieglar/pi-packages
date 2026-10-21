/**
 * HANDOFF-853274 — MCP server surface in messaging mode (in-memory transport).
 *
 * Without a messaging binding the surface must stay exactly the Phase 1 smoke
 * surface; with one, the server additionally exposes the three messaging
 * tools over the injected port — and nothing else changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import type { ExchangeMessagingPort } from "../../../src/control/mcp/messaging-tools.js";

const HOST_LABEL = "test-host";

function port(overrides: Partial<ExchangeMessagingPort> = {}): ExchangeMessagingPort {
  return {
    send: () => ({ disposition: "CREATED", messageId: "msg_1", auditSequence: 3, recipient: "pi/main" }),
    listInbox: () => ({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false }),
    readPayload: () => ({
      messageId: "msg_1",
      from: "pi/main",
      to: "chatgpt/main",
      payloadDigest: "d47",
      payloadLength: 2,
      createdAt: "2026-10-14T00:00:00.000Z",
      auditSequence: 3,
      payloadText: "ok",
    }),
    // HANDOFF-CE-E2B-01: the port contract now carries the ACK operation; the
    // stub is never reached by the pre-existing assertions below.
    acknowledge: () => ({
      disposition: "CREATED",
      receipt: {
        receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        messageId: "msg_1",
        endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
        kind: "delivery_ack",
        createdAt: "2026-10-14T00:00:00.000Z",
      },
      receiptAuditSequence: 4,
    }),
    ...overrides,
  };
}

async function connect(messaging?: { port: ExchangeMessagingPort }) {
  const client = new Client({ name: "vitest", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createExchangeMcpServer(HOST_LABEL, messaging);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server messaging mode", () => {
  let clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients) await client.close();
    clients = [];
  });

  it("lists exactly ping plus the three messaging tools with closed schemas", async () => {
    const { client } = await connect({ port: port() });
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload"]);
    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.additionalProperties).toBe(false);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    const send = tools[1]!;
    expect(send.annotations?.readOnlyHint).toBe(false);
    expect(send.annotations?.idempotentHint).toBe(true);
  });

  it("routes a send through the injected port and returns its evidence", async () => {
    const seen: unknown[] = [];
    const { client } = await connect({
      port: port({ send: (input) => { seen.push(input); return port().send(input); } }),
    });
    clients.push(client);
    const result = await client.callTool({
      name: "ce_send",
      arguments: { to: "pi/main", text: "hello", idempotencyKey: "k1" },
    });
    expect(result.isError).not.toBe(true);
    expect(seen).toEqual([{ to: "pi/main", text: "hello", idempotencyKey: "k1" }]);
    expect(result.structuredContent).toMatchObject({ disposition: "CREATED", recipient: "pi/main" });
  });

  it("rejects authority-selecting arguments as JSON-RPC invalid params", async () => {
    const { client } = await connect({ port: port() });
    clients.push(client);
    await expect(
      client.callTool({ name: "ce_send", arguments: { to: "pi/main", text: "x", idempotencyKey: "k", endpointId: "pi/rogue" } }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      client.callTool({ name: "ce_read_payload", arguments: { messageId: "m", capability: "cap_0123456789abcdef" } }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("surfaces port refusals as isError tool results, not protocol errors", async () => {
    const { client } = await connect({
      port: port({
        send: () => {
          const error = new Error("internal: /var/lib/secret cap_0123456789abcdef");
          throw Object.assign(error, { code: "CE_HOST_UNCERTAIN", retryable: true });
        },
      }),
    });
    clients.push(client);
    const result = await client.callTool({
      name: "ce_send",
      arguments: { to: "pi/main", text: "x", idempotencyKey: "k" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "CE_HOST_UNCERTAIN", retryable: false });
    expect(JSON.stringify(result)).not.toContain("/var/lib/secret");
    // The server stays healthy for later calls.
    const pong = await client.callTool({ name: "ping", arguments: {} });
    expect(pong.isError).not.toBe(true);
  });

  it("stays exactly ping-only without a messaging binding and fails messaging calls closed", async () => {
    const { client } = await connect();
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
    await expect(client.callTool({ name: "ce_send", arguments: { to: "x", text: "y", idempotencyKey: "z" } })).rejects.toMatchObject({
      code: -32601,
    });
  });
});
