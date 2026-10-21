import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPERATIONAL_CAPABILITY_SCOPES,
  P1_CAPABILITY_SCOPES,
  P2A_CAPABILITY_SCOPES,
  P2B_CAPABILITY_SCOPES,
  P3A_CAPABILITY_SCOPES,
  P4C_CAPABILITY_SCOPES,
  SESSION_BOUND_CAPABILITY_SCOPES,
} from "../../src/storage/capability.js";
import { readMessageMetadataInTransaction } from "../../src/storage/creation.js";
import { readMessageMetadata, readMessagePayload, sendMessage } from "../../src/storage/messaging.js";
import {
  acquireOwnership,
  authorizeCurrentOwner,
  bindSession,
  detachSession,
  releaseOwnership,
  verifyOwnership,
} from "../../src/storage/ownership.js";
import { issueCapability, joinExchange, readCapabilityStatus, revokeCapability, runOwned } from "../../src/storage/participant.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectRefusal,
  exchange,
  expectedDigest,
  fixture,
  NOW,
  participant,
  reader,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P3B (E1, authorization slice): the independent operational `ack`
 * capability scope and its Session binding.
 *
 * This suite pins exactly the authorized boundary and nothing beyond it:
 * - `ack` joins the operational and Session-bound scope unions; no earlier
 *   phase scope is widened.
 * - Issuance requires the exact Session binding (an ATTACHED Session of the
 *   Participant) and persists only the host-keyed digest.
 * - `authorizeCurrentOwner` accepts the explicit `ack` scope and applies the
 *   full current-Owner chain: attached bound Session, current Owner Session,
 *   exact fencing, unexpired and non-regressed lease.
 * - Wrong Session, detached Session, stale fence, expired lease, clock
 *   regression, revoked, expired, wrong-scope, and forged credentials all
 *   fail closed BEFORE any replay-style protected lookup, with zero durable
 *   writes.
 * - `ack` stays cryptographically and semantically disjoint from
 *   `resume`/`send`/`read`/`payload_read` in both directions.
 * - This E1 authorization seam never executes ACK or writes receipt evidence,
 *   including under the current E2-A receipt-capable schema.
 *
 * The protected lookup below is the smallest private testable seam consistent
 * with the current patterns: authorization runs first inside one owned
 * transaction, then an instrumented replay-style Message lookup — exactly the
 * shape a future ACK operation must keep. Nothing here invents a receipt or
 * replay engine.
 */

afterEach(cleanupFixtures);

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV"; // current Owner Session
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW"; // bound, never Owner
const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX"; // bound, later DETACHED
const UNBOUND = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const SENDER_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0"; // the sender Participant's own Session
const FORGED = `cap_${"ab".repeat(32)}`;

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const clockAt = (seconds: number) => ({ now: () => at(seconds) });

const ownerEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "ack-owner" });
const senderEndpoint = Object.freeze({ adapter: "adapter-a", endpointId: "ack-sender" });
const payload = new Uint8Array([7, 7, 7, 7]);

interface AckWorld {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly ownerId: string;
  readonly senderId: string;
  readonly messageId: string;
  readonly attach: string;
  readonly ackFor: (sessionId: string, options?: { readonly expiresAt?: string }) => string;
}

