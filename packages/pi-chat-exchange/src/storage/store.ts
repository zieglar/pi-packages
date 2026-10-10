import { constants, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { openStorageConnection, type StorageConnectionOptions } from "./connection.js";
import {
  FilesystemSafetyError,
  prepareDatabasePath,
  assertSecureDatabaseArtifacts,
  pathStat,
  withRestrictiveUmask,
} from "./filesystem.js";
import { RuntimeEligibilityError } from "./runtime.js";
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
} from "./schema.js";
import { withImmediateTransaction } from "./transaction.js";
import { StoreLifecycleError } from "./errors.js";
import { assertTrustRootAbsent, createHostSecretFile, validateTrustRoot } from "./trust-root.js";
export { StoreLifecycleError } from "./errors.js";
export type { StoreLifecycleErrorCode } from "./errors.js";

export interface InitializeStoreOptions extends StorageConnectionOptions {
  /** Private deterministic test seam; production callers omit this. */
  readonly storeUuid?: () => string;
  /** Private deterministic test seam; production callers omit this. */
  readonly now?: () => string;
  /** Private deterministic test seam; production callers omit this. Must
   * return exactly 32 bytes; the bytes are hex-encoded into the host secret
   * file and never persisted in SQLite. */
  readonly secretBytes?: () => Uint8Array;
}
export interface DurableStore {
  readonly database: DatabaseSync;
  readonly storeUuid: string;
  readonly schemaVersion: number;
  /** Private host-local path of the validated database file. Required by the
   * B3-P1B capability plane to re-read the host trust root; never part of any
   * public result, error, or audit surface. */
  readonly databasePath: string;
  close(): void;
}

export interface StoreMetadataRow {
  readonly singleton: number;
  readonly store_uuid: string;
  readonly application_id: string;
  readonly schema_version: number;
  readonly created_at: string;
}

const V1_REQUIRED_TABLES = new Set([
  "attempt",
  "audit_event",
  "current_claim",
  "disposition",
  "evidence_application",
  "evidence_envelope",
  "exchange",
  "fencing_high_water",
  "idempotency_record",
  "message",
  "reconciliation",
  "restore_hold",
  "result",
  "schema_migrations",
  "store_metadata",
]);

const V2_REQUIRED_TABLES = new Set([
  ...V1_REQUIRED_TABLES,
  "delivery_cursor",
  "exchange_membership",
  "host_trust_root",
  "participant",
  "participant_capability",
  "participant_fencing_high_water",
  "participant_ownership",
  "participant_session",
]);

// Strict compatibility: compare every persisted schema object, including implicit
// indexes. Root pages are layout, not schema. SQL is intentionally not normalized:
// even semantically equivalent unauthorized DDL is incompatible.
function schemaManifest(db: DatabaseSync): string {
  return JSON.stringify(db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
  ).all());
}

const approvedManifests: { v1?: string; v2?: string } = {};
function approvedManifest(version: 1 | 2): string {
  const cached = approvedManifests[version === 1 ? "v1" : "v2"];
  if (cached !== undefined) return cached;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(version === 1 ? INITIAL_SCHEMA_SQL : V2_FOUNDATION_SQL);
    const manifest = schemaManifest(reference);
    approvedManifests[version === 1 ? "v1" : "v2"] = manifest;
    return manifest;
  } finally {
    reference.close();
  }
}

function assertApprovedSchema(db: DatabaseSync, version: 1 | 2): void {
  if (schemaManifest(db) !== approvedManifest(version)) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "live schema differs from the approved manifest");
  }
}

function firstColumn(db: DatabaseSync, sql: string): SQLOutputValue | undefined {
  const row = db.prepare(sql).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function isStoreUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function closeAfterFailure(db: DatabaseSync, error: unknown): never {
  try {
    db.close();
  } catch {
    // Preserve the validation failure; the connection is already unusable.
  }
  throw error;
}

function handle(db: DatabaseSync, metadata: StoreMetadataRow, databasePath: string): DurableStore {
  return {
    database: db,
    storeUuid: metadata.store_uuid,
    // The validated live schema version (PRAGMA user_version == ledger maximum),
    // not the initialization-time store_metadata.schema_version, which stays 1
    // for migrated stores and is never updated.
    schemaVersion: CURRENT_SCHEMA_VERSION,
    databasePath,
    close: () => db.close(),
  };
}
function assertIntegrity(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA integrity_check").all();
  if (
    rows.length !== 1 ||
    Object.values(rows[0] ?? {})[0] !== "ok" ||
    db.prepare("PRAGMA foreign_key_check").all().length !== 0
  ) {
    throw new StoreLifecycleError("STORAGE_CORRUPT", "SQLite integrity validation failed");
  }
}

interface MigrationLedgerRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export type StoreShapeKind = "v1" | "v2";
export interface StoreShape {
  readonly kind: StoreShapeKind;
  readonly metadata: StoreMetadataRow;
}

function ledgerMatches(
  migrations: MigrationLedgerRow[],
  expected: readonly (readonly [number, string, string])[],
): boolean {
  return (
    migrations.length === expected.length &&
    expected.every(
      ([version, name, checksum], index) =>
        migrations[index]?.version === version &&
        migrations[index]?.name === name &&
        migrations[index]?.checksum === checksum,
    )
  );
}

function assertRestoreHoldReleased(db: DatabaseSync): void {
  const restoreHold = db
    .prepare("SELECT held FROM restore_hold WHERE singleton = 1")
    .get() as { held?: unknown } | undefined;
  if (restoreHold?.held === 1) {
    throw new StoreLifecycleError(
      "STORAGE_RESTORE_HOLD",
      "store is under restore hold and cannot be opened writable",
    );
  }
  if (restoreHold?.held !== 0) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store restore-hold state is invalid");
  }
}

