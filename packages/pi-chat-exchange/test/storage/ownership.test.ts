import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOwnership,
  authorizeCurrentOwner,
  bindSession,
  FENCING_TOKEN_MAX,
  FIRST_FENCING_TOKEN,
  generateSessionId,
  LEASE_DEFAULT_TTL_SECONDS,
  LEASE_MAX_TTL_SECONDS,
  LEASE_MIN_TTL_SECONDS,
  LEASE_RENEWAL_RECOMMENDATION_SECONDS,
  readCurrentOwnership,
  readFencingHighWater,
  readLeaseStatus,
  readSessionBinding,
  readSessionBindings,
  releaseOwnership,
  renewLease,
  SESSION_ID_PATTERN,
  verifyOwnership,
  type OwnershipLease,
} from "../../src/storage/ownership.js";
import { revokeCapability, runOwned } from "../../src/storage/participant.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import { openStore } from "../../src/storage/store.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectRefusal,
  fixture,
  NOW,
  participant,
  privileged,
  reader,
  rowCounts,
  SECRET_HEX,
  type Fixture,
} from "./support/participant-fixture.js";

/**
 * CE-0002-B3-P2A: Session binding, Participant ownership, leases, and fencing.
 * Every test runs against a real file-backed v2 store, the real host-secret
 * artifact, and real SQLite owned transactions. Nothing is mocked; fault
 * injection uses only the accepted private hook seams and connection-level
 * COMMIT/ROLLBACK interception already used by the accepted B2 suites.
 */

afterEach(cleanupFixtures);

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const FORGED = `cap_${"ab".repeat(32)}`;

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const clockAt = (seconds: number) => ({ now: () => at(seconds) });

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly attach: string;
  /** `resume` capability bound to S1 (R1: resume authority is Session-bound);
   *  undefined when S1 is not bound in this world. */
  readonly resume: string | undefined;
  /** Issues a `resume` capability bound to the given bound Session. */
  readonly resumeFor: (sessionId: string) => string;
}

function world(options: { readonly bind?: readonly string[] } = {}): World {
  const active = fixture("ce-b3-p2a-");
  const participantId = participant(active, "endpoint-owner").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  const bound = options.bind ?? [S1];
  for (const sessionId of bound) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, clockAt(0));
  }
  const resumeFor = (sessionId: string) => capabilityFor(active, participantId, "resume", { sessionId });
  const resume = bound.includes(S1) ? resumeFor(S1) : undefined;
  return { active, participantId, attach, resume, resumeFor };
}

function acquire(w: World, sessionId = S1, seconds = 0, extra: Record<string, unknown> = {}): OwnershipLease {
  return acquireOwnership(
    w.active.store,
    { participantId: w.participantId, sessionId, capability: w.attach, ...extra },
    clockAt(seconds),
  );
}

function owner(w: World, sessionId: string, fencingToken: number, capability: unknown = w.resume) {
  return { participantId: w.participantId, sessionId, fencingToken, capability };
}

/** Full durable fingerprint of the B3 planes: zero-write is proven, not assumed. */
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
      capabilities: all("SELECT * FROM participant_capability ORDER BY capability_digest"),
      audits: all("SELECT * FROM audit_event ORDER BY exchange_id, sequence"),
    });
  } finally {
    view.close();
  }
}

function zeroWrite(active: Fixture, run: () => unknown, code: string): unknown {
  const before = durable(active);
  const error = expectRefusal(run, code);
  expect(durable(active), `${code} wrote durable state`).toBe(before);
  return error;
}