function ackWorld(): AckWorld {
  const active = fixture("ce-b3-p3b-ack-");
  const exchangeId = exchange(active);
  const ownerId = participant(active, ownerEndpoint.endpointId).participant.participantId;
  const senderId = participant(active, senderEndpoint.endpointId).participant.participantId;

  const attach = capabilityFor(active, ownerId, "attach");
  for (const sessionId of [S1, S2, S3]) {
    bindSession(active.store, { participantId: ownerId, sessionId, capability: attach }, clockAt(0));
  }
  acquireOwnership(active.store, { participantId: ownerId, sessionId: S1, capability: attach }, clockAt(0));

  const senderAttach = capabilityFor(active, senderId, "attach");
  bindSession(active.store, { participantId: senderId, sessionId: SENDER_SESSION, capability: senderAttach }, clockAt(0));
  acquireOwnership(active.store, { participantId: senderId, sessionId: SENDER_SESSION, capability: senderAttach }, clockAt(0));

  joinExchange(active.store, { exchangeId, participantId: ownerId, capability: capabilityFor(active, ownerId, "join"), idempotencyKey: `join-${ownerId}` }, clockAt(0));
  joinExchange(active.store, { exchangeId, participantId: senderId, capability: capabilityFor(active, senderId, "join"), idempotencyKey: `join-${senderId}` }, clockAt(0));

  const senderSend = capabilityFor(active, senderId, "send", { sessionId: SENDER_SESSION });
  const sent = sendMessage(
    active.store,
    {
      participantId: senderId,
      sessionId: SENDER_SESSION,
      fencingToken: 1,
      capability: senderSend,
      message: { exchangeId, from: senderEndpoint, to: ownerEndpoint, payload, idempotencyKey: "ack-target-1" },
    },
    clockAt(5),
  );

  const ackFor = (sessionId: string, options: { readonly expiresAt?: string } = {}) =>
    capabilityFor(active, ownerId, "ack", {
      sessionId,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    });

  return { active, exchangeId, ownerId, senderId, messageId: sent.message.messageId, attach, ackFor };
}

/** Deterministic snapshot of every existing durable plane that ACK authority
 * must not mutate. The fixture has no concurrent writer while snapshots are
 * compared, so any difference is attributable to the exercised call. */
function durable(active: Fixture): string {
  const view = reader(active);
  try {
    const all = (sql: string) => view.prepare(sql).all();
    return JSON.stringify({
      counts: rowCounts(active),
      sessions: all("SELECT * FROM participant_session ORDER BY participant_id, session_id"),
      ownership: all("SELECT * FROM participant_ownership ORDER BY participant_id"),
      fencing: all(
        "SELECT participant_id, CAST(fencing_token AS TEXT) AS token, private_revision FROM participant_fencing_high_water ORDER BY participant_id",
      ),
      attempts: all("SELECT * FROM attempt ORDER BY rowid"),
      claims: all("SELECT * FROM current_claim ORDER BY rowid"),
      cursors: all("SELECT * FROM delivery_cursor ORDER BY rowid"),
      results: all("SELECT * FROM result ORDER BY rowid"),
      capabilities: all("SELECT * FROM participant_capability ORDER BY capability_digest"),
      audits: all("SELECT * FROM audit_event ORDER BY exchange_id, sequence"),
      messages: all(
        "SELECT * FROM message ORDER BY message_id",
      ),
    });
  } finally {
    view.close();
  }
}

interface LookupPresentation {
  readonly sessionId: string;
  readonly fencingToken: number;
  readonly capability: unknown;
}

interface LookupOutcome {
  readonly result?: { readonly ownership: unknown; readonly message: unknown };
  readonly error?: unknown;
  readonly statements: readonly string[];
}

/** The instrumented replay-style protected lookup that a future ACK operation
 * would run: exact-scope current-Owner authorization first, Message lookup
 * only afterwards, inside one owned IMMEDIATE transaction. Every prepared
 * statement is recorded so a refusal can be proven to leave the protected
 * lookup unreachable. */
function ackProtectedLookup(w: AckWorld, presentation: LookupPresentation, seconds: number): LookupOutcome {
  const db = w.active.store.database;
  const originalOwnPrepare = Object.getOwnPropertyDescriptor(db, "prepare");
  const originalPrepare = db.prepare;
  const statements: string[] = [];
  db.prepare = ((sql: string) => {
    statements.push(sql);
    return Reflect.apply(originalPrepare, db, [sql]);
  }) as typeof db.prepare;
  try {
    const result = runOwned(w.active.store, "Ack-authorized protected lookup", (tx) => {
      const ownership = authorizeCurrentOwner(tx, w.active.store, {
        participantId: w.ownerId,
        sessionId: presentation.sessionId,
        fencingToken: presentation.fencingToken,
        capability: presentation.capability,
        scope: "ack",
        now: at(seconds),
      });
      const message = readMessageMetadataInTransaction(tx, w.exchangeId, w.messageId);
      return { ownership, message };
    });
    return { result, statements };
  } catch (error) {
    return { error, statements };
  } finally {
    if (originalOwnPrepare === undefined) {
      Reflect.deleteProperty(db, "prepare");
    } else {
      Object.defineProperty(db, "prepare", originalOwnPrepare);
    }
  }
}


