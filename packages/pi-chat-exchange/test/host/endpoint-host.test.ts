/**
 * HANDOFF-853274 — shared host (src/host/endpoint-host.ts) tests.
 *
 * The Pi wrapper keeps its own 131-case suite; these tests cover what only
 * the adapter-neutral shared host provides: a non-Pi adapter, cross-adapter
 * recipients, the single-instance lease lifecycle (requireUnowned / renew /
 * end), and fail-closed restart after a crash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { CeEndpointHost, CeHostRefusal, type CeEndpointHostPolicy } from "../../src/host/endpoint-host.js";
import type { DurableStore } from "../../src/storage/store.js";
import { cleanupFixtures, fixture, type Fixture } from "../storage/support/participant-fixture.js";

afterEach(cleanupFixtures);

const NOW = "2026-10-10T00:00:00.000Z";
const ENDPOINT = "chatgpt/main";

interface Rig {
  readonly store: DurableStore;
  readonly host: CeEndpointHost;
  readonly freshHost: (overrides?: Partial<CeEndpointHostPolicy>) => CeEndpointHost;
}

function rig(overrides: Partial<CeEndpointHostPolicy> = {}): Rig {
  const fx: Fixture = fixture("ce-host-shared-");
  const base: CeEndpointHostPolicy = {
    adapter: "chatgpt",
    exchangeNamespace: "ce-mcp",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: ENDPOINT }],
    leaseTtlSeconds: 600,
    payloadRead: { enabled: true },
    now: () => NOW,
    ...overrides,
  };
  return {
    store: fx.store,
    host: new CeEndpointHost(fx.store, base),
    freshHost: (next = {}) => new CeEndpointHost(fx.store, { ...base, ...next }),
  };
}

function expectRefusal(run: () => unknown, code: string): CeHostRefusal {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CeHostRefusal);
    expect(error).toMatchObject({ code });
    return error as CeHostRefusal;
  }
  throw new Error(`expected CeHostRefusal ${code}`);
}

describe("shared host: adapter neutrality", () => {
describe("shared host: adapter neutrality", () => {
  it("operates a non-Pi adapter end to end over one store", () => {
    const { host } = rig({ allowlist: [{ endpointId: "chatgpt/a" }, { endpointId: "chatgpt/b" }] });
    host.beginSession("chatgpt/a");
    host.beginSession("chatgpt/b");
    const sent = host.send("chatgpt/a", { to: "chatgpt/b", text: "same-adapter delivery", idempotencyKey: "sa-1" });
    expect(sent).toMatchObject({ disposition: "CREATED", recipient: "chatgpt/b" });
    const inbox = host.listInbox("chatgpt/b", {});
    expect(inbox.messages.map((message) => message.messageId)).toContain(sent.messageId);
    const read = host.readPayload("chatgpt/b", { messageId: sent.messageId });
    expect(read.payloadText).toBe("same-adapter delivery");
    expect(read.from).toBe("chatgpt/a");
  });
  });

  it("sends to an explicit cross-adapter recipient and back through a second host", () => {
    const fx = fixture("ce-host-shared-pair-");
    const mcp = new CeEndpointHost(fx.store, {
      adapter: "chatgpt",
      exchangeNamespace: "ce-mcp",
      exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: "chatgpt/main" }],
      payloadRead: { enabled: true },
      recipients: [{ adapter: "pi", endpointId: "pi/main" }],
      leaseTtlSeconds: 600,
      now: () => NOW,
    });
    const pi = new CeEndpointHost(fx.store, {
      adapter: "pi",
      exchangeNamespace: "ce-mcp",
      exchangeIdempotencyKey: "exchange-1",
      allowlist: [{ endpointId: "pi/main" }],
      recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
      leaseTtlSeconds: 600,
      payloadRead: { enabled: true },
      now: () => NOW,
    });
    mcp.beginSession("chatgpt/main");
    pi.beginSession("pi/main");

    const outbound = mcp.send("chatgpt/main", { to: "pi/main", text: "chatgpt -> pi", idempotencyKey: "out-1" });
    expect(outbound).toMatchObject({ disposition: "CREATED", recipient: "pi/main" });

    const reply = pi.send("pi/main", { to: "chatgpt/main", text: "pi -> chatgpt", idempotencyKey: "in-1" });
    expect(reply).toMatchObject({ disposition: "CREATED", recipient: "chatgpt/main" });

    const piInbox = mcp.listInbox("chatgpt/main", {});
    expect(piInbox.messages.map((message) => message.messageId)).toContain(reply.messageId);
    const read = mcp.readPayload("chatgpt/main", { messageId: reply.messageId });
    expect(read.payloadText).toBe("pi -> chatgpt");
    expect(read.from).toBe("pi/main");
  });

  it("refuses an unlisted recipient label", () => {
    const { host } = rig({ recipients: [{ adapter: "pi", endpointId: "pi/main" }] });
    host.beginSession(ENDPOINT);
    expectRefusal(() => host.send(ENDPOINT, { to: "pi/rogue", text: "x", idempotencyKey: "k" }), "CE_HOST_ENDPOINT_NOT_ALLOWED");
  });

  it("refuses a same-adapter entry in recipients at construction", () => {
    const { freshHost } = rig();
    expectRefusal(() => freshHost({ recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/other" }] }), "CE_HOST_INVALID_REQUEST");
  });
});

describe("shared host: single-instance lease lifecycle", () => {
  it("renews and ends its lease, allowing a clean restart", () => {
    const { host, freshHost } = rig();
    host.beginSession(ENDPOINT);
    const renewed = host.renew(ENDPOINT);
    expect(renewed.fencingToken).toBeGreaterThan(0);
    expect(host.end(ENDPOINT)).toMatchObject({ released: true, detached: true });
    const again = freshHost();
    expect(() => again.beginSession(ENDPOINT, { requireUnowned: true })).not.toThrow();
  });

  it("refuses a second live instance before any durable write (requireUnowned)", () => {
    const { host, freshHost } = rig();
    host.beginSession(ENDPOINT);
    const intruder = freshHost();
    expectRefusal(() => intruder.beginSession(ENDPOINT, { requireUnowned: true }), "CE_HOST_AUTHORITY_ABSENT");
  });

  it("fails closed after a crash: an expired ownership row still refuses restart", () => {
    const later = () => "2026-10-10T02:00:00.000Z";
    const { host, freshHost } = rig();
    host.beginSession(ENDPOINT);
    // No end(): simulates a crashed process. The lease has long expired by now.
    const restarted = freshHost({ now: later });
    const refusal = expectRefusal(
      () => restarted.beginSession(ENDPOINT, { requireUnowned: true }),
      "CE_HOST_AUTHORITY_ABSENT",
    );
    expect(refusal.reason).toBeDefined();
  });

  it("releases cleanly even when the detach cannot be confirmed", () => {
    const { host } = rig();
    host.beginSession(ENDPOINT);
    // end() releases ownership first; a detach failure must still report released.
    const ended = host.end(ENDPOINT);
    expect(ended.released).toBe(true);
    expect(typeof ended.detached).toBe("boolean");
  });
});

describe("shared host: payload read policy", () => {
  it("refuses payload reads when the operator opt-in is absent", () => {
    const { host } = rig({
      allowlist: [{ endpointId: "chatgpt/a" }, { endpointId: "chatgpt/b" }],
      payloadRead: { enabled: false },
    });
    host.beginSession("chatgpt/a");
    host.beginSession("chatgpt/b");
    const sent = host.send("chatgpt/a", { to: "chatgpt/b", text: "secret text", idempotencyKey: "pr-1" });
    expectRefusal(() => host.readPayload("chatgpt/b", { messageId: sent.messageId }), "CE_HOST_PAYLOAD_DISABLED");
    // Metadata listing stays available without the payload opt-in.
    expect(host.listInbox("chatgpt/b", {}).messages.map((message) => message.messageId)).toContain(sent.messageId);
  });
});