function tamper(active: Fixture, sql: string, ...values: (string | number | null)[]): void {
  const db = privileged(active);
  try {
    db.prepare(sql).run(...values);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------

describe("B3-P2A Session binding", () => {
  it("binds a Session under an attach capability without conferring ownership", () => {
    const w = world({ bind: [] });
    const bound = bindSession(
      w.active.store,
      { participantId: w.participantId, sessionId: S1, capability: w.attach },
      clockAt(5),
    );
    expect(bound).toEqual({ participantId: w.participantId, sessionId: S1, boundAt: at(5) });
    expect(Object.isFrozen(bound)).toBe(true);
    expect(readSessionBinding(w.active.store, w.participantId, S1)).toEqual(bound);
    expect(rowCounts(w.active)).toMatchObject({ session: "1", ownership: "0", fencing: "0" });
    expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(5))).toBe("UNOWNED");
  });

  it("never creates a Session or ownership implicitly at Participant creation", () => {
    const active = fixture("ce-b3-p2a-");
    participant(active, "endpoint-a");
    participant(active, "endpoint-b");
    expect(rowCounts(active)).toMatchObject({ participant: "2", session: "0", ownership: "0", fencing: "0" });
  });

  it("keeps Session identity distinct from Participant identity and records history", () => {
    const w = world({ bind: [S2, S1, S3] });
    expect(SESSION_ID_PATTERN.test(S1)).toBe(true);
    expect(SESSION_ID_PATTERN.test(w.participantId)).toBe(false);
    expect(SESSION_ID_PATTERN.test(generateSessionId(Date.parse(NOW)))).toBe(true);
    expect(readSessionBindings(w.active.store, w.participantId).map((row) => row.sessionId)).toEqual([S1, S2, S3]);
    // A Participant ID is not a SessionRef and a SessionRef is not a Participant ID.
    expectRefusal(
      () => bindSession(w.active.store, { participantId: w.participantId, sessionId: w.participantId, capability: w.attach }),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    expectRefusal(() => readSessionBindings(w.active.store, S1), "STORAGE_PARTICIPANT_REQUEST_INVALID");
  });

  it("refuses a duplicate binding with zero writes", () => {
    const w = world();
    zeroWrite(
      w.active,
      () => bindSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(9)),
      "SESSION_ALREADY_BOUND",
    );
    expect(readSessionBinding(w.active.store, w.participantId, S1)?.boundAt).toBe(at(0));
  });

  it("refuses a Session already bound to another Participant", () => {
    const w = world();
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const otherAttach = capabilityFor(w.active, other, "attach");
    zeroWrite(
      w.active,
      () => bindSession(w.active.store, { participantId: other, sessionId: S1, capability: otherAttach }),
      "SESSION_BOUND_TO_OTHER_PARTICIPANT",
    );
  });

  it("refuses wrong-Participant, wrong-scope, forged, expired, revoked, and non-capability credentials", () => {
    const w = world({ bind: [S2] });
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const expiring = capabilityFor(w.active, w.participantId, "attach", { expiresAt: at(60) });
    const revoked = capabilityFor(w.active, w.participantId, "attach");
    revokeCapability(w.active.store, { participantId: w.participantId, scope: "attach", capability: revoked }, clockAt(1));
    const credentials: [string, unknown, number][] = [
      ["other Participant attach", capabilityFor(w.active, other, "attach"), 0],
      ["resume scope", w.resumeFor(S2), 0],
      ["join scope", capabilityFor(w.active, w.participantId, "join"), 0],
      ["forged", FORGED, 0],
      ["expired", expiring, 60],
      ["revoked", revoked, 2],
      ["Session ID", S1, 0],
      ["Participant ID", w.participantId, 0],
      ["missing", undefined, 0],
    ];
    for (const [label, capability, seconds] of credentials) {
      const error = zeroWrite(
        w.active,
        () => bindSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability }, clockAt(seconds)),
        "CAPABILITY_REJECTED",
      );
      expect(error, label).toMatchObject({ message: "host capability authorization rejected" });
    }
    expect(rowCounts(w.active).session).toBe("1");
  });
});

