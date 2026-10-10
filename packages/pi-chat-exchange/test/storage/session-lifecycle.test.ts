import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as publicSurface from "../../src/index.js";
import { openStorageConnection } from "../../src/storage/connection.js";
import { migrateStore } from "../../src/storage/migration.js";
import {
  acquireOwnership,
  bindSession,
  readCurrentOwnership,
  readSessionBinding,
  readSessionBindings,
  readSessionLifecycle,
  renewLease,
  takeoverOwnership,
  verifyOwnership,
} from "../../src/storage/ownership.js";
import { issueCapability } from "../../src/storage/participant.js";
import {
  APPLICATION_ID,
  CURRENT_SCHEMA_VERSION,
  INITIAL_MIGRATION_CHECKSUM,
  INITIAL_MIGRATION_NAME,
  INITIAL_SCHEMA_SQL,
  SQLITE_APPLICATION_ID,
  V2_FOUNDATION_CHECKSUM,
  V2_FOUNDATION_NAME,
  V2_FOUNDATION_SQL,
  V2_MIGRATION_NAME,
  V3_FOUNDATION_CHECKSUM,
  V3_FOUNDATION_NAME,
  V3_FOUNDATION_SQL,
  V3_MIGRATION_NAME,
  V4_ADDITIVE_SQL,
  V4_FOUNDATION_CHECKSUM,
  V4_FOUNDATION_NAME,
  V4_MIGRATION_CHECKSUM,
  V4_MIGRATION_NAME,
} from "../../src/storage/schema.js";
import { initializeStore, openStore, preflightStoreShape, type DurableStore } from "../../src/storage/store.js";
import { StorageTransactionError, withImmediateTransaction } from "../../src/storage/transaction.js";
import { createHostSecretFile, hostSecretDigest, hostSecretPath } from "../../src/storage/trust-root.js";
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
 * CE-0002-B3-P2C-A: schema v4, the irreversible Session lifecycle, strict
 * Session-state validation, explicit v3→v4 migration (and the v2/v1 chains),
 * and the private host-local lifecycle read. Every test runs against real
 * file-backed SQLite and the real host-secret artifact; nothing is mocked.
 * Negative controls that need malformed durable state drop the relevant v4
 * triggers on a privileged connection, write the state, and restore the
 * byte-identical trigger SQL so the approved manifest still validates.
 */

afterEach(cleanupFixtures);

const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const S_UNKNOWN = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAZ";

const V4_TRIGGERS = [
  "participant_session_insert_attached",
  "participant_session_nodelete",
  "participant_session_identity_immutable",
  "participant_session_detach_once",
  "participant_session_detach_not_owner",
  "participant_ownership_session_attached_insert",
  "participant_ownership_session_attached_update",
] as const;

const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const clockAt = (seconds: number) => ({ now: () => at(seconds) });

interface World {
  readonly active: Fixture;
  readonly participantId: string;
  readonly otherParticipantId: string;
  readonly attach: string;
  readonly otherAttach: string;
}

/** A v4 store with one Participant holding S1, S2, S3 (all ATTACHED at t=0)
 * and a second Participant with no Sessions. */
function world(): World {
  const active = fixture("ce-b3-p2c-a-");
  const participantId = participant(active, "endpoint-owner").participant.participantId;
  const otherParticipantId = participant(active, "endpoint-other").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  const otherAttach = capabilityFor(active, otherParticipantId, "attach");
  for (const sessionId of [S1, S2, S3]) {
    bindSession(active.store, { participantId, sessionId, capability: attach }, clockAt(0));
  }
  return { active, participantId, otherParticipantId, attach, otherAttach };
}

/** The one permitted lifecycle transition, written by a privileged writer
 * (P2C-A defines no detach operation; this is test/setup authority only). */
function rawDetach(db: DatabaseSync, participantId: string, sessionId: string, detachedAt: string): void {
  const result = db
    .prepare(
      "UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE participant_id = ? AND session_id = ?",
    )
    .run(detachedAt, participantId, sessionId);
  expect(result.changes).toBe(1);
}

function withPrivileged<T>(active: Fixture, body: (db: DatabaseSync) => T): T {
  const db = privileged(active);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** Drops the named v4 triggers, runs the tamper, then restores the exact
 * stored trigger SQL so the approved schema manifest is byte-identical. */
function tamper(active: Fixture, triggers: readonly string[], body: (db: DatabaseSync) => void): void {
  withPrivileged(active, (db) => {
    const saved = triggers.map((name) => {
      const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name);
      expect(row).toBeDefined();
      return String(row!.sql);
    });
    for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
    try {
      body(db);
    } finally {
      for (const sql of saved) db.exec(sql);
    }
  });
}

function sessionRows(db: { prepare: (sql: string) => { all: () => unknown[] } }): unknown[] {
  return db
    .prepare(
      "SELECT participant_id, session_id, bound_at, detached_at, private_revision FROM participant_session ORDER BY participant_id, session_id",
    )
    .all();
}

