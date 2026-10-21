import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITY_PATTERN } from "../../src/storage/participant-identity.js";
import {
  bindEndpointRef,
  createParticipant,
  issueCapability,
  readCapabilityStatus,
  revokeCapability,
} from "../../src/storage/participant.js";
import { recoverTrustRoot } from "../../src/storage/recovery.js";
import { hostSecretPath } from "../../src/storage/trust-root.js";
import {
  capabilityFor,
  cleanupFixtures,
  expectedDigest,
  expectRefusal,
  fixture,
  LATER,
  NOW,
  participant,
  privileged,
  reader,
  rowCounts,
  SECRET_HEX,
} from "./support/participant-fixture.js";

/** B3-P1B: Host Capability issuance, verification, and revocation against a
 * real file-backed v2 store and its real host-secret artifact. */

afterEach(cleanupFixtures);

const EXPIRED_AT = "2026-10-09T23:00:00.000Z";
const FUTURE_AT = "2026-10-11T00:00:00.000Z";

describe("Host Capability issuance (B3-P1B)", () => {
  it("issues a random scoped capability bound to the current trust generation", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;

    const issued = issueCapability(
      active.store,
      { participantId: created.participantId, scope: "join", expiresAt: FUTURE_AT },
      { now: () => NOW },
    );
    expect(issued.capability).toMatch(CAPABILITY_PATTERN);
    expect(issued).toMatchObject({
      participantId: created.participantId,
      scope: "join",
      trustGeneration: 1,
      createdAt: NOW,
      expiresAt: FUTURE_AT,
    });
    expect(Object.isFrozen(issued)).toBe(true);

    const view = reader(active);
    try {
      expect(
        view
          .prepare(
            "SELECT capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at FROM participant_capability",
          )
          .all(),
      ).toEqual([
        {
          capability_digest: expectedDigest(1, created.participantId, "join", issued.capability),
          participant_id: created.participantId,
          scope: "join",
          trust_generation: 1,
          created_at: NOW,
          expires_at: FUTURE_AT,
          revoked_at: null,
        },
      ]);
    } finally {
      view.close();
    }

    expect(
      readCapabilityStatus(
        active.store,
        { capability: issued.capability, participantId: created.participantId, scope: "join" },
        { now: () => NOW },
      ),
    ).toBe("VALID");
  });

  it("issues independent capabilities and never repeats a token", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const tokens = new Set(
      ["create", "bind", "join"].map((scope) =>
        capabilityFor(active, created.participantId, scope as "create" | "bind" | "join"),
      ),
    );
    expect(tokens.size).toBe(3);
    expect(rowCounts(active).capability).toBe("3");
  });

  it("refuses issuance for an unknown Participant and for non-operational scopes", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;

    expectRefusal(
      () => issueCapability(active.store, { participantId: "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV", scope: "join" }, { now: () => NOW }),
      "PARTICIPANT_NOT_FOUND",
    );
    // No universal reconciliation scope is authorized. ACK has its own
    // Session-bound scope (ack-capability.test.ts).
    expectRefusal(
      () => issueCapability(active.store, { participantId: created.participantId, scope: "reconcile" }, { now: () => NOW }),
      "CAPABILITY_SCOPE_UNSUPPORTED",
    );
    expect(rowCounts(active).capability).toBe("0");
  });

  it("persists no plaintext capability anywhere in SQLite", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const issued = issueCapability(active.store, { participantId: created.participantId, scope: "join" }, { now: () => NOW });
    const token = issued.capability;

    // Byte-level sweep of the database file, the WAL, and every text column.
    const artifacts = [active.databasePath, `${active.databasePath}-wal`]
      .map((path) => {
        try {
          return readFileSync(path).toString("latin1");
        } catch {
          return "";
        }
      })
      .join("\n");
    expect(artifacts).not.toContain(token);
    expect(artifacts).not.toContain(token.slice("cap_".length));
    expect(artifacts).not.toContain(SECRET_HEX);

    const view = reader(active);
    try {
      const dump = JSON.stringify([
        view.prepare("SELECT * FROM participant_capability").all(),
        view.prepare("SELECT * FROM audit_event").all(),
        view.prepare("SELECT * FROM participant").all(),
        view.prepare("SELECT sql FROM sqlite_schema").all(),
      ]);
      expect(dump).not.toContain(token);
      expect(dump).not.toContain(token.slice("cap_".length));
      expect(dump).not.toContain(SECRET_HEX);
      // Only the host-keyed digest is stored.
      expect(dump).toContain(expectedDigest(1, created.participantId, "join", token));
    } finally {
      view.close();
    }
  });
});