describe("B3-P2A ownership acquisition", () => {
  it("allocates the first fencing token as 1 with the default 120 s lease", () => {
    const w = world();
    const lease = acquire(w);
    expect(lease).toEqual({
      participantId: w.participantId,
      sessionId: S1,
      fencingToken: FIRST_FENCING_TOKEN,
      expiresAt: at(LEASE_DEFAULT_TTL_SECONDS),
      leaseTtlSeconds: 120,
      leaseStartedAt: at(0),
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toEqual({
      participantId: w.participantId,
      sessionId: S1,
      fencingToken: 1,
      expiresAt: at(120),
      leaseStartedAt: at(0),
    });
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(60))).toBe("ACTIVE");
    expect(rowCounts(w.active)).toMatchObject({ ownership: "1", fencing: "1" });
  });

  it("keeps fencing counters per Participant", () => {
    const w = world();
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const otherAttach = capabilityFor(w.active, other, "attach");
    bindSession(w.active.store, { participantId: other, sessionId: S2, capability: otherAttach }, clockAt(0));
    expect(acquire(w).fencingToken).toBe(1);
    expect(
      acquireOwnership(w.active.store, { participantId: other, sessionId: S2, capability: otherAttach }, clockAt(0))
        .fencingToken,
    ).toBe(1);
  });

  it("refuses an unbound Session and another Participant's Session", () => {
    const w = world();
    zeroWrite(w.active, () => acquire(w, S2), "SESSION_NOT_BOUND");
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const otherAttach = capabilityFor(w.active, other, "attach");
    bindSession(w.active.store, { participantId: other, sessionId: S3, capability: otherAttach }, clockAt(0));
    zeroWrite(w.active, () => acquire(w, S3), "SESSION_NOT_BOUND");
  });

  it("refuses duplicate acquisition, including by the current Owner itself", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    zeroWrite(w.active, () => acquire(w, S1, 10), "OWNERSHIP_HELD");
    zeroWrite(w.active, () => acquire(w, S2, 119), "OWNERSHIP_HELD");
    expect(readCurrentOwnership(w.active.store, w.participantId)?.sessionId).toBe(S1);
  });

  it("refuses unauthorized acquisition with zero writes", () => {
    const w = world();
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const expiring = capabilityFor(w.active, w.participantId, "attach", { expiresAt: at(30) });
    const revoked = capabilityFor(w.active, w.participantId, "attach");
    revokeCapability(w.active.store, { participantId: w.participantId, scope: "attach", capability: revoked }, clockAt(0));
    for (const [capability, seconds] of [
      [FORGED, 0],
      [w.resume, 0],
      [capabilityFor(w.active, other, "attach"), 0],
      [expiring, 30],
      [revoked, 1],
      [S1, 0],
    ] as [string, number][]) {
      zeroWrite(
        w.active,
        () => acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability }, clockAt(seconds)),
        "CAPABILITY_REJECTED",
      );
    }
    expect(rowCounts(w.active)).toMatchObject({ ownership: "0", fencing: "0" });
  });

  it("refuses a superseded trust generation after operator recovery", () => {
    const w = world();
    w.active.store.close();
    rmSync(hostSecretPath(w.active.databasePath));
    const recovered = recoverTrustRoot({
      directory: w.active.directory,
      filename: w.active.filename,
      now: () => at(1),
      secretBytes: () => new Uint8Array(32).fill(0x31),
    });
    try {
      expectRefusal(
        () => acquireOwnership(recovered, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(2)),
        "CAPABILITY_REJECTED",
      );
      expect(readFencingHighWater(recovered, w.participantId)).toBe(0);
    } finally {
      recovered.close();
    }
  });

  it("enforces the 30–3600 s TTL policy and keeps renewal a recommendation only", () => {
    expect([LEASE_DEFAULT_TTL_SECONDS, LEASE_RENEWAL_RECOMMENDATION_SECONDS, LEASE_MIN_TTL_SECONDS, LEASE_MAX_TTL_SECONDS])
      .toEqual([120, 30, 30, 3600]);
    const w = world({ bind: [S1, S2] });
    for (const leaseTtlSeconds of [29, 3601, 0, -1, 120.5, "120", null]) {
      zeroWrite(w.active, () => acquire(w, S1, 0, { leaseTtlSeconds }), "STORAGE_PARTICIPANT_REQUEST_INVALID");
    }
    expect(acquire(w, S1, 0, { leaseTtlSeconds: 30 }).expiresAt).toBe(at(30));
    releaseOwnership(w.active.store, owner(w, S1, 1), clockAt(10));
    expect(acquire(w, S2, 30, { leaseTtlSeconds: 3600 }).expiresAt).toBe(at(3630));
    // No scheduler, heartbeat, or timer exists in the ownership plane.
    const source = readFileSync(new URL("../../src/storage/ownership.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval|setImmediate|Date\.now\(\)\s*[-+<>]|while\s*\(/);
  });
});

