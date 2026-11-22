import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { callSessionPairing } from "../../../src/control/mcp/session-pairing.js";
import { createExchangeMcpServer, type MessagingServerBinding } from "../../../src/control/mcp/server.js";

const token = `ce_pair_${Buffer.alloc(24, 9).toString("base64url")}`;
const base = (): MessagingServerBinding => ({ port: {} as never });

async function connected(binding: MessagingServerBinding, check: (client: Client) => Promise<void>) {
  const server = createExchangeMcpServer("test", binding);
  const client = new Client({ name: "pairing-test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  try { await check(client); } finally { await client.close(); await server.close(); }
}

describe("CE MCP session pairing", () => {
  it("defaults the sender and returns a bounded acceptance", () => {
    const redeem = vi.fn(() => ({ status: "accepted" as const, from: "chatgpt/main", expiresAt: 300_000 }));
    const result = callSessionPairing({ redeem }, { token });
    expect(redeem).toHaveBeenCalledWith(token, undefined);
    expect(result).toMatchObject({ isError: false, structuredContent: { status: "PAIRING_ACCEPTED", from: "chatgpt/main", expiresAt: 300_000 } });
    expect(result.content).toEqual([{ type: "text", text: "Pairing accepted. Return to Pi and run:\n\n```text\n/ce pair complete\n```" }]);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("accepts an explicit sender and rejects extra or malformed arguments", () => {
    const redeem = vi.fn(() => ({ status: "accepted" as const, from: "chatgpt/work", expiresAt: 300_000 }));
    expect(callSessionPairing({ redeem }, { token, from: "chatgpt/work" }).isError).toBe(false);
    expect(redeem).toHaveBeenCalledWith(token, "chatgpt/work");
    for (const args of [{ token, from: "bad sender" }, { token, session: "private" }, { token: "bad" }]) {
      expect(() => callSessionPairing({ redeem }, args)).toThrow();
    }
  });

  it("sanitizes redemption refusals", () => {
    const result = callSessionPairing({ redeem: () => ({ status: "refused", reason: "PAIRING_EXPIRED" }) }, { token });
    expect(result).toEqual({ content: [{ type: "text", text: "Pairing code expired or unavailable. Generate a new code in Pi with /ce pair." }], isError: true });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("advertises ce_pair only when a live pairing port is composed", async () => {
    await connected(base(), async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("ce_pair");
      await expect(client.callTool({ name: "ce_pair", arguments: { token } })).rejects.toMatchObject({ code: -32601 });
    });
    await connected({ ...base(), pairing: { redeem: () => ({ status: "accepted", from: "chatgpt/main", expiresAt: 300_000 }) } }, async client => {
      const tools = (await client.listTools()).tools;
      expect(tools.map(tool => tool.name)).toContain("ce_pair");
      expect(tools.find(tool => tool.name === "ce_pair")?.description).toContain("/ce pair");
      const result = await client.callTool({ name: "ce_pair", arguments: { token } });
      expect(result.structuredContent).toMatchObject({ status: "PAIRING_ACCEPTED", from: "chatgpt/main" });
    });
  });
});
