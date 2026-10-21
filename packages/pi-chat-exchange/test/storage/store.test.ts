import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import {
  APPLICATION_ID,
  CURRENT_SCHEMA_VERSION,
  INITIAL_MIGRATION_CHECKSUM,
  V2_FOUNDATION_CHECKSUM,
  V2_MIGRATION_CHECKSUM,
  V3_FOUNDATION_CHECKSUM,
  V3_MIGRATION_CHECKSUM,
  V4_FOUNDATION_CHECKSUM,
  V4_MIGRATION_CHECKSUM,
  V5_FOUNDATION_CHECKSUM,
  V5_FOUNDATION_NAME,
  V5_MIGRATION_CHECKSUM,
  V7_FOUNDATION_CHECKSUM,
  V7_FOUNDATION_NAME,
  SQLITE_APPLICATION_ID,
} from "../../src/storage/schema.js";
import {
  StoreLifecycleError,
  initializeStore,
  openStore,
} from "../../src/storage/store.js";

const roots: string[] = [];
const STORE_UUID = "018f5f43-52f8-7c5a-8f64-9d5e06d24a9a";

function storeLocation(): { directory: string; filename: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-chat-exchange-store-"));
  roots.push(root);
  return { directory: join(root, "database"), filename: "store.sqlite" };
}

function databasePath(location: ReturnType<typeof storeLocation>): string {
  return join(location.directory, location.filename);
}