describe("B3-P2A lease renewal and expiry", () => {
  it("renews explicitly, keeps the fencing token, and moves the deadline forward", () => {
    const w = world();
    acquire(w);
    const renewed = renewLease(w.active.store, owner(w, S1, 1), clockAt(60));
    expect(renewed).toMatchObject({ sessionId: S1, fencingToken: 1, expiresAt: at(180), leaseStartedAt: at(60) });
    // The persisted term start advances with the renewal.
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ expiresAt: at(180), leaseStartedAt: at(60) });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    // Verification is zero-write.
    const before = durable(w.active);
    expect(verifyOwnership(w.active.store, owner(w, S1, 1), clockAt(100))).toMatchObject({ fencingToken: 1 });
    expect(durable(w.active)).toBe(before);
  });

  it("authorizes a current Owner under an exact Session-bound operation scope", () => {
    const w = world();
    acquire(w);
    const send = capabilityFor(w.active, w.participantId, "send", { sessionId: S1 });
    const before = durable(w.active);

    const ownership = runOwned(w.active.store, "Scoped owner test", (tx) =>
      authorizeCurrentOwner(tx, w.active.store, {
        ...owner(w, S1, 1, send),
        scope: "send",
        now: at(10),
      }),
    );

    expect(ownership).toMatchObject({ participantId: w.participantId, sessionId: S1, fencingToken: 1 });
    expect(durable(w.active)).toBe(before);
  });

  it("routes payload_read through exact current-Owner, fencing, and lease authorization", () => {
    const w = world();
    acquire(w);
    const payloadRead = capabilityFor(w.active, w.participantId, "payload_read", { sessionId: S1 });
    const metadataRead = capabilityFor(w.active, w.participantId, "read", { sessionId: S1 });
    const authorizePayload = (capability: string, fencingToken: number, seconds: number) =>
      runOwned(w.active.store, "Payload-read owner test", (tx) =>
        authorizeCurrentOwner(tx, w.active.store, {
          ...owner(w, S1, fencingToken, capability),
          scope: "payload_read",
          now: at(seconds),
        }),
      );

    const before = durable(w.active);
    expect(authorizePayload(payloadRead, 1, 10)).toMatchObject({
      participantId: w.participantId,
      sessionId: S1,
      fencingToken: 1,
    });
    expect(durable(w.active)).toBe(before);
    zeroWrite(w.active, () => authorizePayload(metadataRead, 1, 10), "CAPABILITY_REJECTED");
    zeroWrite(w.active, () => authorizePayload(payloadRead, 2, 10), "FENCING_STALE");
    zeroWrite(w.active, () => authorizePayload(payloadRead, 1, 120), "LEASE_EXPIRED");
  });

  it("refuses renewal by a non-owner Session, a stale token, and an unbound Session", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    // A resume capability bound to S2 authorizes S2 only: S2 is bound but not Owner.
    const resume2 = w.resumeFor(S2);
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S2, 1, resume2), clockAt(10)), "OWNERSHIP_NOT_CURRENT");
    // A resume capability bound to S1 never authorizes an operation as S2.
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S2, 1), clockAt(10)), "CAPABILITY_REJECTED");
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S1, 2), clockAt(10)), "FENCING_STALE");
    // An unbound Session can hold no resume capability at all (R1): the refusal
    // is authorization, before any Session-binding lookup.
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S3, 1), clockAt(10)), "CAPABILITY_REJECTED");
    for (const fencingToken of [0, -1, 1.5, "1", FENCING_TOKEN_MAX + 1]) {
      zeroWrite(
        w.active,
        () => renewLease(w.active.store, { ...owner(w, S1, 1), fencingToken }, clockAt(10)),
        "STORAGE_PARTICIPANT_REQUEST_INVALID",
      );
    }
  });

  it("requires a currently valid resume capability for renewal", () => {
    const w = world();
    acquire(w);
    const other = participant(w.active, "endpoint-other").participant.participantId;
    bindSession(w.active.store, { participantId: other, sessionId: S3, capability: capabilityFor(w.active, other, "attach") }, clockAt(0));
    const expiring = capabilityFor(w.active, w.participantId, "resume", { expiresAt: at(20), sessionId: S1 });
    const revoked = capabilityFor(w.active, w.participantId, "resume", { sessionId: S1 });
    revokeCapability(
      w.active.store,
      { participantId: w.participantId, scope: "resume", capability: revoked, sessionId: S1 },
      clockAt(1),
    );
    for (const [capability, seconds] of [
      [w.attach, 10],
      [FORGED, 10],
      [capabilityFor(w.active, other, "resume", { sessionId: S3 }), 10],
      [expiring, 20],
      [revoked, 10],
      [S1, 10],
    ] as [string, number][]) {
      zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S1, 1, capability), clockAt(seconds)), "CAPABILITY_REJECTED");
    }
  });

  it("refuses an expired lease for renewal, verification, and release", () => {
    const w = world();
    acquire(w);
    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(120)), "LEASE_EXPIRED");
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(5000)), "LEASE_EXPIRED");
    }
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(120))).toBe("EXPIRED");
  });

  it("never lets a wall-clock rollback renew or extend a lease", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    renewLease(w.active.store, owner(w, S1, 1), clockAt(60)); // term [60, 180)
    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(30)), "LEASE_CLOCK_REGRESSION");
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(-3600)), "LEASE_CLOCK_REGRESSION");
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)?.expiresAt).toBe(at(180));
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(30))).toBe("CLOCK_REGRESSION");
    // A rolled-back clock cannot widen the window by presenting a larger TTL:
    // the persisted term start decides, never the request TTL.
    zeroWrite(
      w.active,
      () => renewLease(w.active.store, { ...owner(w, S1, 1), leaseTtlSeconds: 3600 }, clockAt(-3600)),
      "LEASE_CLOCK_REGRESSION",
    );
    // A rolled-back clock cannot make room for another acquirer either.
    zeroWrite(w.active, () => acquire(w, S2, 30), "OWNERSHIP_HELD");
    // Renewal at a later valid instant only ever moves the deadline forward.
    expect(renewLease(w.active.store, owner(w, S1, 1), clockAt(61)).expiresAt).toBe(at(181));
  });

  it("refuses Owner replacement through attach once a lease expires (R1: takeover is required)", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w); // S1, token 1, term [0, 120)
    // The expired Owner can neither renew nor release (Q4).
    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(120)), "LEASE_EXPIRED");
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(5000)), "LEASE_EXPIRED");
    }
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(200))).toBe("EXPIRED");
    // No acquisition is admitted while any ownership row exists — not by
    // another Session and not by the expired Owner itself. Replacing any
    // existing Owner is takeover (Q1); P2B activated the takeover scope, but
    // attach authority is NOT widened by it.
    zeroWrite(w.active, () => acquire(w, S2, 200), "OWNERSHIP_TAKEOVER_REQUIRED");
    zeroWrite(w.active, () => acquire(w, S1, 200), "OWNERSHIP_TAKEOVER_REQUIRED");
    zeroWrite(w.active, () => acquire(w, S2, 200, { leaseTtlSeconds: 30 }), "OWNERSHIP_TAKEOVER_REQUIRED");
    // Holding a valid Session-bound takeover capability does not widen attach:
    // acquisition still refuses, and the takeover token is not an attach token.
    const takeover2 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
    zeroWrite(w.active, () => acquire(w, S2, 200), "OWNERSHIP_TAKEOVER_REQUIRED");
    zeroWrite(
      w.active,
      () =>
        acquireOwnership(
          w.active.store,
          { participantId: w.participantId, sessionId: S2, capability: takeover2 },
          clockAt(200),
        ),
      "CAPABILITY_REJECTED",
    );
    // The durable state is untouched: same Owner, same token, same expiry.
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      sessionId: S1,
      fencingToken: 1,
      expiresAt: at(120),
      leaseStartedAt: at(0),
    });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
  });

  it("admits acquisition again after an explicit release, with the next fencing token", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w); // S1, token 1
    releaseOwnership(w.active.store, owner(w, S1, 1), clockAt(10));
    expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
    const second = acquire(w, S2, 20);
    expect(second).toMatchObject({ sessionId: S2, fencingToken: 2, expiresAt: at(140), leaseStartedAt: at(20) });
    // The released Owner is no longer current: every Owner operation refuses.
    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(30)), "OWNERSHIP_NOT_CURRENT");
    }
    const resume2 = w.resumeFor(S2);
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S2, 1, resume2), clockAt(30)), "FENCING_STALE");
    expect(verifyOwnership(w.active.store, owner(w, S2, 2, resume2), clockAt(30)).fencingToken).toBe(2);
  });
});

