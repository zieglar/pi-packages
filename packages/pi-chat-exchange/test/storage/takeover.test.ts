import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireOwnership,
  bindSession,
  FENCING_TOKEN_MAX,
  generateSessionId,
  readCurrentOwnership,
  readFencingHighWater,
  readLeaseStatus,
  readSessionBindings,
  reconcileTakeover,
  releaseOwnership,
  renewLease,
  takeoverOwnership,
  verifyOwnership,
  type OwnershipLease,
} from "../../src/storage/ownership.js";
import { issueCapability, revokeCapability } from "../../src/storage/participant.js";
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
 * CE-0002-B3-P2B: explicit durable Owner takeover, supersession, and
 * reconciliation. Every test runs against a real file-backed v3 store, the
 * real host-secret artifact, and real SQLite owned transactions. Nothing is
 * mocked; fault injection uses only the accepted private hook seams and the
 * connection-level COMMIT/ROLLBACK interception of the accepted suites.
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
  readonly resumeFor: (sessionId: string) => string;
  readonly takeoverFor: (sessionId: string, options?: { expiresAt?: string }) => string;
}

function world(options: { readonly bind?: readonly string[] } = {}): World {
  const active = fixture("ce-b3-p2b-");
  const participantId = participant(active, "endpoint-owner").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  // Capabilities are pre-issued at world construction so refusal tests can
  // prove zero durable writes (issuance itself is a write).
  const resumeCaps = new Map<string, string>();
  const takeoverCaps = new Map<string, string>();
  for (const sessionId of options.bind ?? [S1, S2, S3]) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, clockAt(0));
    resumeCaps.set(sessionId, capabilityFor(active, participantId, "resume", { sessionId }));
    takeoverCaps.set(sessionId, capabilityFor(active, participantId, "takeover", { sessionId }));
  }
  const resumeFor = (sessionId: string) => resumeCaps.get(sessionId) ?? capabilityFor(active, participantId, "resume", { sessionId });
  const takeoverFor = (sessionId: string, opts: { expiresAt?: string } = {}) =>
    opts.expiresAt === undefined
      ? (takeoverCaps.get(sessionId) ?? capabilityFor(active, participantId, "takeover", { sessionId }))
      : capabilityFor(active, participantId, "takeover", { sessionId, expiresAt: opts.expiresAt });
  return { active, participantId, attach, resumeFor, takeoverFor };
}

/** Expired Owner S1 (token 1, term [0, 30)) waiting to be taken over. */
function expiredWorld(): World {
  const w = world();
  acquireOwnership(
    w.active.store,
    { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 },
    clockAt(0),
  );
  return w;
}

