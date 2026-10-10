import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createMessage } from "../../src/storage/creation.js";
import { joinExchange, readExchangeMembership } from "../../src/storage/participant.js";
import { openStore } from "../../src/storage/store.js";
import {
  auditRows,
  capabilityFor,
  cleanupFixtures,
  exchange,
  expectRefusal,
  fixture,
  LATER,
  NOW,
  participant,
  privileged,
  reader,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/** B3-P1B: durable Exchange membership, the immutable join boundary, and the
 * accepted per-Exchange audit discipline, against real SQLite. */

afterEach(cleanupFixtures);

const from = { adapter: "adapter-a", endpointId: "endpoint-1" };
const to = { adapter: "adapter-a", endpointId: "endpoint-2" };

function message(active: Fixture, exchangeId: string, idempotencyKey: string, at = NOW): string {
  return createMessage(
    active.store,
    { exchangeId, from, to, payload: Uint8Array.from([1, 2, 3]), idempotencyKey },
    { now: () => at },
  ).message.messageId;
}

interface Joined {
  readonly exchangeId: string;
  readonly participantId: string;
  readonly capability: string;
}

function joinable(active: Fixture, endpointId = "endpoint-1", exchangeKey = "exchange-key"): Joined {
  const exchangeId = exchange(active, exchangeKey);
  const participantId = participant(active, endpointId).participant.participantId;
  return { exchangeId, participantId, capability: capabilityFor(active, participantId, "join") };
}

describe("Exchange membership join (B3-P1B)", () => {
  it("records authorized membership with one audit event and an immutable boundary", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);

    const joined = joinExchange(
      active.store,
      { exchangeId, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    expect(joined.disposition).toBe("CREATED");
    // exchange_opened is sequence 1, so the join boundary is sequence 2.
    expect(joined.membership).toEqual({ exchangeId, participantId, joinBoundarySeq: 2, createdAt: LATER });
    expect(Object.isFrozen(joined.membership)).toBe(true);
    expect(joined.record).toEqual({ entityId: participantId, requestDigest: joined.record.requestDigest, createdAt: LATER });

    expect(readExchangeMembership(active.store, exchangeId, participantId)).toEqual(joined.membership);
    expect(auditRows(active, exchangeId)).toEqual([
      { sequence: 1, kind: "exchange_opened", subject: exchangeId },
      { sequence: 2, kind: "participant_joined", subject: participantId },
    ]);
    expect(rowCounts(active)).toMatchObject({ membership: "1", audits: "2", ownership: "0", cursor: "0" });
  });

  it("keeps membership rows and the join boundary immutable in storage", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);
    joinExchange(active.store, { exchangeId, participantId, capability, idempotencyKey: "join-1" }, { now: () => LATER });

    const db = privileged(active);
    try {
      expect(() =>
        db.prepare("UPDATE exchange_membership SET join_boundary_seq = 99 WHERE exchange_id = ?").run(exchangeId),
      ).toThrow(/immutable/);
      expect(() => db.exec("DELETE FROM exchange_membership")).toThrow(/immutable/);
    } finally {
      db.close();
    }
    expect(readExchangeMembership(active.store, exchangeId, participantId)?.joinBoundarySeq).toBe(2);
  });

  it("separates history before the join boundary from activity after it", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);
    const before = message(active, exchangeId, "msg-before");
    const joined = joinExchange(
      active.store,
      { exchangeId, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    const after = message(active, exchangeId, "msg-after", LATER);

    const boundary = joined.membership.joinBoundarySeq;
    const events = auditRows(active, exchangeId);
    const sequenceOf = (messageId: string): number => {
      const row = events.find((event) => event.subject === messageId);
      if (row === undefined) throw new Error("missing audit event for message");
      return row.sequence;
    };
    // The pre-join Message is strictly before the boundary (excluded); the
    // post-join Message is strictly after it (eligible).
    expect(sequenceOf(before)).toBeLessThan(boundary);
    expect(sequenceOf(after)).toBeGreaterThan(boundary);
    expect(events.map((event) => event.kind)).toEqual([
      "exchange_opened",
      "message_created",
      "participant_joined",
      "message_created",
    ]);

    // Historical Message rows are never rewritten by a join.
    const view = reader(active);
    try {
      expect(view.prepare("SELECT message_id, state, CAST(private_revision AS TEXT) AS rev FROM message ORDER BY created_at, message_id").all()).toEqual([
        { message_id: before, state: "CREATED", rev: "1" },
        { message_id: after, state: "CREATED", rev: "1" },
      ]);
    } finally {
      view.close();
    }
  });

  it("replays a duplicate join with zero writes and an unchanged boundary", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);
    const joined = joinExchange(
      active.store,
      { exchangeId, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    const before = rowCounts(active);

    const replayed = joinExchange(
      active.store,
      { exchangeId, participantId, capability, idempotencyKey: "join-1" },
      { now: () => "2026-10-10T02:00:00.000Z" },
    );
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.membership).toEqual(joined.membership);
    expect(replayed.record).toEqual(joined.record);
    expect(rowCounts(active)).toEqual(before);
    expect(auditRows(active, exchangeId).filter((event) => event.kind === "participant_joined")).toHaveLength(1);
  });

  it("refuses a conflicting request on an existing join key", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);
    const other = participant(active, "endpoint-other").participant.participantId;
    const otherCapability = capabilityFor(active, other, "join");
    joinExchange(active.store, { exchangeId, participantId, capability, idempotencyKey: "join-1" }, { now: () => LATER });
    const before = rowCounts(active);

    expectRefusal(
      () =>
        joinExchange(
          active.store,
          { exchangeId, participantId: other, capability: otherCapability, idempotencyKey: "join-1" },
          { now: () => LATER },
        ),
      "IDEMPOTENCY_KEY_CONFLICT",
    );
    expect(rowCounts(active)).toEqual(before);
  });

  it("refuses an unauthorized join with zero writes", () => {
    const active = fixture();
    const { exchangeId, participantId } = joinable(active);
    const before = rowCounts(active);

    for (const capability of [`cap_${"ab".repeat(32)}`, undefined, participantId]) {
      expectRefusal(
        () =>
          joinExchange(
            active.store,
            { exchangeId, participantId, capability, idempotencyKey: "join-unauthorized" },
            { now: () => LATER },
          ),
        "CAPABILITY_REJECTED",
      );
    }
    // A capability for another scope never authorizes a join either.
    expectRefusal(
      () =>
        joinExchange(
          active.store,
          {
            exchangeId,
            participantId,
            capability: capabilityFor(active, participantId, "bind"),
            idempotencyKey: "join-unauthorized",
          },
          { now: () => LATER },
        ),
      "CAPABILITY_REJECTED",
    );
    expect(rowCounts(active)).toMatchObject({ membership: "0", audits: "1" });
    expect(rowCounts(active).records).toBe(before.records);
    expect(readExchangeMembership(active.store, exchangeId, participantId)).toBeUndefined();
  });

  it("refuses joins for a missing Participant, missing Exchange, or closed Exchange", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);

    expectRefusal(
      () =>
        joinExchange(
          active.store,
          { exchangeId: "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", participantId, capability, idempotencyKey: "join-missing" },
          { now: () => LATER },
        ),
      "STORAGE_EXCHANGE_NOT_FOUND",
    );

    const db = privileged(active);
    try {
      db.prepare("UPDATE exchange SET state = 'CLOSED', closed_at = ? WHERE exchange_id = ?").run(LATER, exchangeId);
    } finally {
      db.close();
    }
    expectRefusal(
      () =>
        joinExchange(
          active.store,
          { exchangeId, participantId, capability, idempotencyKey: "join-closed" },
          { now: () => LATER },
        ),
      "EXCHANGE_JOIN_REJECTED",
    );
    expect(rowCounts(active)).toMatchObject({ membership: "0" });
  });

  it("supports two Participants in one Exchange with distinct boundaries", () => {
    const active = fixture();
    const exchangeId = exchange(active);
    const first = participant(active, "endpoint-1").participant.participantId;
    const second = participant(active, "endpoint-2").participant.participantId;

    const firstJoin = joinExchange(
      active.store,
      {
        exchangeId,
        participantId: first,
        capability: capabilityFor(active, first, "join"),
        idempotencyKey: "join-first",
      },
      { now: () => LATER },
    );
    message(active, exchangeId, "msg-between", LATER);
    const secondJoin = joinExchange(
      active.store,
      {
        exchangeId,
        participantId: second,
        capability: capabilityFor(active, second, "join"),
        idempotencyKey: "join-second",
      },
      { now: () => LATER },
    );

    expect(firstJoin.membership.joinBoundarySeq).toBe(2);
    expect(secondJoin.membership.joinBoundarySeq).toBe(4);
    expect(auditRows(active, exchangeId).map((event) => event.kind)).toEqual([
      "exchange_opened",
      "participant_joined",
      "message_created",
      "participant_joined",
    ]);
    expect(rowCounts(active).membership).toBe("2");
  });

  it("supports one Participant joining two Exchanges independently", () => {
    const active = fixture();
    const participantId = participant(active, "endpoint-1").participant.participantId;
    const capability = capabilityFor(active, participantId, "join");
    const firstExchange = exchange(active, "exchange-a");
    const secondExchange = exchange(active, "exchange-b");

    // The same idempotency key is Exchange-scoped, exactly as in B2.
    const a = joinExchange(
      active.store,
      { exchangeId: firstExchange, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    const b = joinExchange(
      active.store,
      { exchangeId: secondExchange, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    expect(a.disposition).toBe("CREATED");
    expect(b.disposition).toBe("CREATED");
    expect(a.membership.joinBoundarySeq).toBe(2);
    expect(b.membership.joinBoundarySeq).toBe(2);
    expect(rowCounts(active).membership).toBe("2");
    expect(readExchangeMembership(active.store, firstExchange, participantId)?.exchangeId).toBe(firstExchange);
    expect(readExchangeMembership(active.store, secondExchange, participantId)?.exchangeId).toBe(secondExchange);
  });

  it("persists membership across close and reopen", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);
    const joined = joinExchange(
      active.store,
      { exchangeId, participantId, capability, idempotencyKey: "join-1" },
      { now: () => LATER },
    );
    active.store.close();

    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      expect(readExchangeMembership(reopened, exchangeId, participantId)).toEqual(joined.membership);
      // Replay still works after reopen, with zero writes.
      const replayed = joinExchange(
        reopened,
        { exchangeId, participantId, capability, idempotencyKey: "join-1" },
        { now: () => LATER },
      );
      expect(replayed.disposition).toBe("REPLAYED");
      expect(replayed.membership).toEqual(joined.membership);
    } finally {
      reopened.close();
    }
  });

  it("serializes concurrent joins: contention is BUSY, and the winner's key replays", () => {
    const active = fixture();
    const { exchangeId, participantId, capability } = joinable(active);

    // A separate writer holding the write lock makes the join fail BUSY with
    // the accepted retryable classification and zero writes.
    const holder = new DatabaseSync(active.databasePath);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const error = expectRefusal(
        () =>
          joinExchange(
            active.store,
            { exchangeId, participantId, capability, idempotencyKey: "join-1" },
            { now: () => LATER },
          ),
        "STORAGE_TRANSACTION_BUSY",
      );
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(rowCounts(active)).toMatchObject({ membership: "0", audits: "1" });

    // Two independent connections racing the same join key: exactly one
    // membership row, one audit event, and an unchanged boundary.
    const second = openStore({ directory: active.directory, filename: active.filename });
    try {
      const winner = joinExchange(
        active.store,
        { exchangeId, participantId, capability, idempotencyKey: "join-1" },
        { now: () => LATER },
      );
      const loser = joinExchange(
        second,
        { exchangeId, participantId, capability, idempotencyKey: "join-1" },
        { now: () => "2026-10-10T03:00:00.000Z" },
      );
      expect(winner.disposition).toBe("CREATED");
      expect(loser.disposition).toBe("REPLAYED");
      expect(loser.membership).toEqual(winner.membership);
    } finally {
      second.close();
    }
    expect(rowCounts(active)).toMatchObject({ membership: "1", audits: "2" });
  });
});
