import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createMessage, messageCreatedAuditSequence } from "../../src/storage/creation.js";
import { readMessageMetadata, sendMessage } from "../../src/storage/messaging.js";
import { acquireOwnership, bindSession, detachSession, releaseOwnership } from "../../src/storage/ownership.js";
import { joinExchange, revokeCapability } from "../../src/storage/participant.js";
import { openStore } from "../../src/storage/store.js";
import {
  capabilityFor,
  cleanupFixtures,
  exchange,
  expectRefusal,
  fixture,
  NOW,
  participant,
  privileged,
  reader,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

const SENDER_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
const RECIPIENT_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const AT_SEND = "2026-10-10T00:00:10.000Z";

const senderEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "sender" });
const recipientEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "recipient" });
const payload = new Uint8Array([0, 1, 2, 3, 255]);

afterEach(cleanupFixtures);

interface MessagingWorld {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly senderSend: string;
  readonly recipientRead: string;
}

function messagingWorld(): MessagingWorld {
  const active = fixture("ce-b3-p3a-");
  const exchangeId = exchange(active);
  const senderId = participant(active, senderEndpoint.endpointId).participant.participantId;
  const recipientId = participant(active, recipientEndpoint.endpointId).participant.participantId;

  for (const [participantId, sessionId] of [
    [senderId, SENDER_SESSION],
    [recipientId, RECIPIENT_SESSION],
  ] as const) {
    const attach = capabilityFor(active, participantId, "attach");
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
    acquireOwnership(
      active.store,
      { participantId, sessionId, capability: attach },
      { now: () => NOW },
    );
    const join = capabilityFor(active, participantId, "join");
    joinExchange(
      active.store,
      { exchangeId, participantId, capability: join, idempotencyKey: `join-${participantId}` },
      { now: () => NOW },
    );
  }

  return {
    active,
    exchangeId,
    senderId,
    recipientId,
    senderSend: capabilityFor(active, senderId, "send", { sessionId: SENDER_SESSION }),
    recipientRead: capabilityFor(active, recipientId, "read", { sessionId: RECIPIENT_SESSION }),
  };
}

function sendRequest(w: MessagingWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participantId: w.senderId,
    sessionId: SENDER_SESSION,
    fencingToken: 1,
    capability: w.senderSend,
    message: {
      exchangeId: w.exchangeId,
      from: senderEndpoint,
      to: recipientEndpoint,
      payload,
      idempotencyKey: "message-1",
    },
    ...overrides,
  };
}

function readRequest(w: MessagingWorld, messageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participantId: w.recipientId,
    sessionId: RECIPIENT_SESSION,
    fencingToken: 1,
    capability: w.recipientRead,
    exchangeId: w.exchangeId,
    messageId,
    ...overrides,
  };
}

function insertRawMessageWithoutTrustedApi(
  w: MessagingWorld,
  messageId: string,
  auditDigest?: string,
): void {
  const body = Uint8Array.from([9, 8, 7]);
  const digest = createHash("sha256").update(body).digest("hex");
  const db = privileged(w.active);
  try {
    db.prepare(
      "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, NULL, 1)",
    ).run(
      messageId,
      w.exchangeId,
      JSON.stringify(senderEndpoint),
      JSON.stringify(recipientEndpoint),
      digest,
      body.byteLength,
      body,
      AT_SEND,
    );
    if (auditDigest !== undefined) {
      const maximum = Number(
        db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
      );
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
      ).run(
        "evt_01ARZ3NDEKTSV4RRFFQ69G5FAY",
        w.exchangeId,
        maximum + 1,
        messageId,
        AT_SEND,
        auditDigest,
        body.byteLength,
      );
    }
  } finally {
    db.close();
  }
}

