import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { resolveSqliteDriver } from "../../src/storage/sqlite-driver-selection.js";
import { afterEach, describe, expect, it } from "vitest";
import { generateEntityId } from "../../src/protocol/identity.js";
import { discoverInboxMessages } from "../../src/storage/inbox-discovery.js";
import { sendMessage } from "../../src/storage/messaging.js";
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
const OTHER_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA2";
const AT_LIST = "2026-10-10T00:00:20.000Z";
const senderEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "sender" });
const recipientEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "recipient" });
const otherEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "other" });

interface InboxWorld {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly senderId: string;
  readonly recipientId: string;
  readonly otherId: string;
  readonly senderSend: string;
  readonly recipientRead: string;
}

afterEach(cleanupFixtures);

function bindOwnJoin(
  active: Fixture,
  exchangeId: string,
  participantId: string,
  sessionId: string,
  endpointKey: string,
): void {
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
  acquireOwnership(active.store, { participantId, sessionId, capability: attach }, { now: () => NOW });
  const join = capabilityFor(active, participantId, "join");
  joinExchange(
    active.store,
    { exchangeId, participantId, capability: join, idempotencyKey: `join-${endpointKey}` },
    { now: () => NOW },
  );
}

function inboxWorld(): InboxWorld {
  const active = fixture("ce-b3-p3c-inbox-");
  const exchangeId = exchange(active);
  const senderId = participant(active, senderEndpoint.endpointId).participant.participantId;
  const recipientId = participant(active, recipientEndpoint.endpointId).participant.participantId;
  const otherId = participant(active, otherEndpoint.endpointId).participant.participantId;
  bindOwnJoin(active, exchangeId, senderId, SENDER_SESSION, "sender");
  bindOwnJoin(active, exchangeId, recipientId, RECIPIENT_SESSION, "recipient");
  bindOwnJoin(active, exchangeId, otherId, OTHER_SESSION, "other");
  return {
    active,
    exchangeId,
    senderId,
    recipientId,
    otherId,
    senderSend: capabilityFor(active, senderId, "send", { sessionId: SENDER_SESSION }),
    recipientRead: capabilityFor(active, recipientId, "read", { sessionId: RECIPIENT_SESSION }),
  };
}

function listRequest(w: InboxWorld, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    participantId: w.recipientId,
    sessionId: RECIPIENT_SESSION,
    fencingToken: 1,
    capability: w.recipientRead,
    exchangeId: w.exchangeId,
    ...overrides,
  };
}

function sendTo(
  w: InboxWorld,
  to: { readonly adapter: string; readonly endpointId: string },
  key: string,
  seconds: number,
  exchangeId = w.exchangeId,
) {
  const now = new Date(Date.parse(NOW) + seconds * 1000).toISOString();
  return sendMessage(
    w.active.store,
    {
      participantId: w.senderId,
      sessionId: SENDER_SESSION,
      fencingToken: 1,
      capability: w.senderSend,
      message: {
        exchangeId,
        from: senderEndpoint,
        to,
        payload: Uint8Array.from([seconds & 0xff, 2, 3]),
        idempotencyKey: key,
      },
    },
    { now: () => now },
  );
}

function insertOrphanAudit(w: InboxWorld, subjectId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"): number {
  const db = privileged(w.active);
  try {
    const sequence = Number(
      db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
    ) + 1;
    db.prepare(
      "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
    ).run(
      "evt_01ARZ3NDEKTSV4RRFFQ69G5FZZ",
      w.exchangeId,
      sequence,
      subjectId,
      "2026-10-10T00:00:10.000Z",
      "a".repeat(64),
      3,
    );
    return sequence;
  } finally {
    db.close();
  }
}

function insertRawMessageCandidate(
  w: InboxWorld,
  options: { readonly toEndpointJson?: string; readonly auditDigest?: string } = {},
): string {
  const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAY";
  const body = Uint8Array.from([9, 8, 7]);
  const digest = createHash("sha256").update(body).digest("hex");
  const db = privileged(w.active);
  try {
    const sequence = Number(
      db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
    ) + 1;
    db.prepare(
      "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, NULL, 1)",
    ).run(
      messageId,
      w.exchangeId,
      JSON.stringify(senderEndpoint),
      options.toEndpointJson ?? JSON.stringify(recipientEndpoint),
      digest,
      body.byteLength,
      body,
      "2026-10-10T00:00:11.000Z",
    );
    db.prepare(
      "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
    ).run(
      "evt_01ARZ3NDEKTSV4RRFFQ69G5FZY",
      w.exchangeId,
      sequence,
      messageId,
      "2026-10-10T00:00:11.000Z",
      options.auditDigest ?? digest,
      body.byteLength,
    );
    return messageId;
  } finally {
    db.close();
  }
}

