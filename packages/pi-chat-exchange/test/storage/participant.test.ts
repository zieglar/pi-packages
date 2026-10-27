import { afterEach, describe, expect, it } from "vitest";
import {
  bindEndpointRef,
  createParticipant,
  readParticipant,
  readParticipantByEndpoint,
} from "../../src/storage/participant.js";
import { PARTICIPANT_ID_PATTERN } from "../../src/storage/participant-identity.js";
import { openStore } from "../../src/storage/store.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectRefusal,
  fixture,
  NOW,
  participant,
  privileged,
  rowCounts,
} from "./support/participant-fixture.js";

/** B3-P1B: stable Participant identity and immutable Endpoint binding.
 * Every test runs against a real file-backed v2 store. */

afterEach(cleanupFixtures);

describe("Participant identity (B3-P1B)", () => {
  it("creates a durable prt_ ULID identity bound to one stable endpoint", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1");

    expect(created.disposition).toBe("CREATED");
    expect(created.participant.participantId).toMatch(PARTICIPANT_ID_PATTERN);
    expect(created.participant).toEqual({
      participantId: created.participant.participantId,
      adapter: "adapter-a",
      endpointId: "endpoint-1",
      createdAt: NOW,
    });
    expect(Object.isFrozen(created.participant)).toBe(true);
    expect(Object.isFrozen(created.record)).toBe(true);
    expect(created.record.entityId).toBe(created.participant.participantId);

    // Durable identity and stable endpoint projection are both readable.
    expect(readParticipant(active.store, created.participant.participantId)).toEqual(created.participant);
    expect(readParticipantByEndpoint(active.store, "adapter-a", "endpoint-1")).toEqual(created.participant);

    // The identity plane writes nothing into the inert P2/P3 tables and no
    // Session row: a Session ID is never an identity.
    expect(rowCounts(active)).toMatchObject({
      participant: "1",
      session: "0",
      ownership: "0",
      fencing: "0",
      cursor: "0",
      membership: "0",
    });
  });

  it("allocates unique identities for distinct endpoints", () => {
    const active = fixture();
    const first = participant(active, "endpoint-1");
    const second = participant(active, "endpoint-2");
    const third = participant(active, "endpoint-3", "create-3", "adapter-b");

    const ids = [first, second, third].map((created) => created.participant.participantId);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(PARTICIPANT_ID_PATTERN);
    expect(rowCounts(active).participant).toBe("3");
  });

  it("keeps Participant identity and endpoint binding immutable in storage", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const db = privileged(active);
    try {
      expect(() =>
        db.prepare("UPDATE participant SET participant_id = ? WHERE participant_id = ?").run(
          "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          created.participantId,
        ),
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare("UPDATE participant SET endpoint_id = ? WHERE participant_id = ?").run(
          "moved-endpoint",
          created.participantId,
        ),
      ).toThrow(/immutable/);
      expect(() =>
        db.prepare("UPDATE participant SET endpoint_adapter = ? WHERE participant_id = ?").run(
          "adapter-z",
          created.participantId,
        ),
      ).toThrow(/immutable/);
    } finally {
      db.close();
    }
    expect(readParticipant(active.store, created.participantId)).toEqual(created);
  });

  it("refuses a second Participant for the same stable endpoint identity", () => {
    const active = fixture();
    const first = participant(active, "endpoint-1");
    // A different idempotency key is a genuinely new creation request, so the
    // duplicate endpoint binding is refused rather than silently reassigned.
    expectRefusal(() => participant(active, "endpoint-1", "create-other"), "PARTICIPANT_ENDPOINT_CONFLICT");
    expect(rowCounts(active)).toMatchObject({ participant: "1", records: "1" });
    expect(readParticipantByEndpoint(active.store, "adapter-a", "endpoint-1")?.participantId).toBe(
      first.participant.participantId,
    );
  });

  it("treats the same endpoint on a different adapter as a different identity", () => {
    const active = fixture();
    const a = participant(active, "endpoint-1");
    const b = participant(active, "endpoint-1", "create-b", "adapter-b");
    expect(b.participant.participantId).not.toBe(a.participant.participantId);
    expect(readParticipantByEndpoint(active.store, "adapter-b", "endpoint-1")?.participantId).toBe(
      b.participant.participantId,
    );
  });

  it("replays one key idempotently and refuses a conflicting request on the same key", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1", "key-1");
    const replayed = participant(active, "endpoint-1", "key-1");
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.participant).toEqual(created.participant);
    expect(replayed.record).toEqual(created.record);
    expect(rowCounts(active)).toMatchObject({ participant: "1", records: "1" });

    expectRefusal(
      () => participant(active, "endpoint-different", "key-1"),
      "IDEMPOTENCY_KEY_CONFLICT",
    );
    expect(rowCounts(active)).toMatchObject({ participant: "1", records: "1" });
  });

  it("excludes the ephemeral instanceId from identity, digest, and binding", () => {
    const active = fixture();
    const created = createParticipant(
      active.store,
      { endpoint: { adapter: "adapter-a", endpointId: "endpoint-1", instanceId: "instance-1" }, idempotencyKey: "key-1" },
      { now: () => NOW },
    );
    expect(created.disposition).toBe("CREATED");

    // Same stable endpoint, different ephemeral incarnation, same key: this is
    // the same request, so it replays instead of conflicting.
    const replayed = createParticipant(
      active.store,
      { endpoint: { adapter: "adapter-a", endpointId: "endpoint-1", instanceId: "instance-2" }, idempotencyKey: "key-1" },
      { now: () => NOW },
    );
    expect(replayed.disposition).toBe("REPLAYED");
    expect(replayed.participant).toEqual(created.participant);
    expect(replayed.record.requestDigest).toBe(created.record.requestDigest);

    // A different incarnation never creates a second Participant either.
    expectRefusal(
      () =>
        createParticipant(
          active.store,
          {
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1", instanceId: "instance-3" },
            idempotencyKey: "key-2",
          },
          { now: () => NOW },
        ),
      "PARTICIPANT_ENDPOINT_CONFLICT",
    );

    const view = privileged(active);
    try {
      // instanceId is never persisted in the stable binding.
      expect(view.prepare("SELECT endpoint_adapter, endpoint_id FROM participant").all()).toEqual([
        { endpoint_adapter: "adapter-a", endpoint_id: "endpoint-1" },
      ]);
    } finally {
      view.close();
    }
  });

  it("survives close and reopen with identity and binding intact", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    active.store.close();

    const reopened = openStore({ directory: active.directory, filename: active.filename });
    try {
      expect(readParticipant(reopened, created.participantId)).toEqual(created);
      expect(readParticipantByEndpoint(reopened, "adapter-a", "endpoint-1")).toEqual(created);
    } finally {
      reopened.close();
    }
  });
});

