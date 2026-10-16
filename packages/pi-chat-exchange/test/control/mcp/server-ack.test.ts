/**
 * HANDOFF-CE-E2B-01 — the `ce_ack` MCP server surface (clause 5).
 *
 * `ce_ack` is advertised ONLY when the binding declares the ack opt-in. Bindings
 * without that opt-in keep exactly the four-tool surface and a
 * `ce_ack` call there fails closed with MethodNotFound; argument-shape
 * violations stay JSON-RPC invalid params (-32602).
 */
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import type { ExchangeMessagingPort } from "../../../src/control/mcp/messaging-tools.js";

const HOST_LABEL = "test-host";

const ACK_ARGS = {
  messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  payloadDigest: "c".repeat(64),
  payloadLength: 5,
  messageCreatedAuditSequence: 3,
};

function port(overrides: Partial<ExchangeMessagingPort> = {}): ExchangeMessagingPort {
  return {
    send: () => ({ disposition: "CREATED", messageId: "msg_1", auditSequence: 3, recipient: "pi/main" }),
    listInbox: () => ({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false }),
    readPayload: () => ({
      messageId: ACK_ARGS.messageId,
      from: "pi/main",
      to: "chatgpt/main",
      payloadDigest: ACK_ARGS.payloadDigest,
      payloadLength: ACK_ARGS.payloadLength,
      createdAt: "2026-10-16T00:00:00.000Z",
      auditSequence: ACK_ARGS.messageCreatedAuditSequence,
      payloadText: "ok",
    }),
    acknowledge: () => ({
      disposition: "CREATED",
      receipt: {
        receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        exchangeId: "exc_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        messageId: ACK_ARGS.messageId,
        endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
        kind: "delivery_ack",
        createdAt: "2026-10-16T00:00:00.000Z",
      },
      receiptAuditSequence: 9,
    }),
    ...overrides,
  };
}

const BASE_TOOLS = ["ping", "ce_send", "ce_inbox_list", "ce_read_payload"];

async function connect(messaging?: { port: ExchangeMessagingPort; ackEnabled?: boolean }) {
  const client = new Client({ name: "vitest", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createExchangeMcpServer(HOST_LABEL, messaging);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("MCP server ce_ack advertisement", () => {
  let clients: Client[] = [];
  afterEach(async () => {
    for (const client of clients) await client.close();
    clients = [];
  });

  it("keeps exactly the four-tool surface without the ack opt-in (default)", async () => {
    const { client } = await connect({ port: port() });
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(BASE_TOOLS);
  });

  it("lists ce_ack last when the binding declares the ack opt-in", async () => {
    const { client } = await connect({ port: port(), ackEnabled: true });
    clients.push(client);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...BASE_TOOLS, "ce_ack"]);
    const ack = tools[4]!;
    expect(ack.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect((ack.inputSchema as Record<string, unknown>).additionalProperties).toBe(false);
    expect(String(ack.description).toLowerCase()).toContain("reception");
  });

  it("routes a ce_ack call through the port and returns the receipt evidence", async () => {
    const seen: unknown[] = [];
    const { client } = await connect({ port: port({ acknowledge: (input) => { seen.push(input); return port().acknowledge(input); } }), ackEnabled: true });
    clients.push(client);
    const result = await client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS } });
    expect(seen).toEqual([{ ...ACK_ARGS }]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      disposition: "CREATED",
      receiptAuditSequence: 9,
      receipt: { kind: "delivery_ack", receiptId: "rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
  });

  it("fails a ce_ack call closed with MethodNotFound without the opt-in", async () => {
    const calls: unknown[] = [];
    const { client } = await connect({ port: port({ acknowledge: (input) => { calls.push(input); return port().acknowledge(input); } }) });
    clients.push(client);
    await expect(client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS } })).rejects.toMatchObject({ code: -32601 });
    expect(calls).toEqual([]);
  });

  it("fails a ce_ack call closed with MethodNotFound when no messaging binding exists", async () => {
    const { client } = await connect();
    clients.push(client);
    await expect(client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS } })).rejects.toMatchObject({ code: -32601 });
  });

  it("rejects argument-shape violations as invalid params and never reaches the port", async () => {
    const calls: unknown[] = [];
    const { client } = await connect({ port: port({ acknowledge: (input) => { calls.push(input); return port().acknowledge(input); } }), ackEnabled: true });
    clients.push(client);
    await expect(
      client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS, capability: "cap_0123456789abcdef" } }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS, sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV" } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: "ce_ack", arguments: { messageId: "m", payloadDigest: "zz", payloadLength: -1, messageCreatedAuditSequence: 0 } }))
      .rejects.toMatchObject({ code: -32602 });
    await expect(client.callTool({ name: "ce_ack", arguments: {} })).rejects.toMatchObject({ code: -32602 });
    expect(calls).toEqual([]);
  });

  it("surfaces a port refusal as a sanitized isError result, not a protocol error", async () => {
    const { client } = await connect({
      port: port({ acknowledge: () => {
        const error = new Error("internal: /var/lib/secret cap_0123456789abcdef");
        throw Object.assign(error, { code: "CE_HOST_ACK_DISABLED" });
      } }),
      ackEnabled: true,
    });
    clients.push(client);
    const result = await client.callTool({ name: "ce_ack", arguments: { ...ACK_ARGS } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "CE_HOST_ACK_DISABLED", retryable: false });
    expect(JSON.stringify(result)).not.toContain("cap_0123456789abcdef");
    expect(JSON.stringify(result)).not.toContain("/var/lib/secret");
  });

  it("keeps the pre-existing tools working unchanged alongside the opt-in", async () => {
    const { client } = await connect({ port: port(), ackEnabled: true });
    clients.push(client);
    const pong = await client.callTool({ name: "ping", arguments: {} });
    expect(pong.isError).not.toBe(true);
    const sent = await client.callTool({ name: "ce_send", arguments: { to: "pi/main", text: "x", idempotencyKey: "k" } });
    expect(sent.structuredContent).toMatchObject({ disposition: "CREATED" });
    await expect(client.callTool({ name: "ce_send", arguments: { to: "x", text: "y", idempotencyKey: "z", endpointId: "rogue" } }))
      .rejects.toMatchObject({ code: -32602 });
  });
});