function takeover(w: World, sessionId = S2, seconds = 31, extra: Record<string, unknown> = {}): OwnershipLease {
  return takeoverOwnership(
    w.active.store,
    { participantId: w.participantId, sessionId, capability: w.takeoverFor(sessionId), ...extra },
    clockAt(seconds),
  );
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
      memberships: all("SELECT * FROM exchange_membership ORDER BY exchange_id, participant_id"),
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

const ownerReq = (w: World, sessionId: string, fencingToken: number, capability: unknown) => ({
  participantId: w.participantId,
  sessionId,
  fencingToken,
  capability,
});

// ---------------------------------------------------------------------------

describe("B3-P2B takeover eligibility", () => {
  it("takes over an expired Owner atomically: new Owner, next fencing token, persisted term", () => {
    const w = expiredWorld();
    const lease = takeover(w, S2, 31);
    expect(lease).toMatchObject({
      participantId: w.participantId,
      sessionId: S2,
      fencingToken: 2,
      leaseStartedAt: at(31),
      expiresAt: at(151),
      leaseTtlSeconds: 120,
    });
    expect(Object.isFrozen(lease)).toBe(true);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      sessionId: S2,
      fencingToken: 2,
      leaseStartedAt: at(31),
    });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(100))).toBe("ACTIVE");
    // The new Owner operates under its own Session-bound resume capability.
    const resume2 = w.resumeFor(S2);
    expect(verifyOwnership(w.active.store, ownerReq(w, S2, 2, resume2), clockAt(100)).fencingToken).toBe(2);
    expect(renewLease(w.active.store, ownerReq(w, S2, 2, resume2), clockAt(100)).leaseStartedAt).toBe(at(100));
  });

  it("takes over a legacy (NULL lease_started_at) row and persists a v3 term", () => {
    const w = expiredWorld(); // token 1, term [0, 30)
    // Simulate a migrated v2 row: no persisted lease start, far-future expiry.
    tamper(w.active, "UPDATE participant_ownership SET lease_started_at = NULL, expires_at = ?", at(999999));
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ leaseStartedAt: null });
    // The legacy row never authorizes as a live lease, even with a valid
    // Session-bound resume capability for its own Session.
    const resume1 = w.resumeFor(S1);
    zeroWrite(w.active, () => verifyOwnership(w.active.store, ownerReq(w, S1, 1, resume1), clockAt(10)), "LEASE_EXPIRED");
    expect(readLeaseStatus(w.active.store, { participantId: w.participantId }, clockAt(10))).toBe("EXPIRED");

    const lease = takeover(w, S2, 31);
    expect(lease).toMatchObject({ sessionId: S2, fencingToken: 2, leaseStartedAt: at(31), expiresAt: at(151) });
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ leaseStartedAt: at(31) });
  });

  it("refuses takeover of a live Owner, including one millisecond before expiry", () => {
    const w = expiredWorld(); // term [0, 30)
    zeroWrite(w.active, () => takeover(w, S2, 0), "OWNERSHIP_HELD");
    zeroWrite(w.active, () => takeover(w, S2, 29.999), "OWNERSHIP_HELD");
    zeroWrite(w.active, () => takeover(w, S1, 10), "OWNERSHIP_HELD");
    // Exact expiry is the takeover boundary (mutation-catcher for `>=`).
    expect(takeover(w, S2, 30).fencingToken).toBe(2);
  });

  it("refuses takeover of a clock-regressed lease", () => {
    const w = world();
    acquireOwnership(
      w.active.store,
      { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 },
      clockAt(100),
    ); // term [100, 130)
    // A clock before the persisted term start is regression, never eligibility.
    zeroWrite(w.active, () => takeover(w, S2, 90), "LEASE_CLOCK_REGRESSION");
    zeroWrite(w.active, () => takeover(w, S2, 0), "LEASE_CLOCK_REGRESSION");
    // Widening the presented TTL does not create eligibility either.
    zeroWrite(w.active, () => takeover(w, S2, 90, { leaseTtlSeconds: 3600 }), "LEASE_CLOCK_REGRESSION");
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
  });

  it("refuses takeover when no ownership row exists: initial acquisition is attach", () => {
    const w = world();
    zeroWrite(w.active, () => takeover(w, S1, 0), "OWNERSHIP_TAKEOVER_INELIGIBLE");
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(0);
    // And acquisition remains available for the attach path.
    expect(acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(1)).fencingToken).toBe(1);
  });

  it("refuses takeover of corrupt ownership state instead of repairing it", () => {
    const w = expiredWorld();
    tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 99");
    zeroWrite(w.active, () => takeover(w, S2, 31), "STORAGE_OWNERSHIP_CORRUPT");
    tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = 1");
    tamper(w.active, "UPDATE participant_ownership SET session_id = ?", S3); // S3 bound but not the issued cap's session... still structurally valid; break it properly below
    tamper(w.active, "UPDATE participant_ownership SET fencing_token = 5"); // mismatched vs high-water 1
    zeroWrite(w.active, () => takeover(w, S2, 31), "STORAGE_OWNERSHIP_CORRUPT");
  });

  it("validates takeover requests: TTL range, identities, unknown fields", () => {
    const w = expiredWorld();
    const cap = w.takeoverFor(S2);
    for (const leaseTtlSeconds of [0, 29, 3601, 1.5, Number.NaN, "120"]) {
      expectRefusal(
        () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: cap, leaseTtlSeconds }, clockAt(31)),
        "STORAGE_PARTICIPANT_REQUEST_INVALID",
      );
    }
    for (const bad of [
      { participantId: w.participantId, sessionId: S2, capability: cap, extra: 1 },
      { participantId: "prt_bad", sessionId: S2, capability: cap },
      { participantId: w.participantId, sessionId: "ses_nope", capability: cap },
      { participantId: w.participantId, capability: cap },
    ]) {
      expectRefusal(() => takeoverOwnership(w.active.store, bad, clockAt(31)), "STORAGE_PARTICIPANT_REQUEST_INVALID");
    }
    expect(rowCounts(w.active).ownership).toBe("1");
  });
});

