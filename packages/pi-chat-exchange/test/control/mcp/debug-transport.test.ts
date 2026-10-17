import { expect, it } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { observeTransport } from "../../../src/control/mcp/debug-transport.js";

it("preserves send/receive extras, identity, exceptions and logs only after send succeeds", async () => {
  const events: unknown[] = []; const received: unknown[] = [];
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { SECRET: "CANARY" } } as const;
  const extra = { requestInfo: { headers: { authorization: "CANARY" } } };
  let sent: unknown;
  const raw: Transport = {
    start: async () => { raw.onmessage?.(init, extra); },
    send: async (frame, opts) => { sent = [frame, opts]; }, close: async () => {},
  };
  const observed = observeTransport(raw, (_component, event, context) => events.push([event, context]));
  expect(observed).toBe(raw);
  observed.onmessage = (frame, info) => received.push([frame, info]);
  await observed.start();
  expect(received).toEqual([[init, extra]]);
  const reply = { jsonrpc: "2.0", id: 1, result: { SECRET: "CANARY" } } as const;
  const opts = { relatedRequestId: 1 };
  await observed.send(reply, opts);
  expect(sent).toEqual([reply, opts]);
  expect(JSON.stringify(events)).not.toContain("CANARY");
  expect(JSON.stringify(events)).toContain("MCP_INITIALIZE");
  expect(JSON.stringify(events)).toContain("MCP_RESPONSE_SENT");
});
it("does not claim response sent when underlying send rejects", async () => {
  const events: string[] = []; const failure = new Error("CANARY");
  const raw: Transport = { start: async () => {}, close: async () => {}, send: async () => { throw failure; } };
  observeTransport(raw, (_component, event) => events.push(event));
  await expect(raw.send({ jsonrpc: "2.0", id: 1, result: {} })).rejects.toBe(failure);
  expect(events).not.toContain("MCP_RESPONSE_SENT");
  expect(events).toContain("MCP_ERROR");
});
it("does not treat inherited Object names as protocol event aliases", async () => {
  const events: unknown[] = [];
  const raw: Transport = { start: async () => { raw.onmessage?.({ jsonrpc: "2.0", id: 1, method: "toString" }); }, close: async () => {}, send: async () => {} };
  observeTransport(raw, (_component, event) => events.push(event));
  await raw.start();
  expect(events).toEqual(["MCP_REQUEST_RECEIVED"]);
});
