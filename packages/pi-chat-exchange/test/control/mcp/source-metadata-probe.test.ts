import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import { createSourceMetadataProbe, type SourceMetadataObservation } from "../../../src/control/mcp/source-metadata-probe.js";

it("exposes SDK metadata only to an explicitly injected probe after valid ping admission", async () => {
  const seen: unknown[] = [];
  const server = createExchangeMcpServer("metadata-test", undefined, metadata => { seen.push(metadata); });
  const client = new Client({ name: "metadata-test", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["ping"]);
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    await expect(client.callTool({ name: "ping", arguments: { bad: 1 } })).rejects.toMatchObject({ code: -32602 });
    expect(seen).toHaveLength(0);
    const result = await client.callTool({ name: "ping", arguments: {}, _meta: { "openai/session": "SYNTHETIC_SESSION_CANARY" } });
    expect(seen).toEqual([{ "openai/session": "SYNTHETIC_SESSION_CANARY" }]);
    expect(result.structuredContent).toEqual({ service: "pi-chat-exchange", protocolVersion: 1, host: "metadata-test", status: "reachable" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_SESSION_CANARY");
  } finally { await client.close(); await server.close(); }
});

const SCOPE = "a".repeat(64);
const SESSION = "PRIVATE_SESSION_CANARY";

function armed() {
  const observations: SourceMetadataObservation[] = [];
  const probe = createSourceMetadataProbe(SCOPE, SCOPE, row => observations.push(row));
  expect(probe).toBeTypeOf("function");
  return { probe: probe!, observations };
}

it("is disabled by default and rejects an unrelated or malformed launch scope", () => {
  expect(createSourceMetadataProbe(SCOPE)).toBeUndefined();
  expect(createSourceMetadataProbe(SCOPE, "b".repeat(64))).toBeUndefined();
  expect(createSourceMetadataProbe("not-a-digest", "not-a-digest")).toBeUndefined();
});

it.each([
  [undefined, { present: false, type: "missing" }],
  [{}, { present: false, type: "missing" }],
  [null, { present: false, type: "invalid-metadata" }],
  [[], { present: false, type: "invalid-metadata" }],
  ["RAW_META_CANARY", { present: false, type: "invalid-metadata" }],
  [{ "openai/session": null }, { present: true, type: "null" }],
  [{ "openai/session": 5 }, { present: true, type: "number" }],
  [{ "openai/session": false }, { present: true, type: "boolean" }],
  [{ "openai/session": [] }, { present: true, type: "array" }],
  [{ "openai/session": {} }, { present: true, type: "object" }],
  [{ "openai/session": "" }, { present: true, type: "string" }],
  [{ "openai/session": "x".repeat(4097) }, { present: true, type: "string" }],
])("projects missing and malformed metadata without leaking values (%j)", (metadata, expected) => {
  const { probe, observations } = armed();
  expect(() => probe(metadata)).not.toThrow();
  expect(observations).toEqual([{ event: "SOURCE_METADATA_OBSERVATION", ...expected }]);
});

it("logs only a projection and private keyed digest, once even after logging failure", () => {
  const { probe, observations } = armed();
  probe({ "openai/session": SESSION, headers: "HEADER_CANARY", token: "TOKEN_CANARY", payload: "PAYLOAD_CANARY" });
  probe({ "openai/session": "SECOND_CANARY" });
  expect(observations).toHaveLength(1);
  expect(Object.keys(observations[0]!).sort()).toEqual(["digest", "event", "present", "type"]);
  expect(observations[0]).toMatchObject({ present: true, type: "string", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(JSON.stringify(observations)).not.toMatch(/CANARY|headers|token|payload/);
  const other = armed(); other.probe({ "openai/session": SESSION });
  expect(other.observations[0]!.digest).not.toBe(observations[0]!.digest);
  let calls = 0;
  const failing = createSourceMetadataProbe(SCOPE, SCOPE, () => { calls++; throw new Error("SINK_CANARY"); })!;
  expect(() => failing({ "openai/session": SESSION })).not.toThrow();
  failing({ "openai/session": SESSION });
  expect(calls).toBe(1);
});

it("does not execute metadata accessors or accept inherited values", () => {
  let reads = 0;
  const metadata = Object.defineProperty({}, "openai/session", { get() { reads++; throw new Error("GETTER_CANARY"); } });
  const first = armed(); first.probe(metadata);
  expect(reads).toBe(0);
  expect(first.observations[0]).toMatchObject({ present: true, type: "accessor" });
  const second = armed(); second.probe(Object.create({ "openai/session": SESSION }));
  expect(second.observations[0]).toMatchObject({ present: false, type: "missing" });
  const third = armed(); third.probe(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PROXY_CANARY"); } }));
  expect(third.observations[0]).toMatchObject({ present: false, type: "unreadable" });
});

it("observes at most one admitted valid ping via the actual SDK without changing results", async () => {
  const { probe, observations } = armed();
  const server = createExchangeMcpServer("metadata-test", undefined, probe);
  const client = new Client({ name: "metadata-test", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    await expect(client.callTool({ name: "ping", arguments: { bad: SESSION } })).rejects.toMatchObject({ code: -32602 });
    expect(observations).toHaveLength(0);
    const first = await client.callTool({ name: "ping", arguments: {}, _meta: { "openai/session": SESSION } });
    const second = await client.callTool({ name: "ping", arguments: {} });
    expect(first.structuredContent).toEqual(second.structuredContent);
    expect(JSON.stringify(first)).not.toContain(SESSION);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({ present: true, type: "string" });
    expect(JSON.stringify(observations)).not.toContain(SESSION);
  } finally { await client.close(); await server.close(); }
});

it.each(["execution-guard", "admission"])("does not sample ping rejected by %s", async mode => {
  const { probe, observations } = armed();
  const notCalled = () => { throw new Error("synthetic business port must not run"); };
  const server = createExchangeMcpServer("metadata-test", {
    port: { send: notCalled, listInbox: notCalled, readPayload: notCalled, acknowledge: notCalled },
    ...(mode === "execution-guard" ? { executionGuard: { enabled: true } } : { admission: notCalled }),
  }, probe);
  const client = new Client({ name: "metadata-test", version: "0.0.1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    await expect(client.callTool({ name: "ping", arguments: {}, _meta: { "openai/session": SESSION } })).rejects.toMatchObject({ code: -32603 });
    expect(observations).toHaveLength(0);
  } finally { await client.close(); await server.close(); }
});
