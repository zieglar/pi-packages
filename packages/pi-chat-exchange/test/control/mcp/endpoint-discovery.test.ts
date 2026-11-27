import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer, type MessagingServerBinding } from "../../../src/control/mcp/server.js";

import { callEndpointDiscovery } from "../../../src/control/mcp/endpoint-discovery.js";
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

it("accepts only a bounded explicit Runtime scope and passes it without a Session ID", async () => {
  const calls: unknown[] = [];
  const port = { discover(previous?: string, runtimeId?: string) { calls.push([previous, runtimeId]);
    return { ...projection(), runtimes: [{ runtimeId: "workbench" }], currentBinding: { status: "unknown" as const, runtimeId: runtimeId! } }; } };
  expect(callEndpointDiscovery(port, { runtimeId: "workbench" }).structuredContent).toMatchObject({ currentBinding: { status: "unknown", runtimeId: "workbench" } });
  expect(calls).toEqual([[undefined, "workbench"]]);
  for (const runtimeId of ["", "../auth", "bad scope", "x".repeat(129)]) expect(() => callEndpointDiscovery(port, { runtimeId })).toThrow();
  expect(calls).toHaveLength(1);
});

it("advertises a connector-compatible Runtime binding query and sends to its discovered target", async () => {
  const queries: unknown[] = [];
  const sends: unknown[] = [];
  const target = projection().targets[0]!;
  await connected({
    port: {
      send(input: unknown) { sends.push(input); return { disposition: "CREATED" as const, messageId: "msg_01M7J3HPF0JSAHQWN2AHGA52C8", auditSequence: 1, recipient: target.endpointId }; },
    } as never,
    discovery: {
      discover(...args: unknown[]) {
        queries.push(args);
        return {
          ...projection(),
          targets: [target],
          runtimeSelection: { scope: "ce-endpoint" as const, status: "bound" as const, revision: "b".repeat(64), runtimeId: "runtime-current" },
          currentBinding: { status: "verified" as const, runtimeId: "runtime-current", endpointId: target.endpointId,
            source: "pi.runtime.lifecycle" as const, observedAt: "2026-11-03T00:00:00.000Z", expiresAt: "2026-11-03T00:01:00.000Z" },
        };
      },
    },
  }, async client => {
    const tool = (await client.listTools()).tools.find(candidate => candidate.name === "ce_endpoints")!;
    expect(tool.inputSchema).not.toHaveProperty("oneOf");

    const discovery = await client.callTool({ name: "ce_endpoints", arguments: { useRuntimeBinding: true } });
    const discoveredTarget = (discovery.structuredContent as EndpointDiscoveryResult).targets[0]!.endpointId;
    expect(discoveredTarget).toBe("B");
    expect(queries).toEqual([[undefined, undefined, true]]);

    const sent = await client.callTool({ name: "ce_send", arguments: {
      to: discoveredTarget, text: "runtime-bound wake", idempotencyKey: "new-chat-no-preknown-endpoint",
    } });
    expect(sent.isError).toBe(false);
    expect(sends).toEqual([{ to: "B", text: "runtime-bound wake", idempotencyKey: "new-chat-no-preknown-endpoint" }]);
  });
});

it("retains delivery mode when resolving the shared selected target", async () => {
  const calls: unknown[] = [];
  const selection = { endpointId: "B", policyId: "p1", generation: 2, runtimeSessionId: "s1", epoch: 3 };
  await connected({
    port: { send(input: unknown, metadata: unknown) { calls.push([input, metadata]); return { disposition: "CREATED" as const, messageId: "msg_1", auditSequence: 1, recipient: "B" }; } } as never,
    selectedTarget: () => selection,
    discovery: { discover: () => ({ ...projection(), targets: [{ ...projection().targets[0]!, active: "true" as const }] }) },
  }, async client => {
    const sent = await client.callTool({ name: "ce_send", arguments: { selectionVersion: 2, text: "hello", idempotencyKey: "k", deliveryMode: "steer" } });
    expect(sent.isError).toBe(false);
    expect(calls).toEqual([[{ to: "B", text: "hello", idempotencyKey: "k", deliveryMode: "steer" },
      { policyId: "p1", selectionVersion: 2, targetRuntimeSessionId: "s1", bindingEpoch: 3 }]]);
  });
});

it("keeps legacy tool order and refuses discovery without an explicit port", async () => {
  for (const binding of [undefined, base(), { ...base(), ackEnabled: true }]) {
    await connected(binding, async client => {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(binding === undefined ? ["ping", "ce_help"] : ["ping", "ce_send", "ce_inbox_list", "ce_read_payload", ...(binding.ackEnabled ? ["ce_ack"] : []), "ce_help"]);
      await expect(client.callTool({ name: "ce_endpoints", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    });
  }
});

it("advertises a closed optional-predecessor query after ACK and returns only validated projection", async () => {
  let calls = 0;
  await connected({ ...base(), ackEnabled: true, discovery: { discover: () => { calls++; return projection(); } } }, async client => {
    const tools = (await client.listTools()).tools;
    expect(tools.map(t => t.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack", "ce_endpoints", "ce_help"]);
    expect(tools.find(t => t.name === "ce_endpoints")?.inputSchema).toMatchObject({ properties: { previousEndpointId: { type: "string", minLength: 1, maxLength: 256 } }, additionalProperties: false });
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
    { ...valid, sessionSwitch: { status: "unknown", previousEndpointId: "pi/A", successorEndpointId: "pi/B" } },
    { ...valid, sessionSwitch: { status: "verified", previousEndpointId: "pi/A", successorEndpointId: "pi/B", source: "guessed-from-time", observedAt: valid.observedAt } },
    { ...valid, sessionSwitch: { status: "verified", previousEndpointId: "pi/A", successorEndpointId: "pi/B", source: "pi.new.lifecycle", observedAt: valid.observedAt, nativeSessionId: "private-id" } },
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

it("accepts an explicit previous Endpoint for /new discovery without selecting a target", async () => {
  const queries: unknown[] = [];
  await connected({ ...base(), discovery: { discover: (...args: unknown[]) => { queries.push(args); return projection(); } } }, async client => {
    const result = await client.callTool({ name: "ce_endpoints", arguments: { previousEndpointId: "pi/old" } });
    expect(result.isError).toBe(false);
    expect(queries).toEqual([["pi/old"]]);
  });
});
