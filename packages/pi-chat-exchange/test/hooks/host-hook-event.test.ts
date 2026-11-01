import { afterEach, describe, expect, it } from "vitest";
import { CeEndpointHost, type CeEndpointHostPolicy } from "../../src/host/endpoint-host.js";
import type { CeCommittedMessageEvent } from "../../src/hooks/events.js";
import { cleanupFixtures, fixture } from "../storage/support/participant-fixture.js";

const NOW = "2026-10-10T00:00:00.000Z";
const A = "chatgpt/a";
const B = "pi/main";
const MARKDOWN = "# 标题 🚀\r\n\r\n  indented\ntrailing  \n```ts\nconst x = \"😀\";\n```";

afterEach(cleanupFixtures);

function rig(onMessageCommitted?: (event: CeCommittedMessageEvent) => void) {
  const fx = fixture("ce-hook-host-event-");
  const policy: CeEndpointHostPolicy = {
    adapter: "chatgpt",
    exchangeNamespace: "ce-hooks-test",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: A }],
    recipients: [{ adapter: "pi", endpointId: B }],
    payloadRead: { enabled: true },
    ack: { enabled: true },
    now: () => NOW,
    ...(onMessageCommitted === undefined ? {} : { onMessageCommitted }),
  };
  const host = new CeEndpointHost(fx.store, policy);
  const recipient = new CeEndpointHost(fx.store, {
    adapter: "pi",
    exchangeNamespace: "ce-hooks-test",
    exchangeIdempotencyKey: "exchange-1",
    allowlist: [{ endpointId: B }],
    recipients: [{ adapter: "chatgpt", endpointId: A }],
    payloadRead: { enabled: true },
    ack: { enabled: true },
    now: () => NOW,
  });
  host.beginSession(A);
  recipient.beginSession(B);
  return { fx, host, recipient };
}

describe("ce.message.committed.v1 Host boundary", () => {
  it("emits only after COMMIT with exact endpoint and metadata, never payload or authority", () => {
    const events: CeCommittedMessageEvent[] = [];
    const observed: Array<{ committed: boolean; stored: boolean }> = [];
    const { fx, host, recipient } = rig((event) => {
      events.push(event);
      observed.push({
        committed: fx.store.database.isTransaction === false,
        stored: fx.store.database.prepare("SELECT payload_body FROM message WHERE message_id=?").get(event.messageId) !== undefined,
      });
    });

    const sent = host.send(A, { to: B, text: MARKDOWN, idempotencyKey: "created-1" });
    expect(events).toHaveLength(1);
    expect(observed).toEqual([{ committed: true, stored: true }]);
    const event = events[0]!;
    expect(event).toMatchObject({
      event: "ce.message.committed.v1",
      eventKey: `${event.exchangeId}/${sent.auditSequence}`,
      messageId: sent.messageId,
      sender: { adapter: "chatgpt", endpointId: A },
      recipient: { adapter: "pi", endpointId: B },
      createdAt: NOW,
      payloadLength: new TextEncoder().encode(MARKDOWN).byteLength,
    });
    expect(event.eventId).toMatch(/^evt_[0-9A-Z]{26}$/);
    expect(event.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(event)).not.toContain("标题");
    for (const forbidden of ["payload", "payloadText", "text", "capability", "sessionId", "fencingToken", "correlationId"]) {
      expect(event).not.toHaveProperty(forbidden);
    }

    const read = recipient.readPayload(B, { messageId: sent.messageId });
    expect(read.payloadText).toBe(MARKDOWN);
    const replay = host.send(A, { to: B, text: MARKDOWN, idempotencyKey: "created-1" });
    expect(replay.disposition).toBe("REPLAYED");
    expect(events).toHaveLength(1);
  });

  it("isolates a throwing Hook sink from committed send and independent ACK", () => {
    let called = false;
    const { host, recipient } = rig(() => { called = true; throw new Error("local hook failed"); });
    const sent = host.send(A, { to: B, text: "durable despite hook", idempotencyKey: "created-2" });
    expect(called).toBe(true);
    expect(sent.disposition).toBe("CREATED");
    const read = recipient.readPayload(B, { messageId: sent.messageId });
    expect(read.payloadText).toBe("durable despite hook");
    const ack = recipient.acknowledge(B, {
      messageId: sent.messageId,
      payloadDigest: read.payloadDigest,
      payloadLength: read.payloadLength,
      messageCreatedAuditSequence: read.auditSequence,
    });
    expect(ack.disposition).toBe("CREATED");
  });

  it.each(["rollback", "indeterminate"] as const)("emits nothing for a %s commit", (mode) => {
    const events: CeCommittedMessageEvent[] = [];
    const { fx, host } = rig((event) => events.push(event));
    const exec = fx.store.database.exec.bind(fx.store.database);
    let commitFailed = false;
    fx.store.database.exec = (sql: string) => {
      if (sql.includes("COMMIT")) {
        commitFailed = true;
        throw new Error("injected commit failure");
      }
      if (mode === "indeterminate" && commitFailed && sql.includes("ROLLBACK")) throw new Error("injected rollback failure");
      return exec(sql);
    };
    expect(() => host.send(A, { to: B, text: "must not notify", idempotencyKey: `failed-${mode}` })).toThrow();
    expect(events).toHaveLength(0);
  });
});
