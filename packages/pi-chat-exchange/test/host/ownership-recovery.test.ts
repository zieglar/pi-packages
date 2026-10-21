import { afterEach, describe, expect, it } from "vitest";
import { recoverExpiredOwnership } from "../../src/host/ownership-recovery.js";
import {
  acquireOwnership,
  bindSession,
  readCurrentOwnership,
  readFencingHighWater,
  readSessionLifecycle,
} from "../../src/storage/ownership.js";
import {
  capabilityFor,
  cleanupFixtures,
  fixture,
  NOW,
  participant,
  privileged,
  rowCounts,
  type Fixture,
} from "../storage/support/participant-fixture.js";

const OLD_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RECOVERY_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();
const clockAt = (seconds: number) => ({ now: () => at(seconds) });

afterEach(cleanupFixtures);

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly request: {
    readonly adapter: "mcp";
    readonly endpointId: "chatgpt-desktop";
    readonly expectedOwner: {
      readonly sessionId: string;
      readonly fencingToken: number;
      readonly leaseStartedAt: string;
      readonly expiresAt: string;
    };
    readonly leaseTtlSeconds: number;
  };
}

function world(): World {
  const active = fixture("ce-recovery-");
  const participantId = participant(active, "chatgpt-desktop", "create-chatgpt", "mcp").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: OLD_SESSION, capability: attach }, clockAt(0));
  acquireOwnership(
    active.store,
    { participantId, sessionId: OLD_SESSION, capability: attach, leaseTtlSeconds: 30 },
    clockAt(0),
  );
  return {
    active,
    participantId,
    request: {
      adapter: "mcp",
      endpointId: "chatgpt-desktop",
      expectedOwner: {
        sessionId: OLD_SESSION,
        fencingToken: 1,
        leaseStartedAt: at(0),
        expiresAt: at(30),
      },
      leaseTtlSeconds: 120,
    },
  };
}

describe("operator-authorized stale ownership recovery", () => {
  it("takes over only the expected expired owner, releases it, detaches the recovery Session, and emits evidence", () => {
    const w = world();
    const receipt = recoverExpiredOwnership(w.active.store, w.request, {
      now: () => at(31),
      sessionId: () => RECOVERY_SESSION,
    });

    expect(receipt).toMatchObject({
      version: 1,
      disposition: "RECOVERED",
      endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
      participantId: w.participantId,
      supersededOwner: w.request.expectedOwner,
      recoverySessionId: RECOVERY_SESSION,
      takeover: { fencingToken: 2, leaseStartedAt: at(31), expiresAt: at(151) },
      final: { ownership: "UNOWNED", fencingHighWater: 2, recoverySession: "DETACHED" },
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: RECOVERY_SESSION })).toMatchObject({
      state: "DETACHED",
      detachedAt: at(31),
    });
    expect(JSON.stringify(receipt)).not.toContain("cap_");
  });

  it("refuses a live owner before any recovery writes", () => {
    const w = world();
    const before = rowCounts(w.active);
    expect(() => recoverExpiredOwnership(w.active.store, w.request, clockAt(29))).toThrowError(
      expect.objectContaining({ code: "CE_RECOVERY_OWNER_ACTIVE" }),
    );
    expect(rowCounts(w.active)).toEqual(before);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: OLD_SESSION, fencingToken: 1 });
  });

  it("refuses endpoint and expected-owner mismatches before any recovery writes", () => {
    const w = world();
    const before = rowCounts(w.active);
    expect(() =>
      recoverExpiredOwnership(w.active.store, { ...w.request, endpointId: "other-endpoint" }, clockAt(31)),
    ).toThrowError(expect.objectContaining({ code: "CE_RECOVERY_TARGET_MISMATCH" }));
    expect(() =>
      recoverExpiredOwnership(
        w.active.store,
        { ...w.request, expectedOwner: { ...w.request.expectedOwner, fencingToken: 99 } },
        clockAt(31),
      ),
    ).toThrowError(expect.objectContaining({ code: "CE_RECOVERY_OWNER_MISMATCH" }));
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("allows only one successful recovery for one expected owner", () => {
    const w = world();
    const first = recoverExpiredOwnership(w.active.store, w.request, {
      now: () => at(31),
      sessionId: () => RECOVERY_SESSION,
    });
    expect(first.disposition).toBe("RECOVERED");
    expect(() =>
      recoverExpiredOwnership(w.active.store, w.request, {
        now: () => at(31),
        sessionId: () => "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX",
      }),
    ).toThrowError(expect.objectContaining({ code: "CE_RECOVERY_OWNER_ABSENT" }));
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
  });

  it("refuses a clock-regressed lease before any recovery writes", () => {
    const w = world();
    const before = rowCounts(w.active);
    expect(() => recoverExpiredOwnership(w.active.store, w.request, clockAt(-10))).toThrowError(
      expect.objectContaining({ code: "CE_RECOVERY_CLOCK_REGRESSION" }),
    );
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("recovers a legacy NULL-start ownership row with explicit null evidence", () => {
    const w = world();
    const raw = privileged(w.active);
    try {
      raw.prepare("UPDATE participant_ownership SET lease_started_at = NULL").run();
    } finally {
      raw.close();
    }
    const receipt = recoverExpiredOwnership(
      w.active.store,
      { ...w.request, expectedOwner: { ...w.request.expectedOwner, leaseStartedAt: null } },
      { now: () => at(31), sessionId: () => RECOVERY_SESSION },
    );
    expect(receipt.disposition).toBe("RECOVERED");
    expect(receipt.supersededOwner.leaseStartedAt).toBeNull();
    expect(readCurrentOwnership(w.active.store, w.participantId)).toBeUndefined();
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
  });

  it("refuses stale non-null evidence for a legacy NULL-start row", () => {
    const w = world();
    const raw = privileged(w.active);
    try {
      raw.prepare("UPDATE participant_ownership SET lease_started_at = NULL").run();
    } finally {
      raw.close();
    }
    const before = rowCounts(w.active);
    expect(() => recoverExpiredOwnership(w.active.store, w.request, clockAt(31))).toThrowError(
      expect.objectContaining({ code: "CE_RECOVERY_OWNER_MISMATCH" }),
    );
    expect(rowCounts(w.active)).toEqual(before);
  });

  it("never creates dual authority when interrupted after the atomic takeover", () => {
    const w = world();
    expect(() =>
      recoverExpiredOwnership(w.active.store, w.request, {
        now: () => at(31),
        sessionId: () => RECOVERY_SESSION,
        afterTakeover: () => {
          throw new Error("simulated process interruption");
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "CE_RECOVERY_OUTCOME_UNKNOWN" }));

    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({
      sessionId: RECOVERY_SESSION,
      fencingToken: 2,
    });
    expect(readFencingHighWater(w.active.store, w.participantId)).toBe(2);
  });
});