/** Statements that touched the protected Message plane: none may run before
 * authorization has passed. */
function protectedLookupCount(statements: readonly string[]): number {
  return statements.filter((sql) => /FROM message\b/.test(sql)).length;
}

/** A refused ack presentation: the exact code, an unreachable protected
 * lookup, and zero durable writes — all in one assertion set. */
function refusedLookup(w: AckWorld, presentation: LookupPresentation, seconds: number, code: string): LookupOutcome {
  const before = durable(w.active);
  const changes = w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n;
  const outcome = ackProtectedLookup(w, presentation, seconds);
  expect(outcome.error).toMatchObject({ code });
  expect(protectedLookupCount(outcome.statements), `${code} must refuse before the protected lookup`).toBe(0);
  expect(durable(w.active), `${code} wrote durable state`).toBe(before);
  expect(w.active.store.database.prepare("SELECT total_changes() AS n").get()!.n).toBe(changes);
  return outcome;
}

function zeroWrite(active: Fixture, run: () => unknown, code: string): unknown {
  const before = durable(active);
  const error = expectRefusal(run, code);
  expect(durable(active), `${code} wrote durable state`).toBe(before);
  return error;
}

function statusOf(w: AckWorld, capability: string, sessionId: string, seconds: number): string {
  return readCapabilityStatus(
    w.active.store,
    { capability, participantId: w.ownerId, scope: "ack", sessionId },
    clockAt(seconds),
  );
}

// ---------------------------------------------------------------------------

