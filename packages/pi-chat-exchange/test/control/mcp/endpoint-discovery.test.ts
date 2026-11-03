import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer, type MessagingServerBinding } from "../../../src/control/mcp/server.js";

import type { EndpointDiscoveryResult } from "../../../src/control/mcp/endpoint-discovery.js";

const projection = (): EndpointDiscoveryResult => ({
  self: { adapter: "chatgpt", endpointId: "main", ownCapabilities: { send: true, inbox: true, payloadRead: false, ack: false } },
  targets: [{ adapter: "pi", endpointId: "B", registered: true, authorized: { send: true }, active: "unknown", reachable: "unknown", reason: "PRESENCE_WITHHELD" }],
  observedAt: "2026-11-03T00:00:00.000Z", viewDigest: "a".repeat(64),
});
async function connected(binding: MessagingServerBinding | undefined, check: (client: Client) => Promise<void>) {
  const server = createExchangeMcpServer("test", binding);
  const client = new Client({ name: "discovery-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try { await check(client); } finally { await client.close(); await server.close(); }
}
const base = (): MessagingServerBinding => ({ port: {} as never });

it("keeps legacy tool order and refuses discovery without an explicit port", async () => {
  for (const binding of [undefined, base(), { ...base(), ackEnabled: true }]) {
    await connected(binding, async client => {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(binding === undefined ? ["ping"] : ["ping", "ce_send", "ce_inbox_list", "ce_read_payload", ...(binding.ackEnabled ? ["ce_ack"] : [])]);
      await expect(client.callTool({ name: "ce_endpoints", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    });
  }
});

it("advertises a closed empty tool after ACK and returns only validated projection", async () => {
  let calls = 0;
  await connected({ ...base(), ackEnabled: true, discovery: { discover: () => { calls++; return projection(); } } }, async client => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack", "ce_endpoints"]);
    expect(tools.at(-1)?.inputSchema).toMatchObject({ properties: {}, additionalProperties: false });
    for (const field of ["sender", "target", "cursor", "session", "capability"]) {
      await expect(client.callTool({ name: "ce_endpoints", arguments: { [field]: "secret" } })).rejects.toMatchObject({ code: -32602 });
    }
    expect(calls).toBe(0);
    const result = await client.callTool({ name: "ce_endpoints", arguments: {} });
    expect(result.structuredContent).toEqual(projection());
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(projection()) }]);
    expect(result.isError).toBe(false);
    expect(calls).toBe(1);
  });
});

it("runs admission and execution guard before discovery without invoking the source", async () => {
  let calls = 0;
  for (const gate of [{ admission: () => { throw Error("private-path"); } }, { executionGuard: { enabled: true } }]) {
    await connected({ ...base(), ...gate, discovery: { discover: () => { calls++; return projection(); } } }, async client => {
      await expect(client.callTool({ name: "ce_endpoints", arguments: {} })).rejects.toMatchObject({ code: -32603 });
    });
  }
  expect(calls).toBe(0);
});

it("refuses malformed, oversized or private source results and sanitizes source errors", async () => {
  const valid = projection();
  const invalid: unknown[] = [null, {}, { ...valid, sequence: 1 }, { ...valid, viewDigest: "private-path" },
    { ...valid, self: { ...valid.self, ownerId: "private-id" } },
    { ...valid, targets: Array.from({ length: 129 }, () => valid.targets[0]) },
    { ...valid, targets: [{ ...valid.targets[0], active: true }] },
    { ...valid, targets: [{ ...valid.targets[0], reason: "private-path" }] },
    { ...valid, targets: [{ ...valid.targets[0], authorized: { send: false } }] },
    { ...valid, targets: [{ ...valid.targets[0], payloadRead: true }] },
    { ...valid, self: { ...valid.self, ownCapabilities: { send: "true" } } },
  ];
  for (const value of [...invalid, new Error("private-path credential payload")]) {
    await connected({ ...base(), discovery: { discover: () => { if (value instanceof Error) throw value; return value as EndpointDiscoveryResult; } } }, async client => {
      const error = await client.callTool({ name: "ce_endpoints", arguments: {} }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: -32603 });
      expect(String(error)).toContain("endpoint discovery unavailable");
      expect(String(error)).not.toMatch(/private-path|credential|payload/);
    });
  }
});