describe("Endpoint binding affirmation (B3-P1B)", () => {
  it("affirms the immutable binding with a bind capability and zero writes", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");
    const before = rowCounts(active);

    const binding = bindEndpointRef(
      active.store,
      {
        participantId: created.participantId,
        endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
        capability,
      },
      { now: () => NOW },
    );
    expect(binding).toEqual({
      participantId: created.participantId,
      adapter: "adapter-a",
      endpointId: "endpoint-1",
      boundAt: NOW,
    });
    expect(Object.isFrozen(binding)).toBe(true);
    expect(rowCounts(active)).toEqual(before);
  });

  it("ignores a differing ephemeral instanceId when affirming the binding", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");
    for (const instanceId of ["instance-a", "instance-b"]) {
      expect(
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1", instanceId },
            capability,
          },
          { now: () => NOW },
        ).endpointId,
      ).toBe("endpoint-1");
    }
  });

  it("refuses silent reassignment to a different endpoint identity", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");

    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-moved" },
            capability,
          },
          { now: () => NOW },
        ),
      "PARTICIPANT_BINDING_MISMATCH",
    );
    expect(readParticipant(active.store, created.participantId)?.endpointId).toBe("endpoint-1");
  });

  it("refuses a Participant claiming an endpoint owned by another Participant", () => {
    const active = fixture();
    const first = participant(active, "endpoint-1").participant;
    const second = participant(active, "endpoint-2").participant;
    const capability = capabilityFor(active, second.participantId, "bind");

    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: second.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability,
          },
          { now: () => NOW },
        ),
      "PARTICIPANT_ENDPOINT_CONFLICT",
    );
    expect(readParticipantByEndpoint(active.store, "adapter-a", "endpoint-1")?.participantId).toBe(
      first.participantId,
    );
  });

  it("refuses binding without a capability and for an unknown Participant", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;

    // A Participant ID alone is never authorization.
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability: `cap_${"0".repeat(64)}`,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );

    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability: `cap_${"0".repeat(64)}`,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
  });
});
