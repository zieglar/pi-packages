import { createHash } from "node:crypto";
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
  V3_FOUNDATION_CHECKSUM,
  V3_FOUNDATION_NAME,
  V3_FOUNDATION_SQL,
  V4_FOUNDATION_CHECKSUM,
  V4_FOUNDATION_NAME,
  V4_FOUNDATION_SQL,
  V5_FOUNDATION_CHECKSUM,
  V5_FOUNDATION_NAME,
  V5_FOUNDATION_SQL,
  V6_FOUNDATION_CHECKSUM,
  V6_FOUNDATION_NAME,
  V6_MIGRATION_CHECKSUM,
  V6_MIGRATION_NAME,
} from "../../src/storage/schema.js";
import { initializeStore, openStore, preflightStoreShape } from "../../src/storage/store.js";
import { StorageTransactionError, withImmediateTransaction } from "../../src/storage/transaction.js";
import { createHostSecretFile, hostSecretDigest } from "../../src/storage/trust-root.js";

interface StoreLocation {
  readonly root: string;
  readonly directory: string;
  readonly filename: string;
}

const roots: string[] = [];
const STORE_UUID = "018f5f43-52f8-7c5a-8f64-9d5e06d24a9a";
const NOW = "2026-10-12T00:00:00.000Z";
const SECRET = new Uint8Array(32).fill(0x65);
const SECRET_HEX = Buffer.from(SECRET).toString("hex");
const PARTICIPANT_ID = "prt_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SESSION_ID = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXCHANGE_ID = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MESSAGE_ID = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";

function location(): StoreLocation {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-schema-v6-"));
  roots.push(root);
  return { root, directory: join(root, "database"), filename: "store.sqlite" };
}

function databasePath(loc: StoreLocation): string {
  return join(loc.directory, loc.filename);
}

const foundations = {
  1: { sql: INITIAL_SCHEMA_SQL, name: INITIAL_MIGRATION_NAME, checksum: INITIAL_MIGRATION_CHECKSUM },
  2: { sql: V2_FOUNDATION_SQL, name: V2_FOUNDATION_NAME, checksum: V2_FOUNDATION_CHECKSUM },
  3: { sql: V3_FOUNDATION_SQL, name: V3_FOUNDATION_NAME, checksum: V3_FOUNDATION_CHECKSUM },
  4: { sql: V4_FOUNDATION_SQL, name: V4_FOUNDATION_NAME, checksum: V4_FOUNDATION_CHECKSUM },
  5: { sql: V5_FOUNDATION_SQL, name: V5_FOUNDATION_NAME, checksum: V5_FOUNDATION_CHECKSUM },
} as const;

type HistoricalVersion = keyof typeof foundations;