function insertUnrelatedAuditRows(w: InboxWorld, count: number): void {
  const db = privileged(w.active);
  try {
    const maximum = Number(
      db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
    );
    for (let index = 1; index <= count; index += 1) {
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_state_changed', ?, ?, NULL, NULL, NULL, 1)",
      ).run(
        generateEntityId("evt_", Date.parse(NOW) + index),
        w.exchangeId,
        maximum + index,
        `noise-${index}`,
        new Date(Date.parse(NOW) + index * 1000).toISOString(),
      );
    }
  } finally {
    db.close();
  }
}

function cursorCount(active: Fixture): number {
  const db = reader(active);
  try {
    return Number(db.prepare("SELECT count(*) AS n FROM delivery_cursor").get()!.n);
  } finally {
    db.close();
  }
}

describe("CE-0002 B3-P3C bounded Inbox Discovery", () => {
  it("lists authorized recipient metadata in Audit Sequence order and exposes no payload", () => {
    const w = inboxWorld();
    const first = sendTo(w, recipientEndpoint, "recipient-1", 10);
    const second = sendTo(w, recipientEndpoint, "recipient-2", 11);

    const result = discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST });

    expect(result.messages).toEqual([
      { message: first.message, auditSequence: first.auditSequence },
      { message: second.message, auditSequence: second.auditSequence },
    ]);
    expect(result.continuationAuditSequence).toBe(second.auditSequence);
    expect(result.scanBudgetExhausted).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("payload_body");
    expect(result.messages.every((item) => !Object.hasOwn(item.message, "payload"))).toBe(true);
  });

  it("returns an empty Inbox with no fabricated continuation", () => {
    const w = inboxWorld();
    expect(discoverInboxMessages(w.active.store, listRequest(w, { afterAuditSequence: 4 }), { now: () => AT_LIST })).toEqual({
      messages: [],
      continuationAuditSequence: null,
      scanBudgetExhausted: false,
    });
  });

  it("filters other recipients and other Exchanges without leaking their metadata", () => {
    const w = inboxWorld();
    const mine = sendTo(w, recipientEndpoint, "mine", 10);
    sendTo(w, otherEndpoint, "theirs", 11);
    const otherExchange = exchange(w.active, "other-exchange");
    const recipientJoin = capabilityFor(w.active, w.recipientId, "join");
    joinExchange(
      w.active.store,
      { exchangeId: otherExchange, participantId: w.recipientId, capability: recipientJoin, idempotencyKey: "join-other" },
      { now: () => NOW },
    );
    const senderJoin = capabilityFor(w.active, w.senderId, "join");
    joinExchange(
      w.active.store,
      { exchangeId: otherExchange, participantId: w.senderId, capability: senderJoin, idempotencyKey: "join-other-sender" },
      { now: () => NOW },
    );
    const foreign = sendTo(w, recipientEndpoint, "foreign-exchange", 12, otherExchange);

    const result = discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST });
    expect(result.messages).toEqual([{ message: mine.message, auditSequence: mine.auditSequence }]);
    expect(result.messages[0]!.message.exchangeId).toBe(w.exchangeId);
    expect(result.messages.map((item) => item.message.messageId)).not.toContain(foreign.message.messageId);
  });

  it("enforces the immutable membership join boundary", () => {
    const active = fixture("ce-b3-p3c-boundary-");
    const exchangeId = exchange(active);
    const senderId = participant(active, senderEndpoint.endpointId).participant.participantId;
    const recipientId = participant(active, recipientEndpoint.endpointId).participant.participantId;
    const otherId = participant(active, otherEndpoint.endpointId).participant.participantId;
    bindOwnJoin(active, exchangeId, senderId, SENDER_SESSION, "sender");
    const recipientAttach = capabilityFor(active, recipientId, "attach");
    bindSession(active.store, { participantId: recipientId, sessionId: RECIPIENT_SESSION, capability: recipientAttach }, { now: () => NOW });
    acquireOwnership(active.store, { participantId: recipientId, sessionId: RECIPIENT_SESSION, capability: recipientAttach }, { now: () => NOW });
    const world: InboxWorld = {
      active,
      exchangeId,
      senderId,
      recipientId,
      otherId,
      senderSend: capabilityFor(active, senderId, "send", { sessionId: SENDER_SESSION }),
      recipientRead: "",
    };
    const historical = sendTo(world, recipientEndpoint, "before-join", 5);
    const join = capabilityFor(active, recipientId, "join");
    const membership = joinExchange(
      active.store,
      { exchangeId, participantId: recipientId, capability: join, idempotencyKey: "join-recipient" },
      { now: () => "2026-10-10T00:00:06.000Z" },
    );
    const liveWorld = {
      ...world,
      recipientRead: capabilityFor(active, recipientId, "read", { sessionId: RECIPIENT_SESSION }),
    };
    const eligible = sendTo(liveWorld, recipientEndpoint, "after-join", 7);

    const result = discoverInboxMessages(active.store, listRequest(liveWorld), { now: () => AT_LIST });
    expect(historical.auditSequence).toBeLessThan(membership.membership.joinBoundarySeq);
    expect(result.messages).toEqual([{ message: eligible.message, auditSequence: eligible.auditSequence }]);
  });

  it("paginates by the last raw Audit Sequence examined, including an empty subsequent page", () => {
    const w = inboxWorld();
    const sent = [
      sendTo(w, recipientEndpoint, "page-1", 10),
      sendTo(w, recipientEndpoint, "page-2", 11),
      sendTo(w, recipientEndpoint, "page-3", 12),
    ];
    const first = discoverInboxMessages(
      w.active.store,
      listRequest(w, { pageSize: 2, rawScanLimit: 10 }),
      { now: () => AT_LIST },
    );
    expect(first.messages.map((item) => item.message.messageId)).toEqual(sent.slice(0, 2).map((item) => item.message.messageId));
    expect(first.continuationAuditSequence).toBe(sent[1]!.auditSequence);
    expect(first.scanBudgetExhausted).toBe(false);

    const second = discoverInboxMessages(
      w.active.store,
      listRequest(w, {
        afterAuditSequence: first.continuationAuditSequence,
        pageSize: 2,
        rawScanLimit: 10,
      }),
      { now: () => AT_LIST },
    );
    expect(second.messages.map((item) => item.message.messageId)).toEqual([sent[2]!.message.messageId]);
    expect(second.continuationAuditSequence).toBe(sent[2]!.auditSequence);

    const empty = discoverInboxMessages(
      w.active.store,
      listRequest(w, { afterAuditSequence: second.continuationAuditSequence }),
      { now: () => AT_LIST },
    );
    expect(empty).toEqual({ messages: [], continuationAuditSequence: null, scanBudgetExhausted: false });
  });

  it.each([
    ["negative cursor", { afterAuditSequence: -1 }],
    ["fractional cursor", { afterAuditSequence: 1.5 }],
    ["unsafe cursor", { afterAuditSequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["zero page", { pageSize: 0 }],
    ["oversized page", { pageSize: 51 }],
    ["fractional page", { pageSize: 1.5 }],
    ["zero scan", { rawScanLimit: 0 }],
    ["oversized scan", { rawScanLimit: 2001 }],
    ["unsafe scan", { rawScanLimit: Number.MAX_SAFE_INTEGER + 1 }],
    ["page exceeds scan", { pageSize: 3, rawScanLimit: 2 }],
  ])("rejects invalid numeric input: %s", (_label, overrides) => {
    const w = inboxWorld();
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w, overrides), { now: () => AT_LIST }),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
  });

  it("bounds raw Audit work and advances over unrelated rows without claiming more eligible Messages", () => {
    const w = inboxWorld();
    const sent = sendTo(w, recipientEndpoint, "after-unrelated", 10);
    const membership = reader(w.active);
    let boundary: number;
    try {
      boundary = Number(
        membership
          .prepare("SELECT join_boundary_seq FROM exchange_membership WHERE exchange_id=? AND participant_id=?")
          .get(w.exchangeId, w.recipientId)!.join_boundary_seq,
      );
    } finally {
      membership.close();
    }

    const first = discoverInboxMessages(
      w.active.store,
      listRequest(w, { afterAuditSequence: boundary, pageSize: 1, rawScanLimit: 1 }),
      { now: () => AT_LIST },
    );
    expect(first.messages).toEqual([]);
    expect(first.continuationAuditSequence).toBe(boundary + 1);
    expect(first.scanBudgetExhausted).toBe(true);

    const second = discoverInboxMessages(
      w.active.store,
      listRequest(w, { afterAuditSequence: first.continuationAuditSequence, pageSize: 1, rawScanLimit: 1 }),
      { now: () => AT_LIST },
    );
    expect(second.messages).toEqual([{ message: sent.message, auditSequence: sent.auditSequence }]);
    expect(second.continuationAuditSequence).toBe(sent.auditSequence);
    expect(second.scanBudgetExhausted).toBe(true);
  });

  it("remains bounded with many unrelated Audit rows", () => {
    const w = inboxWorld();
    const db = reader(w.active);
    let boundary: number;
    try {
      boundary = Number(db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n);
    } finally {
      db.close();
    }
    insertUnrelatedAuditRows(w, 25);
    const sent = sendTo(w, recipientEndpoint, "after-many-unrelated", 10);

    const first = discoverInboxMessages(
      w.active.store,
      listRequest(w, { afterAuditSequence: boundary, pageSize: 1, rawScanLimit: 20 }),
      { now: () => AT_LIST },
    );
    expect(first).toEqual({
      messages: [],
      continuationAuditSequence: boundary + 20,
      scanBudgetExhausted: true,
    });

    const second = discoverInboxMessages(
      w.active.store,
      listRequest(w, { afterAuditSequence: first.continuationAuditSequence, pageSize: 1, rawScanLimit: 20 }),
      { now: () => AT_LIST },
    );
    expect(second.messages).toEqual([{ message: sent.message, auditSequence: sent.auditSequence }]);
    expect(second.continuationAuditSequence).toBe(sent.auditSequence);
    expect(second.scanBudgetExhausted).toBe(false);
  });

  it("stops at P before K and returns the exact examined continuation", () => {
    const w = inboxWorld();
    const first = sendTo(w, recipientEndpoint, "p-before-k-1", 10);
    sendTo(w, recipientEndpoint, "p-before-k-2", 11);
    const result = discoverInboxMessages(
      w.active.store,
      listRequest(w, { pageSize: 1, rawScanLimit: 10 }),
      { now: () => AT_LIST },
    );
    expect(result.messages).toHaveLength(1);
    expect(result.continuationAuditSequence).toBe(first.auditSequence);
    expect(result.scanBudgetExhausted).toBe(false);
  });

  it("rejects forged capability, Session mismatch, stale fencing, and expired lease without metadata", () => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, "protected", 10);
    const wrongScope = capabilityFor(w.active, w.recipientId, "send", { sessionId: RECIPIENT_SESSION });
    const cases = [
      [{ capability: `cap_${"ab".repeat(32)}` }, "CAPABILITY_REJECTED", AT_LIST],
      [{ capability: wrongScope }, "CAPABILITY_REJECTED", AT_LIST],
      [{ sessionId: OTHER_SESSION }, "CAPABILITY_REJECTED", AT_LIST],
      [{ fencingToken: 2 }, "FENCING_STALE", AT_LIST],
      [{}, "LEASE_EXPIRED", "2026-10-10T00:02:00.000Z"],
    ] as const;
    for (const [overrides, code, now] of cases) {
      const error = expectRefusal(
        () => discoverInboxMessages(w.active.store, listRequest(w, overrides), { now: () => now }),
        code,
      );
      const published = JSON.stringify(error);
      expect(published).not.toContain(w.recipientRead);
      expect(published).not.toContain("messageId");
      expect(published).not.toContain("SELECT");
      expect(published).not.toContain(w.active.databasePath);
    }
  });

  it("rejects a valid reader that is not a member of the requested Exchange", () => {
    const w = inboxWorld();
    const unrelatedExchange = exchange(w.active, "not-a-member");
    expectRefusal(
      () => discoverInboxMessages(
        w.active.store,
        listRequest(w, { exchangeId: unrelatedExchange }),
        { now: () => AT_LIST },
      ),
      "PARTICIPANT_NOT_MEMBER",
    );
  });

  it("rejects revoked and detached Session authority with the opaque capability refusal", () => {
    {
      const w = inboxWorld();
      revokeCapability(
        w.active.store,
        { participantId: w.recipientId, scope: "read", capability: w.recipientRead, sessionId: RECIPIENT_SESSION },
        { now: () => "2026-10-10T00:00:10.000Z" },
      );
      expectRefusal(
        () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
        "CAPABILITY_REJECTED",
      );
    }
    {
      const w = inboxWorld();
      const resume = capabilityFor(w.active, w.recipientId, "resume", { sessionId: RECIPIENT_SESSION });
      releaseOwnership(
        w.active.store,
        { participantId: w.recipientId, sessionId: RECIPIENT_SESSION, fencingToken: 1, capability: resume },
        { now: () => "2026-10-10T00:00:10.000Z" },
      );
      detachSession(
        w.active.store,
        { participantId: w.recipientId, sessionId: RECIPIENT_SESSION, capability: resume },
        { now: () => "2026-10-10T00:00:11.000Z" },
      );
      expectRefusal(
        () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
        "CAPABILITY_REJECTED",
      );
    }
  });

  it("rejects discovery after ownership release", () => {
    const w = inboxWorld();
    const resume = capabilityFor(w.active, w.recipientId, "resume", { sessionId: RECIPIENT_SESSION });
    releaseOwnership(
      w.active.store,
      { participantId: w.recipientId, sessionId: RECIPIENT_SESSION, fencingToken: 1, capability: resume },
      { now: () => "2026-10-10T00:00:10.000Z" },
    );
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "OWNERSHIP_NOT_CURRENT",
    );
  });

  it("fails closed for duplicate exact correlation", () => {
    const w = inboxWorld();
    const sent = sendTo(w, recipientEndpoint, "duplicate", 10);
    const db = privileged(w.active);
    try {
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_created', ?, ?, ?, ?, NULL, 1)",
      ).run(
        "evt_01ARZ3NDEKTSV4RRFFQ69G5FZX",
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
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed for an orphan Audit candidate and returns no partial metadata", () => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, "valid-before-orphan", 10);
    insertOrphanAudit(w);
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed for an observed Audit row with an unknown kind", () => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, "valid-before-invalid-kind", 10);
    const db = privileged(w.active);
    try {
      const sequence = Number(
        db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
      ) + 1;
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'corrupt_kind', 'corrupt-subject', ?, NULL, NULL, NULL, 1)",
      ).run(
        "evt_01ARZ3NDEKTSV4RRFFQ69G5FZW",
        w.exchangeId,
        sequence,
        "2026-10-10T00:00:11.000Z",
      );
    } finally {
      db.close();
    }
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it.each([
    ["event id", { eventId: "invalid-event", subjectId: "noise", unsafeSequence: false }],
    ["subject", { eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FZV", subjectId: "", unsafeSequence: false }],
    ["sequence", { eventId: "evt_01ARZ3NDEKTSV4RRFFQ69G5FZU", subjectId: "noise", unsafeSequence: true }],
  ] as const)("fails closed for malformed raw Audit %s", (_label, malformed) => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, `valid-before-invalid-${_label}`, 10);
    const db = privileged(w.active);
    try {
      const next = Number(
        db.prepare("SELECT MAX(sequence) AS n FROM audit_event WHERE exchange_id=?").get(w.exchangeId)!.n,
      ) + 1;
      db.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, outcome, private_revision) VALUES (?, ?, ?, 'message_state_changed', ?, ?, NULL, NULL, NULL, 1)",
      ).run(
        malformed.eventId,
        w.exchangeId,
        malformed.unsafeSequence ? Number.MAX_SAFE_INTEGER + 1 : next,
        malformed.subjectId,
        "2026-10-10T00:00:11.000Z",
      );
    } finally {
      db.close();
    }
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed for exact-correlation field mismatch", () => {
    const w = inboxWorld();
    insertRawMessageCandidate(w, { auditDigest: "f".repeat(64) });
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed for malformed Message metadata", () => {
    const w = inboxWorld();
    insertRawMessageCandidate(w, { toEndpointJson: JSON.stringify({ adapter: "adapter-a" }) });
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("fails closed for a malformed durable recipient endpoint binding", () => {
    const w = inboxWorld();
    const db = privileged(w.active);
    try {
      db.exec("DROP TRIGGER participant_identity_immutable");
      db.prepare("UPDATE participant SET endpoint_adapter='' WHERE participant_id=?").run(w.recipientId);
    } finally {
      db.close();
    }
    expectRefusal(
      () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
      "STORAGE_IDEMPOTENCY_CORRUPT",
    );
  });

  it("documents that a Message with no creation Audit is undiscoverable rather than globally proven valid", () => {
    const w = inboxWorld();
    const body = Uint8Array.from([4, 5, 6]);
    const digest = createHash("sha256").update(body).digest("hex");
    const db = privileged(w.active);
    try {
      db.prepare(
        "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, NULL, 1)",
      ).run(
        "msg_01ARZ3NDEKTSV4RRFFQ69G5FAX",
        w.exchangeId,
        JSON.stringify(senderEndpoint),
        JSON.stringify(recipientEndpoint),
        digest,
        body.byteLength,
        body,
        "2026-10-10T00:00:10.000Z",
      );
    } finally {
      db.close();
    }
    expect(discoverInboxMessages(w.active.store, listRequest(w, { afterAuditSequence: 4 }), { now: () => AT_LIST })).toEqual({
      messages: [],
      continuationAuditSequence: null,
      scanBudgetExhausted: false,
    });
  });

  it("does not mutate ACK state, delivery cursors, or any persistent discovery state", () => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, "zero-write-list", 10);
    const before = rowCounts(w.active);
    const result = discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST });
    expect(result.messages).toHaveLength(1);
    expect(rowCounts(w.active)).toEqual(before);
    expect(cursorCount(w.active)).toBe(0);
    const db = reader(w.active);
    try {
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE '%discovery%'").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("classifies Inbox lock contention as BUSY without retry or writes", () => {
    const w = inboxWorld();
    sendTo(w, recipientEndpoint, "busy-list", 10);
    const before = rowCounts(w.active);
    const blocker = resolveSqliteDriver().open(w.active.databasePath);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      const error = expectRefusal(
        () => discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST }),
        "STORAGE_TRANSACTION_BUSY",
      );
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
      expect(rowCounts(w.active)).toEqual(before);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("publishes no Inbox result after an INDETERMINATE commit outcome", () => {
    const w = inboxWorld();
    const sent = sendTo(w, recipientEndpoint, "indeterminate-list", 10);
    const original = w.active.store.database.exec.bind(w.active.store.database);
    w.active.store.database.exec = (sql) => {
      const result = original(sql);
      if (sql === "COMMIT") throw new Error("SENSITIVE_SECRET");
      return result;
    };
    let published: ReturnType<typeof discoverInboxMessages> | undefined;
    const error = expectRefusal(
      () => {
        published = discoverInboxMessages(w.active.store, listRequest(w), { now: () => AT_LIST });
      },
      "STORAGE_TRANSACTION_FAILED",
    );
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(published).toBeUndefined();
    expect(() => w.active.store.database.prepare("SELECT 1")).toThrow();

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(discoverInboxMessages(reopened, listRequest(w), { now: () => AT_LIST }).messages).toEqual([
        { message: sent.message, auditSequence: sent.auditSequence },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("repeats stateless discovery after Store restart", () => {
    const w = inboxWorld();
    const sent = sendTo(w, recipientEndpoint, "restart", 10);
    w.active.store.close();
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(discoverInboxMessages(reopened, listRequest(w), { now: () => AT_LIST }).messages).toEqual([
        { message: sent.message, auditSequence: sent.auditSequence },
      ]);
    } finally {
      reopened.close();
    }
  });

  it("uses the Schema v5 ordering and exact-correlation indexes", () => {
    const w = inboxWorld();
    const db = reader(w.active);
    try {
      const scanPlan = JSON.stringify(
        db.prepare(
          "EXPLAIN QUERY PLAN SELECT event_id, exchange_id, sequence, kind, subject_id FROM audit_event WHERE exchange_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?",
        ).all(w.exchangeId, 0, 10),
      );
      const correlationPlan = JSON.stringify(
        db.prepare(
          "EXPLAIN QUERY PLAN SELECT event_id FROM audit_event WHERE exchange_id=? AND kind='message_created' AND subject_id=? LIMIT 2",
        ).all(w.exchangeId, "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      );
      expect(scanPlan).toMatch(/idx_audit_event_exchange|sqlite_autoindex_audit_event/);
      expect(correlationPlan).toContain("idx_audit_event_correlation");
    } finally {
      db.close();
    }
  });
});
