import { expect, it, vi } from "vitest";
import { CeBoundEndpoint } from "../../src/host/bound-endpoint.js";
import { CeHostRefusal, type CeEndpointHost } from "../../src/host/endpoint-host.js";

it("injects fresh admission before begin, every tool and heartbeat, never cleanup", async () => {
  const host = { beginSession: vi.fn(), send: vi.fn(), listInbox: vi.fn(), readPayload: vi.fn(), acknowledge: vi.fn(), renew: vi.fn(), end: vi.fn(() => ({ released: true, detached: true })) };
  let tick = () => {};
  let denied = false;
  const seen: unknown[] = [];
  const admission = (operation: unknown) => { seen.push(operation); if (denied) throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT"); };
  const bound = CeBoundEndpoint.start(host as unknown as CeEndpointHost, "chatgpt/main", { renewIntervalMs: 1, admission, timers: { setInterval: (cb) => { tick = cb; return 1; }, clearInterval: vi.fn() } });
  bound.send({ to: "pi/A", text: "hi", idempotencyKey: "k" });
  bound.listInbox({}); bound.readPayload({ messageId: "m" });
  bound.acknowledge({ messageId: "m", payloadDigest: "d", payloadLength: 1, messageCreatedAuditSequence: 1 });
  tick();
  expect(seen).toEqual([{ kind: "begin" }, { kind: "send", to: "pi/A" }, { kind: "inbox" }, { kind: "readPayload" }, { kind: "ack" }, { kind: "renew" }]);
  denied = true;
  for (const call of [() => bound.listInbox({}), () => bound.readPayload({ messageId: "m" }), () => bound.acknowledge({ messageId: "m", payloadDigest: "d", payloadLength: 1, messageCreatedAuditSequence: 1 }), () => bound.send({ to: "pi/A", text: "hi", idempotencyKey: "k" })]) expect(call).toThrow();
  tick();
  expect(host.renew).toHaveBeenCalledTimes(1);
  expect(host.listInbox).toHaveBeenCalledTimes(1);
  expect(await bound.shutdown()).toMatchObject({ released: true });
  expect(host.end).toHaveBeenCalledTimes(1);
});

it("denies begin before host writes", () => {
  const beginSession = vi.fn();
  expect(() => CeBoundEndpoint.start({ beginSession } as unknown as CeEndpointHost, "x", { renewIntervalMs: 1, admission: () => { throw new CeHostRefusal("CE_HOST_AUTHORITY_ABSENT"); } })).toThrow();
  expect(beginSession).not.toHaveBeenCalled();
});
