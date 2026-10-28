import fs from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { multiSessionFixture } from "../tunnel/support/multi-session-fixture.js";
import { CeEndpointHost } from "../../src/host/endpoint-host.js";
import { initializeStore, openStore } from "../../src/storage/store.js";
import { readCurrentOwnership, readSessionBindings } from "../../src/storage/ownership.js";
import { readParticipantByEndpoint } from "../../src/storage/participant.js";

const qualificationChildren = [...new Set(["A", "B", "C", "D", "E", "F", "G"].map((label) => process.env[`CE_TEST_NODE_${label}`])
  .filter((path): path is string => typeof path === "string" && path.length > 0))];
if (qualificationChildren.length === 0) qualificationChildren.push(process.execPath);

it.each(qualificationChildren)("actual MCP child %s intersects loaded/current grants, retains B/shared reception, denies invalid policy on all tools", { timeout: 30_000 }, async (childNode) => {
  const f = await multiSessionFixture();
  await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/B", runtimeSessionId: "real-B", payloadRead: true, ack: true } });
  const loaded = f.selected();
  const store = initializeStore({ directory: loaded.config.store.directory, filename: loaded.config.store.file });
  const pi = new CeEndpointHost(store, { adapter: "pi", allowlist: [{ endpointId: "pi/A" }, { endpointId: "pi/B" }], recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }], exchangeNamespace: loaded.config.exchange.namespace, exchangeIdempotencyKey: loaded.config.exchange.idempotencyKey, leaseTtlSeconds: 300, payloadRead: { enabled: true }, ack: { enabled: true } });
  pi.beginSession("pi/A"); pi.beginSession("pi/B");
  const transport = new StdioClientTransport({ command: childNode, args: [resolve("dist/bin/mcp-stdio.js"), "--config", loaded.bindingPath], stderr: "pipe" });
  let diagnostics = ""; transport.stderr?.on("data", (b) => { diagnostics += String(b); });
  const client = new Client({ name: "multi-session-fixture", version: "1" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["ping", "ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack"]);
    expect((await client.callTool({ name: "ping", arguments: {} })).isError).not.toBe(true);
    const send = (to: string, key: string) => client.callTool({ name: "ce_send", arguments: { to, text: "synthetic-chatgpt-text", idempotencyKey: key } });
    const a = await send("pi/A", "a"); const b = await send("pi/B", "b");
    expect(a.isError).not.toBe(true); expect(b.isError).not.toBe(true);
    const aId = (a.structuredContent as { messageId: string }).messageId;
    const bId = (b.structuredContent as { messageId: string }).messageId;
    expect(pi.readPayload("pi/A", { messageId: aId }).payloadText).toBe("synthetic-chatgpt-text");
    expect(() => pi.readPayload("pi/A", { messageId: bId })).toThrow();
    const bMeta = pi.readPayload("pi/B", { messageId: bId });
    expect(() => pi.acknowledge("pi/A", { messageId: bId, payloadDigest: bMeta.payloadDigest, payloadLength: bMeta.payloadLength, messageCreatedAuditSequence: bMeta.auditSequence })).toThrow();
    const replyA = pi.send("pi/A", { to: "chatgpt/main", text: "synthetic-A-reply", idempotencyKey: "ra" });
    const replyB = pi.send("pi/B", { to: "chatgpt/main", text: "synthetic-B-reply", idempotencyKey: "rb" });
    await f.api.register({ expectedRevision: f.api.revision(), registration: { endpointId: "pi/C", runtimeSessionId: "real-C", payloadRead: true, ack: true } });
    expect((await send("pi/C", "c")).isError).toBe(true); // no implicit acquisition
    await f.api.revoke({ expectedRevision: f.api.revision(), endpointId: "pi/A" });
    expect((await send("pi/A", "a-revoked")).isError).toBe(true);
    expect((await send("pi/B", "b-survives")).isError).not.toBe(true);
    const inbox = await client.callTool({ name: "ce_inbox_list", arguments: {} });
    expect(inbox.isError).not.toBe(true);
    expect(JSON.stringify(inbox)).toContain(replyA.messageId); expect(JSON.stringify(inbox)).toContain(replyB.messageId);
    // Shared chatgpt/main inbox is explicitly retained, including reception from A.
    let lastAck: { messageId: string; payloadDigest: string; payloadLength: number; messageCreatedAuditSequence: number } | undefined;
    for (const reply of [replyA, replyB]) {
      const read = await client.callTool({ name: "ce_read_payload", arguments: { messageId: reply.messageId } });
      expect(read.isError).not.toBe(true);
      const metadata = JSON.parse((read.content as { text: string }[])[0]!.text.match(/of (\{.*\})\. It/)![1]!) as { payloadDigest: string; payloadLength: number; auditSequence: number };
      lastAck = { messageId: reply.messageId, payloadDigest: metadata.payloadDigest, payloadLength: metadata.payloadLength, messageCreatedAuditSequence: metadata.auditSequence };
      const ack = await client.callTool({ name: "ce_ack", arguments: lastAck });
      expect(ack.isError).not.toBe(true);
      expect(JSON.stringify(ack)).toContain("delivery_ack");
    }
    f.narrowGlobal(false, false);
    expect((await client.callTool({ name: "ce_read_payload", arguments: { messageId: replyB.messageId } })).isError).toBe(true);
    expect((await client.callTool({ name: "ce_ack", arguments: lastAck! })).isError).toBe(true);
    expect((await client.callTool({ name: "ce_inbox_list", arguments: {} })).isError).not.toBe(true);
    fs.writeFileSync(f.profilePath, "partially-written-profile");
    await expect(client.listTools()).rejects.toMatchObject({ code: -32603 });
    await expect(client.callTool({ name: "ping", arguments: {} })).rejects.toMatchObject({ code: -32603 });
    for (const name of ["ce_send", "ce_inbox_list", "ce_read_payload", "ce_ack"]) await expect(client.callTool({ name, arguments: {} })).rejects.toMatchObject({ code: -32603 });
    await client.close();
    // Invalid policy must NOT deny CE cleanup on EOF/SIGTERM.
    for (let i = 0; i < 100 && !diagnostics.includes("CE_MCP_STOPPED"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(diagnostics).toContain("CE_MCP_STOPPED released=true detached=true");
    const check = openStore({ directory: loaded.config.store.directory, filename: loaded.config.store.file });
    try {
      const participant = readParticipantByEndpoint(check, "chatgpt", "chatgpt/main")!;
      expect(readCurrentOwnership(check, participant.participantId)).toBeUndefined();
      expect(readSessionBindings(check, participant.participantId)).toEqual([]);
    } finally { check.close(); }
  } finally {
    await client.close(); await transport.close();
    pi.end("pi/A"); pi.end("pi/B"); store.close(); f.cleanup();
  }
});