function initializeHistoricalStore(loc: StoreLocation, version: HistoricalVersion): void {
  const foundation = foundations[version];
  const db = openStorageConnection(loc, undefined, true);
  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(foundation.sql);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, ?, ?)",
      ).run(STORE_UUID, APPLICATION_ID, version, NOW);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(version, foundation.name, foundation.checksum, NOW);
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      if (version >= 2) {
        tx.prepare(
          "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
        ).run(hostSecretDigest(SECRET_HEX), NOW);
      }
      tx.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${version};`);
    });
  } finally {
    db.close();
  }
  if (version >= 2) createHostSecretFile(databasePath(loc), () => SECRET);
}

function schemaManifest(db: ReturnType<typeof openStorageConnection>): unknown[] {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all();
}

function directorySnapshot(directory: string): [string, string][] {
  return readdirSync(directory)
    .sort()
    .map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

function seedV5History(loc: StoreLocation): void {
  const db = openStorageConnection(loc);
  try {
    withImmediateTransaction(db, (tx) => {
      tx.prepare(
        "INSERT INTO participant(participant_id, endpoint_adapter, endpoint_id, created_at, private_revision) VALUES (?, 'pi', 'endpoint-b', ?, 1)",
      ).run(PARTICIPANT_ID, NOW);
      tx.prepare(
        "INSERT INTO participant_session(participant_id, session_id, bound_at, detached_at, private_revision) VALUES (?, ?, ?, NULL, 1)",
      ).run(PARTICIPANT_ID, SESSION_ID, NOW);
      tx.prepare(
        "INSERT INTO participant_capability(capability_digest, participant_id, scope, trust_generation, created_at, expires_at, revoked_at, private_revision, session_id) VALUES (?, ?, 'read', 1, ?, ?, ?, 7, ?)",
      ).run("a".repeat(64), PARTICIPANT_ID, NOW, "2027-01-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", SESSION_ID);

      const body = new TextEncoder().encode("hello");
      const digest = createHash("sha256").update(body).digest("hex");
      tx.prepare(
        "INSERT INTO exchange(exchange_id, state, created_at, private_revision) VALUES (?, 'OPEN', ?, 1)",
      ).run(EXCHANGE_ID, NOW);
      tx.prepare(
        "INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, ?, ?, 'CREATED', ?, ?, ?, ?, 'message-key', 1)",
      ).run(
        MESSAGE_ID,
        EXCHANGE_ID,
        JSON.stringify({ adapter: "pi", endpointId: "endpoint-a" }),
        JSON.stringify({ adapter: "pi", endpointId: "endpoint-b" }),
        digest,
        body.byteLength,
        body,
        NOW,
      );
      tx.prepare(
        "INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at, digest, length, private_revision) VALUES (?, ?, 1, 'message_created', ?, ?, ?, ?, 1)",
      ).run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", EXCHANGE_ID, MESSAGE_ID, NOW, digest, body.byteLength);
    });
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Schema v6 payload capability migration", () => {
  it("initializes a fresh v6 store with the payload_read vocabulary", () => {
    const loc = location();
    const store = initializeStore({ ...loc, storeUuid: () => STORE_UUID, secretBytes: () => SECRET, now: () => NOW });
    try {
      expect(CURRENT_SCHEMA_VERSION).toBe(6);
      expect(store.schemaVersion).toBe(6);
      expect(store.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(store.database.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual([
        { version: 6, name: V6_FOUNDATION_NAME, checksum: V6_FOUNDATION_CHECKSUM },
      ]);
      const ddl = String(
        store.database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='participant_capability'").get()!.sql,
      );
      expect(ddl).toContain("'read'");
      expect(ddl).toContain("'payload_read'");
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      store.close();
    }
  });

  it.each([1, 2, 3, 4, 5] as const)("requires explicit v%s to v6 migration and opens only after it", (version) => {
    const loc = location();
    initializeHistoricalStore(loc, version);
    expect(() => openStore(loc)).toThrowError(expect.objectContaining({ code: "STORAGE_MIGRATION_REQUIRED" }));

    const migrated = migrateStore({
      ...loc,
      fromVersion: version,
      toVersion: 6,
      now: () => NOW,
      secretBytes: () => SECRET,
    });
    try {
      expect(migrated.schemaVersion).toBe(6);
      expect(migrated.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
      expect(migrated.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(migrated.database.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1").get())
        .toEqual({ version: 6, name: V6_MIGRATION_NAME, checksum: V6_MIGRATION_CHECKSUM });
    } finally {
      migrated.close();
    }
    expect(() => openStore(loc).close()).not.toThrow();
  });

  it("preserves existing capability, Message, Audit, indexes, and triggers during v5 to v6", () => {
    const loc = location();
    initializeHistoricalStore(loc, 5);
    seedV5History(loc);
    const before = openStorageConnection(loc);
    const capabilityBefore = before.prepare("SELECT * FROM participant_capability").all();
    const messageBefore = before.prepare("SELECT * FROM message").all();
    const auditBefore = before.prepare("SELECT * FROM audit_event").all();
    const otherObjectsBefore = before.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name <> 'participant_capability' AND name <> 'sqlite_autoindex_participant_capability_1' ORDER BY type, name",
    ).all();
    before.close();

    const migrated = migrateStore({ ...loc, fromVersion: 5, toVersion: 6, now: () => NOW });
    try {
      expect(migrated.database.prepare("SELECT * FROM participant_capability").all()).toEqual(capabilityBefore);
      expect(migrated.database.prepare("SELECT * FROM message").all()).toEqual(messageBefore);
      expect(migrated.database.prepare("SELECT * FROM audit_event").all()).toEqual(auditBefore);
      expect(migrated.database.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name <> 'participant_capability' AND name <> 'sqlite_autoindex_participant_capability_1' ORDER BY type, name",
      ).all()).toEqual(otherObjectsBefore);
      expect(migrated.database.prepare("PRAGMA index_list('participant_capability')").all())
        .toContainEqual(expect.objectContaining({ name: "sqlite_autoindex_participant_capability_1", unique: 1, origin: "pk" }));
      expect(migrated.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("converges fresh and migrated stores on one exact v6 schema manifest", () => {
    const migratedLoc = location();
    initializeHistoricalStore(migratedLoc, 5);
    migrateStore({ ...migratedLoc, fromVersion: 5, toVersion: 6, now: () => NOW }).close();

    const freshLoc = location();
    initializeStore({ ...freshLoc, storeUuid: () => STORE_UUID, secretBytes: () => SECRET, now: () => NOW }).close();

    const migrated = openStorageConnection(migratedLoc);
    const fresh = openStorageConnection(freshLoc);
    try {
      expect(schemaManifest(migrated)).toEqual(schemaManifest(fresh));
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it("rolls an interrupted v5 to v6 rebuild back to the exact v5 store", () => {
    const loc = location();
    initializeHistoricalStore(loc, 5);
    seedV5History(loc);
    const before = openStorageConnection(loc);
    const beforeManifest = schemaManifest(before);
    const beforeCapabilities = before.prepare("SELECT * FROM participant_capability").all();
    before.close();

    expect(() => migrateStore({
      ...loc,
      fromVersion: 5,
      toVersion: 6,
      now: () => NOW,
      beforeCommit: () => { throw new Error("simulated interruption"); },
    })).toThrowError(StorageTransactionError);

    expect(preflightStoreShape(databasePath(loc)).kind).toBe("v5");
    const probe = openStorageConnection(loc);
    try {
      expect(schemaManifest(probe)).toEqual(beforeManifest);
      expect(probe.prepare("SELECT * FROM participant_capability").all()).toEqual(beforeCapabilities);
      expect(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='participant_capability_v6'").get())
        .toEqual({ n: 0 });
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
      expect(probe.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
    } finally {
      probe.close();
    }
  });

  it("refuses schema drift introduced after writer validation but before the migration transaction", () => {
    const loc = location();
    initializeHistoricalStore(loc, 5);
    seedV5History(loc);

    expect(() => migrateStore({
      ...loc,
      fromVersion: 5,
      toVersion: 6,
      now: () => NOW,
      beforeTransaction: () => {
        const privileged = openStorageConnection(loc);
        try {
          privileged.exec("ALTER TABLE participant_capability ADD COLUMN privileged_note TEXT");
          privileged.prepare(
            "UPDATE participant_capability SET privileged_note = 'must-survive' WHERE capability_digest = ?",
          ).run("a".repeat(64));
        } finally {
          privileged.close();
        }
      },
    })).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));

    const probe = openStorageConnection(loc);
    try {
      expect(probe.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
      expect(probe.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 5 });
      expect(probe.prepare(
        "SELECT privileged_note FROM participant_capability WHERE capability_digest = ?",
      ).get("a".repeat(64))).toEqual({ privileged_note: "must-survive" });
      expect(probe.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='participant_capability_v6'").get())
        .toEqual({ n: 0 });
    } finally {
      probe.close();
    }
  });

  it("refuses v5 schema drift without attempting repair", () => {
    const loc = location();
    initializeHistoricalStore(loc, 5);
    const writer = openStorageConnection(loc);
    writer.exec("CREATE TABLE participant_capability_v6 (id TEXT) STRICT");
    writer.close();
    const before = directorySnapshot(loc.directory);

    expect(() => migrateStore({ ...loc, fromVersion: 5, toVersion: 6, now: () => NOW }))
      .toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });
});