function tableNames(db: ReturnType<typeof openStorageConnection>): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("private durable store schema and lifecycle", () => {
  it("initializes explicit store identity and a checksummed version ledger", () => {
    const location = storeLocation();
    const store = initializeStore({
      ...location,
      storeUuid: () => STORE_UUID,
      now: () => "2026-10-08T00:00:00.000Z",
    });
    try {
      expect(CURRENT_SCHEMA_VERSION).toBe(7);
      expect(store.storeUuid).toBe(STORE_UUID);
      expect(store.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(store.database.prepare("PRAGMA application_id").get()).toEqual({ application_id: SQLITE_APPLICATION_ID });
      expect(store.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_SCHEMA_VERSION });
      expect(store.database.prepare("SELECT * FROM store_metadata").get()).toMatchObject({
        singleton: 1,
        store_uuid: STORE_UUID,
        application_id: APPLICATION_ID,
        schema_version: CURRENT_SCHEMA_VERSION,
      });
      expect(store.database.prepare("SELECT version, name, checksum FROM schema_migrations").all()).toEqual([
        { version: CURRENT_SCHEMA_VERSION, name: V7_FOUNDATION_NAME, checksum: V7_FOUNDATION_CHECKSUM },
      ]);
    } finally {
      store.close();
    }
  });

  it("preserves every frozen v1-v5 schema checksum", () => {
    expect({
      initial: INITIAL_MIGRATION_CHECKSUM,
      v2Migration: V2_MIGRATION_CHECKSUM,
      v2Foundation: V2_FOUNDATION_CHECKSUM,
      v3Migration: V3_MIGRATION_CHECKSUM,
      v3Foundation: V3_FOUNDATION_CHECKSUM,
      v4Migration: V4_MIGRATION_CHECKSUM,
      v4Foundation: V4_FOUNDATION_CHECKSUM,
      v5Migration: V5_MIGRATION_CHECKSUM,
      v5Foundation: V5_FOUNDATION_CHECKSUM,
    }).toEqual({
      initial: "8d4e7ac1af702ac1aaf1dffc9d7c71cd45fedc540457b0ef30f0105ac454cbda",
      v2Migration: "688d44b662ba501b2ca04a873178ee6002896ffbe5d4a8de98be0f4621ab48d9",
      v2Foundation: "eb90391ec3e239d647d2254dec72c312669c5de634b74452561d40ee2665808d",
      v3Migration: "b2f82ab1d30f9067ad69a543b0a7bae40da2c3fa406f0d4ae30c8b07c767e3db",
      v3Foundation: "8c572d538c373b599142d0e87da9b0218c138293b6b0fa4644bdcbf306dfa7d9",
      v4Migration: "c50851404d529299d69bc8ab57eea601e0fd73a626a59da9b4d96c2a5fe7e658",
      v4Foundation: "e558f1ae27d715e3b5372b4c62f078e68168b3c50c7975e171edef690e96e62c",
      v5Migration: "2cbf0669141a8aeb9cd134d88387e31367de9dc3c88e02a1467477fe531a44ea",
      v5Foundation: "976de30d1173a5a9d9181c73e1cb33caa8e3f2af65f4a7cd211d59ded46bda17",
    });
  });

  it("creates the complete minimal private schema and correlation indexes", () => {
    const store = initializeStore({ ...storeLocation(), storeUuid: () => STORE_UUID });
    try {
      expect(tableNames(store.database)).toEqual([
        "attempt",
        "audit_event",
        "current_claim",
        "delivery_ack_receipt",
        "delivery_cursor",
        "disposition",
        "evidence_application",
        "evidence_envelope",
        "exchange",
        "exchange_membership",
        "fencing_high_water",
        "host_trust_root",
        "idempotency_record",
        "message",
        "participant",
        "participant_capability",
        "participant_fencing_high_water",
        "participant_ownership",
        "participant_session",
        "reconciliation",
        "restore_hold",
        "result",
        "schema_migrations",
        "store_metadata",
      ]);
      const indexes = store.database
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
        .all()
        .map((row) => String(row.name));
      expect(indexes).toEqual(
        expect.arrayContaining([
          "idx_attempt_message",
          "idx_audit_event_correlation",
          "idx_audit_event_exchange",
          "idx_evidence_envelope_correlation",
          "idx_message_exchange",
          "idx_reconciliation_message",
          "idx_result_correlation",
        ]),
      );
      const correlationIndex = store.database
        .prepare("PRAGMA index_list('audit_event')")
        .all()
        .find((row) => row.name === "idx_audit_event_correlation");
      expect(correlationIndex).toMatchObject({ unique: 0, origin: "c", partial: 0 });
      expect(store.database.prepare("PRAGMA index_info('idx_audit_event_correlation')").all()).toEqual([
        { seqno: 0, cid: 1, name: "exchange_id" },
        { seqno: 1, cid: 3, name: "kind" },
        { seqno: 2, cid: 4, name: "subject_id" },
      ]);
      for (const table of [
        "exchange",
        "message",
        "attempt",
        "current_claim",
        "fencing_high_water",
        "result",
        "idempotency_record",
        "evidence_envelope",
        "evidence_application",
        "reconciliation",
        "disposition",
        "audit_event",
      ]) {
        const columns = store.database.prepare(`PRAGMA table_info(${table})`).all();
        expect(columns.some((column) => column.name === "private_revision")).toBe(true);
      }
    } finally {
      store.close();
    }
  });

  it("enforces foreign keys, uniqueness, and immutable identities", () => {
    const store = initializeStore({ ...storeLocation(), storeUuid: () => STORE_UUID });
    try {
      const db = store.database;
      db.prepare("INSERT INTO exchange(exchange_id, state, created_at) VALUES (?, 'OPEN', ?)").run(
        "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "2026-10-08T00:00:00.000Z",
      );
      const insertMessage = db.prepare(`
        INSERT INTO message(
          message_id, exchange_id, from_endpoint_json, to_endpoint_json, state,
          payload_digest, payload_length, created_at
        ) VALUES (?, ?, '{}', '{}', 'QUEUED', ?, 0, ?)
      `);
      expect(() =>
        insertMessage.run(
          "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          "ho_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          "a".repeat(64),
          "2026-10-08T00:00:00.000Z",
        ),
      ).toThrow();
      insertMessage.run(
        "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "a".repeat(64),
        "2026-10-08T00:00:00.000Z",
      );
      expect(() =>
        db.prepare("UPDATE exchange SET exchange_id = ? WHERE exchange_id = ?").run(
          "ho_01ARZ3NDEKTSV4RRFFQ69G5FAX",
          "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        ),
      ).toThrow();
      expect(() =>
        db.prepare("INSERT INTO fencing_high_water(message_id, fencing_token) VALUES (?, 0)").run(
          "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        ),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("uses only the frozen lifecycle and outcome vocabularies", () => {
    const store = initializeStore({ ...storeLocation(), storeUuid: () => STORE_UUID });
    try {
      const db = store.database;
      const exchangeId = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const attemptId = "att_01ARZ3NDEKTSV4RRFFQ69G5FAV";
      const at = "2026-10-08T00:00:00.000Z";
      db.prepare("INSERT INTO exchange(exchange_id, state, created_at) VALUES (?, 'OPEN', ?)").run(exchangeId, at);
      db.prepare(`
        INSERT INTO message(
          message_id, exchange_id, from_endpoint_json, to_endpoint_json, state,
          payload_digest, payload_length, created_at
        ) VALUES (?, ?, '{}', '{}', 'CREATED', ?, 0, ?)
      `).run(messageId, exchangeId, "a".repeat(64), at);
      expect(() =>
        db.prepare("UPDATE message SET state = 'PENDING' WHERE message_id = ?").run(messageId),
      ).toThrow();
      const insertAttempt = db.prepare(`
        INSERT INTO attempt(
          attempt_id, message_id, endpoint_json, consumer_id, instance_id,
          fencing_token, lease_expires_at, dispatch, transport, created_at
        ) VALUES (?, ?, '{}', 'consumer', 'instance', 1, ?, 'started', ?, ?)
      `);
      expect(() => insertAttempt.run(attemptId, messageId, at, "failed", at)).not.toThrow();
      expect(() =>
        db.prepare("UPDATE attempt SET transport = 'not_delivered' WHERE attempt_id = ?").run(attemptId),
      ).toThrow();
      const insertResult = db.prepare(`
        INSERT INTO result(
          result_id, exchange_id, message_id, attempt_id, source_endpoint_json,
          transport, runtime, body, result_digest, settled_at
        ) VALUES (?, ?, ?, ?, '{}', 'failed', ?, '', ?, ?)
      `);
      expect(() =>
        insertResult.run(
          "hr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          exchangeId,
          messageId,
          attemptId,
          "rejected",
          "b".repeat(64),
          at,
        ),
      ).toThrow();
      expect(() =>
        insertResult.run(
          "hr_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          exchangeId,
          messageId,
          attemptId,
          "cancelled",
          "b".repeat(64),
          at,
        ),
      ).not.toThrow();
    } finally {
      store.close();
    }
  });

  it("reopens a valid store without changing its identity", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    const reopened = openStore(location);
    try {
      expect(reopened.storeUuid).toBe(STORE_UUID);
      expect(reopened.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
  });

  it("rejects initialization over an existing store", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    expect(() => initializeStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_ALREADY_INITIALIZED" }),
    );
  });

  it("rejects a foreign SQLite database", () => {
    const location = storeLocation();
    const foreign = openStorageConnection(location);
    foreign.exec("CREATE TABLE unrelated (id TEXT PRIMARY KEY)");
    foreign.close();
    expect(() => openStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_FOREIGN_STORE" }),
    );
  });

  it("rejects a newer schema version without migrating it", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    const db = openStorageConnection(location);
    db.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_SCHEMA_TOO_NEW" }),
    );
  });

  it("rejects a migration checksum mismatch", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    const db = openStorageConnection(location);
    db.exec("DROP TRIGGER schema_migrations_immutable");
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run(
      "0".repeat(64),
      CURRENT_SCHEMA_VERSION,
    );
    db.close();
    expect(() => openStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_MIGRATION_CHECKSUM_MISMATCH" }),
    );
  });

  it("rejects a store under restore hold", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    const db = openStorageConnection(location);
    db.prepare(
      "UPDATE restore_hold SET held = 1, reason = ?, detected_at = ? WHERE singleton = 1",
    ).run("historical restore requires operator review", "2026-10-08T00:00:00.000Z");
    db.close();
    expect(() => openStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_RESTORE_HOLD" }),
    );
  });

  it("rejects corrupt database content instead of resetting it", () => {
    const location = storeLocation();
    initializeStore({ ...location, storeUuid: () => STORE_UUID }).close();
    chmodSync(databasePath(location), 0o600);
    writeFileSync(databasePath(location), "not a sqlite database", { mode: 0o600 });
    expect(() => openStore(location)).toThrow(StoreLifecycleError);
    expect(() => openStore(location)).toThrowError(
      expect.objectContaining({ code: "STORAGE_CORRUPT" }),
    );
  });
});
