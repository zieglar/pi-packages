/**
 * CE-0002 B3-P4D — private authorized Message payload read.
 *
 * Every test runs against a real file-backed SQLite store with the real host
 * secret artifact. The payload must be materialized only after the complete
 * authorization and eligibility chain, returned as a fresh byte copy, and no
 * Message, Audit, receipt, cursor, lease, or ownership state may change.
 */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveSqliteDriver } from "../../src/storage/sqlite-driver-selection.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMessage } from "../../src/storage/creation.js";
import { readMessageMetadata, readMessagePayload, sendMessage } from "../../src/storage/messaging.js";
import {
  acquireOwnership,
  bindSession,
  detachSession,
  releaseOwnership,
  takeoverOwnership,
} from "../../src/storage/ownership.js";
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
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

const SENDER_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
const RECIPIENT_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1";
const RECIPIENT_SECOND_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA2";
const AT_SEND = "2026-10-10T00:00:10.000Z";
const AFTER_LEASE = "2026-10-10T01:00:00.000Z";

const senderEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "sender" });
const recipientEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "recipient" });
const payload = new Uint8Array([0, 1, 2, 3, 255]);

afterEach(cleanupFixtures);

interface PayloadWorld {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly senderSend: string;
  readonly recipientRead: string;
  readonly recipientPayloadRead: string;
  readonly senderPayloadRead: string;
}