describe("B3-P2B takeover authorization", () => {
  it("requires a Session-bound takeover capability: wrong Session, wrong Participant, wrong scope, forgery", () => {
    const w = expiredWorld();
    const capS2 = w.takeoverFor(S2);
    // Wrong presented Session (capability is bound to S2).
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: capS2 }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: capS2 }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    // Missing Session: refused at the request boundary of the capability plane.
    expectRefusal(
      () => issueCapability(w.active.store, { participantId: w.participantId, scope: "takeover" }, clockAt(31)),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    // Wrong Participant: a second Participant's row never authorizes here.
    const other = participant(w.active, "endpoint-other").participant.participantId;
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: other, sessionId: S2, capability: capS2 }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    // Wrong scope: neither attach nor resume tokens are takeover tokens.
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.resumeFor(S2) }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    // Forged token.
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: FORGED }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
  });

  it("refuses revoked and expired takeover capabilities", () => {
    const w = expiredWorld();
    const revoked = w.takeoverFor(S2);
    // Revocation requires the bound Session and refuses a mismatch.
    expectRefusal(
      () => revokeCapability(w.active.store, { participantId: w.participantId, scope: "takeover", capability: revoked }, clockAt(31)),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    expectRefusal(
      () => revokeCapability(w.active.store, { participantId: w.participantId, scope: "takeover", capability: revoked, sessionId: S3 }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
    revokeCapability(w.active.store, { participantId: w.participantId, scope: "takeover", capability: revoked, sessionId: S2 }, clockAt(31));
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: revoked }, clockAt(32)),
      "CAPABILITY_REJECTED",
    );

    const expired = w.takeoverFor(S3, { expiresAt: at(40) });
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: expired }, clockAt(40)),
      "CAPABILITY_REJECTED",
    );
  });

  it("refuses a takeover capability bound to a superseded trust generation", () => {
    const w = expiredWorld();
    const cap = w.takeoverFor(S2);
    w.active.store.close();
    // Operator trust-root recovery: old secret removed, generation 2 appended,
    // every outstanding capability revoked.
    rmSync(hostSecretPath(w.active.databasePath));
    const recovered = recoverTrustRoot({
      directory: w.active.directory,
      filename: w.active.filename,
      now: () => at(35),
      secretBytes: () => new Uint8Array(32).fill(0x77),
    });
    try {
      expectRefusal(
        () => takeoverOwnership(recovered, { participantId: w.participantId, sessionId: S2, capability: cap }, clockAt(36)),
        "CAPABILITY_REJECTED",
      );
      // Fresh issuance under the new generation is required and works.
      const fresh = issueCapability(recovered, { participantId: w.participantId, scope: "takeover", sessionId: S2 }, clockAt(36)).capability;
      expect(
        takeoverOwnership(recovered, { participantId: w.participantId, sessionId: S2, capability: fresh }, clockAt(37)).fencingToken,
      ).toBe(2);
    } finally {
      recovered.close();
    }
  });

  it("requires the takeover capability's Session to be bound at issuance and at use", () => {
    const w = expiredWorld();
    // Issuance against an unknown Session refuses.
    expectRefusal(
      () => issueCapability(w.active.store, { participantId: w.participantId, scope: "takeover", sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0" }, clockAt(31)),
      "SESSION_NOT_BOUND",
    );
    // A takeover capability issued for a valid Session of ANOTHER Participant
    // never authorizes here.
    const other = participant(w.active, "endpoint-other").participant.participantId;
    const otherAttach = capabilityFor(w.active, other, "attach");
    bindSession(w.active.store, { participantId: other, sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0", capability: otherAttach }, clockAt(0));
    const foreign = capabilityFor(w.active, other, "takeover", { sessionId: "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0" });
    zeroWrite(
      w.active,
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: foreign }, clockAt(31)),
      "CAPABILITY_REJECTED",
    );
  });

  it("host-local status read classifies Session binding for takeover", () => {
    const w = expiredWorld();
    const cap = w.takeoverFor(S2);
    const status = (sessionId?: string) =>
      import("../../src/storage/participant.js").then(({ readCapabilityStatus }) =>
        readCapabilityStatus(
          w.active.store,
          { capability: cap, participantId: w.participantId, scope: "takeover", ...(sessionId === undefined ? {} : { sessionId }) },
          clockAt(31),
        ),
      );
    return Promise.all([
      expect(status(S2)).resolves.toBe("VALID"),
      expect(status(S1)).resolves.toBe("SESSION_MISMATCH"),
      expect(status()).resolves.toBe("SESSION_MISMATCH"),
    ]);
  });
});

