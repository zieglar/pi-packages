import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import {
  createParticipant,
  joinExchange,
  readCapabilityStatus,
  readExchangeMembership,
  revokeCapability,
  type MembershipJoin,
} from "../../src/storage/participant.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import { initializeStore } from "../../src/storage/store.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";
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

/**
 * CE-0002-B3-P1B-R1 regression suite for the independent review's MAJOR-1
 * finding: idempotent replay previously returned protected Participant and
 * Membership data before current Capability authorization, which made a known
 * idempotency key an implicit authorization credential.
 *
 * Every test runs against a real file-backed v2 store, a real host-secret
 * artifact, and real SQLite transactions. Nothing here is mocked.
 */

afterEach(cleanupFixtures);

const EXPIRES_AT = "2026-10-10T02:00:00.000Z";
const AFTER_EXPIRY = "2026-10-10T03:00:00.000Z";
const FORGED = `cap_${"cd".repeat(32)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

interface Joined {
  readonly active: Fixture;
  readonly exchangeId: string;
  readonly participantId: string;
  readonly capability: string;
  readonly first: MembershipJoin;
}

/** One authorized join, ready for replay attempts under the same key. */
function joined(options: { readonly expiresAt?: string } = {}): Joined {
  const active = fixture();
  const exchangeId = exchange(active);
  const participantId = participant(active, "endpoint-1").participant.participantId;
  const capability = capabilityFor(active, participantId, "join", options);
  const first = joinExchange(
    active.store,
    { exchangeId, participantId, capability, idempotencyKey: "join-1" },
    { now: () => LATER },
  );
  expect(first.disposition).toBe("CREATED");
  return { active, exchangeId, participantId, capability, first };
}

/** Durable state fingerprint: row counts plus the full audit ledger and the
 * persisted membership row, so "zero-write" is proven, not asserted. */
function durableState(active: Fixture, exchangeId: string): string {
  const view = reader(active);
  try {
    return JSON.stringify({
      counts: rowCounts(active),
      audits: auditRows(active, exchangeId),
      memberships: view
        .prepare(
          "SELECT exchange_id, participant_id, join_boundary_seq, created_at FROM exchange_membership ORDER BY participant_id",
        )
        .all(),
      participants: view
        .prepare("SELECT participant_id, endpoint_adapter, endpoint_id, created_at FROM participant ORDER BY participant_id")
        .all(),
      capabilities: view
        .prepare(
          "SELECT capability_digest, participant_id, scope, trust_generation, expires_at, revoked_at FROM participant_capability ORDER BY capability_digest",
        )
        .all(),
      records: view
        .prepare("SELECT namespace, idempotency_key, request_digest, entity_id FROM idempotency_record ORDER BY namespace, idempotency_key")
        .all(),
    });
  } finally {
    view.close();
  }
}

/** A refused replay must disclose nothing protected: no identity, no boundary,
 * no digest, no capability, in the message, the cause chain, or the stack. */
function assertNoProtectedDisclosure(error: unknown, secrets: readonly string[]): void {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    parts.push(current.name, current.message, String(current.stack ?? ""));
    current = (current as Error & { cause?: unknown }).cause;
  }
  const corpus = parts.join(" ");
  for (const secret of secrets) {
    expect(corpus, "refusal disclosed protected data").not.toContain(secret);
  }
}

function attemptReplay(
  state: Joined,
  capability: unknown,
  now = LATER,
): { outcome: MembershipJoin } | { error: unknown } {
  try {
    return {
      outcome: joinExchange(
        state.active.store,
        { exchangeId: state.exchangeId, participantId: state.participantId, capability, idempotencyKey: "join-1" },
        { now: () => now },
      ),
    };
  } catch (error) {
    return { error };
  }
}

describe("B3-P1B-R1 A: authorized join replay", () => {
  it("replays byte-identically with zero writes under a currently valid capability", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);

    const replayed = joinExchange(
      state.active.store,
      {
        exchangeId: state.exchangeId,
        participantId: state.participantId,
        capability: state.capability,
        idempotencyKey: "join-1",
      },
      { now: () => AFTER_EXPIRY },
    );

    // L: deterministic, byte-identical, boundary-preserving, zero-write.
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.membership).toEqual(state.first.membership);
    expect(replayed.record).toEqual(state.first.record);
    expect(durableState(state.active, state.exchangeId)).toBe(before);
    expect(auditRows(state.active, state.exchangeId).filter((row) => row.kind === "participant_joined")).toEqual([
      { sequence: 2, kind: "participant_joined", subject: state.participantId },
    ]);

    // Repeating it again is still identical: no drift across replays.
    const again = attemptReplay(state, state.capability);
    expect("outcome" in again && again.outcome.membership).toEqual(state.first.membership);
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });
});

describe("B3-P1B-R1 B-G: unauthorized join replay", () => {
  it("B: refuses a forged capability on the replay path", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);
    const result = attemptReplay(state, FORGED);
    expect("error" in result).toBe(true);
    expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("B2: refuses a missing capability, a Participant ID, and an idempotency key as credentials", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);
    for (const credential of [undefined, null, state.participantId, "join-1", state.capability.slice(4)]) {
      const result = attemptReplay(state, credential);
      expect("error" in result, `credential ${String(credential)} was accepted`).toBe(true);
      expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    }
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("C: refuses a revoked capability on the replay path", () => {
    const state = joined();
    revokeCapability(
      state.active.store,
      { participantId: state.participantId, scope: "join", capability: state.capability },
      { now: () => LATER },
    );
    const before = durableState(state.active, state.exchangeId);
    const result = attemptReplay(state, state.capability);
    expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    expect(durableState(state.active, state.exchangeId)).toBe(before);
    // Revocation stays one-way: the refused replay does not un-revoke it.
    expect(
      readCapabilityStatus(
        state.active.store,
        { capability: state.capability, participantId: state.participantId, scope: "join" },
        { now: () => LATER },
      ),
    ).toBe("REVOKED");
  });

  it("D: refuses an expired capability on the replay path", () => {
    const state = joined({ expiresAt: EXPIRES_AT });
    // The join itself happened while the capability was still valid.
    expect(state.first.disposition).toBe("CREATED");
    const before = durableState(state.active, state.exchangeId);
    const result = attemptReplay(state, state.capability, AFTER_EXPIRY);
    expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("E: refuses a wrong-scope capability on the replay path", () => {
    const state = joined();
    const bindCapability = capabilityFor(state.active, state.participantId, "bind");
    const createCapability = capabilityFor(state.active, state.participantId, "create");
    const before = durableState(state.active, state.exchangeId);
    for (const capability of [bindCapability, createCapability]) {
      const result = attemptReplay(state, capability);
      expect("error" in result).toBe(true);
      expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    }
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("F: refuses another Participant's join capability on the replay path", () => {
    const state = joined();
    const other = participant(state.active, "endpoint-2").participant.participantId;
    const otherCapability = capabilityFor(state.active, other, "join");
    const before = durableState(state.active, state.exchangeId);
    const result = attemptReplay(state, otherCapability);
    expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("G: refuses a superseded-generation capability on the replay path", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);
    state.active.store.close();

    // Operator-authorized recovery: old secret removed first, generation 2
    // appended, every outstanding capability revoked.
    rmSync(hostSecretPath(state.active.databasePath));
    const recovered = recoverTrustRoot({
      directory: state.active.directory,
      filename: state.active.filename,
      now: () => AFTER_EXPIRY,
      secretBytes: () => new Uint8Array(32).fill(0x77),
    });
    try {
      expectRefusal(
        () =>
          joinExchange(
            recovered,
            {
              exchangeId: state.exchangeId,
              participantId: state.participantId,
              capability: state.capability,
              idempotencyKey: "join-1",
            },
            { now: () => AFTER_EXPIRY },
          ),
        "CAPABILITY_REJECTED",
      );
      // Membership itself is untouched: recovery revokes authority, not state.
      expect(readExchangeMembership(recovered, state.exchangeId, state.participantId)).toEqual(
        state.first.membership,
      );
    } finally {
      recovered.close();
    }
    // Only the trust generation and the revocation stamps changed.
    expect(durableState(state.active, state.exchangeId)).not.toBe(before);
    expect(auditRows(state.active, state.exchangeId).filter((row) => row.kind === "participant_joined")).toEqual([
      { sequence: 2, kind: "participant_joined", subject: state.participantId },
    ]);
  });

  it("M: an unauthorized replay discloses no Membership or Participant data", () => {
    const state = joined();
    const view = reader(state.active);
    const digest = String(
      (view.prepare("SELECT capability_digest FROM participant_capability").get() as { capability_digest: string })
        .capability_digest,
    );
    view.close();

    const result = attemptReplay(state, FORGED);
    const error = (result as { error: unknown }).error;
    expect(error).toMatchObject({
      code: "CAPABILITY_REJECTED",
      message: "host capability authorization rejected",
    });
    assertNoProtectedDisclosure(error, [
      state.participantId,
      state.exchangeId,
      state.first.record.requestDigest,
      state.capability,
      FORGED,
      digest,
      "join-1",
    ]);
    // The refusal is indistinguishable from a refusal on a key that never
    // existed, so the replay path is not an existence oracle for membership.
    const unknownKey = (() => {
      try {
        return {
          outcome: joinExchange(
            state.active.store,
            {
              exchangeId: state.exchangeId,
              participantId: state.participantId,
              capability: FORGED,
              idempotencyKey: "join-never-used",
            },
            { now: () => LATER },
          ),
        };
      } catch (unknownError) {
        return { error: unknownError };
      }
    })();
    expect((unknownKey as { error: { message: string; code: string } }).error.message).toBe(
      (error as { message: string }).message,
    );
    expect((unknownKey as { error: { code: string } }).error.code).toBe("CAPABILITY_REJECTED");
  });

  it("N: an authorized replay still serializes through an owned immediate transaction", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);
    const holder = privileged(state.active);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const result = attemptReplay(state, state.capability);
      expect((result as { error: { code: string; retryable: boolean } }).error).toMatchObject({
        code: "STORAGE_TRANSACTION_BUSY",
        retryable: true,
      });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(durableState(state.active, state.exchangeId)).toBe(before);
    // Once the contender releases the lock, the authorized replay succeeds and
    // is still byte-identical.
    const after = attemptReplay(state, state.capability);
    expect("outcome" in after && after.outcome.membership).toEqual(state.first.membership);
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });
});

describe("B3-P1B-R1 H-K: sponsored Participant creation replay", () => {
  function sponsored(): {
    active: Fixture;
    sponsorId: string;
    capability: string;
    created: ReturnType<typeof createParticipant>;
  } {
    const active = fixture();
    const sponsorId = participant(active, "endpoint-sponsor").participant.participantId;
    const capability = capabilityFor(active, sponsorId, "create");
    const created = createParticipant(
      active.store,
      {
        endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
        idempotencyKey: "sponsored-1",
        sponsor: { participantId: sponsorId, capability },
      },
      { now: () => NOW },
    );
    expect(created.disposition).toBe("CREATED");
    return { active, sponsorId, capability, created };
  }

  it("H: replays a sponsored creation under a currently valid create capability", () => {
    const { active, sponsorId, capability, created } = sponsored();
    const before = durableState(active, "ho_none");
    const replayed = createParticipant(
      active.store,
      {
        endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
        idempotencyKey: "sponsored-1",
        sponsor: { participantId: sponsorId, capability },
      },
      { now: () => LATER },
    );
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.participant).toEqual(created.participant);
    expect(replayed.record).toEqual(created.record);
    expect(durableState(active, "ho_none")).toBe(before);
  });

  it("I: refuses a forged sponsor capability on the replay path", () => {
    const { active, sponsorId, created } = sponsored();
    const before = durableState(active, "ho_none");
    const error = expectRefusal(
      () =>
        createParticipant(
          active.store,
          {
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
            idempotencyKey: "sponsored-1",
            sponsor: { participantId: sponsorId, capability: FORGED },
          },
          { now: () => LATER },
        ),
      "CAPABILITY_REJECTED",
    );
    assertNoProtectedDisclosure(error, [
      created.participant.participantId,
      created.record.requestDigest,
      "endpoint-sponsored",
      "sponsored-1",
    ]);
    expect(durableState(active, "ho_none")).toBe(before);
  });

  it("J: refuses a revoked sponsor capability on the replay path", () => {
    const { active, sponsorId, capability } = sponsored();
    revokeCapability(
      active.store,
      { participantId: sponsorId, scope: "create", capability },
      { now: () => LATER },
    );
    const before = durableState(active, "ho_none");
    expectRefusal(
      () =>
        createParticipant(
          active.store,
          {
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
            idempotencyKey: "sponsored-1",
            sponsor: { participantId: sponsorId, capability },
          },
          { now: () => LATER },
        ),
      "CAPABILITY_REJECTED",
    );
    expect(durableState(active, "ho_none")).toBe(before);
  });

  it("K: unsponsored creation keeps its accepted host-local semantics", () => {
    const active = fixture();
    const created = createParticipant(
      active.store,
      { endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" }, idempotencyKey: "k1" },
      { now: () => NOW },
    );
    expect(created.disposition).toBe("CREATED");
    const before = durableState(active, "ho_none");

    // Replay needs no capability: this is a trusted host-local operation and
    // its accepted B2-style idempotency semantics are unchanged.
    const replayed = createParticipant(
      active.store,
      { endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" }, idempotencyKey: "k1" },
      { now: () => LATER },
    );
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.participant).toEqual(created.participant);
    expect(durableState(active, "ho_none")).toBe(before);

    // A different request on the same key is still a conflict, not a replay.
    expectRefusal(
      () =>
        createParticipant(
          active.store,
          { endpoint: { adapter: "adapter-a", endpointId: "endpoint-2" }, idempotencyKey: "k1" },
          { now: () => LATER },
        ),
      "IDEMPOTENCY_KEY_CONFLICT",
    );
    expect(durableState(active, "ho_none")).toBe(before);
  });

  it("K2: an authorized sponsored replay still refuses a conflicting request on the same key", () => {
    const { active, sponsorId, capability } = sponsored();
    const before = durableState(active, "ho_none");
    // Corruption-before-conflict ordering inside the authorized replay path is
    // unchanged; only authorization now precedes it.
    expectRefusal(
      () =>
        createParticipant(
          active.store,
          {
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-other" },
            idempotencyKey: "sponsored-1",
            sponsor: { participantId: sponsorId, capability },
          },
          { now: () => LATER },
        ),
      "IDEMPOTENCY_KEY_CONFLICT",
    );
    expect(durableState(active, "ho_none")).toBe(before);
  });
});

describe("B3-P1B-R1 minor hardening controls", () => {
  it("C (MINOR-4): a capability cannot be replayed into another store", () => {
    const source = fixture("ce-r1-source-");
    const participantId = participant(source, "endpoint-1").participant.participantId;
    const token = capabilityFor(source, participantId, "join");
    const view = reader(source);
    const capabilityRow = view
      .prepare(
        "SELECT capability_digest, participant_id, scope, trust_generation, created_at FROM participant_capability",
      )
      .get() as Record<string, unknown>;
    const participantRow = view
      .prepare("SELECT participant_id, endpoint_adapter, endpoint_id, created_at FROM participant")
      .get() as Record<string, unknown>;
    view.close();

    // An independent store with its own host secret, carrying copied rows: the
    // worst realistic case short of stealing the host secret itself.
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-r1-target-"));
    roots.push(root);
    const directory = join(root, "database");
    const target = initializeStore({
      directory,
      filename: "store.sqlite",
      now: () => NOW,
      secretBytes: () => new Uint8Array(32).fill(0x7c),
    });
    try {
      const writer = openStorageConnection({ directory, filename: "store.sqlite" });
      try {
        writer
          .prepare(
            "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, ?, ?, ?, 1)",
          )
          .run(
            participantRow.participant_id as string,
            participantRow.endpoint_adapter as string,
            participantRow.endpoint_id as string,
            participantRow.created_at as string,
          );
        writer
          .prepare(
            "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at, private_revision) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1)",
          )
          .run(
            capabilityRow.capability_digest as string,
            capabilityRow.participant_id as string,
            capabilityRow.scope as string,
            capabilityRow.trust_generation as number,
            capabilityRow.created_at as string,
          );
      } finally {
        writer.close();
      }

      // The digest is keyed by the host secret, so the copied row verifies
      // nothing in a store with a different trust root.
      expect(
        readCapabilityStatus(target, { capability: token, participantId, scope: "join" }, { now: () => NOW }),
      ).toBe("UNKNOWN");
      const targetExchange = createParticipantFreeExchange(directory);
      expectRefusal(
        () =>
          joinExchange(
            target,
            { exchangeId: targetExchange, participantId, capability: token, idempotencyKey: "join-x" },
            { now: () => NOW },
          ),
        "CAPABILITY_REJECTED",
      );
      // And it still verifies in its own store: the token itself is intact.
      expect(
        readCapabilityStatus(
          source.store,
          { capability: token, participantId, scope: "join" },
          { now: () => NOW },
        ),
      ).toBe("VALID");
    } finally {
      target.close();
    }
  });

  it("D (MINOR-4): a Session ID never authorizes, and no session state exists", () => {
    const state = joined();
    // P1B persists no session rows at all: there is no session identity that
    // could be presented as a credential.
    expect(rowCounts(state.active).session).toBe("0");

    // Even a host-fabricated session identity for the real Participant and the
    // current trust generation authorizes nothing: only the bearer token does.
    const writer = privileged(state.active);
    try {
      writer
        .prepare(
          "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
        )
        .run(state.participantId, "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", LATER);
    } finally {
      writer.close();
    }
    const before = durableState(state.active, state.exchangeId);
    for (const credential of ["ses_01ARZ3NDEKTSV4RRFFQ69G5FAV", state.participantId]) {
      expect(
        readCapabilityStatus(
          state.active.store,
          { capability: credential, participantId: state.participantId, scope: "join" },
          { now: () => LATER },
        ),
      ).toBe("MALFORMED");
      const result = attemptReplay(state, credential);
      expect("error" in result).toBe(true);
      expect((result as { error: { code: string } }).error).toMatchObject({ code: "CAPABILITY_REJECTED" });
    }
    expect(durableState(state.active, state.exchangeId)).toBe(before);
  });

  it("B (MINOR-2): a trust-root fingerprint disagreement is a typed trust-root refusal", () => {
    const state = joined();
    const before = durableState(state.active, state.exchangeId);
    // Tamper with the persisted fingerprint so the live secret no longer
    // matches the current generation, while leaving the schema intact.
    const writer = privileged(state.active);
    try {
      writer.exec("DROP TRIGGER host_trust_root_immutable");
      writer
        .prepare("UPDATE host_trust_root SET secret_digest = ? WHERE generation = 1")
        .run("f".repeat(64));
      writer.exec(
        "CREATE TRIGGER host_trust_root_immutable\nBEFORE UPDATE ON host_trust_root BEGIN SELECT RAISE(ABORT, 'host trust root is immutable'); END;",
      );
    } finally {
      writer.close();
    }

    const error = expectRefusal(
      () => attemptReplayOrThrow(state, state.capability),
      "STORAGE_TRUST_ROOT_MISMATCH",
    );
    // Fail closed, with no capability material and no repair.
    assertNoProtectedDisclosure(error, [state.capability, state.participantId, "f".repeat(64)]);
    const after = durableState(state.active, state.exchangeId);
    expect(JSON.parse(after).audits).toEqual(JSON.parse(before).audits);
  });
});

/** Privileged test-authority setup: seeds one OPEN Exchange row directly in
 * the foreign store used by the cross-store control, so the join attempt fails
 * on authorization rather than on a missing Exchange. */
function createParticipantFreeExchange(directory: string): string {
  const writer = openStorageConnection({ directory, filename: "store.sqlite" });
  try {
    writer
      .prepare(
        "INSERT INTO exchange(exchange_id, state, created_at, closed_at, private_revision) VALUES (?, 'OPEN', ?, NULL, 1)",
      )
      .run("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", NOW);
    return "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  } finally {
    writer.close();
  }
}

function attemptReplayOrThrow(state: Joined, capability: unknown): MembershipJoin {
  return joinExchange(
    state.active.store,
    { exchangeId: state.exchangeId, participantId: state.participantId, capability, idempotencyKey: "join-1" },
    { now: () => LATER },
  );
}