function payloadWorld(): PayloadWorld {
  const active = fixture("ce-b3-p4d-");
  const exchangeId = exchange(active);
  const senderId = participant(active, senderEndpoint.endpointId).participant.participantId;
  const recipientId = participant(active, recipientEndpoint.endpointId).participant.participantId;

  for (const [participantId, sessionId] of [
    [senderId, SENDER_SESSION],
    [recipientId, RECIPIENT_SESSION],
  ] as const) {
    const attach = capabilityFor(active, participantId, "attach");
    bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
    acquireOwnership(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
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
    recipientPayloadRead: capabilityFor(active, recipientId, "payload_read", { sessionId: RECIPIENT_SESSION }),
    senderPayloadRead: capabilityFor(active, senderId, "payload_read", { sessionId: SENDER_SESSION }),
  };
}

function sendRequest(w: PayloadWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function payloadRequest(w: PayloadWorld, messageId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participantId: w.recipientId,
    sessionId: RECIPIENT_SESSION,
    fencingToken: 1,
    capability: w.recipientPayloadRead,
    exchangeId: w.exchangeId,
    messageId,
    ...overrides,
  };
}

function sendOne(w: PayloadWorld, idempotencyKey = "message-1", bytes: Uint8Array = payload): string {
  return sendMessage(w.active.store, sendRequest(w, {
    message: {
      exchangeId: w.exchangeId,
      from: senderEndpoint,
      to: recipientEndpoint,
      payload: bytes,
      idempotencyKey,
    },
  }), { now: () => AT_SEND }).message.messageId;
}

function insertRawMessageWithoutTrustedApi(w: PayloadWorld, messageId: string, auditDigest?: string): void {
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

describe("CE-0002 B3-P4D authorized durable payload read", () => {
  it("returns the exact stored bytes to the authorized recipient without durable writes", () => {
    const w = payloadWorld();
    const before = rowCounts(w.active);
    const messageId = sendOne(w);
    const afterSend = rowCounts(w.active);
    const changesBefore = w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n;

    const result = readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND });
    expect(result.message).toMatchObject({ messageId, exchangeId: w.exchangeId, payloadLength: payload.byteLength });
    expect(result.auditSequence).toBeGreaterThan(0);
    expect(Array.from(result.payload)).toEqual(Array.from(payload));
    expect(rowCounts(w.active)).toEqual(afterSend);
    expect(Number(before.audits)).toBeLessThan(Number(afterSend.audits));

    // A repeated authorized read returns identical bytes; mutating the returned
    // copy must never affect durable state or a later read.
    result.payload[0] = 42;
    const second = readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND });
    expect(Array.from(second.payload)).toEqual(Array.from(payload));
    expect(second.payload).not.toBe(result.payload);
    expect(w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore);
  });

  it("keeps DELIVERY_UNKNOWN unchanged across repeated authorized payload reads", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    w.active.store.database.prepare("UPDATE message SET state='DELIVERY_UNKNOWN' WHERE message_id=?").run(messageId);
    const before = w.active.store.database.prepare("SELECT * FROM message WHERE message_id=?").get(messageId);
    const changesBefore = w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const read = readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND });
      expect(read.message.state).toBe("DELIVERY_UNKNOWN");
      expect(read.payload).toEqual(payload);
    }
    expect(w.active.store.database.prepare("SELECT * FROM message WHERE message_id=?").get(messageId)).toEqual(before);
    expect(w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore);
  });

  it("never selects payload_body for an ineligible recipient or inconsistent Audit", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const missingAuditId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY";
    insertRawMessageWithoutTrustedApi(w, missingAuditId);
    let bodyReads = 0;
    const original = w.active.store.database.prepare.bind(w.active.store.database);
    w.active.store.database.prepare = (sql: string) => {
      if (/\bSELECT\b[\s\S]*\bpayload_body\b/i.test(sql)) bodyReads += 1;
      return original(sql);
    };
    expectRefusal(() => readMessagePayload(w.active.store, payloadRequest(w, messageId, {
      participantId: w.senderId, sessionId: SENDER_SESSION, capability: w.senderPayloadRead,
    }), { now: () => AT_SEND }), "MESSAGE_READ_REJECTED");
    expectRefusal(() => readMessagePayload(w.active.store, payloadRequest(w, missingAuditId), { now: () => AT_SEND }), "STORAGE_IDEMPOTENCY_CORRUPT");
    expect(bodyReads).toBe(0);
    readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND });
    expect(bodyReads).toBe(1);
  });

  it("reads an empty payload and the maximum storable payload intact", () => {
    const w = payloadWorld();
    const empty = readMessagePayload(
      w.active.store,
      payloadRequest(w, sendOne(w, "empty", new Uint8Array(0))),
      { now: () => AT_SEND },
    );
    expect(empty.payload.byteLength).toBe(0);

    const large = new Uint8Array(1_048_576);
    for (let index = 0; index < large.length; index += 1) large[index] = index % 251;
    const max = readMessagePayload(w.active.store, payloadRequest(w, sendOne(w, "max", large)), { now: () => AT_SEND });
    expect(max.payload.byteLength).toBe(1_048_576);
    expect(createHash("sha256").update(max.payload).digest("hex")).toBe(max.message.payloadDigest);
  });

  it("refuses unknown Messages, non-recipients, and foreign Exchanges opaquely", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const foreignExchange = exchange(w.active, "foreign-exchange");
    const before = rowCounts(w.active);

    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW"), { now: () => AT_SEND }),
      "MESSAGE_READ_REJECTED",
    );
    expectRefusal(
      () => readMessagePayload(
        w.active.store,
        payloadRequest(w, messageId, { participantId: w.senderId, sessionId: SENDER_SESSION, capability: w.senderPayloadRead }),
        { now: () => AT_SEND },
      ),
      "MESSAGE_READ_REJECTED",
    );
    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId, { exchangeId: foreignExchange }), { now: () => AT_SEND }),
      "PARTICIPANT_NOT_MEMBER",
    );
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("keeps Message IDs scoped to their Exchange even with membership in both", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const foreignExchange = exchange(w.active, "joined-foreign-exchange");
    const join = capabilityFor(w.active, w.recipientId, "join");
    joinExchange(w.active.store, { exchangeId: foreignExchange, participantId: w.recipientId, capability: join, idempotencyKey: "join-foreign" }, { now: () => NOW });
    const changesBefore = w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n;
    expectRefusal(() => readMessagePayload(w.active.store, payloadRequest(w, messageId, { exchangeId: foreignExchange }), { now: () => AT_SEND }), "MESSAGE_READ_REJECTED");
    expect(w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(changesBefore);
  });

  it("requires the exact payload_read scope in both directions", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);

    expectRefusal(
      () => readMessagePayload(
        w.active.store,
        payloadRequest(w, messageId, { capability: w.recipientRead }),
        { now: () => AT_SEND },
      ),
      "CAPABILITY_REJECTED",
    );
    expectRefusal(
      () => readMessageMetadata(
        w.active.store,
        payloadRequest(w, messageId, { capability: w.recipientPayloadRead }),
        { now: () => AT_SEND },
      ),
      "CAPABILITY_REJECTED",
    );
  });

  it("refuses a non-member Participant with ownership of its own Session", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const outsiderId = participant(w.active, "outsider").participant.participantId;
    const outsiderSession = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA3";
    const attach = capabilityFor(w.active, outsiderId, "attach");
    bindSession(w.active.store, { participantId: outsiderId, sessionId: outsiderSession, capability: attach }, { now: () => NOW });
    acquireOwnership(w.active.store, { participantId: outsiderId, sessionId: outsiderSession, capability: attach }, { now: () => NOW });
    const outsiderPayloadRead = capabilityFor(w.active, outsiderId, "payload_read", { sessionId: outsiderSession });

    expectRefusal(
      () => readMessagePayload(
        w.active.store,
        payloadRequest(w, messageId, { participantId: outsiderId, sessionId: outsiderSession, capability: outsiderPayloadRead }),
        { now: () => AT_SEND },
      ),
      "PARTICIPANT_NOT_MEMBER",
    );
  });

  it("excludes a recipient from Messages at or before its immutable join boundary", () => {
    const active = fixture("ce-b3-p4d-boundary-");
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
    const payloadRead = capabilityFor(active, recipientId, "payload_read", { sessionId: RECIPIENT_SESSION });

    expectRefusal(
      () => readMessagePayload(
        active.store,
        {
          participantId: recipientId,
          sessionId: RECIPIENT_SESSION,
          fencingToken: 1,
          capability: payloadRead,
          exchangeId,
          messageId: created.message.messageId,
        },
        { now: () => AT_SEND },
      ),
      "MESSAGE_READ_REJECTED",
    );
    expect(rowCounts(active).cursor).toBe("0");
  });

  it("enforces Session binding, lifecycle, revocation, and expiry on the capability", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);

    expectRefusal(
      () => readMessagePayload(
        w.active.store,
        payloadRequest(w, messageId, { sessionId: RECIPIENT_SECOND_SESSION }),
        { now: () => AT_SEND },
      ),
      "CAPABILITY_REJECTED",
    );

    const attach2 = capabilityFor(w.active, w.recipientId, "attach");
    bindSession(w.active.store, { participantId: w.recipientId, sessionId: RECIPIENT_SECOND_SESSION, capability: attach2 }, { now: () => NOW });
    const detached = capabilityFor(w.active, w.recipientId, "payload_read", { sessionId: RECIPIENT_SECOND_SESSION });
    const resume = capabilityFor(w.active, w.recipientId, "resume", { sessionId: RECIPIENT_SECOND_SESSION });
    releaseOwnership(w.active.store, {
      participantId: w.recipientId,
      sessionId: RECIPIENT_SESSION,
      fencingToken: 1,
      capability: capabilityFor(w.active, w.recipientId, "resume", { sessionId: RECIPIENT_SESSION }),
    }, { now: () => AT_SEND });
    detachSession(w.active.store, { participantId: w.recipientId, sessionId: RECIPIENT_SECOND_SESSION, capability: resume }, { now: () => AT_SEND });
    expectRefusal(
      () => readMessagePayload(
        w.active.store,
        payloadRequest(w, messageId, { sessionId: RECIPIENT_SECOND_SESSION, capability: detached }),
        { now: () => AT_SEND },
      ),
      "CAPABILITY_REJECTED",
    );

    revokeCapability(
      w.active.store,
      { participantId: w.recipientId, scope: "payload_read", sessionId: RECIPIENT_SESSION, capability: w.recipientPayloadRead },
      { now: () => AT_SEND },
    );
    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
      "CAPABILITY_REJECTED",
    );

    const expired = capabilityFor(w.active, w.recipientId, "payload_read", { sessionId: RECIPIENT_SESSION, expiresAt: "2026-10-10T00:00:05.000Z" });
    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId, { capability: expired }), { now: () => AT_SEND }),
      "CAPABILITY_REJECTED",
    );
  });

  it("enforces current ownership, fencing, and an active lease", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);

    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId, { fencingToken: 2 }), { now: () => AT_SEND }),
      "FENCING_STALE",
    );
    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AFTER_LEASE }),
      "LEASE_EXPIRED",
    );

    // After lease expiry a second Session takes over; the first is superseded.
    const attach2 = capabilityFor(w.active, w.recipientId, "attach");
    bindSession(w.active.store, { participantId: w.recipientId, sessionId: RECIPIENT_SECOND_SESSION, capability: attach2 }, { now: () => NOW });
    const takeover = capabilityFor(w.active, w.recipientId, "takeover", { sessionId: RECIPIENT_SECOND_SESSION });
    takeoverOwnership(w.active.store, { participantId: w.recipientId, sessionId: RECIPIENT_SECOND_SESSION, capability: takeover }, { now: () => AFTER_LEASE });
    expectRefusal(
      () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AFTER_LEASE }),
      "OWNERSHIP_NOT_CURRENT",
    );
  });

  it("refuses a BLOB whose actual length disagrees with otherwise valid metadata and Audit", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    w.active.store.database.prepare("UPDATE message SET payload_body=? WHERE message_id=?").run(new Uint8Array([1]), messageId);
    expectRefusal(() => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }), "STORAGE_IDEMPOTENCY_CORRUPT");
  });

  it("fails closed on missing or inconsistent payload and audit integrity", () => {
    {
      const w = payloadWorld();
      const messageId = sendOne(w);
      const db = privileged(w.active);
      try {
        db.prepare("UPDATE message SET payload_body=NULL WHERE message_id=?").run(messageId);
      } finally {
        db.close();
      }
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      const w = payloadWorld();
      const messageId = sendOne(w);
      const db = privileged(w.active);
      try {
        db.prepare("UPDATE message SET payload_length=payload_length+1 WHERE message_id=?").run(messageId);
      } finally {
        db.close();
      }
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      const w = payloadWorld();
      const messageId = sendOne(w);
      const changed = new Uint8Array(payload.length).fill(0x7f);
      const db = privileged(w.active);
      try {
        db.prepare("UPDATE message SET payload_body=? WHERE message_id=?").run(changed, messageId);
      } finally {
        db.close();
      }
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      // No message_created audit row at all.
      const w = payloadWorld();
      const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY";
      insertRawMessageWithoutTrustedApi(w, messageId);
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      // Audit digest disagrees with the stored Message digest.
      const w = payloadWorld();
      const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAX";
      insertRawMessageWithoutTrustedApi(w, messageId, "ab".repeat(32));
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
    {
      // Two correlated audit rows.
      const w = payloadWorld();
      const messageId = sendOne(w);
      const db = privileged(w.active);
      try {
        db.prepare(
          "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
        ).run(
          "evt_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
          w.exchangeId,
          999,
          messageId,
          AT_SEND,
          "c".repeat(64),
          payload.byteLength,
        );
      } finally {
        db.close();
      }
      expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_IDEMPOTENCY_CORRUPT",
      );
    }
  });

  it("attempts BEGIN once on BUSY and performs no writes", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const before = rowCounts(w.active);
    const blocker = resolveSqliteDriver().open(w.active.databasePath);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      const error = expectRefusal(
        () => readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND }),
        "STORAGE_TRANSACTION_BUSY",
      );
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
      expect(rowCounts(w.active)).toEqual(before);
    } finally {
      blocker.close();
    }
  });

  it("publishes no payload on an INDETERMINATE commit outcome", () => {
    const w = payloadWorld();
    const messageId = sendOne(w);
    const original = w.active.store.database.exec.bind(w.active.store.database);
    w.active.store.database.exec = (sql) => {
      const result = original(sql);
      if (sql === "COMMIT") throw new Error("PRIVATE_COMMIT_FAILURE");
      return result;
    };
    let published: unknown;
    const error = expectRefusal(
      () => {
        published = readMessagePayload(w.active.store, payloadRequest(w, messageId), { now: () => AT_SEND });
      },
      "STORAGE_TRANSACTION_FAILED",
    );
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(published).toBeUndefined();
    expect(() => w.active.store.database.prepare("SELECT 1")).toThrow();
    expect(JSON.stringify([String(error), (error as Error).stack, (error as Error).cause])).not.toContain("cap_");

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(Array.from(readMessagePayload(reopened, payloadRequest(w, messageId), { now: () => AT_SEND }).payload)).toEqual(Array.from(payload));
    } finally {
      reopened.close();
    }
  });
});