describe("B3-P2A-R1 persisted lease term (MAJOR-1 remediation)", () => {
  it("never evaluates a stored term against a request TTL (no false rollback refusal)", () => {
    // Regression A: acquire with ttl=3600; later operations that carry no TTL
    // (or a different TTL) must not reinterpret the stored term.
    const w = world();
    const lease = acquire(w, S1, 0, { leaseTtlSeconds: 3600 });
    expect(lease).toMatchObject({ leaseStartedAt: at(0), expiresAt: at(3600) });
    expect(verifyOwnership(w.active.store, owner(w, S1, 1), clockAt(60))).toMatchObject({ leaseStartedAt: at(0) });
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(60))).toBe("ACTIVE");
    // Renewal with the same TTL extends from the persisted start.
    const renewed = renewLease(w.active.store, { ...owner(w, S1, 1), leaseTtlSeconds: 3600 }, clockAt(60));
    expect(renewed).toMatchObject({ leaseStartedAt: at(60), expiresAt: at(3660) });
  });

  it("refuses renewal from a rolled-back clock even when the request widens the TTL", () => {
    // Regression B: the persisted term start decides; a larger request TTL can
    // never widen the rollback window.
    const w = world();
    acquire(w, S1, 0, { leaseTtlSeconds: 30 }); // term [0, 30)
    for (const leaseTtlSeconds of [30, 120, 3600]) {
      zeroWrite(
        w.active,
        () => renewLease(w.active.store, { ...owner(w, S1, 1), leaseTtlSeconds }, clockAt(-1000)),
        "LEASE_CLOCK_REGRESSION",
      );
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      leaseStartedAt: at(0),
      expiresAt: at(30),
    });
  });

  it("refuses a renewal that would shorten the current term, with zero writes", () => {
    const w = world();
    acquire(w, S1, 0, { leaseTtlSeconds: 3600 }); // term [0, 3600)
    zeroWrite(
      w.active,
      () => renewLease(w.active.store, { ...owner(w, S1, 1), leaseTtlSeconds: 30 }, clockAt(60)),
      "LEASE_TERM_SHORTENED",
    );
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      leaseStartedAt: at(0),
      expiresAt: at(3600),
    });
    // Equal expiry is not a shortening.
    expect(
      renewLease(w.active.store, { ...owner(w, S1, 1), leaseTtlSeconds: 3540 }, clockAt(60)).expiresAt,
    ).toBe(at(3600));
  });

  it("refuses renewal and release at exactly the expiry instant", () => {
    const w = world();
    acquire(w); // term [0, 120)
    expect(renewLease(w.active.store, owner(w, S1, 1), clockAt(119))).toMatchObject({ expiresAt: at(239) });
    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, owner(w, S1, 1), clockAt(239)), "LEASE_EXPIRED");
    }
  });

  it("binds resume authority to exactly one Session durably", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    const resume2 = w.resumeFor(S2);
    // The S2-bound capability cannot act as the S1 Owner, and vice versa.
    zeroWrite(w.active, () => renewLease(w.active.store, owner(w, S1, 1, resume2), clockAt(10)), "CAPABILITY_REJECTED");
    // Revoking a resume capability requires its bound Session.
    expectRefusal(
      () => revokeCapability(w.active.store, { participantId: w.participantId, scope: "resume", capability: resume2 }, clockAt(11)),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    revokeCapability(w.active.store, { participantId: w.participantId, scope: "resume", capability: resume2, sessionId: S2 }, clockAt(11));
    // The persisted binding is visible to host-local reads, never a credential.
    const view = reader(w.active);
    try {
      const rows = view.prepare("SELECT scope, session_id FROM participant_capability ORDER BY scope, session_id").all();
      expect(rows).toContainEqual({ scope: "resume", session_id: S1 });
      expect(rows).toContainEqual({ scope: "resume", session_id: S2 });
      for (const row of view.prepare("SELECT session_id FROM participant_capability WHERE scope <> 'resume'").all()) {
        expect(row.session_id).toBeNull();
      }
    } finally {
      view.close();
    }
  });
});

