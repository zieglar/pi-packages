import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createExchangeMcpServer, type MessagingServerBinding } from "../../../src/control/mcp/server.js";

it("freshly gates discovery and every tool including ping/unknown without leaking rejection text", async () => {
  let denied = false; let checks = 0; let calls = 0;
  const binding: MessagingServerBinding = {
    port: { send: () => { calls++; throw Error("UNREACHABLE"); } } as never,
    admission: () => { checks++; if (denied) throw Error("/private/profile synthetic-payload credential-value"); },
  };
  const server = createExchangeMcpServer("test-host", binding);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try {
    expect((await client.listTools()).tools).toHaveLength(4);
    expect((await client.callTool({ name: "ping", arguments: {} })).isError).not.toBe(true);
    denied = true;
    for (const call of [() => client.listTools(), () => client.callTool({ name: "ping", arguments: {} }), () => client.callTool({ name: "unknown", arguments: {} }), () => client.callTool({ name: "ce_send", arguments: { to: "pi/A", text: "secret-text", idempotencyKey: "k" } })]) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).toMatchObject({ code: -32603 });
      expect(String(error)).toContain("admission denied");
      for (const privateText of ["/private/profile", "synthetic-payload", "credential-value", "secret-text"]) expect(String(error)).not.toContain(privateText);
    }
    expect(calls).toBe(0); expect(checks).toBe(6);
    denied = false; expect((await client.callTool({ name: "ping", arguments: {} })).isError).not.toBe(true);
  } finally { await client.close(); await server.close(); }
});
