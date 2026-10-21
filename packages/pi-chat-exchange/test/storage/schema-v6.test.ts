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

describe("current-only payload-capability vocabulary and old-store refusal (E2-A)", () => {
  it("CUR-INIT-01/fresh-current-foundation: v7 preserves payload_read, scope separation and all current guards", () => {
    const loc=location();
    const store=initializeStore({...loc,storeUuid:()=>STORE_UUID,secretBytes:()=>SECRET,now:()=>NOW});
    try {
      expect(CURRENT_SCHEMA_VERSION).toBe(7);
      expect(store.schemaVersion).toBe(7);
      expect(store.database.prepare("PRAGMA user_version").get()).toEqual({user_version:7});
      const ddl=String(store.database.prepare("SELECT sql FROM sqlite_schema WHERE name='participant_capability'").get()!.sql);
      expect(ddl).toContain("'payload_read'"); expect(ddl).toContain("'ack'");
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    }finally{store.close();}
  });
  it.each([1,2,3,4,5] as const)("OLD-REFUSE-01/unsupported-v6-header: v%s refuses without historical migration or repair", version=>{
    const loc=location();initializeHistoricalStore(loc,version);const before=directorySnapshot(loc.directory);
    expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });
  it("old v5 capability, Message, Audit, indexes and guards remain untouched on refusal",()=>{
    const loc=location();initializeHistoricalStore(loc,5);seedV5History(loc);
    const before=directorySnapshot(loc.directory);
    expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });
  it("old v5 drift is not repaired, rebuilt or made current",()=>{
    const loc=location();initializeHistoricalStore(loc,5);const writer=openStorageConnection(loc);
    writer.exec("CREATE TABLE unauthorized_copy(id TEXT) STRICT");writer.close();
    const before=directorySnapshot(loc.directory);
    expect(()=>openStore(loc)).toThrowError(expect.objectContaining({code:"STORAGE_INCOMPATIBLE"}));
    expect(directorySnapshot(loc.directory)).toEqual(before);
  });
  // Historical v5→v6 success/convergence/rebuild-fault obligations are explicitly
  // reclassified, not PASS: see build/LEGACY-BASELINE-INVENTORY.json and SOURCE-TOUCHES.md.
});
