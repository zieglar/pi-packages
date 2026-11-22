import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createExchangeMcpServer } from "../../../src/control/mcp/server.js";
import { createSourceMetadataProbe, type SourceMetadataObservation } from "../../../src/control/mcp/source-metadata-probe.js";

const SCOPE = "a".repeat(64);
const SESSION = "PRIVATE_SESSION_CANARY";

function armed() {
  const observations: SourceMetadataObservation[] = [];
  const probe = createSourceMetadataProbe(SCOPE, SCOPE, row => observations.push(row));
  expect(probe).toBeTypeOf("function");
  return { probe: probe!, observations };
}

describe("one-use source metadata probe", () => {
  it("is disabled by default and rejects a different or malformed launch scope", () => {
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
    [{ "openai/session": "" }, { present: true, type: "string" }],
    [{ "openai/session": "x".repeat(4097) }, { present: true, type: "string" }],
  ])("projects missing and malformed metadata without throwing (%j)", (metadata, expected) => {
    const { probe, observations } = armed();
    expect(() => probe(metadata)).not.toThrow();
    expect(observations).toEqual([{ event: "SOURCE_METADATA_OBSERVATION", ...expected }]);
  });

  it("logs only the projection and a scoped irreversible digest, never other metadata", () => {
    const { probe, observations } = armed();
    probe({ "openai/session": SESSION, headers: "HEADER_CANARY", token: "TOKEN_CANARY", payload: "PAYLOAD_CANARY" });
    expect(observations).toHaveLength(1);
    expect(Object.keys(observations[0]!).sort()).toEqual(["digest", "event", "present", "type"]);
    expect(observations[0]).toMatchObject({ present: true, type: "string", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(observations)).not.toMatch(/CANARY|headers|token|payload/);
    const second = armed();
    second.probe({ "openai/session": SESSION });
    expect(second.observations[0]!.digest).not.toBe(observations[0]!.digest);
  });

  it("consumes one observation even if the metadata is missing or the sink fails", () => {
    const { probe, observations } = armed();
    probe(undefined);
    probe({ "openai/session": SESSION });
    expect(observations).toHaveLength(1);
    let calls = 0;
    const failing = createSourceMetadataProbe(SCOPE, SCOPE, () => { calls++; throw new Error("SINK_CANARY"); })!;
    expect(() => failing({ "openai/session": SESSION })).not.toThrow();
    failing({ "openai/session": SESSION });
    expect(calls).toBe(1);
  });

  it("does not execute metadata accessors or count inherited properties", () => {
    let reads = 0;
    const metadata = Object.defineProperty({}, "openai/session", { get() { reads++; throw new Error("GETTER_CANARY"); } });
    const first = armed();
    expect(() => first.probe(metadata)).not.toThrow();
    expect(reads).toBe(0);
    expect(first.observations[0]).toMatchObject({ present: true, type: "accessor" });
    const second = armed();
    second.probe(Object.create({ "openai/session": SESSION }));
    expect(second.observations[0]).toMatchObject({ present: false, type: "missing" });
  });

  it("observes SDK metadata only on one admitted valid ping without changing the response", async () => {
    const { probe, observations } = armed();
    const server = createExchangeMcpServer("probe-test", undefined, probe);
    const client = new Client({ name: "probe-test", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toMatchObject({ code: -32601 });
      await expect(client.callTool({ name: "ping", arguments: { bad: SESSION } })).rejects.toMatchObject({ code: -32602 });
      expect(observations).toHaveLength(0);
      const first = await client.callTool({ name: "ping", arguments: {}, _meta: { "openai/session": SESSION } });
      const second = await client.callTool({ name: "ping", arguments: {} });
      expect(first.structuredContent).toEqual({ service: "pi-chat-exchange", protocolVersion: 1, host: "probe-test", status: "reachable" });
      expect(second.structuredContent).toEqual(first.structuredContent);
      expect(JSON.stringify(first)).not.toContain(SESSION);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({ present: true, type: "string" });
    } finally { await client.close(); await server.close(); }
  });

  it.each(["execution-guard", "admission"])("does not sample a ping rejected by %s", async mode => {
    const { probe, observations } = armed();
    const notCalled = () => { throw new Error("business port must not run"); };
    const server = createExchangeMcpServer("probe-test", {
      port: { send: notCalled, listInbox: notCalled, readPayload: notCalled, acknowledge: notCalled },
      ...(mode === "execution-guard" ? { executionGuard: { enabled: true } } : { admission: notCalled }),
    }, probe);
    const client = new Client({ name: "probe-test", version: "0.0.1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(st), client.connect(ct)]);
      await expect(client.callTool({ name: "ping", arguments: {}, _meta: { "openai/session": SESSION } })).rejects.toMatchObject({ code: -32603 });
      expect(observations).toHaveLength(0);
    } finally { await client.close(); await server.close(); }
  });
});