function manifest(db: { prepare: (sql: string) => { all: () => unknown[] } }): unknown[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
}

function expectTriggerAbort(run: () => unknown, message: string): void {
  expect(run).toThrowError(new RegExp(message));
}

// ---------------------------------------------------------------------------
// Fresh v4 store
// ---------------------------------------------------------------------------

describe("fresh schema v4 store (B3-P2C-A)", () => {
  it("initializes at v4 with the v4 foundation ledger and every lifecycle trigger", () => {
    const active = fixture("ce-b3-p2c-a-fresh-");
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
    expect(active.store.schemaVersion).toBe(4);
    const db = active.store.database;
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(db.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual([
      { version: 4, name: V4_FOUNDATION_NAME, checksum: V4_FOUNDATION_CHECKSUM },
    ]);
    const triggers = db
      .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'participant_%session%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    expect(triggers.sort()).toEqual([...V4_TRIGGERS].sort());
    // v4 is purely additive: no table rebuild, no new column, no new scope.
    expect(
      db.prepare("SELECT name FROM pragma_table_info('participant_session') ORDER BY cid").all().map((row) => row.name),
    ).toEqual(["participant_id", "session_id", "bound_at", "detached_at", "private_revision"]);
    const capabilityDdl = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'participant_capability'").get()!.sql,
    );
    expect(capabilityDdl).toContain(
      "scope IN ('create', 'bind', 'join', 'attach', 'resume', 'takeover', 'send', 'ack', 'read')",
    );
    expect(capabilityDdl).not.toContain("detach");
  });

  it("binds new Sessions ATTACHED at revision 1", () => {
    const w = world();
    expect(sessionRows(w.active.store.database)).toEqual(
      [S1, S2, S3].map((sessionId) => ({
        participant_id: w.participantId,
        session_id: sessionId,
        bound_at: at(0),
        detached_at: null,
        private_revision: 1,
      })),
    );
    for (const sessionId of [S1, S2, S3]) {
      expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId })).toEqual({
        state: "ATTACHED",
        boundAt: at(0),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Trigger enforcement
// ---------------------------------------------------------------------------

describe("schema v4 lifecycle triggers (privileged writer)", () => {
  it("never deletes Session history", () => {
    const w = world();
    withPrivileged(w.active, (db) => {
      expectTriggerAbort(
        () => db.prepare("DELETE FROM participant_session WHERE session_id = ?").run(S1),
        "Session bindings are permanent history",
      );
      rawDetach(db, w.participantId, S2, at(5));
      expectTriggerAbort(
        () => db.prepare("DELETE FROM participant_session WHERE session_id = ?").run(S2),
        "Session bindings are permanent history",
      );
      expectTriggerAbort(() => db.exec("DELETE FROM participant_session"), "Session bindings are permanent history");
    });
    expect(rowCounts(w.active).session).toBe("3");
  });

  it("keeps Participant ID, Session ID, and bound_at immutable", () => {
    const w = world();
    const identityOrTransition = "Session binding identity is immutable|Session detach is one-way and irreversible";
    const cases = [
      ["participant_id", w.otherParticipantId],
      ["session_id", S_UNKNOWN],
      ["bound_at", at(1)],
    ] as const;
    withPrivileged(w.active, (db) => {
      for (const [column, value] of cases) {
        // Both the identity and the transition triggers refuse; SQLite's
        // trigger order is not part of the contract.
        expectTriggerAbort(
          () => db.prepare(`UPDATE participant_session SET ${column} = ? WHERE session_id = ?`).run(value, S1),
          identityOrTransition,
        );
        // Even combined with an otherwise legal detach transition.
        expectTriggerAbort(
          () =>
            db
              .prepare(
                `UPDATE participant_session SET ${column} = ?, detached_at = ?, private_revision = 2 WHERE session_id = ?`,
              )
              .run(value, at(5), S1),
          identityOrTransition,
        );
      }
    });
    // The identity trigger stands on its own: with the transition trigger
    // removed, an otherwise legal detach that rewrites identity still aborts.
    tamper(w.active, ["participant_session_detach_once"], (db) => {
      for (const [column, value] of cases) {
        expectTriggerAbort(
          () =>
            db
              .prepare(
                `UPDATE participant_session SET ${column} = ?, detached_at = ?, private_revision = 2 WHERE session_id = ?`,
              )
              .run(value, at(5), S1),
          "Session binding identity is immutable",
        );
      }
    });
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 })).toEqual({
      state: "ATTACHED",
      boundAt: at(0),
    });
  });

  it("permits exactly one transition — ATTACHED r1 → DETACHED r2 — and never reverts", () => {
    const w = world();
    withPrivileged(w.active, (db) => {
      // Malformed transitions from ATTACHED.
      expectTriggerAbort(
        () => db.prepare("UPDATE participant_session SET detached_at = ? WHERE session_id = ?").run(at(5), S1),
        "Session detach is one-way and irreversible",
      );
      expectTriggerAbort(
        () => db.prepare("UPDATE participant_session SET private_revision = 2 WHERE session_id = ?").run(S1),
        "Session detach is one-way and irreversible",
      );
      expectTriggerAbort(
        () =>
          db
            .prepare("UPDATE participant_session SET detached_at = ?, private_revision = 3 WHERE session_id = ?")
            .run(at(5), S1),
        "Session detach is one-way and irreversible",
      );
      // A no-op rewrite of an ATTACHED row is not a lifecycle transition.
      expectTriggerAbort(
        () => db.prepare("UPDATE participant_session SET detached_at = NULL WHERE session_id = ?").run(S1),
        "Session detach is one-way and irreversible",
      );

      rawDetach(db, w.participantId, S1, at(5));

      // DETACHED is terminal: no revert, no re-detach, no revision change.
      for (const [sql, params] of [
        ["UPDATE participant_session SET detached_at = NULL, private_revision = 1 WHERE session_id = ?", [S1]],
        ["UPDATE participant_session SET detached_at = NULL WHERE session_id = ?", [S1]],
        ["UPDATE participant_session SET detached_at = ? WHERE session_id = ?", [at(9), S1]],
        ["UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE session_id = ?", [at(9), S1]],
        ["UPDATE participant_session SET private_revision = 3 WHERE session_id = ?", [S1]],
        ["UPDATE participant_session SET private_revision = 1 WHERE session_id = ?", [S1]],
      ] as const) {
        expectTriggerAbort(
          () => db.prepare(sql).run(...params),
          "Session detach is one-way and irreversible",
        );
      }
    });
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 })).toEqual({
      state: "DETACHED",
      boundAt: at(0),
      detachedAt: at(5),
    });
  });

  it("creates Session rows ATTACHED only, and never reuses a Session ID", () => {
    const w = world();
    withPrivileged(w.active, (db) => {
      const insert = db.prepare(
        "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, ?, ?)",
      );
      expectTriggerAbort(
        () => insert.run(w.participantId, S_UNKNOWN, at(0), at(1), 2),
        "a Session binding is created attached",
      );
      expectTriggerAbort(
        () => insert.run(w.participantId, S_UNKNOWN, at(0), null, 2),
        "a Session binding is created attached",
      );
      expectTriggerAbort(
        () => insert.run(w.participantId, S_UNKNOWN, at(0), at(1), 1),
        "a Session binding is created attached",
      );
      rawDetach(db, w.participantId, S2, at(5));
      // A detached Session ID can never be re-bound — not to its Participant
      // (primary key) and not to another Participant (durable uniqueness).
      expect(() => insert.run(w.participantId, S2, at(6), null, 1)).toThrow();
      expect(() => insert.run(w.otherParticipantId, S2, at(6), null, 1)).toThrow();
    });
    expect(rowCounts(w.active).session).toBe("3");
  });

  it("refuses to detach the current Owner Session, live or expired", () => {
    const w = world();
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(0));
    withPrivileged(w.active, (db) => {
      expectTriggerAbort(
        () => rawDetach(db, w.participantId, S1, at(5)),
        "the current Owner Session cannot be detached",
      );
    });
    // Expired: the row still references S1, so the guard still holds.
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S1, fencingToken: 1 });
    withPrivileged(w.active, (db) => {
      expectTriggerAbort(
        () => rawDetach(db, w.participantId, S1, at(10_000)),
        "the current Owner Session cannot be detached",
      );
    });
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 }).state).toBe("ATTACHED");

    // After supersession the former Owner may be detached; the new Owner may not.
    const takeover = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
    takeoverOwnership(
      w.active.store,
      { participantId: w.participantId, sessionId: S2, capability: takeover },
      clockAt(200),
    );
    withPrivileged(w.active, (db) => {
      rawDetach(db, w.participantId, S1, at(201));
      expectTriggerAbort(
        () => rawDetach(db, w.participantId, S2, at(201)),
        "the current Owner Session cannot be detached",
      );
    });
    // Ownership and fencing are untouched by the lifecycle.
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S2, fencingToken: 2 });
  });

  it("never lets an ownership row reference a detached Session", () => {
    const w = world();
    withPrivileged(w.active, (db) => {
      rawDetach(db, w.participantId, S1, at(5));
      expectTriggerAbort(
        () =>
          db
            .prepare(
              "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, lease_started_at, private_revision) VALUES (?, ?, 1, ?, ?, 1)",
            )
            .run(w.participantId, S1, at(120), at(0)),
        "ownership cannot reference a detached Session",
      );
      db.prepare(
        "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, lease_started_at, private_revision) VALUES (?, ?, 1, ?, ?, 1)",
      ).run(w.participantId, S2, at(120), at(0));
      db.prepare(
        "INSERT INTO participant_fencing_high_water(participant_id, fencing_token, private_revision) VALUES (?, 1, 1)",
      ).run(w.participantId);
      expectTriggerAbort(
        () => db.prepare("UPDATE participant_ownership SET session_id = ? WHERE participant_id = ?").run(S1, w.participantId),
        "ownership cannot reference a detached Session",
      );
    });
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S2 });
  });
});

