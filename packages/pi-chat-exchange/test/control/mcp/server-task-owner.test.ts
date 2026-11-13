import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { createExchangeMcpServer, type MessagingServerBinding } from "../../../src/control/mcp/server.js";

const MESSAGE_ID = "msg_01M73NE8XRRBED0ER5QA9RF9JV";
const registration = { schemaVersion: 1 as const, exchangeId: "exchange-1", requestMessageId: "msg_01M73NE8XRRBED0ER5QA9RF9JW",
  messageId: MESSAGE_ID, from: "pi/session-a", to: "chatgpt/main", projectLabel: "Project A", taskOwner: "pi/session-a",
  ownerStatus: "REGISTERED" as const, probeId: "123e4567-e89b-42d3-a456-426614174000" };

function binding(extra: Partial<MessagingServerBinding> = {}): MessagingServerBinding {
  return { port: { send: () => { throw new Error("messaging port must not run"); } } as never, ...extra };
}

async function connected(server: ReturnType<typeof createExchangeMcpServer>) {
  const client = new Client({ name: "task-owner-test", version: "1" }); const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]); return client;
}

it("advertises and serves TaskOwner only when the trusted port is injected", async () => {
  const absentServer = createExchangeMcpServer("test", binding()); const absent = await connected(absentServer);
  try {
    expect((await absent.listTools()).tools.map(tool => tool.name)).not.toContain("ce_task_owner");
    await expect(absent.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).rejects.toMatchObject({ code: -32601 });
  } finally { await absent.close(); await absentServer.close(); }

  const presentServer = createExchangeMcpServer("test", binding({ taskOwner: { lookup: () => registration } })); const present = await connected(presentServer);
  try {
    expect((await present.listTools()).tools.map(tool => tool.name)).toContain("ce_task_owner");
    expect((await present.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).structuredContent).toEqual(registration);
  } finally { await present.close(); await presentServer.close(); }
});

it("runs general and TaskOwner admission freshly before every registry lookup", async () => {
  let generalDenied = false; let ownerDenied = false; let generalChecks = 0; let ownerChecks = 0; let lookups = 0;
  const server = createExchangeMcpServer("test", binding({
    admission: () => { generalChecks++; if (generalDenied) throw new Error("general secret"); },
    taskOwnerAdmission: () => { ownerChecks++; if (ownerDenied) throw new Error("owner secret"); },
    taskOwner: { lookup: () => { lookups++; return registration; } },
  }));
  const client = await connected(server);
  try {
    await client.listTools();
    expect((await client.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).structuredContent).toEqual(registration);
    ownerDenied = true;
    await expect(client.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).rejects.toMatchObject({ code: -32603 });
    expect(lookups).toBe(1);
    ownerDenied = false; generalDenied = true;
    await expect(client.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).rejects.toMatchObject({ code: -32603 });
    expect(lookups).toBe(1); expect(generalChecks).toBe(4); expect(ownerChecks).toBe(2);
  } finally { await client.close(); await server.close(); }
});

it("blocks TaskOwner at the unified execution guard before admission or lookup", async () => {
  let checks = 0; let lookups = 0;
  const server = createExchangeMcpServer("test", binding({ executionGuard: { enabled: true },
    taskOwnerAdmission: () => { checks++; }, taskOwner: { lookup: () => { lookups++; return registration; } } }));
  const client = await connected(server);
  try {
    await expect(client.callTool({ name: "ce_task_owner", arguments: { messageId: MESSAGE_ID } })).rejects.toMatchObject({ code: -32603 });
    expect(checks).toBe(0); expect(lookups).toBe(0);
  } finally { await client.close(); await server.close(); }
});