/** Classifies a store into exactly one approved shape. Recognition of a
 * pristine v1 store (STORAGE_MIGRATION_REQUIRED on normal open) is separated
 * from drift (STORAGE_INCOMPATIBLE), tamper (STORAGE_MIGRATION_CHECKSUM_MISMATCH),
 * and newer versions (STORAGE_SCHEMA_TOO_NEW). `store_metadata.schema_version`
 * is the schema version at initialization (1 for migrated stores, 2 for fresh
 * v2 stores); it is never updated, and the v1 immutability trigger keeps it
 * that way. The live version is `PRAGMA user_version`, which must equal the
 * ledger's highest entry. */
export function classifyStoreShape(db: DatabaseSync): StoreShape {
  assertIntegrity(db);

  const sqliteApplicationId = firstColumn(db, "PRAGMA application_id");
  const sqliteSchemaVersion = firstColumn(db, "PRAGMA user_version");
  if (typeof sqliteSchemaVersion !== "number") {
    throw new StoreLifecycleError("STORAGE_CORRUPT", "SQLite did not return a schema version");
  }
  if (sqliteSchemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new StoreLifecycleError(
      "STORAGE_SCHEMA_TOO_NEW",
      `store schema ${sqliteSchemaVersion} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  if (sqliteApplicationId !== SQLITE_APPLICATION_ID) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "SQLite application identity is not Chat Exchange");
  }

  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  for (const table of V1_REQUIRED_TABLES) {
    if (!tables.has(table)) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", `required private table ${table} is missing`);
    }
  }

  const metadata = db.prepare("SELECT * FROM store_metadata WHERE singleton = 1").get() as
    | StoreMetadataRow
    | undefined;
  if (metadata === undefined || !isStoreUuid(metadata.store_uuid)) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store metadata identity is missing or invalid");
  }
  if (metadata.application_id !== APPLICATION_ID) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "store metadata belongs to another application");
  }
  if (metadata.schema_version > CURRENT_SCHEMA_VERSION) {
    throw new StoreLifecycleError(
      "STORAGE_SCHEMA_TOO_NEW",
      `store metadata schema ${metadata.schema_version} is newer than supported schema ${CURRENT_SCHEMA_VERSION}`,
    );
  }

  const migrations = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as MigrationLedgerRow[];

  const shapeVersion = ledgerMatches(migrations, [[1, INITIAL_MIGRATION_NAME, INITIAL_MIGRATION_CHECKSUM]])
    ? 1
    : ledgerMatches(migrations, [
        [1, INITIAL_MIGRATION_NAME, INITIAL_MIGRATION_CHECKSUM],
        [2, V2_MIGRATION_NAME, V2_MIGRATION_CHECKSUM],
      ]) || ledgerMatches(migrations, [[2, V2_FOUNDATION_NAME, V2_FOUNDATION_CHECKSUM]])
      ? 2
      : undefined;
  if (shapeVersion === undefined) {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_CHECKSUM_MISMATCH",
      "store migration ledger does not match the approved schema",
    );
  }

  // Version coherence: the initialization-time metadata version is 1 exactly
  // when the store began at v1 (whether or not it was migrated since), and 2
  // exactly when it was initialized at v2.
  const expectedMetadataVersion = ledgerMatches(migrations, [[2, V2_FOUNDATION_NAME, V2_FOUNDATION_CHECKSUM]])
    ? 2
    : 1;
  if (
    metadata.schema_version !== expectedMetadataVersion ||
    sqliteSchemaVersion !== shapeVersion
  ) {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "store schema requires an explicitly approved migration",
    );
  }

  const requiredTables = shapeVersion === 1 ? V1_REQUIRED_TABLES : V2_REQUIRED_TABLES;
  for (const table of requiredTables) {
    if (!tables.has(table)) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", `required private table ${table} is missing`);
    }
  }
  assertApprovedSchema(db, shapeVersion);
  assertRestoreHoldReleased(db);
  return { kind: shapeVersion === 1 ? "v1" : "v2", metadata };
}

/** Normal-open validation: a recognized v1 store is refused with a typed
 * migration-required result (migration is never implicit); a v2 store must
 * additionally pass host trust-root validation on every open. */
function readAndValidateStore(db: DatabaseSync, databasePath: string): StoreMetadataRow {
  const shape = classifyStoreShape(db);
  if (shape.kind === "v1") {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_REQUIRED",
      "store schema v1 requires the explicit approved migration to v2",
    );
  }
  validateTrustRoot(databasePath, db);
  return shape.metadata;
}

export function initializeStore(options: InitializeStoreOptions): DurableStore {
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) !== undefined) {
    throw new StoreLifecycleError(
      "STORAGE_ALREADY_INITIALIZED",
      "refusing to initialize over an existing database file",
    );
  }

  // Refuse ambiguous preexisting secrets before creating any artifact (B3-P1A).
  assertTrustRootAbsent(databasePath);

  const storeUuid = (options.storeUuid ?? randomUUID)();
  if (!isStoreUuid(storeUuid)) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store UUID generator returned an invalid UUID");
  }
  const appliedAt = (options.now ?? (() => new Date().toISOString()))();
  const db = openStorageConnection(options, undefined, true);

  // Host Trust Root bootstrap (B3-P1A): the secret file is created before the
  // schema transaction. A crash between the two leaves DB file plus orphan
  // secret; the next attempt refuses at STORAGE_ALREADY_INITIALIZED or at the
  // pre-creation absence check — operator review, never automatic cleanup.
  const secretDigest = createHostSecretFile(databasePath, options.secretBytes);

  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(V2_FOUNDATION_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, ?, ?)",
      ).run(storeUuid, APPLICATION_ID, CURRENT_SCHEMA_VERSION, appliedAt);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(
        CURRENT_SCHEMA_VERSION,
        V2_FOUNDATION_NAME,
        V2_FOUNDATION_CHECKSUM,
        appliedAt,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.prepare(
        "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
      ).run(secretDigest, appliedAt);
      tx.exec(
        `PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${CURRENT_SCHEMA_VERSION};`,
      );
    });
    return handle(db, readAndValidateStore(db, databasePath), databasePath);
  } catch (error) {
    return closeAfterFailure(
      db,
      error instanceof StoreLifecycleError
        ? error
        : new StoreLifecycleError("STORAGE_CORRUPT", "store initialization failed", { cause: error }),
    );
  }
}

// SQLite readOnly alone can update/create WAL shared-memory artifacts. Validate
// a disposable DB+WAL snapshot instead; never let SQLite open the rejected source.
// Concurrent copying is not an atomic backup: corruption fails closed, and the
// selected original is revalidated before writer setup and before handle return.
function withStoreSnapshot<T>(databasePath: string, validate: (reader: DatabaseSync) => T): T {
  if (pathStat(`${databasePath}-journal`) !== undefined) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "rollback-journal recovery requires operator review");
  }
  const directory = withRestrictiveUmask(() => mkdtempSync(join(tmpdir(), "ce-preflight-")));
  const snapshot = join(directory, "store.sqlite");
  let reader: DatabaseSync | undefined;
  try {
    copyFileSync(databasePath, snapshot, constants.COPYFILE_EXCL);
    if (pathStat(`${databasePath}-wal`) !== undefined) {
      copyFileSync(`${databasePath}-wal`, `${snapshot}-wal`, constants.COPYFILE_EXCL);
    }
    reader = withRestrictiveUmask(() => new DatabaseSync(snapshot, { readOnly: true, defensive: true }));
    reader.exec("PRAGMA trusted_schema=OFF; BEGIN;");
    return validate(reader);
  } catch (error) {
    if (error instanceof StoreLifecycleError) throw error;
    throw new StoreLifecycleError("STORAGE_CORRUPT", "read-only store preflight failed", { cause: error });
  } finally {
    reader?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function preflightStore(databasePath: string): StoreMetadataRow {
  return withStoreSnapshot(databasePath, (reader) => readAndValidateStore(reader, databasePath));
}

/** Shape-only preflight for the explicit migration and trust-root recovery
 * entry points: classifies the store without demanding migration or a valid
 * trust root, since those are exactly the states those operations address. */
export function preflightStoreShape(databasePath: string): StoreShape {
  return withStoreSnapshot(databasePath, (reader) => classifyStoreShape(reader));
}

export function openStore(options: StorageConnectionOptions): DurableStore {
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }

  const preflight = preflightStore(databasePath);
  const validateWriter = (writer: DatabaseSync): StoreMetadataRow => {
    const metadata = readAndValidateStore(writer, databasePath);
    if (metadata.store_uuid !== preflight.store_uuid) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store identity changed since preflight");
    }
    return metadata;
  };

  let db: DatabaseSync;
  try {
    db = openStorageConnection(options, validateWriter);
  } catch (error) {
    if (error instanceof RuntimeEligibilityError || error instanceof FilesystemSafetyError) throw error;
    if (error instanceof Error && error.cause instanceof StoreLifecycleError) throw error.cause;
    throw new StoreLifecycleError("STORAGE_CORRUPT", "failed to open the SQLite store", { cause: error });
  }

  try {
    return handle(db, validateWriter(db), databasePath);
  } catch (error) {
    return closeAfterFailure(
      db,
      error instanceof StoreLifecycleError
        ? error
        : new StoreLifecycleError("STORAGE_CORRUPT", "store validation failed", { cause: error }),
    );
  }
}