// ---------------------------------------------------------------------------
// Session validation through the storage operations
// ---------------------------------------------------------------------------

describe("detached Sessions never regain authority (B3-P2C-A validation)", () => {
  it("reports DETACHED, hides it from current bindings, and refuses every Session operation zero-write", () => {
    const w = world();
    // Pre-issue S2 capabilities while ATTACHED so refusals can be zero-write.
    const resume2 = capabilityFor(w.active, w.participantId, "resume", { sessionId: S2 });
    const takeover2 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
    withPrivileged(w.active, (db) => rawDetach(db, w.participantId, S2, at(5)));

    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S2 })).toEqual({
      state: "DETACHED",
      boundAt: at(0),
      detachedAt: at(5),
    });
    expect(readSessionBinding(w.active.store, w.participantId, S2)).toBeUndefined();
    expect(readSessionBindings(w.active.store, w.participantId).map((binding) => binding.sessionId)).toEqual([S1, S3]);

    const before = rowCounts(w.active);
    const rowsBefore = sessionRows(w.active.store.database);
    // Session ID reuse refused (same Participant / other Participant).
    expectRefusal(
      () => bindSession(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(10)),
      "SESSION_ALREADY_BOUND",
    );
    expectRefusal(
      () =>
        bindSession(
          w.active.store,
          { participantId: w.otherParticipantId, sessionId: S2, capability: w.otherAttach },
          clockAt(10),
        ),
      "SESSION_BOUND_TO_OTHER_PARTICIPANT",
    );
    // No new Session-bound capability for a detached Session.
    for (const scope of ["resume", "takeover"] as const) {
      expectRefusal(
        () => issueCapability(w.active.store, { participantId: w.participantId, scope, sessionId: S2 }, clockAt(10)),
        "SESSION_NOT_BOUND",
      );
    }
    // No initial acquisition and no takeover into a detached Session, even
    // with a capability issued while it was attached.
    expectRefusal(
      () => acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(10)),
      "SESSION_NOT_BOUND",
    );
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(10));
    const afterAcquire = rowCounts(w.active);
    expectRefusal(
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: takeover2 }, clockAt(500)),
      "SESSION_NOT_BOUND",
    );
    expectRefusal(
      () =>
        verifyOwnership(
          w.active.store,
          { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: resume2 },
          clockAt(20),
        ),
      "SESSION_NOT_BOUND",
    );
    expect(rowCounts(w.active)).toEqual(afterAcquire);
    expect({ ...before, ownership: "1", fencing: "1" }).toEqual(afterAcquire);
    expect(sessionRows(w.active.store.database)).toEqual(rowsBefore);
  });

  it("refuses a superseded, detached former Owner without touching ownership or fencing", () => {
    const w = world();
    const resume1 = capabilityFor(w.active, w.participantId, "resume", { sessionId: S1 });
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(0));
    const takeover3 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S3 });
    takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S3, capability: takeover3 }, clockAt(200));
    withPrivileged(w.active, (db) => rawDetach(db, w.participantId, S1, at(201)));
    const before = rowCounts(w.active);
    expectRefusal(
      () =>
        renewLease(
          w.active.store,
          { participantId: w.participantId, sessionId: S1, fencingToken: 1, capability: resume1 },
          clockAt(202),
        ),
      "SESSION_NOT_BOUND",
    );
    expect(rowCounts(w.active)).toEqual(before);
    expect(readCurrentOwnership(w.active.store, w.participantId)).toMatchObject({ sessionId: S3, fencingToken: 2 });
  });

  it("persists DETACHED across restart and keeps enforcing the lifecycle", () => {
    const w = world();
    withPrivileged(w.active, (db) => rawDetach(db, w.participantId, S3, at(7)));
    w.active.store.close();
    const reopened = openStore({ directory: w.active.directory, filename: w.active.filename });
    try {
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S3 })).toEqual({
        state: "DETACHED",
        boundAt: at(0),
        detachedAt: at(7),
      });
      expect(readSessionLifecycle(reopened, { participantId: w.participantId, sessionId: S1 }).state).toBe("ATTACHED");
      expect(() =>
        reopened.database
          .prepare("UPDATE participant_session SET detached_at = NULL, private_revision = 1 WHERE session_id = ?")
          .run(S3),
      ).toThrowError(/one-way and irreversible/);
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed state refusal
// ---------------------------------------------------------------------------