describe("B3-P2B supersession", () => {
  it("superseded Owner loses everything: renewal, release, verification, and its fencing token", () => {
    const w = expiredWorld();
    const resume1 = w.resumeFor(S1);
    takeover(w, S2, 31); // S2, token 2

    for (const operation of [renewLease, verifyOwnership, releaseOwnership]) {
      zeroWrite(w.active, () => operation(w.active.store, ownerReq(w, S1, 1, resume1), clockAt(40)), "OWNERSHIP_NOT_CURRENT");
    }
    // The old fencing token is stale even when presented by the new Owner Session.
    const resume2 = w.resumeFor(S2);
    zeroWrite(w.active, () => renewLease(w.active.store, ownerReq(w, S2, 1, resume2), clockAt(40)), "FENCING_STALE");
    // The old resume capability cannot act as the new Owner even with the new token.
    zeroWrite(w.active, () => renewLease(w.active.store, ownerReq(w, S2, 2, resume1), clockAt(40)), "CAPABILITY_REJECTED");
    // Historical bindings survive for audit continuity; nothing else moved.
    expect(readSessionBindings(w.active.store, w.participantId).map((b) => b.sessionId)).toEqual([S1, S2, S3]);
    expect(readParticipantRowCount(w.active)).toBe("1");
  });

  it("an expired Owner may take itself over, with a strictly greater fencing token", () => {
    const w = expiredWorld(); // S1, token 1, term [0, 30)
    const lease = takeover(w, S1, 31);
    expect(lease).toMatchObject({ sessionId: S1, fencingToken: 2, leaseStartedAt: at(31) });
    const resume1 = w.resumeFor(S1);
    zeroWrite(w.active, () => verifyOwnership(w.active.store, ownerReq(w, S1, 1, resume1), clockAt(40)), "FENCING_STALE");
    expect(verifyOwnership(w.active.store, ownerReq(w, S1, 2, resume1), clockAt(40)).fencingToken).toBe(2);
  });

  it("keeps fencing strictly monotonic across acquisition, takeover, release, and re-takeover", () => {
    const w = world();
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(0));
    expect(takeover(w, S2, 31).fencingToken).toBe(2);
    // Live S2 releases; the high-water survives; acquisition resumes at 3.
    releaseOwnership(w.active.store, ownerReq(w, S2, 2, w.resumeFor(S2)), clockAt(40));
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: w.attach, leaseTtlSeconds: 30 }, clockAt(50));
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S3, fencingToken: 3 });
    expect(takeover(w, S1, 81).fencingToken).toBe(4);
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(4);
  });

  it("refuses takeover at fencing exhaustion with zero writes", () => {
    const w = expiredWorld();
    tamper(w.active, "UPDATE participant_ownership SET fencing_token = ?", FENCING_TOKEN_MAX);
    tamper(w.active, "UPDATE participant_fencing_high_water SET fencing_token = ?", FENCING_TOKEN_MAX);
    zeroWrite(w.active, () => takeover(w, S2, 31), "FENCING_EXHAUSTED");
  });

  it("touches nothing outside ownership and fencing: identity, bindings, membership, audit survive", () => {
    const w = expiredWorld();
    const before = JSON.parse(durable(w.active));
    takeover(w, S2, 31);
    const after = JSON.parse(durable(w.active));
    expect(after.sessions).toEqual(before.sessions);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.audits).toEqual(before.audits);
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.counts.participant).toBe(before.counts.participant);
    expect(after.ownership[0].session_id).toBe(S2);
    expect(Number(after.fencing[0].token)).toBe(2);
  });
});

function readParticipantRowCount(active: Fixture): string {
  const view = reader(active);
  try {
    return String(view.prepare("SELECT CAST(count(*) AS TEXT) AS n FROM participant").get()!.n);
  } finally {
    view.close();
  }
}

