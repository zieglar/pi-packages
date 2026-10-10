import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { migrateStore } from "../../src/storage/migration.js";
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
  V2_MIGRATION_CHECKSUM,
  V2_MIGRATION_NAME,
  V3_MIGRATION_CHECKSUM,
  V3_MIGRATION_NAME,
} from "../../src/storage/schema.js";
import { initializeStore, openStore, preflightStoreShape } from "../../src/storage/store.js";
import { withImmediateTransaction, StorageTransactionError } from "../../src/storage/transaction.js";
import { acquireOwnership, readCurrentOwnership, readFencingHighWater, readLeaseStatus, reconcileTakeover, renewLease, takeoverOwnership } from "../../src/storage/ownership.js";
import { issueCapability } from "../../src/storage/participant.js";
import { createHostSecretFile, hostSecretDigest, hostSecretPath } from "../../src/storage/trust-root.js";

const roots: string[] = [];
interface StoreLocation {
  readonly root: string;
  readonly directory: string;
  readonly filename: string;
}
function location(): StoreLocation {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-b3-migration-"));
  roots.push(root);
  return { root, directory: join(root, "database"), filename: "store.sqlite" };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const STORE_UUID = "018f5f43-52f8-7c5a-8f64-9d5e06d24a9a";
const SECRET = new Uint8Array(32).fill(0x33);
const SECRET_HEX = Buffer.from(SECRET).toString("hex");
const NOW = "2026-10-09T00:00:00.000Z";
const EXCHANGE_ID = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MESSAGE_ID = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";

/** Builds exactly the store a v1 binary would have produced, including seeded
 * B2 rows, using the accepted v1 initialization statements verbatim. */
function initializeV1Store(loc: StoreLocation): void {
  const db = openStorageConnection(loc, undefined, true);
  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(INITIAL_SCHEMA_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, 1, ?)",
      ).run(STORE_UUID, APPLICATION_ID, NOW);
      tx.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (1, ?, ?, ?)").run(
        INITIAL_MIGRATION_NAME,
        INITIAL_MIGRATION_CHECKSUM,
        NOW,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=1;`);
      tx.prepare("INSERT INTO exchange(exchange_id, state, created_at, private_revision) VALUES (?, 'OPEN', ?, 1)").run(
        EXCHANGE_ID,
        NOW,
      );
      tx.prepare(
        "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, created_at, idempotency_key, private_revision) VALUES (?, ?, '{}', '{}', 'CREATED', ?, 0, ?, 'key-1', 1)",
      ).run(MESSAGE_ID, EXCHANGE_ID, "a".repeat(64), NOW);
      tx.prepare(
        "INSERT INTO idempotency_record(namespace, idempotency_key, request_digest, entity_id, created_at, private_revision) VALUES (?, ?, ?, ?, ?, 1)",
      ).run('["message.create","ho_01ARZ3NDEKTSV4RRFFQ69G5FAV"]', "key-1", "b".repeat(64), MESSAGE_ID, NOW);
      tx.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, private_revision) VALUES (?, ?, 1, 'exchange_opened', ?, ?, 1)",
      ).run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", EXCHANGE_ID, EXCHANGE_ID, NOW);
      tx.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, private_revision) VALUES (?, ?, 2, 'message_created', ?, ?, ?, 0, 1)",
      ).run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAW", EXCHANGE_ID, MESSAGE_ID, NOW, "a".repeat(64));
    });
  } finally {
    db.close();
  }
}

function directorySnapshot(directory: string): [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

function schemaManifestRows(database: { prepare: (sql: string) => { all: () => unknown[] } }): unknown[] {
  return database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
}

function migrate(loc: StoreLocation, extra?: Partial<Parameters<typeof migrateStore>[0]>) {
  return migrateStore({
    ...loc,
    fromVersion: 1,
    toVersion: CURRENT_SCHEMA_VERSION,
    now: () => NOW,
    secretBytes: () => SECRET,
    ...extra,
  });
}

describe("explicit v1 to v2 migration (B3-P1A)", () => {
  it("refuses a normal open of a recognized v1 store with STORAGE_MIGRATION_REQUIRED and changes nothing", () => {
    const loc = location();
    initializeV1Store(loc);
    const before = directorySnapshot(loc.directory);
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }),
    );
    // No implicit migration: the refused open is byte-identical nonmutating.
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  it("migrates explicitly: v2 ledger row, user_version advance, preserved metadata version, UUID, and every v1 row", () => {
    const loc = location();
    initializeV1Store(loc);

    const migrated = migrate(loc);
    try {
      expect(migrated.storeUuid).toBe(STORE_UUID);
      expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrated.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      // store_metadata is never UPDATEd: the initialization-time version stays 1.
      expect(migrated.database.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({
        schema_version: 1,
      });
      expect(migrated.database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1, name: INITIAL_MIGRATION_NAME, checksum: INITIAL_MIGRATION_CHECKSUM },
        { version: 2, name: V2_MIGRATION_NAME, checksum: V2_MIGRATION_CHECKSUM },
        { version: 3, name: V3_MIGRATION_NAME, checksum: V3_MIGRATION_CHECKSUM },
      ]);
      // Every seeded v1 row survives intact.
      expect(migrated.database.prepare("SELECT exchange_id, state, created_at FROM exchange").all()).toEqual([
        { exchange_id: EXCHANGE_ID, state: "OPEN", created_at: NOW },
      ]);
      expect(
        migrated.database.prepare("SELECT message_id, exchange_id, state, idempotency_key FROM message").all(),
      ).toEqual([{ message_id: MESSAGE_ID, exchange_id: EXCHANGE_ID, state: "CREATED", idempotency_key: "key-1" }]);
      expect(migrated.database.prepare("SELECT entity_id FROM idempotency_record").all()).toEqual([
        { entity_id: MESSAGE_ID },
      ]);
      expect(migrated.database.prepare("SELECT sequence, kind FROM audit_event ORDER BY sequence").all()).toEqual([
        { sequence: 1, kind: "exchange_opened" },
        { sequence: 2, kind: "message_created" },
      ]);
      // Trust root generation 1 was bootstrapped with the secret fingerprint.
      expect(migrated.database.prepare("SELECT generation, secret_digest FROM host_trust_root").all()).toEqual([
        { generation: 1, secret_digest: hostSecretDigest(SECRET_HEX) },
      ]);
      expect(readFileSync(hostSecretPath(join(loc.directory, loc.filename)), "utf8")).toBe(SECRET_HEX);
      // Ownership/fencing/cursor tables are inert schema in P1A.
      for (const table of [
        "participant",
        "participant_capability",
        "participant_session",
        "exchange_membership",
        "participant_ownership",
        "participant_fencing_high_water",
        "delivery_cursor",
      ]) {
        expect(migrated.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
      }
    } finally {
      migrated.close();
    }
    // The migration proof is a successful normal reopen at the current version.
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("converges to a byte-identical schema manifest for migrated and freshly initialized stores", () => {
    const migratedLoc = location();
    initializeV1Store(migratedLoc);
    migrate(migratedLoc).close();

    const freshLoc = location();
    initializeStore({ ...freshLoc, secretBytes: () => SECRET }).close();

    const migrated = openStore(migratedLoc);
    const fresh = openStore(freshLoc);
    try {
      expect(schemaManifestRows(migrated.database)).toEqual(schemaManifestRows(fresh.database));
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it("refuses migration of a store that does not require it, with zero writes", () => {
    const loc = location();
    initializeStore({ ...loc, secretBytes: () => SECRET }).close();
    const before = directorySnapshot(loc.directory);
    expect(() => migrate(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_NOT_REQUIRED" }),
    );
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });

  it("refuses any migration path other than the explicitly approved ones", () => {
    const loc = location();
    initializeV1Store(loc);
    for (const [fromVersion, toVersion] of [[2, 2], [1, 4], [3, 3], [3, 2]] as const) {
      expect(() => migrate(loc, { fromVersion, toVersion })).toThrowError(
        expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }),
      );
    }
  });

  it("keeps the accepted v1 to v2 path: a v2 store then requires the explicit v2 to v3 migration", () => {
    const loc = location();
    initializeV1Store(loc);
    // The accepted path still migrates v1 to v2 and returns the validated store.
    const v2 = migrate(loc, { fromVersion: 1, toVersion: 2 });
    v2.close();
    // A v2 store is recognized but no longer current: normal open refuses with
    // the typed migration-required result; the store is never silently migrated.
    expect(preflightStoreShape(join(loc.directory, loc.filename)).kind).toBe("v2");
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }),
    );
    // The follow-on approved step completes the chain and the store opens.
    migrate(loc, { fromVersion: 2, toVersion: 3 }).close();
    expect(() => openStore(loc).close()).not.toThrow();
    // A repeated step is not required.
    expect(() => migrate(loc, { fromVersion: 2, toVersion: 3 })).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_NOT_REQUIRED" }),
    );
  });

  it("refuses a drifted v1 store without migrating or creating a secret", () => {
    const loc = location();
    initializeV1Store(loc);
    const modifier = openStorageConnection(loc);
    modifier.exec("CREATE TABLE unauthorized (id TEXT)");
    modifier.close();
    expect(() => migrate(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }),
    );
    expect(readdirSync(loc.directory).includes("host-secret")).toBe(false);
  });

  it("honors restore hold before migrating", () => {
    const loc = location();
    initializeV1Store(loc);
    const modifier = openStorageConnection(loc);
    modifier
      .prepare("UPDATE restore_hold SET held = 1, reason = ?, detected_at = ? WHERE singleton = 1")
      .run("historical restore requires operator review", NOW);
    modifier.close();
    expect(() => migrate(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_RESTORE_HOLD" }));
    expect(readdirSync(loc.directory).includes("host-secret")).toBe(false);
  });

  it("rolls an interrupted migration back to a valid v1 store and fails closed on the orphan secret", () => {
    const loc = location();
    initializeV1Store(loc);
    expect(() =>
      migrate(loc, {
        beforeCommit: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).toThrowError(StorageTransactionError);

    // The rollback is complete: the store is still a recognized, openable-as-
    // migration-required v1 store with no v2 objects.
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }),
    );
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(probe.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
      expect(
        probe.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'host_trust_root'").get(),
      ).toEqual({ count: 0 });
      expect(probe.prepare("SELECT COUNT(*) AS count FROM message").get()).toEqual({ count: 1 });
    } finally {
      probe.close();
    }

    // The orphan secret is never overwritten or deleted automatically: retry
    // refuses until the operator explicitly removes it.
    expect(() => migrate(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_TRUST_ROOT_AMBIGUOUS" }),
    );
    rmSync(hostSecretPath(join(loc.directory, loc.filename)));
    expect(() => migrate(loc).close()).not.toThrow();
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("refuses a tampered v2 ledger after migration", () => {
    const loc = location();
    initializeV1Store(loc);
    migrate(loc).close();
    const modifier = openStorageConnection(loc);
    modifier.exec("DROP TRIGGER schema_migrations_immutable");
    modifier.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2").run("0".repeat(64));
    modifier.close();
    expect(() => openStore(loc)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_CHECKSUM_MISMATCH" }),
    );
  });

  it("refuses schema drift on migrated stores", () => {
    const loc = location();
    initializeV1Store(loc);
    migrate(loc).close();
    const modifier = openStorageConnection(loc);
    modifier.exec("CREATE TABLE unauthorized (id TEXT)");
    modifier.close();
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));

    const dropped = location();
    initializeV1Store(dropped);
    migrate(dropped).close();
    const alterer = openStorageConnection(dropped);
    alterer.exec("DROP TRIGGER host_trust_root_immutable");
    alterer.close();
    expect(() => openStore(dropped)).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
  });

  it("keeps migrated stores structurally newer than any v1 binary accepts", () => {
    // Cross-version control: the accepted v1 reopen policy refuses any
    // user_version greater than 1 (B2 store.test.ts proves the refusal path).
    // A migrated store carries the current user_version, so an older binary can
    // never open it silently; downgrade is impossible.
    const loc = location();
    initializeV1Store(loc);
    migrate(loc).close();
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
    } finally {
      probe.close();
    }
  });
});

describe("explicit v2 to v3 migration (B3-P2A-R1)", () => {
  const P1 = "prt_01ARZ3NDEKTSV4RRFFQ69G5FA0";
  const P2 = "prt_01ARZ3NDEKTSV4RRFFQ69G5FA1";
  const S1 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA0";
  const S2 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA1";
  const S3 = "ses_01ARZ3NDEKTSV4RRFFQ69G5FA2";
  const FAR_FUTURE = "2027-01-01T00:00:00.000Z";

  /** Builds exactly the store a v2 initialization would have produced. */
  function initializeV2Store(loc: StoreLocation): void {
    const digest = hostSecretDigest(SECRET_HEX);
    const db = openStorageConnection(loc, undefined, true);
    try {
      withImmediateTransaction(db, (tx) => {
        tx.exec(V2_FOUNDATION_SQL);
        tx.prepare(
          "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, 2, ?)",
        ).run(STORE_UUID, APPLICATION_ID, NOW);
        tx.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (2, ?, ?, ?)").run(
          V2_FOUNDATION_NAME,
          V2_FOUNDATION_CHECKSUM,
          NOW,
        );
        tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
        tx.prepare(
          "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
        ).run(digest, NOW);
        tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=2;`);
      });
    } finally {
      db.close();
    }
    // The host secret artifact accompanies the store (v2 initialization order).
    createHostSecretFile(join(loc.directory, loc.filename), () => SECRET);
  }

  /** Seeds v2 ownership history: P1 owns via S1 (token 1), S2 also bound to P1,
   * S3 bound to P2. Written before the v3 columns exist, so the ownership row
   * carries no lease start. */
  function seedV2Ownership(loc: StoreLocation): void {
    const db = openStorageConnection(loc);
    try {
      withImmediateTransaction(db, (tx) => {
        for (const [participantId, endpointId] of [[P1, "endpoint-1"], [P2, "endpoint-2"]] as const) {
          tx.prepare(
            "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, 'adapter-a', ?, ?, 1)",
          ).run(participantId, endpointId, NOW);
        }
        for (const [participantId, sessionId] of [[P1, S1], [P1, S2], [P2, S3]] as const) {
          tx.prepare(
            "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
          ).run(participantId, sessionId, NOW);
        }
        // A lease whose deadline lies in the future, with no persisted start.
        tx.prepare(
          "INSERT INTO participant_ownership(participant_id, session_id, fencing_token, expires_at, private_revision) VALUES (?, ?, 1, ?, 1)",
        ).run(P1, S1, FAR_FUTURE);
        tx.prepare(
          "INSERT INTO participant_fencing_high_water(participant_id, fencing_token, private_revision) VALUES (?, 1, 1)",
        ).run(P1);
      });
    } finally {
      db.close();
    }
  }

  function migrateV3(loc: StoreLocation, extra?: Partial<Parameters<typeof migrateStore>[0]>) {
    return migrateStore({ ...loc, fromVersion: 2, toVersion: 3, now: () => NOW, ...extra });
  }

  it("migrates v2 history: legacy ownership rows keep no lease start and never authorize", () => {
    const loc = location();
    initializeV2Store(loc);
    seedV2Ownership(loc);
    const migrated = migrateV3(loc);
    try {
      expect(migrated.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(migrated.database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 2, name: V2_FOUNDATION_NAME },
        { version: 3, name: V3_MIGRATION_NAME },
      ]);
      // The initialization-time metadata version stays 2 (never UPDATEd).
      expect(migrated.database.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({ schema_version: 2 });
      // No lease start was fabricated: the legacy row keeps NULL.
      expect(
        migrated.database.prepare("SELECT session_id, expires_at, lease_started_at FROM participant_ownership").all(),
      ).toEqual([{ session_id: S1, expires_at: FAR_FUTURE, lease_started_at: null }]);
      // Freshly issued v3 capabilities drive the policy checks. Even though the
      // stored deadline lies in the future, the legacy row never authorizes.
      const attach = issueCapability(migrated, { participantId: P1, scope: "attach" }, { now: () => NOW }).capability;
      const resume = issueCapability(migrated, { participantId: P1, scope: "resume", sessionId: S1 }, { now: () => NOW }).capability;
      expect(readLeaseStatus(migrated, { participantId: P1 }, { now: () => NOW })).toBe("EXPIRED");
      expect(() => renewLease(migrated, { participantId: P1, sessionId: S1, fencingToken: 1, capability: resume }, { now: () => NOW })).toThrowError(
        expect.objectContaining({ code: "LEASE_EXPIRED" }),
      );
      expect(() =>
        acquireOwnership(migrated, { participantId: P1, sessionId: S2, capability: attach }, { now: () => NOW }),
      ).toThrowError(expect.objectContaining({ code: "OWNERSHIP_TAKEOVER_REQUIRED" }));
      // Fencing high-water and the durable row survive untouched.
      expect(readFencingHighWater(migrated, P1)).toBe(1);
      expect(readCurrentOwnership(migrated, P1)).toMatchObject({ sessionId: S1, fencingToken: 1, leaseStartedAt: null });
    } finally {
      migrated.close();
    }
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("supports explicit takeover of a migrated legacy Owner (B3-P2B)", () => {
    const loc = location();
    initializeV2Store(loc);
    seedV2Ownership(loc); // P1 owned by S1, token 1, lease_started_at NULL
    const migrated = migrateV3(loc);
    try {
      // Takeover requires a Session-bound takeover capability for the target.
      const takeover = issueCapability(migrated, { participantId: P1, scope: "takeover", sessionId: S2 }, { now: () => NOW }).capability;
      const lease = takeoverOwnership(
        migrated,
        { participantId: P1, sessionId: S2, capability: takeover },
        { now: () => NOW },
      );
      // The next fencing token is strictly greater than the legacy token, and
      // the new row carries a persisted v3 lease start.
      expect(lease).toMatchObject({ sessionId: S2, fencingToken: 2, leaseStartedAt: NOW });
      expect(readFencingHighWater(migrated, P1)).toBe(2);
      expect(readLeaseStatus(migrated, { participantId: P1 }, { now: () => NOW })).toBe("ACTIVE");
      expect(
        reconcileTakeover(migrated, {
          participantId: P1,
          sessionId: S2,
          leaseStartedAt: NOW,
          expiresAt: lease.expiresAt,
          fencingToken: 2,
        }),
      ).toMatchObject({ disposition: "COMMITTED" });
      // The superseded legacy Owner is not current: its resume capability
      // cannot renew, release, or verify the new Owner.
      const resume1 = issueCapability(migrated, { participantId: P1, scope: "resume", sessionId: S1 }, { now: () => NOW }).capability;
      expect(() =>
        renewLease(migrated, { participantId: P1, sessionId: S1, fencingToken: 1, capability: resume1 }, { now: () => NOW }),
      ).toThrowError(expect.objectContaining({ code: "OWNERSHIP_NOT_CURRENT" }));
      // Historical bindings are preserved for audit continuity.
      expect(
        migrated.database
          .prepare("SELECT session_id FROM participant_session WHERE participant_id = ? ORDER BY session_id")
          .all(P1)
          .map((row) => row.session_id),
      ).toEqual([S1, S2]);
    } finally {
      migrated.close();
    }
  });

  it("converges to a byte-identical manifest across fresh, chain-migrated, and v2-migrated stores", () => {
    const freshLoc = location();
    initializeStore({ ...freshLoc, secretBytes: () => SECRET }).close();

    const chainLoc = location();
    initializeV1Store(chainLoc);
    migrate(chainLoc).close();

    const v2Loc = location();
    initializeV2Store(v2Loc);
    migrateV3(v2Loc).close();

    const fresh = openStore(freshLoc);
    const chained = openStore(chainLoc);
    const fromV2 = openStore(v2Loc);
    try {
      expect(schemaManifestRows(chained.database)).toEqual(schemaManifestRows(fresh.database));
      expect(schemaManifestRows(fromV2.database)).toEqual(schemaManifestRows(fresh.database));
      // The v3 objects exist exactly once.
      const names = schemaManifestRows(fresh.database).map((row) => (row as { name: string }).name);
      expect(names).toContain("participant_session_unique_session_id");
      expect(names.filter((name) => name === "participant_ownership")).toHaveLength(1);
    } finally {
      fresh.close();
      chained.close();
      fromV2.close();
    }
  });

  it("rejects conflicting historical Session bindings rather than repairing them", () => {
    const loc = location();
    initializeV2Store(loc);
    seedV2Ownership(loc);
    // Conflicting history: S3 is additionally bound to P1 (the v2 schema has no
    // durable cross-Participant uniqueness; this is exactly what v3 adds).
    const db = openStorageConnection(loc);
    try {
      withImmediateTransaction(db, (tx) => {
        tx.prepare(
          "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
        ).run(P1, S3, NOW);
      });
    } finally {
      db.close();
    }

    expect(() => migrateV3(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_CORRUPT" }));
    // Fail closed with zero durable change: the store is still a recognized v2
    // store, its ledger and rows are untouched, and no v3 object exists.
    expect(preflightStoreShape(join(loc.directory, loc.filename)).kind).toBe("v2");
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }));
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(probe.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([{ version: 2 }]);
      expect(
        probe.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('participant_ownership') WHERE name = 'lease_started_at'").get(),
      ).toEqual({ count: 0 });
      expect(probe.prepare("SELECT COUNT(*) AS count FROM participant_session").get()).toEqual({ count: 4 });
    } finally {
      probe.close();
    }
    // The durable constraint is real once migrated data is clean: a duplicate
    // Session cannot be written even by a privileged writer.
    const clean = location();
    initializeV2Store(clean);
    seedV2Ownership(clean);
    migrateV3(clean).close();
    const writer = openStorageConnection(clean);
    try {
      expect(() =>
        writer
          .prepare(
            "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
          )
          .run(P2, S1, NOW),
      ).toThrow();
    } finally {
      writer.close();
    }
  });

  it("rolls an interrupted v2 to v3 migration back to a valid v2 store and retries cleanly", () => {
    const loc = location();
    initializeV2Store(loc);
    seedV2Ownership(loc);
    expect(() =>
      migrateV3(loc, {
        beforeCommit: () => {
          throw new Error("simulated interruption");
        },
      }),
    ).toThrowError(StorageTransactionError);
    expect(preflightStoreShape(join(loc.directory, loc.filename)).kind).toBe("v2");
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }));
    // No orphan artifacts block the retry: v2 to v3 never touches the secret.
    migrateV3(loc).close();
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("requires the existing trust root: v2 to v3 never rotates or recreates the host secret", () => {
    const loc = location();
    initializeV2Store(loc);
    seedV2Ownership(loc);
    rmSync(hostSecretPath(join(loc.directory, loc.filename)));
    expect(() => migrateV3(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_TRUST_ROOT_MISSING" }));
    expect(preflightStoreShape(join(loc.directory, loc.filename)).kind).toBe("v2");
  });
});