describe("malformed Session lifecycle state is refused, never repaired", () => {
  const MALFORMED: readonly (readonly [string, string | null, number])[] = [
    ["detached at revision 1", "DETACHED_AT", 1],
    ["attached at revision 2", null, 2],
    ["detached at revision 3", "DETACHED_AT", 3],
    ["attached at revision 3", null, 3],
    ["non-canonical detach instant", "2026-10-10T00:00:05Z", 2],
    ["detach before binding", "2026-10-09T23:59:59.000Z", 2],
  ];

  for (const [label, detachedAt, revision] of MALFORMED) {
    it(`refuses ${label}`, () => {
      const w = world();
      const resume2 = capabilityFor(w.active, w.participantId, "resume", { sessionId: S2 });
      tamper(w.active, ["participant_session_detach_once"], (db) => {
        db.prepare("UPDATE participant_session SET detached_at = ?, private_revision = ? WHERE session_id = ?").run(
          detachedAt === "DETACHED_AT" ? at(5) : detachedAt,
          revision,
          S2,
        );
      });
      const before = rowCounts(w.active);
      const rows = sessionRows(w.active.store.database);
      const errors = [
        expectRefusal(() => readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S2 }), "STORAGE_OWNERSHIP_CORRUPT"),
        expectRefusal(() => readSessionBinding(w.active.store, w.participantId, S2), "STORAGE_OWNERSHIP_CORRUPT"),
        expectRefusal(() => readSessionBindings(w.active.store, w.participantId), "STORAGE_OWNERSHIP_CORRUPT"),
        expectRefusal(
          () => issueCapability(w.active.store, { participantId: w.participantId, scope: "resume", sessionId: S2 }, clockAt(10)),
          "STORAGE_OWNERSHIP_CORRUPT",
        ),
        expectRefusal(
          () => acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: w.attach }, clockAt(10)),
          "STORAGE_OWNERSHIP_CORRUPT",
        ),
        expectRefusal(
          () =>
            verifyOwnership(
              w.active.store,
              { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: resume2 },
              clockAt(10),
            ),
          "STORAGE_OWNERSHIP_CORRUPT",
        ),
      ];
      // Fixed sanitized details: no identity, instant, or stored value leaks.
      for (const error of errors) {
        const text = `${(error as Error).message} ${JSON.stringify(error)}`;
        for (const secret of [S2, w.participantId, at(5), "2026-10-10T00:00:05Z", "detached_at", "private_revision"]) {
          expect(text).not.toContain(secret);
        }
      }
      // Zero writes, nothing repaired.
      expect(rowCounts(w.active)).toEqual(before);
      expect(sessionRows(w.active.store.database)).toEqual(rows);
    });
  }

  it("refuses an Owner that references a detached Session", () => {
    const w = world();
    const resume1 = capabilityFor(w.active, w.participantId, "resume", { sessionId: S1 });
    acquireOwnership(w.active.store, { participantId: w.participantId, sessionId: S1, capability: w.attach }, clockAt(0));
    tamper(w.active, ["participant_session_detach_not_owner"], (db) => rawDetach(db, w.participantId, S1, at(5)));
    const before = rowCounts(w.active);
    expectRefusal(() => readCurrentOwnership(w.active.store, w.participantId), "STORAGE_OWNERSHIP_CORRUPT");
    expectRefusal(() => readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 }), "STORAGE_OWNERSHIP_CORRUPT");
    // The lifecycle read validates the Participant's whole ownership state.
    expectRefusal(() => readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S3 }), "STORAGE_OWNERSHIP_CORRUPT");
    expectRefusal(
      () =>
        renewLease(
          w.active.store,
          { participantId: w.participantId, sessionId: S1, fencingToken: 1, capability: resume1 },
          clockAt(10),
        ),
      "SESSION_NOT_BOUND",
    );
    const takeover2 = capabilityFor(w.active, w.participantId, "takeover", { sessionId: S2 });
    const afterIssue = rowCounts(w.active);
    expectRefusal(
      () => takeoverOwnership(w.active.store, { participantId: w.participantId, sessionId: S2, capability: takeover2 }, clockAt(500)),
      "STORAGE_OWNERSHIP_CORRUPT",
    );
    expect(rowCounts(w.active)).toEqual(afterIssue);
    expect({ ...before, capability: afterIssue.capability }).toEqual(afterIssue);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle read