describe("independent Session-bound ack capability scope (CE-0002-B3-P3B E1)", () => {
  it("adds ack to the operational and Session-bound unions without widening any earlier phase scope", () => {
    for (const earlier of [P1_CAPABILITY_SCOPES, P2A_CAPABILITY_SCOPES, P2B_CAPABILITY_SCOPES, P3A_CAPABILITY_SCOPES, P4C_CAPABILITY_SCOPES]) {
      expect(earlier).not.toContain("ack");
    }
    expect(OPERATIONAL_CAPABILITY_SCOPES).toContain("ack");
    expect(SESSION_BOUND_CAPABILITY_SCOPES).toContain("ack");
    // The unions stay duplicate-free and coherent: every Session-bound scope
    // is operational, and `send`/`read`/`payload_read`/`resume` never became
    // acknowledgment authorities.
    expect(new Set(OPERATIONAL_CAPABILITY_SCOPES).size).toBe(OPERATIONAL_CAPABILITY_SCOPES.length);
    for (const scope of SESSION_BOUND_CAPABILITY_SCOPES) {
      expect(OPERATIONAL_CAPABILITY_SCOPES).toContain(scope);
    }
  });

  it("issues ack only under an exact currently bound Session and persists only the keyed digest", () => {
    const w = ackWorld();
    // Issuance without a Session binding is a request refusal, zero-write.
    zeroWrite(
      w.active,
      () => issueCapability(w.active.store, { participantId: w.ownerId, scope: "ack" }, clockAt(10)),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    zeroWrite(
      w.active,
      () => issueCapability(w.active.store, { participantId: w.ownerId, scope: "ack", sessionId: UNBOUND }, clockAt(10)),
      "SESSION_NOT_BOUND",
    );

    const issued = issueCapability(w.active.store, { participantId: w.ownerId, scope: "ack", sessionId: S1 }, clockAt(10));
    expect(issued).toMatchObject({ participantId: w.ownerId, scope: "ack", sessionId: S1, trustGeneration: 1 });

    const view = reader(w.active);
    try {
      const rows = view
        .prepare(
          "SELECT capability_digest, participant_id, scope, trust_generation, expires_at, revoked_at, session_id FROM participant_capability WHERE scope='ack'",
        )
        .all();
      expect(rows).toEqual([
        {
          capability_digest: expectedDigest(1, w.ownerId, "ack", issued.capability),
          participant_id: w.ownerId,
          scope: "ack",
          trust_generation: 1,
          expires_at: null,
          revoked_at: null,
          session_id: S1,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain(issued.capability);
      const durableArtifacts = [w.active.databasePath, `${w.active.databasePath}-wal`]
        .map((path) => {
          try {
            return readFileSync(path).toString("latin1");
          } catch {
            return "";
          }
        })
        .join("");
      expect(durableArtifacts).not.toContain(issued.capability);
    } finally {
      view.close();
    }
  });

  it("never issues ack for a DETACHED Session", () => {
    const w = ackWorld();
    const resume3 = capabilityFor(w.active, w.ownerId, "resume", { sessionId: S3 });
    detachSession(w.active.store, { participantId: w.ownerId, sessionId: S3, capability: resume3 }, clockAt(10));
    zeroWrite(
      w.active,
      () => issueCapability(w.active.store, { participantId: w.ownerId, scope: "ack", sessionId: S3 }, clockAt(11)),
      "SESSION_NOT_BOUND",
    );
  });

  it("authorizes the current Owner under the explicit ack scope and reaches the protected lookup only afterwards", () => {
    const w = ackWorld();
    const ack = w.ackFor(S1);
    const before = durable(w.active);

    const outcome = ackProtectedLookup(w, { sessionId: S1, fencingToken: 1, capability: ack }, 30);
    expect(outcome.error).toBeUndefined();
    expect(outcome.result!.ownership).toMatchObject({ participantId: w.ownerId, sessionId: S1, fencingToken: 1 });
    expect(outcome.result!.message).toMatchObject({ messageId: w.messageId, state: "CREATED" });
    expect(protectedLookupCount(outcome.statements)).toBeGreaterThanOrEqual(1);
    // The authorized lookup is a pure read.
    expect(durable(w.active)).toBe(before);
    expect(statusOf(w, ack, S1, 30)).toBe("VALID");
  });

  it("rejects wrong-Session, detached-Session, stale-fence, expired-lease, and regressed-clock presentations before the lookup", () => {
    const w = ackWorld();
    const ack = w.ackFor(S1);

    // Wrong Session: the capability binds S1 exactly; S2 never borrows it.
    refusedLookup(w, { sessionId: S2, fencingToken: 1, capability: ack }, 30, "CAPABILITY_REJECTED");
    expect(statusOf(w, ack, S2, 30)).toBe("SESSION_MISMATCH");
    // A valid capability for an attached but non-current Session also refuses.
    const ack2 = w.ackFor(S2);
    refusedLookup(w, { sessionId: S2, fencingToken: 1, capability: ack2 }, 30, "OWNERSHIP_NOT_CURRENT");

    // Detached Session: the capability died with its Session (D7) — the
    // refusal is authorization, before any ownership evaluation.
    const ack3 = w.ackFor(S3);
    const resume3 = capabilityFor(w.active, w.ownerId, "resume", { sessionId: S3 });
    detachSession(w.active.store, { participantId: w.ownerId, sessionId: S3, capability: resume3 }, clockAt(15));
    refusedLookup(w, { sessionId: S3, fencingToken: 1, capability: ack3 }, 30, "CAPABILITY_REJECTED");
    expect(statusOf(w, ack3, S3, 30)).toBe("SESSION_DETACHED");

    // Stale fence: token 1 after the term moved to token 2; token 2 succeeds.
    releaseOwnership(
      w.active.store,
      { participantId: w.ownerId, sessionId: S1, fencingToken: 1, capability: capabilityFor(w.active, w.ownerId, "resume", { sessionId: S1 }) },
      clockAt(20),
    );
    acquireOwnership(w.active.store, { participantId: w.ownerId, sessionId: S1, capability: w.attach }, clockAt(25));
    refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: ack }, 30, "FENCING_STALE");
    const current = ackProtectedLookup(w, { sessionId: S1, fencingToken: 2, capability: ack }, 30);
    expect(current.error).toBeUndefined();
    expect(current.result!.ownership).toMatchObject({ sessionId: S1, fencingToken: 2 });

    // Expired lease at the serialization instant (term [25, 145)).
    refusedLookup(w, { sessionId: S1, fencingToken: 2, capability: ack }, 145, "LEASE_EXPIRED");
    // Clock regression before the persisted term start.
    refusedLookup(w, { sessionId: S1, fencingToken: 2, capability: ack }, 24, "LEASE_CLOCK_REGRESSION");
  });

  it("rejects revoked, expired, wrong-scope, and forged ack presentations before the lookup", () => {
    const w = ackWorld();

    const revoked = w.ackFor(S1);
    revokeCapability(w.active.store, { participantId: w.ownerId, scope: "ack", capability: revoked, sessionId: S1 }, clockAt(10));
    refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: revoked }, 30, "CAPABILITY_REJECTED");
    expect(statusOf(w, revoked, S1, 30)).toBe("REVOKED");

    const expiring = w.ackFor(S1, { expiresAt: at(20) });
    refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: expiring }, 30, "CAPABILITY_REJECTED");
    expect(statusOf(w, expiring, S1, 30)).toBe("EXPIRED");

    // Cryptographic disjointness: a `send` token derives a different digest
    // under the ack scope, so it is indistinguishable from forged.
    const send = capabilityFor(w.active, w.ownerId, "send", { sessionId: S1 });
    refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: send }, 30, "CAPABILITY_REJECTED");
    expect(statusOf(w, send, S1, 30)).toBe("UNKNOWN");

    refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: FORGED }, 30, "CAPABILITY_REJECTED");
  });

  it("keeps ack disjoint from resume, send, read, and payload_read in both directions", () => {
    const w = ackWorld();
    const ack = w.ackFor(S1);

    // No other Session-bound operation scope authorizes an ack presentation.
    for (const scope of ["resume", "read", "payload_read"] as const) {
      const other = capabilityFor(w.active, w.ownerId, scope, { sessionId: S1 });
      refusedLookup(w, { sessionId: S1, fencingToken: 1, capability: other }, 30, "CAPABILITY_REJECTED");
    }

    // An ack capability authorizes no other operation.
    zeroWrite(
      w.active,
      () =>
        sendMessage(
          w.active.store,
          {
            participantId: w.ownerId,
            sessionId: S1,
            fencingToken: 1,
            capability: ack,
            message: { exchangeId: w.exchangeId, from: ownerEndpoint, to: senderEndpoint, payload, idempotencyKey: "ack-cannot-send" },
          },
          clockAt(30),
        ),
      "CAPABILITY_REJECTED",
    );
    zeroWrite(
      w.active,
      () =>
        readMessageMetadata(
          w.active.store,
          { participantId: w.ownerId, sessionId: S1, fencingToken: 1, capability: ack, exchangeId: w.exchangeId, messageId: w.messageId },
          clockAt(30),
        ),
      "CAPABILITY_REJECTED",
    );
    zeroWrite(
      w.active,
      () =>
        readMessagePayload(
          w.active.store,
          { participantId: w.ownerId, sessionId: S1, fencingToken: 1, capability: ack, exchangeId: w.exchangeId, messageId: w.messageId },
          clockAt(30),
        ),
      "CAPABILITY_REJECTED",
    );
    zeroWrite(
      w.active,
      () =>
        verifyOwnership(
          w.active.store,
          { participantId: w.ownerId, sessionId: S1, fencingToken: 1, capability: ack },
          clockAt(30),
        ),
      "CAPABILITY_REJECTED",
    );
  });

  it("keeps authorization-only lookup non-ACK with the current empty receipt schema", () => {
    const w = ackWorld();
    const ack = w.ackFor(S1);
    const outcome = ackProtectedLookup(w, { sessionId: S1, fencingToken: 1, capability: ack }, 30);
    expect(outcome.error).toBeUndefined();

    const view = reader(w.active);
    try {
      // E2-A rebaseline: table availability is independent of ACK execution.
      expect(view.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_ack_receipt'").all()).toEqual([{name:"delivery_ack_receipt"}]);
      expect(view.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get()).toEqual({n:0});
      expect(view.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 7 });
      // The only audit kinds are the frozen vocabulary: no receipt_recorded
      // row was written by any authorization or lookup above.
      expect(view.prepare("SELECT DISTINCT kind FROM audit_event ORDER BY kind").all()).toEqual([
        { kind: "exchange_opened" }, { kind: "message_created" }, { kind: "participant_joined" },
      ]);
      expect(rowCounts(w.active).cursor).toBe("0");
    } finally {
      view.close();
    }
  });
});
