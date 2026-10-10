import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readCapabilityStatus, revokeCapability } from "../../src/storage/participant.js";
import {
  acquireOwnership,
  bindSession,
  detachSession,
  readCurrentOwnership,
  readFencingHighWater,
  readSessionBinding,
  readSessionBindings,
  readSessionLifecycle,
  reconcileDetach,
  releaseOwnership,
  renewLease,
  takeoverOwnership,
  verifyOwnership,
} from "../../src/storage/ownership.js";
import { issueCapability } from "../../src/storage/participant.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectRefusal,
  fixture,
  NOW,
  participant,
  privileged,
  rowCounts,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2C-B: the authorized Session Detach operation. Detach is the
 * one-way ATTACHED → DETACHED transition performed by the Session's own
 * Session-bound `resume` capability (D4: self only — the capability must
 * authorize exactly its bound Session; a Session ID alone is never a
 * credential). It never modifies ownership or fencing, never deletes the
 * Session row, and never mutates capability rows: the persisted
 * `detached_at` is the lifecycle source of truth, and every Session-bound
 * capability of a DETACHED Session is unusable from then on (D7), refused
 * with one opaque caller-visible classification.
 *
 * Every refusal here is asserted zero-write (row counts and raw rows are
 * compared before and after), and every durable effect runs against real
 * file-backed SQLite.
 */

afterEach(cleanupFixtures);

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX";

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const clockAt = (seconds: number) => ({ now: () => at(seconds) });

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly attach: string;
  readonly resume1: string;
  readonly resume2: string;
  readonly resume3: string;
}

/** A v4 store whose Participant holds S1, S2, S3 (bound at t=0, ATTACHED),
 * each with its own pre-issued `resume` capability, and no ownership yet. */
function world(): World {
  const active = fixture("ce-b3-p2c-b-");
  const participantId = participant(active, "endpoint-detach").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  for (const sessionId of [S1, S2, S3]) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, clockAt(0));
  }
  return {
    active,
    participantId,
    attach,
    resume1: capabilityFor(active, participantId, "resume", { sessionId: S1 }),
    resume2: capabilityFor(active, participantId, "resume", { sessionId: S2 }),
    resume3: capabilityFor(active, participantId, "resume", { sessionId: S3 }),
  };
}

function sessionRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT participant_id, session_id, bound_at, detached_at, private_revision FROM participant_session ORDER BY participant_id, session_id",
    )
    .all();
}

function capabilityRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at, session_id, private_revision FROM participant_capability ORDER BY capability_digest",
    )
    .all();
}