// ---------------------------------------------------------------------------

describe("readSessionLifecycle (private, host-local, zero-write)", () => {
  it("returns NOT_FOUND for unknown pairs and never discloses foreign bindings", () => {
    const w = world();
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S_UNKNOWN })).toEqual({
      state: "NOT_FOUND",
    });
    // S1 is bound to the first Participant: for any other Participant the pair
    // does not exist.
    expect(readSessionLifecycle(w.active.store, { participantId: w.otherParticipantId, sessionId: S1 })).toEqual({
      state: "NOT_FOUND",
    });
    expect(
      readSessionLifecycle(w.active.store, { participantId: "prt_01ARZ3NDEKTSV4RRFFQ69G5FAZ", sessionId: S1 }),
    ).toEqual({ state: "NOT_FOUND" });
  });

  it("performs zero writes and leaves no open transaction", () => {
    const w = world();
    withPrivileged(w.active, (db) => rawDetach(db, w.participantId, S2, at(5)));
    const db = w.active.store.database;
    const before = { counts: rowCounts(w.active), changes: db.prepare("SELECT total_changes() AS n").get() };
    for (const sessionId of [S1, S2, S_UNKNOWN]) {
      readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId });
    }
    expect(db.isTransaction).toBe(false);
    expect({ counts: rowCounts(w.active), changes: db.prepare("SELECT total_changes() AS n").get() }).toEqual(before);
  });

  it("rejects malformed requests with sanitized details", () => {
    const w = world();
    for (const input of [
      undefined,
      {},
      { participantId: w.participantId },
      { sessionId: S1 },
      { participantId: "not-a-participant", sessionId: S1 },
      { participantId: w.participantId, sessionId: "ses_secret-looking-value" },
      { participantId: w.participantId, sessionId: S1, extra: true },
    ]) {
      const error = expectRefusal(() => readSessionLifecycle(w.active.store, input), "STORAGE_PARTICIPANT_REQUEST_INVALID");
      expect((error as Error).message).not.toContain("secret-looking-value");
      expect((error as Error).message).not.toContain("not-a-participant");
    }
  });

  it("is not part of the public package surface", () => {
    expect(Object.keys(publicSurface)).not.toContain("readSessionLifecycle");
    expect(Object.keys(publicSurface).some((name) => /session|lifecycle/i.test(name) && /read/i.test(name))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Explicit v4 migrations
// ---------------------------------------------------------------------------

const STORE_UUID = "018f5f43-52f8-7c5a-8f64-9d5e06d24a9a";
const MIG_SECRET = new Uint8Array(32).fill(0x44);
const MIG_SECRET_HEX = Buffer.from(MIG_SECRET).toString("hex");
const MIG_NOW = "2026-10-10T00:00:00.000Z";
const P1 = "prt_01ARZ3NDEKTSV4RRFFQ69G5FA0";
const P2 = "prt_01ARZ3NDEKTSV4RRFFQ69G5FA1";

interface StoreLocation {
  readonly directory: string;
  readonly filename: string;
}
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function location(): StoreLocation {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-b3-p2c-a-migration-"));
  roots.push(root);
  return { directory: join(root, "database"), filename: "store.sqlite" };
}
const dbPath = (loc: StoreLocation): string => join(loc.directory, loc.filename);

function directorySnapshot(directory: string): [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

/** Writes exactly the store a given older binary would have initialized. */
function initializeOlderStore(loc: StoreLocation, version: 1 | 2 | 3): void {
  const db = openStorageConnection(loc, undefined, true);
  try {
    withImmediateTransaction(db, (tx) => {
      const [sql, name, checksum] =
        version === 1
          ? [INITIAL_SCHEMA_SQL, INITIAL_MIGRATION_NAME, INITIAL_MIGRATION_CHECKSUM]
          : version === 2
            ? [V2_FOUNDATION_SQL, V2_FOUNDATION_NAME, V2_FOUNDATION_CHECKSUM]
            : [V3_FOUNDATION_SQL, V3_FOUNDATION_NAME, V3_FOUNDATION_CHECKSUM];
      tx.exec(sql);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, ?, ?)",
      ).run(STORE_UUID, APPLICATION_ID, version, MIG_NOW);
      tx.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(
        version,
        name,
        checksum,
        MIG_NOW,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      if (version >= 2) {
        tx.prepare(
          "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
        ).run(hostSecretDigest(MIG_SECRET_HEX), MIG_NOW);
      }
      tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${version};`);
    });
  } finally {
    db.close();
  }
  if (version >= 2) createHostSecretFile(dbPath(loc), () => MIG_SECRET);
}

/** Seeds Session history as an older binary would have written it: P1 holds
 * S1 (current Owner, token 1) and S2; P2 holds S3. With `v3`, the ownership
 * row carries a persisted lease start. */
function seedSessions(loc: StoreLocation, v3: boolean): void {
  const db = openStorageConnection(loc);
  try {
    withImmediateTransaction(db, (tx) => {
      for (const [participantId, endpointId] of [[P1, "endpoint-1"], [P2, "endpoint-2"]] as const) {
        tx.prepare(
          "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, 'adapter-a', ?, ?, 1)",
        ).run(participantId, endpointId, MIG_NOW);
      }
      for (const [participantId, sessionId] of [[P1, S1], [P1, S2], [P2, S3]] as const) {
        tx.prepare(
          "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
        ).run(participantId, sessionId, MIG_NOW);
      }
      if (v3) {
        tx.prepare(
          "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, lease_started_at, private_revision) VALUES (?, ?, 1, ?, ?, 1)",
        ).run(P1, S1, at(120), MIG_NOW);
      } else {
        tx.prepare(
          "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, private_revision) VALUES (?, ?, 1, ?, 1)",
        ).run(P1, S1, at(120));
      }
      tx.prepare(
        "INSERT INTO participant_fencing_high_water(participant_id, fencing_token, private_revision) VALUES (?, 1, 1)",
      ).run(P1);
    });
  } finally {
    db.close();
  }
}

function durableRows(db: DatabaseSync | DurableStore["database"]): Record<string, unknown[]> {
  return {
    session: sessionRows(db),
    ownership: db.prepare("SELECT * FROM participant_ownership ORDER BY participant_id").all(),
    fencing: db.prepare("SELECT * FROM participant_fencing_high_water ORDER BY participant_id").all(),
    trust: db.prepare("SELECT * FROM host_trust_root ORDER BY generation").all(),
    participant: db.prepare("SELECT * FROM participant ORDER BY participant_id").all(),
  };
}

function rowsAt(loc: StoreLocation): Record<string, unknown[]> {
  const db = openStorageConnection(loc);
  try {
    return durableRows(db);
  } finally {
    db.close();
  }
}

function migrate(loc: StoreLocation, fromVersion: number, toVersion: number, extra: Partial<Parameters<typeof migrateStore>[0]> = {}) {
  return migrateStore({ ...loc, fromVersion, toVersion, now: () => MIG_NOW, secretBytes: () => MIG_SECRET, ...extra });
}

function freshManifest(): unknown[] {
  const loc = location();
  const fresh = initializeStore({ ...loc, secretBytes: () => MIG_SECRET });
  try {
    return manifest(fresh.database);
  } finally {
    fresh.close();
  }
}

describe("explicit v3 to v4 migration (B3-P2C-A)", () => {
  it("refuses a normal open of a v3 store with STORAGE_MIGRATION_REQUIRED and changes nothing", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    seedSessions(loc, true);
    const before = directorySnapshot(loc.directory);
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  it("migrates v3 to v4: triggers only, ledger row, every Session row preserved, trust root continuous", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    seedSessions(loc, true);
    const before = rowsAt(loc);
    const secretBefore = readFileSync(hostSecretPath(dbPath(loc)), "utf8");
    const migrated = migrate(loc, 3, 4);
    try {
      expect(migrated.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      expect(migrated.database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 3, name: V3_FOUNDATION_NAME, checksum: V3_FOUNDATION_CHECKSUM },
        { version: 4, name: V4_MIGRATION_NAME, checksum: V4_MIGRATION_CHECKSUM },
      ]);
      expect(migrated.database.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({ schema_version: 3 });
      expect(durableRows(migrated.database)).toEqual(before);
      expect(manifest(migrated.database)).toEqual(freshManifest());
      // The preserved Owner keeps working under freshly issued capabilities.
      const resume = issueCapability(migrated, { participantId: P1, scope: "resume", sessionId: S1 }, clockAt(10)).capability;
      expect(
        renewLease(migrated, { participantId: P1, sessionId: S1, fencingToken: 1, capability: resume }, clockAt(10)),
      ).toMatchObject({ sessionId: S1, fencingToken: 1, leaseStartedAt: at(10) });
      expect(readSessionLifecycle(migrated, { participantId: P2, sessionId: S3 })).toEqual({ state: "ATTACHED", boundAt: MIG_NOW });
    } finally {
      migrated.close();
    }
    expect(readFileSync(hostSecretPath(dbPath(loc)), "utf8")).toBe(secretBefore);
    expect(() => openStore(loc).close()).not.toThrow();
    expect(() => migrate(loc, 3, 4)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_NOT_REQUIRED" }));
  });

  it("rolls an interrupted v3 to v4 step back to a valid v3 store and retries cleanly", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    seedSessions(loc, true);
    const before = rowsAt(loc);
    expect(() =>
      migrate(loc, 3, 4, {
        beforeCommit: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).toThrowError(StorageTransactionError);
    expect(preflightStoreShape(dbPath(loc)).kind).toBe("v3");
    expect(rowsAt(loc)).toEqual(before);
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(
        probe.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name = 'participant_session_detach_once'").get(),
      ).toEqual({ n: 0 });
    } finally {
      probe.close();
    }
    migrate(loc, 3, 4).close();
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("requires the existing trust root and never recreates it", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    rmSync(hostSecretPath(dbPath(loc)));
    expect(() => migrate(loc, 3, 4)).toThrowError(expect.objectContaining({ code: "STORAGE_TRUST_ROOT_MISSING" }));
    expect(preflightStoreShape(dbPath(loc)).kind).toBe("v3");
    expect(readdirSync(loc.directory).includes("host-secret")).toBe(false);
  });

  const FOREIGN: readonly (readonly [string, (db: DatabaseSync) => void])[] = [
    ["a detached row at revision 2", (db) => rawDetach(db, P1, S2, at(5))],
    [
      "a detached row at revision 1",
      (db) => db.prepare("UPDATE participant_session SET detached_at = ? WHERE session_id = ?").run(at(5), S2),
    ],
    ["an attached row at revision 2", (db) => db.prepare("UPDATE participant_session SET private_revision = 2 WHERE session_id = ?").run(S2)],
    [
      "an Owner referencing a detached Session",
      (db) => db.prepare("UPDATE participant_session SET detached_at = ? WHERE session_id = ?").run(at(5), S1),
    ],
    ["a non-canonical bound_at", (db) => db.prepare("UPDATE participant_session SET bound_at = ? WHERE session_id = ?").run("2026-10-10", S3)],
  ];

  for (const [label, write] of FOREIGN) {
    it(`refuses ${label} with zero writes (v3 to v4 and v2 to v4)`, () => {
      for (const version of [3, 2] as const) {
        const loc = location();
        initializeOlderStore(loc, version);
        seedSessions(loc, version === 3);
        const db = openStorageConnection(loc);
        try {
          write(db);
        } finally {
          db.close();
        }
        const before = directorySnapshot(loc.directory);
        expect(() => migrate(loc, version, 4)).toThrowError(expect.objectContaining({ code: "STORAGE_CORRUPT" }));
        // Whole-chain preflight: refused before any step commits, nothing repaired.
        expect(directorySnapshot(loc.directory)).toEqual(before);
        expect(preflightStoreShape(dbPath(loc)).kind).toBe(version === 3 ? "v3" : "v2");
      }
    });
  }
});

describe("explicit chained migrations to v4 (B3-P2C-A)", () => {
  it("migrates v2 to v4 through v3, preserving Session history and the trust root", () => {
    const loc = location();
    initializeOlderStore(loc, 2);
    seedSessions(loc, false);
    const before = rowsAt(loc);
    const migrated = migrate(loc, 2, 4);
    try {
      expect(migrated.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 2, name: V2_FOUNDATION_NAME },
        { version: 3, name: V3_MIGRATION_NAME },
        { version: 4, name: V4_MIGRATION_NAME },
      ]);
      const after = durableRows(migrated.database);
      expect(after.session).toEqual(before.session);
      expect(after.fencing).toEqual(before.fencing);
      expect(after.trust).toEqual(before.trust);
      // The legacy v2 ownership row gains only the NULL v3 column.
      expect(before.ownership).toHaveLength(1);
      expect(after.ownership).toEqual((before.ownership ?? []).map((row) => ({ ...(row as object), lease_started_at: null })));
      expect(manifest(migrated.database)).toEqual(freshManifest());
    } finally {
      migrated.close();
    }
    expect(readFileSync(hostSecretPath(dbPath(loc)), "utf8")).toBe(MIG_SECRET_HEX);
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("migrates v1 to v4 through v2 and v3, bootstrapping the trust root once", () => {
    const loc = location();
    initializeOlderStore(loc, 1);
    const migrated = migrate(loc, 1, 4);
    try {
      expect(migrated.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1, name: INITIAL_MIGRATION_NAME },
        { version: 2, name: V2_MIGRATION_NAME },
        { version: 3, name: V3_MIGRATION_NAME },
        { version: 4, name: V4_MIGRATION_NAME },
      ]);
      expect(migrated.database.prepare("SELECT generation, secret_digest FROM host_trust_root").all()).toEqual([
        { generation: 1, secret_digest: hostSecretDigest(MIG_SECRET_HEX) },
      ]);
      expect(manifest(migrated.database)).toEqual(freshManifest());
    } finally {
      migrated.close();
    }
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("commits each step independently: an interrupted v4 step leaves a valid v3 store", () => {
    const loc = location();
    initializeOlderStore(loc, 2);
    seedSessions(loc, false);
    let steps = 0;
    expect(() =>
      migrate(loc, 2, 4, {
        beforeCommit: () => {
          steps += 1;
          if (steps === 2) throw new Error("simulated interruption");
        },
      }),
    ).toThrowError(StorageTransactionError);
    expect(steps).toBe(2);
    expect(preflightStoreShape(dbPath(loc)).kind).toBe("v3");
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }));
    migrate(loc, 3, 4).close();
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("converges fresh, v3-, v2-, and v1-migrated stores to one manifest that is v3 plus the triggers only", () => {
    const expected = freshManifest();
    for (const version of [3, 2, 1] as const) {
      const loc = location();
      initializeOlderStore(loc, version);
      const migrated = migrate(loc, version, 4);
      try {
        expect(manifest(migrated.database)).toEqual(expected);
      } finally {
        migrated.close();
      }
    }
    // v4 adds exactly the lifecycle triggers to the v3 manifest.
    const loc = location();
    initializeOlderStore(loc, 3);
    const v3 = openStorageConnection(loc);
    let v3Names: string[];
    try {
      v3Names = manifest(v3).map((row) => (row as { name: string }).name);
    } finally {
      v3.close();
    }
    const added = expected.map((row) => (row as { name: string }).name).filter((name) => !v3Names.includes(name));
    expect(added.sort()).toEqual([...V4_TRIGGERS].sort());
    expect(V4_ADDITIVE_SQL).not.toMatch(/ALTER TABLE|CREATE TABLE|DROP /);
  });
});