describe("B3-P2A fencing", () => {
  it("is strictly monotonic across expiry, release, and restart, and never reused", () => {
    const w = world({ bind: [S1, S2] });
    const tokens: number[] = [];
    tokens.push(acquire(w, S1, 0).fencingToken); // 1
    // Expiry alone never frees the token for reuse (R1: takeover is inactive),
    // and an expired Owner cannot release (Q4): the high-water outlives the lease.
    zeroWrite(w.active, () => acquire(w, S2, 500), "OWNERSHIP_TAKEOVER_REQUIRED");
    zeroWrite(w.active, () => releaseOwnership(w.active.store, owner(w, S1, 1), clockAt(500)), "LEASE_EXPIRED");
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
    // A release while live frees acquisition; the next token is never reused.
    // (Restart first, to prove durability, then release and reacquire.)
    const resume2 = w.resumeFor(S2);
    w.active.store.close();
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readFencingHighWater(reopened, w.participantId)).toBe(1);
      releaseOwnership(reopened, owner(w, S1, 1), clockAt(10));
      expect(readCurrentOwnership(reopened, w.participantId)).toBeUndefined();
      tokens.push(acquireOwnership(reopened, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(20)).fencingToken); // 2, after release + restart
      releaseOwnership(reopened, owner(w, S2, 2, resume2), clockAt(30));
      tokens.push(acquireOwnership(reopened, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(40)).fencingToken); // 3
    } finally {
      reopened.close();
    }
    expect(tokens).toEqual([1, 2, 3]);
  });

  it("refuses allocation beyond the safe-integer token space with zero writes", () => {
    const w = world({ bind: [S1, S2] });
    tamper(
      w.active,
      "INSERT INTO participant_fencing_high_water(participant_id, fencing_token, private_revision) VALUES (?, ?, 1)",
      w.participantId,
      FENCING_TOKEN_MAX - 1,
    );
    const last = acquire(w);
    expect(last.fencingToken).toBe(FENCING_TOKEN_MAX);
    releaseOwnership(w.active.store, owner(w, S1, FENCING_TOKEN_MAX), clockAt(1));
    zeroWrite(w.active, () => acquire(w, S2, 2), "FENCING_EXHAUSTED");
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(FENCING_TOKEN_MAX);
  });

  it("refuses inconsistent ownership or fencing state instead of adopting it", () => {
    const cases: [string, (w: World) => void][] = [
      ["ownership without high-water", (w) => tamper(w.active, "DELETE FROM participant_fencing_high_water")],
      ["ownership behind high-water", (w) => tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 5")],
      ["high-water above safe range", (w) =>
        tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 9007199254740993")],
      ["ownership by an unbound Session", (w) =>
        tamper(w.active, "UPDATE participant_ownership SET session_id = ?", S3)],
      ["invalid stored deadline", (w) => tamper(w.active, "UPDATE participant_ownership SET expires_at = 'later'")],
    ];
    for (const [label, corrupt] of cases) {
      const w = world({ bind: [S1, S2] });
      acquire(w);
      corrupt(w);
      const error = zeroWrite(w.active, () => acquire(w, S2, 500), "STORAGE_OWNERSHIP_CORRUPT");
      expect(error, label).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
      zeroWrite(w.active, () => verifyOwnership(w.active.store, owner(w, S1, 1), clockAt(10)), "STORAGE_OWNERSHIP_CORRUPT");
      expectRefusal(() => readCurrentOwnership(w.active.store, w.participantId), "STORAGE_OWNERSHIP_CORRUPT");
    }
  });
});

