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
  V2_MIGRATION_CHECKSUM,
  V2_MIGRATION_NAME,
} from "../../src/storage/schema.js";
import { initializeStore, openStore } from "../../src/storage/store.js";
import { withImmediateTransaction, StorageTransactionError } from "../../src/storage/transaction.js";
import { hostSecretDigest, hostSecretPath } from "../../src/storage/trust-root.js";

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
  return migrateStore({ ...loc, fromVersion: 1, toVersion: 2, now: () => NOW, secretBytes: () => SECRET, ...extra });
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
      expect(migrated.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      // store_metadata is never UPDATEd: the initialization-time version stays 1.
      expect(migrated.database.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({
        schema_version: 1,
      });
      expect(migrated.database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1, name: INITIAL_MIGRATION_NAME, checksum: INITIAL_MIGRATION_CHECKSUM },
        { version: 2, name: V2_MIGRATION_NAME, checksum: V2_MIGRATION_CHECKSUM },
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
    // The migration proof is a successful normal v2 reopen.
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

  it("refuses any migration path other than the explicitly approved v1 to v2", () => {
    const loc = location();
    initializeV1Store(loc);
    expect(() => migrate(loc, { fromVersion: 2, toVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }),
    );
    expect(() => migrate(loc, { fromVersion: 1, toVersion: 3 })).toThrowError(
      expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }),
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
    // A migrated store carries user_version 2, so a v1 binary can never open
    // it silently; downgrade is impossible.
    const loc = location();
    initializeV1Store(loc);
    migrate(loc).close();
    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      probe.close();
    }
  });
});
