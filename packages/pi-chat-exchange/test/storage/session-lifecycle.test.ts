import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  V4_FOUNDATION_SQL,
  V4_FOUNDATION_NAME,
  V4_MIGRATION_CHECKSUM,
  V4_MIGRATION_NAME,
  V7_FOUNDATION_CHECKSUM,
  V7_FOUNDATION_NAME,
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
function rawDetach(db: Pick<DatabaseSync | SqliteConnection, "prepare">, participantId: string, sessionId: string, detachedAt: string): void {
  const result = db
    .prepare(
      "UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE participant_id = ? AND session_id = ?",
    )
    .run(detachedAt, participantId, sessionId);
  expect(result.changes).toBe(1);
}

function withPrivileged<T>(active: Fixture, body: (db: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec">) => T): T {
  const db = privileged(active);
  try {
    return body(db);
  } finally {
    db.close();
  }
}

/** Drops the named v4 triggers, runs the tamper, then restores the exact
 * stored trigger SQL so the approved schema manifest is byte-identical. */
function tamper(active: Fixture, triggers: readonly string[], body: (db: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec">) => void): void {
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

describe("current schema v7 store preserves the B3-P2C-A lifecycle", () => {
  it("initializes at v7 with the current foundation ledger and every v4 lifecycle trigger", () => {
    const active = fixture("ce-b3-p2c-a-fresh-");
    expect(CURRENT_SCHEMA_VERSION).toBe(7);
    expect(active.store.schemaVersion).toBe(7);
    const db = active.store.database;
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual([
      { version: 7, name: V7_FOUNDATION_NAME, checksum: V7_FOUNDATION_CHECKSUM },
    ]);
    const triggers = db
      .prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'participant_%session%' ORDER BY name")
      .all()
      .map((row) => String(row.name));
    expect(triggers.sort()).toEqual([...V4_TRIGGERS].sort());
    expect(db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type='index' AND name='idx_audit_event_correlation'",
    ).get()).toEqual({
      sql: "CREATE INDEX idx_audit_event_correlation ON audit_event(exchange_id, kind, subject_id)",
    });
    // v4 is purely additive: no table rebuild, no new column, no new scope.
    expect(
      db.prepare("SELECT name FROM pragma_table_info('participant_session') ORDER BY cid").all().map((row) => row.name),
    ).toEqual(["participant_id", "session_id", "bound_at", "detached_at", "private_revision"]);
    const capabilityDdl = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'participant_capability'").get()!.sql,
    );
    expect(capabilityDdl).toContain(
      "scope IN ('create', 'bind', 'join', 'attach', 'resume', 'takeover', 'send', 'ack', 'read', 'payload_read')",
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

  it("refuses a detach whose detached_at is malformed, misordered, or written over a malformed bound_at", () => {
    const w = world();
    const refuse = "Session detach is one-way and irreversible";
    const malformedBounds = ["garbage-bound", "", "2026-13-01T00:00:00.000Z", "2026-10-10T00:00:05Z", "2026-10-10T24:00:00.000Z"];
    withPrivileged(w.active, (db) => {
      // NULL, empty, wrong storage class, and every noncanonical or
      // calendar-invalid instant never commit through the detach path
      // (CE-0002-B3-P2C-A-R1): SQLite now enforces the accepted canonical
      // representation on the transition, not only the one-way revision.
      for (const detachedAt of [
        null, // NULL detached_at alongside revision 2
        "", // empty
        5, // wrong storage class (STRICT stores it as text "5.0")
        "not-a-time", // malformed
        "2026-10-10 00:00:05.000Z", // space separator
        "2026-10-10T00:00:05Z", // no milliseconds
        "2026-10-10T00:00:05.000000Z", // microsecond precision
        "2026-10-10T00:00:05.000", // no UTC marker
        "2026-10-10T00:00:05.000+00:00", // offset instead of Z
        "2026-10-10t00:00:05.000z", // the shape is case-sensitive
        "2026-13-01T00:00:00.000Z", // month 13
        "2026-02-30T00:00:00.000Z", // February 30
        "2027-02-29T00:00:00.000Z", // non-leap February 29
        "2026-10-10T24:00:00.000Z", // hour 24: SQLite parses it, the accepted representation does not
        "2026-10-10T00:60:00.000Z", // minute 60
        "2026-06-30T23:59:60.000Z", // leap second
        at(-1), // earlier than bound_at
      ] as const) {
        expectTriggerAbort(
          () =>
            db
              .prepare("UPDATE participant_session SET detached_at = ?, private_revision = 2 WHERE session_id = ?")
              .run(detachedAt, S1),
          refuse,
        );
      }
      // Control: bound_at itself remains the earliest permitted detach.
      rawDetach(db, w.participantId, S1, at(0));

      // The insert trigger checks only born-ATTACHED, so a privileged writer
      // can still insert a malformed bound_at; the detach path refuses that
      // row fail-closed, and no read ever adopts it.
      malformedBounds.forEach((boundAt, index) => {
        const sessionId = `${S_UNKNOWN.slice(0, -1)}${"ABCDEFGH"[index]!}`;
        db.prepare(
          "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
        ).run(w.participantId, sessionId, boundAt);
        expectTriggerAbort(() => rawDetach(db, w.participantId, sessionId, at(5)), refuse);
        expectRefusal(
          () => readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId }),
          "STORAGE_OWNERSHIP_CORRUPT",
        );
      });
    });
    expect(rowCounts(w.active).session).toBe(String(3 + malformedBounds.length));
    expect(readSessionLifecycle(w.active.store, { participantId: w.participantId, sessionId: S1 })).toEqual({
      state: "DETACHED",
      boundAt: at(0),
      detachedAt: at(0),
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
      // CE-0002-B3-P2C-B (deliberate error-precedence change): a Session-bound
      // capability of a DETACHED Session is unusable at classification, so
      // the opaque CAPABILITY_REJECTED outranks the operation's Session
      // check. Still zero-write.
      "CAPABILITY_REJECTED",
    );
    expectRefusal(
      () =>
        verifyOwnership(
          w.active.store,
          { participantId: w.participantId, sessionId: S2, fencingToken: 1, capability: resume2 },
          clockAt(20),
        ),
      // CE-0002-B3-P2C-B (deliberate error-precedence change): see above.
      "CAPABILITY_REJECTED",
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
      // CE-0002-B3-P2C-B (deliberate error-precedence change): see above.
      "CAPABILITY_REJECTED",
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
        // CE-0002-B3-P2C-B (deliberate error-precedence change): see above.
        "CAPABILITY_REJECTED",
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

function v4Manifest(): unknown[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(V4_FOUNDATION_SQL);
    return manifest(db);
  } finally {
    db.close();
  }
}

describe("old v3 refusal and retained legacy preflight security (E2-A)", () => {
  it("refuses normal open of v3 with STORAGE_INCOMPATIBLE and no writes", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    seedSessions(loc, true);
    const before = directorySnapshot(loc.directory);
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  // v3→v4 success and retry-after-interruption acceptance is historical-only.
  // Replaced by unchanged old-foundation refusal; original bodies in evidence.
  it.each([1,2,3] as const)("refuses v%s while preserving complete Session rows and existing trust artifacts",version=>{
    const loc=location();initializeOlderStore(loc,version);
    if(version>=2)seedSessions(loc,version===3);
    const before=directorySnapshot(loc.directory);
    expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  it("requires the existing trust root and never recreates it", () => {
    const loc = location();
    initializeOlderStore(loc, 3);
    rmSync(hostSecretPath(dbPath(loc)));
    expect(() => migrate(loc, 3, 4)).toThrowError(expect.objectContaining({ code: "STORAGE_TRUST_ROOT_MISSING" }));
    expect(preflightStoreShape(dbPath(loc)).kind).toBe("v3");
    expect(readdirSync(loc.directory).includes("host-secret")).toBe(false);
  });

  const FOREIGN: readonly (readonly [string, (db: Pick<DatabaseSync | SqliteConnection, "prepare" | "exec">) => void])[] = [
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

// Explicit chained-migration success/convergence/interruption requirements are
// retired from E2-A runtime acceptance, not skipped/PASS. See SOURCE-TOUCHES.md.
// Current Session lifecycle security and old-store refusal above remain active.