describe("B3-P2A durability and transaction classification", () => {
  it("persists bindings, ownership, fencing, and lease status across restart", () => {
    const w = world();
    acquire(w);
    w.active.store.close();
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readSessionBinding(reopened, w.participantId, S1)?.boundAt).toBe(at(0));
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
      expect(readLeaseStatus(reopened, { participantId: w.participantId }, clockAt(30))).toBe("ACTIVE");
      expect(renewLease(reopened, owner(w, S1, 1), clockAt(30)).expiresAt).toBe(at(150));
    } finally {
      reopened.close();
    }
  });

  it("serializes with other writers: contention is BUSY, retryable, and zero-write", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    const holder = privileged(w.active);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const attempts: (() => unknown)[] = [
        () => bindSession(w.active.store, { participantId: w.participantId, sessionId: S3, capability: w.attach }, clockAt(1)),
        () => acquire(w, S2, 1),
        () => renewLease(w.active.store, owner(w, S1, 1), clockAt(1)),
        () => releaseOwnership(w.active.store, owner(w, S1, 1), clockAt(1)),
        () => verifyOwnership(w.active.store, owner(w, S1, 1), clockAt(1)),
      ];
      for (const attempt of attempts) {
        const error = expectRefusal(attempt, "STORAGE_TRANSACTION_BUSY");
        expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
      }
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ fencingToken: 1, expiresAt: at(120) });
    expect(rowCounts(w.active)).toMatchObject({ session: "2", ownership: "1", fencing: "1" });
  }, 20_000);

  it("rolls fencing and ownership back together when acquisition fails midway", () => {
    const w = world();
    const failing = () => {
      throw new Error("injected");
    };
    for (const seam of ["afterFencingWrite", "afterOwnershipWrite"] as const) {
      const error = zeroWrite(
        w.active,
        () =>
          acquireOwnership(
            w.active.store,
            { participantId: w.participantId, sessionId: S1, capability: w.attach },
            { ...clockAt(0), [seam]: failing },
          ),
        "STORAGE_TRANSACTION_FAILED",
      );
      expect(error, seam).toMatchObject({ outcome: "ROLLED_BACK", retryable: false });
    }
    acquire(w);
    zeroWrite(
      w.active,
      () => renewLease(w.active.store, owner(w, S1, 1), { ...clockAt(10), afterOwnershipWrite: failing }),
      "STORAGE_TRANSACTION_FAILED",
    );
    zeroWrite(
      w.active,
      () => releaseOwnership(w.active.store, owner(w, S1, 1), { ...clockAt(10), afterOwnershipDelete: failing }),
      "STORAGE_TRANSACTION_FAILED",
    );
    // The first committed acquisition still received token 1: failed attempts
    // consumed nothing.
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(1);
  });

  it("reports INDETERMINATE after a committed-then-failed COMMIT and never silently adopts", () => {
    const w = world();
    const store = w.active.store;
    const original = store.database.exec.bind(store.database);
    store.database.exec = (sql: string) => {
      original(sql);
      if (sql === "COMMIT") throw new Error(`SECRET ${w.attach}`);
    };
    let published: OwnershipLease | undefined;
    const error = expectRefusal(() => {
      published = acquire(w);
    }, "STORAGE_TRANSACTION_FAILED");
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(published).toBeUndefined();
    expect(JSON.stringify([String(error), (error as Error).stack, (error as Error).cause])).not.toContain(w.attach);
    // The connection is invalidated; no retry happens behind the caller's back.
    expectRefusal(() => acquire(w), "STORAGE_TRANSACTION_FAILED");

    // The outcome is discoverable only through a fresh durable read, and the
    // same Session re-acquiring is refused rather than adopted.
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
      expectRefusal(
        () => acquireOwnership(reopened, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(1)),
        "OWNERSHIP_HELD",
      );
      expect(verifyOwnership(reopened, owner(w, S1, 1), clockAt(1)).fencingToken).toBe(1);
    } finally {
      reopened.close();
    }
  });

  it("reports INDETERMINATE with zero writes when the owned rollback cannot be proven", () => {
    const w = world();
    const store = w.active.store;
    const original = store.database.exec.bind(store.database);
    store.database.exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      original(sql);
    };
    const error = expectRefusal(
      () =>
        acquireOwnership(
          store,
          { participantId: w.participantId, sessionId: S1, capability: w.attach },
          { ...clockAt(0), afterOwnershipWrite: () => { throw new Error("injected"); } },
        ),
      "STORAGE_TRANSACTION_FAILED",
    );
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(rowCounts(w.active)).toMatchObject({ ownership: "0", fencing: "0" });
  });
});