describe("CE-0002 B3-P3A authorized durable messaging", () => {
  it("bounds exact correlation lookup at two rows without weakening validation", () => {
    let preparedSql = "";
    const message = Object.freeze({
      messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      exchangeId: "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      from: senderEndpoint,
      to: recipientEndpoint,
      state: "CREATED" as const,
      payloadDigest: "a".repeat(64),
      payloadLength: 5,
      createdAt: AT_SEND,
      idempotencyKey: "limit-two",
    });
    const tx = {
      exec: () => undefined,
      prepare: (sql: string) => {
        preparedSql = sql;
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: () => [{
            event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            exchange_id: message.exchangeId,
            sequence: "2",
            kind: "message_created",
            subject_id: message.messageId,
            created_at: message.createdAt,
            digest: message.payloadDigest,
            length: "5",
            outcome: null,
            private_revision: "1",
          }],
        };
      },
    } as unknown as Parameters<typeof messageCreatedAuditSequence>[0];

    expect(messageCreatedAuditSequence(tx, message)).toBe(2);
    expect(preparedSql).toMatch(/subject_id=\? LIMIT 2$/);
  });

  it.each([
    ["created_at", { created_at: "2026-10-10T00:00:11.000Z" }],
    ["length", { length: "4" }],
    ["outcome", { outcome: "unexpected" }],
    ["private_revision", { private_revision: "2" }],
    ["sequence", { sequence: "0" }],
  ] as const)("fails closed when exact correlation has invalid %s", (_field, override) => {
    const message = Object.freeze({
      messageId: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      exchangeId: "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      from: senderEndpoint,
      to: recipientEndpoint,
      state: "CREATED" as const,
      payloadDigest: "a".repeat(64),
      payloadLength: 5,
      createdAt: AT_SEND,
      idempotencyKey: "invalid-correlation",
    });
    const row = {
      event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      exchange_id: message.exchangeId,
      sequence: "2",
      kind: "message_created",
      subject_id: message.messageId,
      created_at: message.createdAt,
      digest: message.payloadDigest,
      length: "5",
      outcome: null,
      private_revision: "1",
      ...override,
    };
    const tx = {
      exec: () => undefined,
      prepare: () => ({
        run: () => ({ changes: 0 }),
        get: () => undefined,
        all: () => [row],
      }),
    } as unknown as Parameters<typeof messageCreatedAuditSequence>[0];

    expect(() => messageCreatedAuditSequence(tx, message)).toThrowError(
      expect.objectContaining({ code: "STORAGE_IDEMPOTENCY_CORRUPT" }),
    );
  });

  it("preserves unauthenticated trusted-host B2 createMessage behavior", () => {
    const active = fixture("ce-b3-p3a-b2-");
    const exchangeId = exchange(active);
    const created = createMessage(
      active.store,
      {
        exchangeId,
        from: senderEndpoint,
        to: recipientEndpoint,
        payload,
        idempotencyKey: "trusted-host",
      },
      { now: () => AT_SEND },
    );
    expect(created).toMatchObject({ disposition: "CREATED", message: { exchangeId } });
  });

  it("commits one authorized Message and exposes recipient-only metadata after the join boundary", () => {
    const w = messagingWorld();
    const before = rowCounts(w.active);

    const sent = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
    expect(sent).toMatchObject({
      disposition: "CREATED",
      auditSequence: 4,
      message: {
        exchangeId: w.exchangeId,
        from: senderEndpoint,
        to: recipientEndpoint,
        state: "CREATED",
        payloadLength: payload.byteLength,
        idempotencyKey: "message-1",
      },
    });
    expect(Object.hasOwn(sent.message, "payload")).toBe(false);

    const read = readMessageMetadata(
      w.active.store,
      readRequest(w, sent.message.messageId),
      { now: () => AT_SEND },
    );
    expect(read).toEqual({ message: sent.message, auditSequence: sent.auditSequence });
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.message)).toBe(true);

    expect(rowCounts(w.active)).toMatchObject({
      messages: String(Number(before.messages) + 1),
      records: String(Number(before.records) + 1),
      audits: String(Number(before.audits) + 1),
      cursor: before.cursor,
    });

    const view = reader(w.active);
    try {
      expect(view.prepare("SELECT payload_body FROM message WHERE message_id = ?").get(sent.message.messageId)).toEqual({
        payload_body: payload,
      });
      expect(view.prepare("SELECT count(*) AS n FROM delivery_cursor").get()).toEqual({ n: 0 });
    } finally {
      view.close();
    }
  });

  it("checks exact send authority before a protected idempotency replay", () => {
    const w = messagingWorld();
    const first = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
    const forged = `cap_${"ab".repeat(32)}`;
    const resume = capabilityFor(w.active, w.senderId, "resume", { sessionId: SENDER_SESSION });
    const before = rowCounts(w.active);

    for (const capability of [forged, resume]) {
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w, { capability }), { now: () => AT_SEND }),
        "CAPABILITY_REJECTED",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }

    const replay = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
    expect(replay).toMatchObject({
      disposition: "REPLAYED",
      auditSequence: first.auditSequence,
      message: { messageId: first.message.messageId },
    });
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("refuses revoked, expired, wrong-Session, wrong-Participant, detached, and non-owner send authority", () => {
    {
      const w = messagingWorld();
      revokeCapability(
        w.active.store,
        { participantId: w.senderId, scope: "send", capability: w.senderSend, sessionId: SENDER_SESSION },
        { now: () => NOW },
      );
      const before = rowCounts(w.active);
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND }),
        "CAPABILITY_REJECTED",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }
    {
      const w = messagingWorld();
      const expired = capabilityFor(w.active, w.senderId, "send", {
        sessionId: SENDER_SESSION,
        expiresAt: "2026-10-10T00:00:05.000Z",
      });
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w, { capability: expired }), { now: () => AT_SEND }),
        "CAPABILITY_REJECTED",
      );
    }
    {
      const w = messagingWorld();
      expectRefusal(
        () =>
          sendMessage(
            w.active.store,
            sendRequest(w, { sessionId: RECIPIENT_SESSION }),
            { now: () => AT_SEND },
          ),
        "CAPABILITY_REJECTED",
      );
      expectRefusal(
        () =>
          sendMessage(
            w.active.store,
            sendRequest(w, { participantId: w.recipientId }),
            { now: () => AT_SEND },
          ),
        "CAPABILITY_REJECTED",
      );
    }
    {
      const w = messagingWorld();
      const secondSession = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA3";
      const attach = capabilityFor(w.active, w.senderId, "attach");
      bindSession(w.active.store, { participantId: w.senderId, sessionId: secondSession, capability: attach }, { now: () => NOW });
      const send = capabilityFor(w.active, w.senderId, "send", { sessionId: secondSession });
      expectRefusal(
        () =>
          sendMessage(
            w.active.store,
            sendRequest(w, { sessionId: secondSession, capability: send }),
            { now: () => AT_SEND },
          ),
        "OWNERSHIP_NOT_CURRENT",
      );
    }
    {
      const w = messagingWorld();
      const resume = capabilityFor(w.active, w.senderId, "resume", { sessionId: SENDER_SESSION });
      releaseOwnership(
        w.active.store,
        { participantId: w.senderId, sessionId: SENDER_SESSION, fencingToken: 1, capability: resume },
        { now: () => "2026-10-10T00:00:01.000Z" },
      );
      detachSession(
        w.active.store,
        { participantId: w.senderId, sessionId: SENDER_SESSION, capability: resume },
        { now: () => "2026-10-10T00:00:02.000Z" },
      );
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND }),
        "CAPABILITY_REJECTED",
      );
    }
  });

  it("rejects malformed protected-read identities before taking authority", () => {
    const w = messagingWorld();
    const before = rowCounts(w.active);
    expectRefusal(
      () =>
        readMessageMetadata(
          w.active.store,
          readRequest(w, "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY", { exchangeId: "not-an-exchange" }),
          { now: () => AT_SEND },
        ),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("refuses stale fencing, expired lease, sender spoofing, and absent membership with zero Message writes", () => {
    {
      const w = messagingWorld();
      const before = rowCounts(w.active);
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w, { fencingToken: 2 }), { now: () => AT_SEND }),
        "FENCING_STALE",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }
    {
      const w = messagingWorld();
      const before = rowCounts(w.active);
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w), { now: () => "2026-10-10T00:02:00.000Z" }),
        "LEASE_EXPIRED",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }
    {
      const w = messagingWorld();
      const before = rowCounts(w.active);
      const message = {
        ...(sendRequest(w).message as Record<string, unknown>),
        from: { adapter: "adapter-a", endpointId: "spoofed" },
      };
      expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w, { message }), { now: () => AT_SEND }),
        "PARTICIPANT_BINDING_MISMATCH",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }
    {
      const w = messagingWorld();
      const outsiderId = participant(w.active, "outsider").participant.participantId;
      const attach = capabilityFor(w.active, outsiderId, "attach");
      const outsiderSession = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA2";
      bindSession(w.active.store, { participantId: outsiderId, sessionId: outsiderSession, capability: attach }, { now: () => NOW });
      acquireOwnership(w.active.store, { participantId: outsiderId, sessionId: outsiderSession, capability: attach }, { now: () => NOW });
      const send = capabilityFor(w.active, outsiderId, "send", { sessionId: outsiderSession });
      const before = rowCounts(w.active);
      expectRefusal(
        () =>
          sendMessage(
            w.active.store,
            sendRequest(w, {
              participantId: outsiderId,
              sessionId: outsiderSession,
              capability: send,
              message: {
                ...(sendRequest(w).message as Record<string, unknown>),
                from: { adapter: "adapter-a", endpointId: "outsider" },
              },
            }),
            { now: () => AT_SEND },
          ),
        "PARTICIPANT_NOT_MEMBER",
      );
      expect(rowCounts(w.active)).toEqual(before);
    }
  });

  it("allows an authorized historical replay after close but refuses a new Message", () => {
    const w = messagingWorld();
    const first = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
    const db = privileged(w.active);
    try {
      db.prepare("UPDATE exchange SET state='CLOSED', closed_at=? WHERE exchange_id=?")
        .run("2026-10-10T00:00:20.000Z", w.exchangeId);
    } finally {
      db.close();
    }

    expect(sendMessage(w.active.store, sendRequest(w), { now: () => "2026-10-10T00:00:30.000Z" })).toMatchObject({
      disposition: "REPLAYED",
      auditSequence: first.auditSequence,
    });
    expectRefusal(
      () =>
        sendMessage(
          w.active.store,
          sendRequest(w, {
            message: { ...(sendRequest(w).message as Record<string, unknown>), idempotencyKey: "message-2" },
          }),
          { now: () => "2026-10-10T00:00:30.000Z" },
        ),
      "EXCHANGE_DISPOSITION_REJECTED",
    );
  });

  it("enforces recipient-only reads, Exchange identity, and exact audit correlation", () => {
    const w = messagingWorld();
    const sent = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
    const senderRead = capabilityFor(w.active, w.senderId, "read", { sessionId: SENDER_SESSION });

    expectRefusal(
      () =>
        readMessageMetadata(
          w.active.store,
          readRequest(w, sent.message.messageId, {
            participantId: w.senderId,
            sessionId: SENDER_SESSION,
            capability: senderRead,
          }),
          { now: () => AT_SEND },
        ),
      "MESSAGE_READ_REJECTED",
    );

    expectRefusal(
      () =>
        readMessageMetadata(
          w.active.store,
          readRequest(w, "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW"),
          { now: () => AT_SEND },
        ),
      "MESSAGE_READ_REJECTED",
    );

    const foreignExchange = exchange(w.active, "foreign-exchange");
    expectRefusal(
      () =>
        readMessageMetadata(
          w.active.store,
          readRequest(w, sent.message.messageId, { exchangeId: foreignExchange }),
          { now: () => AT_SEND },
        ),
      "PARTICIPANT_NOT_MEMBER",
    );

    const db = privileged(w.active);
    try {
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
      ).run(
        "evt_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        w.exchangeId,
        sent.auditSequence + 1,
        sent.message.messageId,
        sent.message.createdAt,
        sent.message.payloadDigest,
        sent.message.payloadLength,
      );
    } finally {
      db.close();
    }
    expectRefusal(
      () => readMessageMetadata(w.active.store, readRequest(w, sent.message.messageId), { now: () => AT_SEND }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed on missing or inconsistent message_created audit correlation", () => {
    {
      const w = messagingWorld();
      const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY";
      insertRawMessageWithoutTrustedApi(w, messageId);
      expectRefusal(
        () => readMessageMetadata(w.active.store, readRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      const w = messagingWorld();
      const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAX";
      insertRawMessageWithoutTrustedApi(w, messageId, "ab".repeat(32));
      expectRefusal(
        () => readMessageMetadata(w.active.store, readRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
  });

  it("excludes a recipient from Messages at or before its immutable join boundary", () => {
    const active = fixture("ce-b3-p3a-boundary-");
    const exchangeId = exchange(active);
    const created = createMessage(
      active.store,
      { exchangeId, from: senderEndpoint, to: recipientEndpoint, payload, idempotencyKey: "before-join" },
      { now: () => "2026-10-10T00:00:01.000Z" },
    );
    const recipientId = participant(active, recipientEndpoint.endpointId).participant.participantId;
    const attach = capabilityFor(active, recipientId, "attach");
    bindSession(active.store, { participantId: recipientId, sessionId: RECIPIENT_SESSION, capability: attach }, { now: () => NOW });
    acquireOwnership(active.store, { participantId: recipientId, sessionId: RECIPIENT_SESSION, capability: attach }, { now: () => NOW });
    const join = capabilityFor(active, recipientId, "join");
    joinExchange(
      active.store,
      { exchangeId, participantId: recipientId, capability: join, idempotencyKey: "join-late" },
      { now: () => "2026-10-10T00:00:02.000Z" },
    );
    const read = capabilityFor(active, recipientId, "read", { sessionId: RECIPIENT_SESSION });
    expectRefusal(
      () =>
        readMessageMetadata(
          active.store,
          {
            participantId: recipientId,
            sessionId: RECIPIENT_SESSION,
            fencingToken: 1,
            capability: read,
            exchangeId,
            messageId: created.message.messageId,
          },
          { now: () => AT_SEND },
        ),
      "MESSAGE_READ_REJECTED",
    );
    expect(rowCounts(active).cursor).toBe("0");
  });

  it.each(["afterMessageInsert", "afterIdempotencyInsert", "afterAuditInsert"] as const)(
    "rolls back the authorized transaction when %s fails",
    (hook) => {
      const w = messagingWorld();
      const before = rowCounts(w.active);
      const error = expectRefusal(
        () =>
          sendMessage(w.active.store, sendRequest(w), {
            now: () => AT_SEND,
            [hook]: () => {
              throw new Error("SENSITIVE_SECRET");
            },
          }),
        "STORAGE_TRANSACTION_FAILED",
      );
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
      expect(rowCounts(w.active)).toEqual(before);
    },
  );

  it("attempts BEGIN once on BUSY and performs no messaging writes", () => {
    const w = messagingWorld();
    const before = rowCounts(w.active);
    const blocker = new DatabaseSync(w.active.databasePath);
    let begins = 0;
    const original = w.active.store.database.exec.bind(w.active.store.database);
    w.active.store.database.exec = (sql) => {
      if (sql === "BEGIN IMMEDIATE") begins += 1;
      return original(sql);
    };
    try {
      blocker.exec("BEGIN IMMEDIATE");
      const error = expectRefusal(
        () => sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND }),
        "STORAGE_TRANSACTION_BUSY",
      );
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
      expect(begins).toBe(1);
      expect(rowCounts(w.active)).toEqual(before);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("publishes no result on INDETERMINATE commit and requires fresh-store inspection", () => {
    const w = messagingWorld();
    const original = w.active.store.database.exec.bind(w.active.store.database);
    w.active.store.database.exec = (sql) => {
      const result = original(sql);
      if (sql === "COMMIT") throw new Error("SENSITIVE_SECRET");
      return result;
    };
    let published: ReturnType<typeof sendMessage> | undefined;
    const error = expectRefusal(
      () => {
        published = sendMessage(w.active.store, sendRequest(w), { now: () => AT_SEND });
      },
      "STORAGE_TRANSACTION_FAILED",
    );
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(published).toBeUndefined();
    expect(() => w.active.store.database.prepare("SELECT 1")).toThrow();

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      const row = reopened.database
        .prepare("SELECT count(*) AS n FROM message WHERE exchange_id = ?")
        .get(w.exchangeId);
      expect(row).toEqual({ n: 1 });
      const replay = sendMessage(reopened, sendRequest(w), { now: () => AT_SEND });
      expect(replay.disposition).toBe("REPLAYED");
    } finally {
      reopened.close();
    }
  });
});