describe("B3-P2B reconciliation after uncertain outcomes", () => {
  it("classifies COMMITTED, NO_TRACE, and EVIDENCE_CONFLICT from durable evidence", () => {
    const w = expiredWorld();
    const evidence = { participantId: w.participantId, sessionId: S2, leaseStartedAt: at(31), expiresAt: at(151), fencingToken: 2 };
    // Before any attempt: no trace.
    expect(reconcileTakeover(w.active.store, evidence)).toMatchObject({ disposition: "NO_TRACE" });
    expect(reconcileTakeover(w.active.store, { ...evidence, sessionId: S1 })).toMatchObject({ disposition: "NO_TRACE" });
    takeover(w, S2, 31);
    expect(reconcileTakeover(w.active.store, evidence)).toMatchObject({ disposition: "COMMITTED" });
    // Token is optional evidence; without it the term match still recognizes.
    const { fencingToken, ...noToken } = evidence;
    expect(reconcileTakeover(w.active.store, noToken)).toMatchObject({ disposition: "COMMITTED" });
    // Same Session under evidence the row cannot carry: the current state was
    // installed by a different request — same start but different expiry or
    // token, or a newer start than the presented evidence.
    expect(reconcileTakeover(w.active.store, { ...evidence, expiresAt: at(152) })).toMatchObject({ disposition: "EVIDENCE_CONFLICT" });
    expect(reconcileTakeover(w.active.store, { ...evidence, fencingToken: 3 })).toMatchObject({ disposition: "EVIDENCE_CONFLICT" });
    expect(reconcileTakeover(w.active.store, { ...evidence, leaseStartedAt: at(30), expiresAt: at(150) })).toMatchObject({ disposition: "EVIDENCE_CONFLICT" });
    // A claim of a LATER term start than the row: the row predates the
    // request's claimed effect, so the request left no trace.
    expect(reconcileTakeover(w.active.store, { ...evidence, leaseStartedAt: at(32), expiresAt: at(152) })).toMatchObject({ disposition: "NO_TRACE" });
    // A different Session: no trace of this request.
    expect(reconcileTakeover(w.active.store, { ...evidence, sessionId: S3 })).toMatchObject({ disposition: "NO_TRACE" });
  });

  it("treats a legacy row naming the target Session as NO_TRACE, never as COMMITTED", () => {
    const w = expiredWorld();
    tamper(w.active, "UPDATE participant_ownership SET lease_started_at = NULL");
    expect(
      reconcileTakeover(w.active.store, { participantId: w.participantId, sessionId: S1, leaseStartedAt: at(31), expiresAt: at(151) }),
    ).toMatchObject({ disposition: "NO_TRACE" });
  });

  it("guides an INDETERMINATE takeover: reconcile first, never blind-retry", () => {
    const w = expiredWorld();
    const takeover3 = w.takeoverFor(S3); // issued before the connection is poisoned
    const store = w.active.store;
    // INDETERMINATE boundary.
    const original = store.database.exec.bind(store.database);
    store.database.exec = (sql: string) => {
      original(sql);
      if (sql === "COMMIT") throw new Error(`injected ${w.attach}`);
    };
    const error = expectRefusal(() => takeover(w, S2, 31), "STORAGE_TRANSACTION_FAILED");
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });
    expect(JSON.stringify([String(error), (error as Error).stack, (error as Error).cause])).not.toContain(w.attach);

    // Reconciliation on a fresh connection proves the commit: no retry.
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(
        reconcileTakeover(reopened, { participantId: w.participantId, sessionId: S2, leaseStartedAt: at(31), expiresAt: at(151) }),
      ).toMatchObject({ disposition: "COMMITTED" });
      expect(readFencingHighWater(reopened, w.participantId)).toBe(2);
      // A blind retry would have refused (the new Owner's lease is live).
      expectRefusal(
        () =>
          takeoverOwnership(
            reopened,
            { participantId: w.participantId, sessionId: S3, capability: takeover3 },
            clockAt(40),
          ),
        "OWNERSHIP_HELD",
      );
    } finally {
      reopened.close();
    }
  });

  it("classifies an INDETERMINATE with unproven rollback as NO_TRACE and permits a fresh authorized attempt", () => {
    const w = expiredWorld();
    const cap2 = w.takeoverFor(S2); // issued before the connection is poisoned
    const store = w.active.store;
    const original = store.database.exec.bind(store.database);
    store.database.exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      original(sql);
    };
    const error = expectRefusal(
      () =>
        takeoverOwnership(
          store,
          { participantId: w.participantId, sessionId: S2, capability: cap2 },
          { ...clockAt(31), afterFencingWrite: () => { throw new Error("boom"); } },
        ),
      "STORAGE_TRANSACTION_FAILED",
    );
    expect(error).toMatchObject({ outcome: "INDETERMINATE", retryable: false });

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(rowCounts(w.active)).toMatchObject({ ownership: "1", fencing: "1" });
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
      expect(
        reconcileTakeover(reopened, { participantId: w.participantId, sessionId: S2, leaseStartedAt: at(31), expiresAt: at(151) }),
      ).toMatchObject({ disposition: "NO_TRACE" });
      // A fresh attempt is a new, fully authorized and eligibility-checked
      // operation — never a replay of the uncertain one.
      expect(takeoverOwnership(reopened, { participantId: w.participantId, sessionId: S2, capability: cap2 }, clockAt(32)).fencingToken).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it("classifies BUSY as retryable ROLLED_BACK and preserves state", () => {
    const w = expiredWorld();
    const blocker = privileged(w.active);
    try {
      blocker.exec("BEGIN IMMEDIATE");
      blocker.prepare("UPDATE participant_fencing_high_water SET private_revision = private_revision WHERE participant_id = ?").run(w.participantId);
      const error = expectRefusal(() => takeover(w, S2, 31), "STORAGE_TRANSACTION_BUSY");
      expect(error).toMatchObject({ outcome: "ROLLED_BACK", retryable: true });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    expect(takeover(w, S2, 31).fencingToken).toBe(2);
  });
});

