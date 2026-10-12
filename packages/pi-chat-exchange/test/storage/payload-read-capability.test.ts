import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  OPERATIONAL_CAPABILITY_SCOPES,
  P3A_CAPABILITY_SCOPES,
  P4C_CAPABILITY_SCOPES,
  SESSION_BOUND_CAPABILITY_SCOPES,
} from "../../src/storage/capability.js";
import { bindSession, detachSession } from "../../src/storage/ownership.js";
import { issueCapability, readCapabilityStatus, revokeCapability } from "../../src/storage/participant.js";
import {
  cleanupFixtures,
  expectedDigest,
  fixture,
  LATER,
  NOW,
  participant,
  privileged,
  reader,
} from "./support/participant-fixture.js";

const SESSION_1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const FUTURE = "2026-10-11T00:00:00.000Z";
const EXPIRED = "2026-10-09T23:00:00.000Z";

afterEach(cleanupFixtures);

function boundParticipant() {
  const active = fixture("ce-payload-capability-");
  const created = participant(active, "endpoint-1").participant;
  const attach = issueCapability(
    active.store,
    { participantId: created.participantId, scope: "attach" },
    { now: () => NOW },
  ).capability;
  bindSession(
    active.store,
    { participantId: created.participantId, sessionId: SESSION_1, capability: attach },
    { now: () => NOW },
  );
  return { active, participantId: created.participantId };
}

describe("independent payload_read capability", () => {
  it("adds only payload_read while preserving the historical metadata-read scope", () => {
    expect(P3A_CAPABILITY_SCOPES).toEqual(["send", "read"]);
    expect(P4C_CAPABILITY_SCOPES).toEqual(["payload_read"]);
    expect(OPERATIONAL_CAPABILITY_SCOPES).toContain("payload_read");
    expect(SESSION_BOUND_CAPABILITY_SCOPES).toContain("payload_read");
  });

  it("requires an existing exact Session binding and persists only the keyed digest", () => {
    const { active, participantId } = boundParticipant();
    expect(() => issueCapability(
      active.store,
      { participantId, scope: "payload_read" },
      { now: () => NOW },
    )).toThrowError(expect.objectContaining({ code: "STORAGE_PARTICIPANT_REQUEST_INVALID" }));
    expect(() => issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_2 },
      { now: () => NOW },
    )).toThrowError(expect.objectContaining({ code: "SESSION_NOT_BOUND" }));

    const issued = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1, expiresAt: FUTURE },
      { now: () => NOW },
    );
    expect(issued).toMatchObject({ participantId, scope: "payload_read", sessionId: SESSION_1, expiresAt: FUTURE });
    expect(readCapabilityStatus(
      active.store,
      { capability: issued.capability, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("VALID");

    const view = reader(active);
    try {
      const rows = view.prepare(
        "SELECT capability_digest, participant_id, scope, trust_generation, expires_at, session_id FROM participant_capability WHERE scope='payload_read'",
      ).all();
      expect(rows).toEqual([{
        capability_digest: expectedDigest(1, participantId, "payload_read", issued.capability),
        participant_id: participantId,
        scope: "payload_read",
        trust_generation: 1,
        expires_at: FUTURE,
        session_id: SESSION_1,
      }]);
      expect(JSON.stringify(rows)).not.toContain(issued.capability);
      expect(readFileSync(active.databasePath).toString("latin1")).not.toContain(issued.capability);
    } finally {
      view.close();
    }
  });

  it("keeps read and payload_read cryptographically and semantically disjoint", () => {
    const { active, participantId } = boundParticipant();
    const metadataRead = issueCapability(
      active.store,
      { participantId, scope: "read", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;
    const payloadRead = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;

    expect(readCapabilityStatus(
      active.store,
      { capability: metadataRead, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("UNKNOWN");
    expect(readCapabilityStatus(
      active.store,
      { capability: payloadRead, participantId, scope: "read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("UNKNOWN");
    expect(readCapabilityStatus(
      active.store,
      { capability: payloadRead, participantId, scope: "payload_read", sessionId: SESSION_2 },
      { now: () => NOW },
    )).toBe("SESSION_MISMATCH");
  });

  it("inherits expiry, revocation, trust-generation, Participant, and lifecycle refusal", () => {
    const { active, participantId } = boundParticipant();
    const other = participant(active, "endpoint-2").participant.participantId;
    const live = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;
    const expired = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1, expiresAt: EXPIRED },
      { now: () => EXPIRED },
    ).capability;

    expect(readCapabilityStatus(
      active.store,
      { capability: live, participantId: other, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("UNKNOWN");
    expect(readCapabilityStatus(
      active.store,
      { capability: expired, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("EXPIRED");

    revokeCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1, capability: live },
      { now: () => LATER },
    );
    expect(readCapabilityStatus(
      active.store,
      { capability: live, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => LATER },
    )).toBe("REVOKED");

    const wrongGeneration = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;
    const db = privileged(active);
    try {
      db.prepare("UPDATE participant_capability SET trust_generation=2 WHERE capability_digest=?")
        .run(expectedDigest(1, participantId, "payload_read", wrongGeneration));
    } finally {
      db.close();
    }
    expect(readCapabilityStatus(
      active.store,
      { capability: wrongGeneration, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    )).toBe("WRONG_GENERATION");

    const detachBound = issueCapability(
      active.store,
      { participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;
    const resume = issueCapability(
      active.store,
      { participantId, scope: "resume", sessionId: SESSION_1 },
      { now: () => NOW },
    ).capability;
    detachSession(active.store, { participantId, sessionId: SESSION_1, capability: resume }, { now: () => LATER });
    expect(readCapabilityStatus(
      active.store,
      { capability: detachBound, participantId, scope: "payload_read", sessionId: SESSION_1 },
      { now: () => LATER },
    )).toBe("SESSION_DETACHED");
  });
});