describe("Host Capability verification (B3-P1B)", () => {
  it("refuses a forged capability", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    capabilityFor(active, created.participantId, "bind");

    const forged = `cap_${"ab".repeat(32)}`;
    expect(
      readCapabilityStatus(
        active.store,
        { capability: forged, participantId: created.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("UNKNOWN");
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability: forged,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
    // Malformed presentations are refused the same way, with no oracle.
    for (const malformed of [undefined, null, 42, "cap_", "cap_zz", `${"a".repeat(68)}`, { token: forged }]) {
      expectRefusal(
        () =>
          bindEndpointRef(
            active.store,
            {
              participantId: created.participantId,
              endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
              capability: malformed,
            },
            { now: () => NOW },
          ),
        "CAPABILITY_REJECTED",
      );
    }
  });

  it("refuses a capability presented for the wrong scope", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const joinCapability = capabilityFor(active, created.participantId, "join");

    // The same token under another scope derives a different digest, so it is
    // not merely "wrong scope" — it does not exist at all.
    expect(
      readCapabilityStatus(
        active.store,
        { capability: joinCapability, participantId: created.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("UNKNOWN");
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability: joinCapability,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
    // A stored row whose scope column disagrees with its digest binding is
    // refused by the explicit scope check as well (defense in depth).
    const db = privileged(active);
    try {
      db.prepare(
        "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at, private_revision) VALUES (?, ?, 'join', 1, ?, 1)",
      ).run(expectedDigest(1, created.participantId, "bind", joinCapability), created.participantId, NOW);
    } finally {
      db.close();
    }
    expect(
      readCapabilityStatus(
        active.store,
        { capability: joinCapability, participantId: created.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("SCOPE_MISMATCH");
  });

  it("refuses a capability issued to another Participant", () => {
    const active = fixture();
    const first = participant(active, "endpoint-1").participant;
    const second = participant(active, "endpoint-2").participant;
    const capability = capabilityFor(active, first.participantId, "bind");

    expect(
      readCapabilityStatus(
        active.store,
        { capability, participantId: second.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("UNKNOWN");
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: second.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-2" },
            capability,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
  });

  it("refuses a revoked capability and never un-revokes it", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");

    const revoked = revokeCapability(
      active.store,
      { participantId: created.participantId, scope: "bind", capability },
      { now: () => LATER },
    );
    expect(revoked).toEqual({ participantId: created.participantId, scope: "bind", revokedAt: LATER });
    expect(
      readCapabilityStatus(
        active.store,
        { capability, participantId: created.participantId, scope: "bind" },
        { now: () => LATER },
      ),
    ).toBe("REVOKED");
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability,
          },
          { now: () => LATER },
        ),
      "CAPABILITY_REJECTED",
    );
    // There is no automatic capability recovery: re-revocation is refused and
    // the revocation timestamp is unchanged.
    expectRefusal(
      () =>
        revokeCapability(
          active.store,
          { participantId: created.participantId, scope: "bind", capability },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
    const view = reader(active);
    try {
      expect(view.prepare("SELECT revoked_at FROM participant_capability").all()).toEqual([{ revoked_at: LATER }]);
    } finally {
      view.close();
    }
  });

  it("refuses an expired capability at its expiry instant", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind", { expiresAt: EXPIRED_AT });

    expect(
      readCapabilityStatus(
        active.store,
        { capability, participantId: created.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("EXPIRED");
    expectRefusal(
      () =>
        bindEndpointRef(
          active.store,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability,
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );

    // A capability that has not expired yet still verifies.
    const live = capabilityFor(active, created.participantId, "bind", { expiresAt: FUTURE_AT });
    expect(
      readCapabilityStatus(
        active.store,
        { capability: live, participantId: created.participantId, scope: "bind" },
        { now: () => NOW },
      ),
    ).toBe("VALID");
  });

  it("refuses capabilities bound to a superseded trust generation", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");
    active.store.close();

    // Operator-authorized trust-root recovery: the operator removes the old
    // secret first, then recovery appends generation 2 and revokes everything.
    rmSync(hostSecretPath(active.databasePath));
    const newSecret = new Uint8Array(32).fill(0x77);
    const recovered = recoverTrustRoot({
      directory: active.directory,
      filename: active.filename,
      now: () => LATER,
      secretBytes: () => newSecret,
    });
    try {
      // The replacement secret inherits no authority: the old token is both
      // revoked and bound to the superseded generation.
      expect(
        readCapabilityStatus(
          recovered,
          { capability, participantId: created.participantId, scope: "bind" },
          { now: () => LATER },
        ),
      ).toBe("UNKNOWN");
      expectRefusal(
        () =>
          bindEndpointRef(
            recovered,
            {
              participantId: created.participantId,
              endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
              capability,
            },
            { now: () => LATER },
          ),
        "CAPABILITY_REJECTED",
      );

      // Generation binding is enforced independently of revocation: a row that
      // carries a current-secret digest but a stale generation is refused.
      const db = privileged(active);
      try {
        db.prepare(
          "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at, private_revision) VALUES (?, ?, 'bind', 1, ?, 1)",
        ).run(
          expectedDigest(2, created.participantId, "bind", capability, Buffer.from(newSecret).toString("hex")),
          created.participantId,
          LATER,
        );
      } finally {
        db.close();
      }
      expect(
        readCapabilityStatus(
          recovered,
          { capability, participantId: created.participantId, scope: "bind" },
          { now: () => LATER },
        ),
      ).toBe("WRONG_GENERATION");

      // Fresh issuance under the new generation is required and works.
      const reissued = issueCapability(
        recovered,
        { participantId: created.participantId, scope: "bind" },
        { now: () => LATER },
      );
      expect(reissued.trustGeneration).toBe(2);
      expect(
        bindEndpointRef(
          recovered,
          {
            participantId: created.participantId,
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
            capability: reissued.capability,
          },
          { now: () => LATER },
        ).endpointId,
      ).toBe("endpoint-1");
    } finally {
      recovered.close();
    }
  });

  it("uses the create scope operationally for sponsored Participant creation", () => {
    const active = fixture();
    const sponsor = participant(active, "endpoint-sponsor").participant;
    const createCapability = capabilityFor(active, sponsor.participantId, "create");

    const sponsored = createParticipant(
      active.store,
      {
        endpoint: { adapter: "adapter-a", endpointId: "endpoint-sponsored" },
        idempotencyKey: "sponsored-1",
        sponsor: { participantId: sponsor.participantId, capability: createCapability },
      },
      { now: () => NOW },
    );
    expect(sponsored.disposition).toBe("CREATED");

    // A sponsor presenting a capability for another scope is refused.
    const bindCapability = capabilityFor(active, sponsor.participantId, "bind");
    expectRefusal(
      () =>
        createParticipant(
          active.store,
          {
            endpoint: { adapter: "adapter-a", endpointId: "endpoint-refused" },
            idempotencyKey: "sponsored-2",
            sponsor: { participantId: sponsor.participantId, capability: bindCapability },
          },
          { now: () => NOW },
        ),
      "CAPABILITY_REJECTED",
    );
    expect(rowCounts(active).participant).toBe("2");
  });
});

describe("Host Capability privacy (B3-P1B)", () => {
  const CAPABILITY_FIELDS = ["capability_digest", "participant_capability", "host_trust_root"] as const;

  /** Sweeps a public value and, for errors, its cause chain and stack as well:
   * no capability token, host secret, capability digest, database path, or SQL
   * text may appear. */
  function assertNoCapabilityDisclosure(
    value: unknown,
    secrets: readonly string[],
    root: string,
    label: string,
  ): void {
    const corpus: string[] = [];
    const visit = (current: unknown, depth: number): void => {
      if (depth > 6 || current === null || current === undefined) return;
      if (typeof current !== "object") {
        corpus.push(String(current));
        return;
      }
      if (current instanceof Error) {
        corpus.push(current.name, current.message, String(current.stack ?? ""));
        visit((current as Error & { cause?: unknown }).cause, depth + 1);
      }
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        corpus.push(key);
        visit(nested, depth + 1);
      }
    };
    visit(value, 0);
    const text = `${corpus.join(" ")} ${JSON.stringify(value)}`;
    for (const secret of secrets) {
      expect(text, `${label}: leaked secret material`).not.toContain(secret);
    }
    expect(text, `${label}: leaked database path`).not.toContain(root);
    expect(text, `${label}: leaked SQL`).not.toMatch(/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    for (const field of CAPABILITY_FIELDS) {
      expect(text, `${label}: leaked column name ${field}`).not.toContain(field);
    }
  }

  it("discloses no capability, digest, secret, path, or SQL on success or refusal", () => {
    const active = fixture();
    const created = participant(active, "endpoint-1").participant;
    const capability = capabilityFor(active, created.participantId, "bind");
    const digest = expectedDigest(1, created.participantId, "bind", capability);
    const secrets = [capability, capability.slice("cap_".length), digest, SECRET_HEX];

    // The issuance result intentionally carries the plaintext token once, to
    // the issuing host: it is swept only for the host secret and the digest.
    assertNoCapabilityDisclosure(
      issueCapability(active.store, { participantId: created.participantId, scope: "join" }, { now: () => NOW }),
      [digest, SECRET_HEX],
      active.root,
      "issuance result",
    );

    // Every other surface must disclose nothing at all.
    assertNoCapabilityDisclosure(
      bindEndpointRef(
        active.store,
        {
          participantId: created.participantId,
          endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
          capability,
        },
        { now: () => NOW },
      ),
      secrets,
      active.root,
      "binding result",
    );

    for (const [label, run] of [
      [
        "forged capability refusal",
        () =>
          bindEndpointRef(
            active.store,
            {
              participantId: created.participantId,
              endpoint: { adapter: "adapter-a", endpointId: "endpoint-1" },
              capability: `cap_${"cd".repeat(32)}`,
            },
            { now: () => NOW },
          ),
      ],
      [
        "binding mismatch refusal",
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
      ],
      [
        "unsupported scope refusal",
        () => issueCapability(active.store, { participantId: created.participantId, scope: "send" }, { now: () => NOW }),
      ],
      [
        "invalid request refusal",
        () =>
          bindEndpointRef(
            active.store,
            { participantId: created.participantId, endpoint: { adapter: "adapter-a" }, capability },
            { now: () => NOW },
          ),
      ],
    ] as const) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(Error);
      expect(Object.hasOwn(caught as object, "cause"), `${label}: attached a cause`).toBe(false);
      assertNoCapabilityDisclosure(caught, secrets, active.root, label);
    }
  });

  it("control: the capability sweep detects each disclosure class", () => {
    const token = `cap_${"ef".repeat(32)}`;
    expect(() => assertNoCapabilityDisclosure({ token }, [token], "/tmp/none", "control")).toThrow();
    expect(() =>
      assertNoCapabilityDisclosure({ detail: "/private/var/db/store.sqlite" }, [], "/private/var/db", "control"),
    ).toThrow();
    expect(() => assertNoCapabilityDisclosure({ sql: "SELECT 1" }, [], "/tmp/none", "control")).toThrow();
    expect(() =>
      assertNoCapabilityDisclosure({ column: "capability_digest" }, [], "/tmp/none", "control"),
    ).toThrow();
    // A secret hidden in a nested cause chain is detected.
    const wrapped = new Error("outer", { cause: new Error(`inner ${token}`) });
    expect(() => assertNoCapabilityDisclosure(wrapped, [token], "/tmp/none", "control")).toThrow();
    // A secret hidden in a stack trace is detected.
    const stacked = new Error("outer");
    stacked.stack = `Error: outer\n    at leak (${token}/file.ts:1:1)`;
    expect(() => assertNoCapabilityDisclosure(stacked, [token], "/tmp/none", "control")).toThrow();
  });
});

describe("Session-bound resume capability (B3-P2A-R1)", () => {
  const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
  const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1";

  function boundParticipant(active: ReturnType<typeof fixture>) {
    const created = participant(active, "endpoint-1").participant;
    const attach = capabilityFor(active, created.participantId, "attach");
    // Imported lazily to keep this file focused on the capability plane.
    return { created, attach };
  }

  it("requires a Session for resume issuance and refuses sessionId on other scopes", async () => {
    const { bindSession } = await import("../../src/storage/ownership.js");
    const active = fixture();
    const { created, attach } = boundParticipant(active);
    bindSession(active.store, { participantId: created.participantId, sessionId: S1, capability: attach }, { now: () => NOW });

    expectRefusal(
      () => issueCapability(active.store, { participantId: created.participantId, scope: "resume" }, { now: () => NOW }),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    expectRefusal(
      () => issueCapability(active.store, { participantId: created.participantId, scope: "create", sessionId: S1 }, { now: () => NOW }),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    // Issuance requires the Session to be currently bound to the Participant.
    expectRefusal(
      () => issueCapability(active.store, { participantId: created.participantId, scope: "resume", sessionId: S2 }, { now: () => NOW }),
      "SESSION_NOT_BOUND",
    );
    const issued = issueCapability(
      active.store,
      { participantId: created.participantId, scope: "resume", sessionId: S1 },
      { now: () => NOW },
    );
    expect(issued).toMatchObject({ scope: "resume", sessionId: S1 });
    expect(Object.isFrozen(issued)).toBe(true);
  });


  it("issues send and read only as capabilities bound to an attached Session", async () => {
    const { bindSession } = await import("../../src/storage/ownership.js");
    const active = fixture();
    const { created, attach } = boundParticipant(active);
    bindSession(active.store, { participantId: created.participantId, sessionId: S1, capability: attach }, { now: () => NOW });

    for (const scope of ["send", "read"] as const) {
      expectRefusal(
        () => issueCapability(active.store, { participantId: created.participantId, scope }, { now: () => NOW }),
        "STORAGE_PARTICIPANT_REQUEST_INVALID",
      );
      const issued = issueCapability(
        active.store,
        { participantId: created.participantId, scope, sessionId: S1 },
        { now: () => NOW },
      );
      expect(issued).toMatchObject({ participantId: created.participantId, scope, sessionId: S1 });
      expect(
        readCapabilityStatus(
          active.store,
          { capability: issued.capability, participantId: created.participantId, scope, sessionId: S1 },
          { now: () => NOW },
        ),
      ).toBe("VALID");
      expect(
        readCapabilityStatus(
          active.store,
          { capability: issued.capability, participantId: created.participantId, scope, sessionId: S2 },
          { now: () => NOW },
        ),
      ).toBe("SESSION_MISMATCH");
    }
  });
  it("classifies the Session binding: valid only for the bound Session", async () => {
    const { bindSession } = await import("../../src/storage/ownership.js");
    const active = fixture();
    const { created, attach } = boundParticipant(active);
    for (const sessionId of [S1, S2]) {
      bindSession(active.store, { participantId: created.participantId, sessionId, capability: attach }, { now: () => NOW });
    }
    const resume = capabilityFor(active, created.participantId, "resume", { sessionId: S1 });
    const status = (extra: object = {}) =>
      readCapabilityStatus(
        active.store,
        { capability: resume, participantId: created.participantId, scope: "resume", ...extra },
        { now: () => NOW },
      );
    expect(status({ sessionId: S1 })).toBe("VALID");
    expect(status({ sessionId: S2 })).toBe("SESSION_MISMATCH");
    // Without the Session the binding cannot be verified: fail closed.
    expect(status()).toBe("SESSION_MISMATCH");
  });

  it("classifies a DETACHED Session's capability as SESSION_DETACHED (B3-P2C-B, D7)", async () => {
    const { bindSession } = await import("../../src/storage/ownership.js");
    const active = fixture();
    const { created, attach } = boundParticipant(active);
    bindSession(active.store, { participantId: created.participantId, sessionId: S1, capability: attach }, { now: () => NOW });
    const resume = capabilityFor(active, created.participantId, "resume", { sessionId: S1 });
    const status = (extra: object = {}) =>
      readCapabilityStatus(
        active.store,
        { capability: resume, participantId: created.participantId, scope: "resume", ...extra },
        { now: () => NOW },
      );
    expect(status({ sessionId: S1 })).toBe("VALID");
    // The accepted privileged-writer transition (test authority only): the
    // persisted detached_at becomes the lifecycle source of truth.
    const db = privileged(active);
    try {
      db.prepare("UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE session_id = ?").run(NOW, S1);
    } finally {
      db.close();
    }
    expect(status({ sessionId: S1 })).toBe("SESSION_DETACHED");
    // The binding check still precedes the lifecycle check: a presenter
    // claiming a different Session is a mismatch, not a lifecycle verdict.
    expect(status({ sessionId: S2 })).toBe("SESSION_MISMATCH");
    expect(status()).toBe("SESSION_MISMATCH");
    // No capability row is rewritten by the lifecycle invalidation.
    const view = reader(active);
    try {
      expect(
        view
          .prepare("SELECT revoked_at FROM participant_capability WHERE scope = 'resume' AND session_id = ?")
          .get(S1),
      ).toEqual({ revoked_at: null });
    } finally {
      view.close();
    }
  });

  it("requires the bound Session to revoke a resume capability", async () => {
    const { bindSession } = await import("../../src/storage/ownership.js");
    const active = fixture();
    const { created, attach } = boundParticipant(active);
    bindSession(active.store, { participantId: created.participantId, sessionId: S1, capability: attach }, { now: () => NOW });
    const resume = capabilityFor(active, created.participantId, "resume", { sessionId: S1 });

    expectRefusal(
      () => revokeCapability(active.store, { participantId: created.participantId, scope: "resume", capability: resume }, { now: () => NOW }),
      "STORAGE_PARTICIPANT_REQUEST_INVALID",
    );
    // A mismatched Session never authorizes the revocation.
    expectRefusal(
      () => revokeCapability(active.store, { participantId: created.participantId, scope: "resume", capability: resume, sessionId: S2 }, { now: () => NOW }),
      "CAPABILITY_REJECTED",
    );
    expect(
      revokeCapability(active.store, { participantId: created.participantId, scope: "resume", capability: resume, sessionId: S1 }, { now: () => NOW }),
    ).toMatchObject({ participantId: created.participantId, scope: "resume" });
    expect(
      readCapabilityStatus(active.store, { capability: resume, participantId: created.participantId, scope: "resume", sessionId: S1 }, { now: () => NOW }),
    ).toBe("REVOKED");
  });
});