describe("B3-P2B durability across restart", () => {
  it("persists the takeover across close and reopen, with supersession intact", () => {
    const w = expiredWorld();
    const resume1 = w.resumeFor(S1);
    takeover(w, S2, 31);
    w.active.store.close();

    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readCurrentOwnership(reopened, w.participantId)).toMatchObject({
        sessionId: S2,
        fencingToken: 2,
        leaseStartedAt: at(31),
        expiresAt: at(151),
      });
      expect(readFencingHighWater(reopened, w.participantId)).toBe(2);
      expectRefusal(() => verifyOwnership(reopened, ownerReq(w, S1, 1, resume1), clockAt(40)), "OWNERSHIP_NOT_CURRENT");
      const resume2 = issueCapability(reopened, { participantId: w.participantId, scope: "resume", sessionId: S2 }, clockAt(39)).capability;
      expect(verifyOwnership(reopened, ownerReq(w, S2, 2, resume2), clockAt(40)).sessionId).toBe(S2);
    } finally {
      reopened.close();
    }
  });
});

describe("B3-P2B takeover privacy", () => {
  it("discloses no capability, digest, secret, identity, path, or SQL in any takeover refusal", () => {
    const w = expiredWorld();
    const capS2 = w.takeoverFor(S2);
    const resume1 = w.resumeFor(S1);
    const view = reader(w.active);
    const digests = view.prepare("SELECT capability_digest FROM participant_capability").all().map((row) => String(row.capability_digest));
    view.close();
    const secrets = [w.attach, capS2, resume1, capS2.slice(4), resume1.slice(4), FORGED, SECRET_HEX, w.active.root, w.participantId, S1, S2, S3, ...digests];

    const refusals: unknown[] = [];
    const capture = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        refusals.push(error);
        return;
      }
      throw new Error("expected a refusal");
    };
    capture(() => takeover(w, S2, 10)); // live owner
    capture(() => takeover(w, S2, 31, { capability: FORGED }));
    capture(() => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: capS2 }, clockAt(31)));
    capture(() => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: "ses_bad", capability: capS2 }, clockAt(31)));
    capture(() => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: capS2, leaseTtlSeconds: 5 }, clockAt(31)));
    capture(() => reconcileTakeover(w.active.store, { participantId: w.participantId, sessionId: S2, leaseStartedAt: "garbage", expiresAt: at(151) }));

    for (const refusal of refusals) {
      const corpus = JSON.stringify([String(refusal), (refusal as Error).stack, (refusal as Error).cause, (refusal as Error).name]);
      for (const secret of secrets) {
        expect(corpus, "refusal leaked secret material").not.toContain(secret);
      }
      expect(corpus).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    }
    expect(refusals.length).toBe(6);
  });
});

describe("B3-P2B generated Session identity", () => {
  it("takeover accepts a freshly generated Session identity bound first", () => {
    const w = expiredWorld();
    const fresh = generateSessionId(Date.parse(at(20)));
    bindSession(w.active.store, { participantId: w.participantId, sessionId: fresh, capability: w.attach }, clockAt(20));
    const lease = takeoverOwnership(
      w.active.store,
      { participantId: w.participantId, sessionId: fresh, capability: w.takeoverFor(fresh) },
      clockAt(31),
    );
    expect(lease.sessionId).toBe(fresh);
  });
});