function tamper(active: Fixture, sql: string, ...values: (string | number | null)[]): void {
  const db = privileged(active);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

describe("B3-P2C-B authorized Session detach", () => {
  // -------------------------------------------------------------------------
  // Authorization (D4: Session-bound resume, self only)
  // -------------------------------------------------------------------------
  describe("authorization", () => {
    it("detaches a bound non-Owner Session under its own resume capability, zero side effects", () => {
      const w = world();
      const before = rowCounts(w.active);
      const rowsBefore = sessionRows(w.active.store.database);
      const capsBefore = capabilityRows(w.active.store.database);

      const detach = detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(10));
      expect(detach).toEqual({ participantId: w.participantId, sessionId: S2, boundAt: at(0), detachedAt: at(10) });
      expect(Object.isFrozen(detach)).toBe(true);

      // Exactly the guarded one-way transition: one session row changed.
      expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S2 })).toEqual({
        state: "DETACHED",
        boundAt: at(0),
        detachedAt: at(10),
      });
      expect(readSessionBinding(w.active.store, w.participantId, S2)).toBeUndefined();
      expect(readSessionBindings(w.active.store, w.participantId).map((b) => b.sessionId)).toEqual([S1, S3]);
      expect(rowCounts(w.active)).toEqual(before);
      const rowsAfter = sessionRows(w.active.store.database);
      expect(rowsAfter).toHaveLength(rowsBefore.length);
      const s2 = rowsAfter.find((row) => (row as { session_id: string }).session_id === S2) as Record<string, unknown>;
      expect(s2).toMatchObject({ detached_at: at(10), private_revision: 2 });
      for (const row of rowsAfter) {
        const r = row as Record<string, unknown>;
        if (r.session_id !== S2) expect(r).toEqual(rowsBefore.find((b) => (b as Record<string, unknown>).session_id === r.session_id));
      }
      // Capability rows are never mutated by Detach.
      expect(capabilityRows(w.active.store.database)).toEqual(capsBefore);

      // A detached row is never returned to a later bind or detach.
      expectRefusal(
        () => bindSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(11)),
        "SESSION_ALREADY_BOUND",
      );
    });

    it("requires the resume capability of exactly that Session (never a Session ID alone)", () => {
      const w = world();
      const takeover3 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S3 });
      const expired = capabilityFor(w.active, w.participantId, "resume", { sessionId: S1, expiresAt: at(5) });
      const before = rowCounts(w.active);
      const cases: readonly [string, () => unknown][] = [
        ["attach scope", () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(10))],
        ["takeover scope", () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S3, capability: takeover3 }, clockAt(10))],
        ["resume of another Session", () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume2 }, clockAt(10))],
        ["forged", () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: "cap_" + "0".repeat(64) }, clockAt(10))],
        ["expired", () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: expired }, clockAt(10))],
      ];
      for (const [, run] of cases) {
        expectRefusal(run, "CAPABILITY_REJECTED");
      }
      const revoked = capabilityFor(w.active, w.participantId, "resume", { sessionId: S1 });
      revokeCapability(w.active.store, { participantId: w.participantId, scope: "resume", capability: revoked, sessionId: S1 }, clockAt(9));
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: revoked }, clockAt(10)),
        "CAPABILITY_REJECTED",
      );
      // Only the one additionally issued-and-revoked capability row differs;
      // no Session row moved.
      expect(rowCounts(w.active)).toEqual({ ...before, capability: String(Number(before.capability) + 1) });
      expect(sessionRows(w.active.store.database).every((row) => (row as Record<string, unknown>).detached_at === null)).toBe(true);
    });

    it("refuses malformed requests without echoing values", () => {
      const w = world();
      const before = rowCounts(w.active);
      for (const [label, input] of [
        ["missing capability", { participantId: w.participantId, sessionId: S1 }],
        ["missing sessionId", { participantId: w.participantId, capability: w.resume1 }],
        ["unknown field", { participantId: w.participantId, sessionId: S1, capability: w.resume1, leaseTtlSeconds: 30 }],
        ["not an object", "nope"],
      ] as const) {
        let message = "";
        try {
          detachSession(w.active.store, input, clockAt(10));
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }
        expect(message, label).not.toContain(S1);
        expect(message, label).not.toContain(w.resume1);
        expect(() => detachSession(w.active.store, input, clockAt(10))).toThrowError(/request/i);
      }
      expect(rowCounts(w.active)).toEqual(before);
    });

    it("refuses an unknown Participant or an unbound Session pair", () => {
      const w = world();
      // A second Participant exists so the unknown-presenter case uses a
      // syntactically valid, genuinely existing foreign identity.
      const stranger = participant(w.active, "endpoint-stranger").participant.participantId;
      const before = rowCounts(w.active);
      expectRefusal(
        () => detachSession(w.active.store, { participantId: "par_NEVERISSUED0000000000000", sessionId: S1, capability: w.resume1 }, clockAt(10)),
        "STORAGE_PARTICIPANT_REQUEST_INVALID",
      );
      // A syntactically valid unknown Participant is refused opaquely at the
      // capability boundary: existence is never disclosed to a presenter
      // without a valid capability for that Participant.
      expectRefusal(
        () => detachSession(w.active.store, { participantId: stranger, sessionId: S1, capability: w.resume1 }, clockAt(10)),
        "CAPABILITY_REJECTED",
      );
      // A Session with no binding to this Participant cannot have a matching
      // Session-bound capability, so the refusal is the same opaque one; a
      // foreign-bound Session is equally indistinguishable (no disclosure).
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAZ", capability: w.resume1 }, clockAt(10)),
        "CAPABILITY_REJECTED",
      );
      expect(rowCounts(w.active)).toEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // Ownership interaction (Q5: the current Owner is never detachable)
  // -------------------------------------------------------------------------
  describe("ownership interaction", () => {
    it("allows detach when no ownership row exists", () => {
      const w = world();
      expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
      detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(10));
      expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 }).state).toBe("DETACHED");
      expect(readFencingHighWater(w.active.store, w.participantId)).toBe(0);
    });

    it("allows detach after release, and keeps Q4: an expired Owner cannot release", () => {
      const w = world();
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      // Q4: releasing while live works, then re-acquire and let it expire.
      releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, fencingToken: 1, capability: w.resume1 }, clockAt(10));
      expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(20));
      // Expired: release refuses (Q4 preserved), and Detach of the current
      // Owner refuses regardless of expiry.
      expectRefusal(
        () => releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, fencingToken: 2, capability: w.resume1 }, clockAt(60)),
        "LEASE_EXPIRED",
      );
      const before = rowCounts(w.active);
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(60)),
        "SESSION_IS_CURRENT_OWNER",
      );
      expect(rowCounts(w.active)).toEqual(before);
      // The way out is takeover, after which the former Owner detaches.
      const takeover2 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
      takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: takeover2 }, clockAt(61));
      const detach = detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(62));
      expect(detach).toMatchObject({ sessionId: S1, detachedAt: at(62) });
      expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S2, fencingToken: 3 });
      expect(readFencingHighWater(w.active.store, w.participantId)).toBe(3);
    });

    it("refuses the current Owner in every lease state: live, expired, legacy, clock-regressed", () => {
      const w = world();
      // Live owner.
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      const before = rowCounts(w.active);
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(10)),
        "SESSION_IS_CURRENT_OWNER",
      );
      // Expired owner: still refused (regardless of lease expiry).
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(60)),
        "SESSION_IS_CURRENT_OWNER",
      );
      // Clock-regressed against the lease term: still the current Owner.
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(-1)),
        "SESSION_IS_CURRENT_OWNER",
      );
      // Legacy (NULL lease_started_at) owner: still refused.
      tamper(w.active, "UPDATE participant_ownership SET lease_started_at = NULL");
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(10)),
        "SESSION_IS_CURRENT_OWNER",
      );
      expect(rowCounts(w.active)).toEqual(before);
      expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 }).state).toBe("ATTACHED");
      // A NON-Owner Session detaches freely while the Owner row exists.
      detachSession(w.active.store, { participantId: w.participantId, sessionId: S3, capability: w.resume3 }, clockAt(11));
      expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    });

    it("refuses a clock regressed before the binding instant, and allows exactly the binding instant", () => {
      const w = world();
      const before = rowCounts(w.active);
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(-0.001)),
        "SESSION_CLOCK_REGRESSION",
      );
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, { now: () => "2026-10-09T23:59:59.999Z" }),
        "SESSION_CLOCK_REGRESSION",
      );
      expect(rowCounts(w.active)).toEqual(before);
      // Exactly bound_at is the earliest permitted detach instant.
      expect(detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(0)))
        .toMatchObject({ detachedAt: at(0) });
    });

    it("refuses corrupt ownership zero-write", () => {
      const w = world();
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 5 WHERE participant_id = ?", w.participantId);
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(10)),
        "STORAGE_OWNERSHIP_CORRUPT",
      );
    });

    it("derives every concurrent outcome from the serialized durable state", () => {
      // Concurrent release commits first: the Session is no longer the Owner,
      // so the serialized Detach succeeds.
      {
        const w = world();
        acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
        releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, fencingToken: 1, capability: w.resume1 }, clockAt(10));
        expect(detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(11)).detachedAt).toBe(at(11));
      }
      // Concurrent takeover commits first: the superseded former Owner
      // detaches; the new Owner does not.
      {
        const w = world();
        acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
        const takeover3 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S3 });
        takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: takeover3 }, clockAt(60));
        detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(61));
        expectRefusal(
          () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S3, capability: w.resume3 }, clockAt(61)),
          "SESSION_IS_CURRENT_OWNER",
        );
      }
      // Concurrent renew commits first: the Session is still the current
      // Owner, so the serialized Detach refuses.
      {
        const w = world();
        acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
        renewLease(w.active.store, { participantId: w.participantId, sessionId: S1, fencingToken: 1, capability: w.resume1, leaseTtlSeconds: 30 }, clockAt(10));
        expectRefusal(
          () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(11)),
          "SESSION_IS_CURRENT_OWNER",
        );
        expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
      }
      // Detach commits first: every later Owner operation on that Session is
      // refused by the unusable capability (D7), zero-write.
      {
        const w = world();
        acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
        releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2 }, clockAt(10));
        detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(11));
        const before = rowCounts(w.active);
        expectRefusal(
          () => renewLease(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2, leaseTtlSeconds: 30 }, clockAt(12)),
          "CAPABILITY_REJECTED",
        );
        expectRefusal(
          () => releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2 }, clockAt(12)),
          "CAPABILITY_REJECTED",
        );
        expectRefusal(
          () => verifyOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2 }, clockAt(12)),
          "CAPABILITY_REJECTED",
        );
        expect(rowCounts(w.active)).toEqual(before);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Capability lifecycle (D7: detached_at is the source of truth)
  // -------------------------------------------------------------------------
  describe("capability lifecycle", () => {
    it("makes every Session-bound capability of a DETACHED Session unusable, opaquely", () => {
      const w = world();
      const takeover2 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(10));
      const before = rowCounts(w.active);
      const rowsBefore = sessionRows(w.active.store.database);
      const capsBefore = capabilityRows(w.active.store.database);

      // Host-local diagnostics identify SESSION_DETACHED.
      expect(
        readCapabilityStatus(w.active.store, { capability: w.resume2, participantId: w.participantId, scope: "resume", sessionId: S2 }, clockAt(11)),
      ).toBe("SESSION_DETACHED");
      expect(
        readCapabilityStatus(w.active.store, { capability: takeover2, participantId: w.participantId, scope: "takeover", sessionId: S2 }, clockAt(11)),
      ).toBe("SESSION_DETACHED");

      // Caller-visible refusals stay one opaque classification.
      expectRefusal(
        () => renewLease(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2, leaseTtlSeconds: 30 }, clockAt(11)),
        "CAPABILITY_REJECTED",
      );
      expectRefusal(
        () => releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2 }, clockAt(11)),
        "CAPABILITY_REJECTED",
      );
      expectRefusal(
        () => verifyOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: w.resume2 }, clockAt(11)),
        "CAPABILITY_REJECTED",
      );
      expectRefusal(
        () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: takeover2 }, clockAt(60)),
        "CAPABILITY_REJECTED",
      );
      // A repeat Detach of the terminal Session is refused the same way.
      expectRefusal(
        () => detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(11)),
        "CAPABILITY_REJECTED",
      );
      // No bulk revocation: capability rows are untouched by Detach.
      expect(capabilityRows(w.active.store.database)).toEqual(capsBefore);
      expect(rowCounts(w.active)).toEqual(before);
      expect(sessionRows(w.active.store.database)).toEqual(rowsBefore);
    });

    it("keeps non-Session-bound scopes session-checked at the operation, and refuses revocation like expiry", () => {
      const w = world();
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      detachSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resume2 }, clockAt(10));
      // attach is not Session-bound: acquisition into a detached Session is
      // refused by the operation's Session check, not the capability plane.
      expectRefusal(
        () => acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(11)),
        "SESSION_NOT_BOUND",
      );
      // Issuance for a detached Session still refuses.
      expectRefusal(
        () => issueCapability(w.active.store, { participantId: w.participantId, scope: "resume", sessionId: S2 }, clockAt(11)),
        "SESSION_NOT_BOUND",
      );
      // Revocation of a detached Session's capability is refused exactly like
      // an expired one: the capability is unusable either way.
      expectRefusal(
        () => revokeCapability(w.active.store, { participantId: w.participantId, scope: "resume", capability: w.resume2, sessionId: S2 }, clockAt(11)),
        "CAPABILITY_REJECTED",
      );
      expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    });
  });

  // -------------------------------------------------------------------------
  // Reconciliation (zero-write, fail-closed, read-based)
  // -------------------------------------------------------------------------
  describe("reconciliation", () => {
    it("classifies COMMITTED / NO_TRACE / EVIDENCE_CONFLICT from durable Session state", () => {
      const w = world();
      // No binding of the pair: NO_TRACE (a foreign-bound Session included).
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FAZ" })).toMatchObject({
        disposition: "NO_TRACE",
        current: undefined,
      });
      // ATTACHED: the detach left no trace (refused and rolled-back are
      // indistinguishable — both zero-write).
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: S1 })).toMatchObject({
        disposition: "NO_TRACE",
        current: { state: "ATTACHED", boundAt: at(0) },
      });

      detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(10));
      // DETACHED with the evidence instant: exact match is COMMITTED.
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: S1, detachedAt: at(10) })).toMatchObject({
        disposition: "COMMITTED",
        current: { state: "DETACHED", boundAt: at(0), detachedAt: at(10) },
      });
      // DETACHED without evidence: the terminal durable effect this request
      // wanted exists — COMMITTED, no retry needed (a retry would refuse).
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: S1 })).toMatchObject({
        disposition: "COMMITTED",
      });
      // DETACHED with a differing evidence instant: a different detach
      // committed — operator review, never auto-retry.
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: S1, detachedAt: at(11) })).toMatchObject({
        disposition: "EVIDENCE_CONFLICT",
      });
      expect(() => reconcileDetach(w.active.store, { participantId: w.participantId })).toThrowError(/request/i);
    });

    it("reconciles around concurrent takeover and release without touching them", () => {
      const w = world();
      acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
      const takeover3 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S3 });
      // Concurrent takeover first: the former Owner detaches under the new
      // Owner, which then releases — reconcile sees that later world.
      takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: takeover3 }, clockAt(60));
      detachSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.resume1 }, clockAt(61));
      releaseOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, fencingToken: 2, capability: w.resume3 }, clockAt(62));
      expect(reconcileDetach(w.active.store, { participantId: w.participantId, sessionId: S1, detachedAt: at(61) })).toMatchObject({
        disposition: "COMMITTED",
      });
      expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
      expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
    });
  });
});