describe("B3-P2A privacy", () => {
  it("discloses no capability, digest, secret, identity, or path in any refusal", () => {
    const w = world({ bind: [S1, S2] });
    acquire(w);
    const view = reader(w.active);
    const digests = view.prepare("SELECT capability_digest FROM participant_capability").all().map((row) => String(row.capability_digest));
    view.close();
    const secrets = [w.attach, w.resume!, w.attach.slice(4), w.resume!.slice(4), FORGED, SECRET_HEX, w.active.root, w.participantId, S1, S2, ...digests];

    const refusals: unknown[] = [];
    const capture = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        refusals.push(error);
      }
    };
    capture(() => bindSession(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }));
    capture(() => bindSession(w.active.store, { participantId: w.participantId, sessionId: S3, capability: FORGED }));
    capture(() => acquire(w, S2, 10));
    capture(() => acquire(w, S3, 10));
    capture(() => renewLease(w.active.store, owner(w, S2, 1), clockAt(10)));
    capture(() => renewLease(w.active.store, owner(w, S1, 7), clockAt(10)));
    capture(() => renewLease(w.active.store, owner(w, S1, 1, w.attach), clockAt(10)));
    capture(() => renewLease(w.active.store, owner(w, S1, 1), clockAt(500)));
    capture(() => renewLease(w.active.store, owner(w, S1, 1), clockAt(-100)));
    capture(() => renewLease(w.active.store, { ...owner(w, S1, 1), sessionId: w.resume }, clockAt(10)));
    capture(() => acquire(w, S1, 0, { leaseTtlSeconds: w.resume }));
    tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 4");
    capture(() => verifyOwnership(w.active.store, owner(w, S1, 1), clockAt(10)));
    expect(refusals).toHaveLength(12);

    for (const refusal of refusals) {
      const parts: string[] = [];
      let current: unknown = refusal;
      for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
        parts.push(current.name, current.message, String(current.stack ?? ""), JSON.stringify(current));
        current = (current as Error & { cause?: unknown }).cause;
      }
      const corpus = parts.join(" ");
      for (const secret of secrets) expect(corpus, "refusal disclosed protected data").not.toContain(secret);
    }
  });

  it("persists no plaintext capability and returns none in results", () => {
    const w = world();
    const lease = acquire(w);
    const renewed = renewLease(w.active.store, owner(w, S1, 1), clockAt(10));
    for (const result of [lease, renewed]) {
      expect(JSON.stringify(result)).not.toContain("cap_");
      expect(Object.keys(result).sort()).toEqual([
        "expiresAt",
        "fencingToken",
        "leaseStartedAt",
        "leaseTtlSeconds",
        "participantId",
        "sessionId",
      ]);
    }
    w.active.store.close();
    for (const suffix of ["", "-wal"]) {
      let bytes = "";
      try {
        bytes = readFileSync(w.active.databasePath + suffix).toString("latin1");
      } catch {
        continue;
      }
      for (const token of [w.attach, w.resume!]) {
        expect(bytes).not.toContain(token);
        expect(bytes).not.toContain(token.slice(4));
      }
    }
  });
});
