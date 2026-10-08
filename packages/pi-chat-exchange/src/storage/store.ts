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
} from "./schema.js";
import { withImmediateTransaction } from "./transaction.js";

export type StoreLifecycleErrorCode =
  | "STORAGE_ALREADY_INITIALIZED"
  | "STORAGE_CORRUPT"
  | "STORAGE_FOREIGN_STORE"
  | "STORAGE_INCOMPATIBLE"
  | "STORAGE_MIGRATION_CHECKSUM_MISMATCH"
  | "STORAGE_RESTORE_HOLD"
  | "STORAGE_SCHEMA_TOO_NEW";

export class StoreLifecycleError extends Error {
  readonly code: StoreLifecycleErrorCode;

  constructor(code: StoreLifecycleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreLifecycleError";
    this.code = code;
  }
}

export interface InitializeStoreOptions extends StorageConnectionOptions {
  /** Private deterministic test seam; production callers omit this. */
  readonly storeUuid?: () => string;
  /** Private deterministic test seam; production callers omit this. */
  readonly now?: () => string;
}

export interface DurableStore {
  readonly database: DatabaseSync;
  readonly storeUuid: string;
  readonly schemaVersion: number;
  close(): void;
}

interface StoreMetadataRow {
  readonly singleton: number;
  readonly store_uuid: string;
  readonly application_id: string;
  readonly schema_version: number;
  readonly created_at: string;
}

const REQUIRED_TABLES = new Set([
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

// Strict compatibility: compare every persisted schema object, including implicit
// indexes. Root pages are layout, not schema. SQL is intentionally not normalized:
// even semantically equivalent unauthorized DDL requires an approved migration.
function schemaManifest(db: DatabaseSync): string {
  return JSON.stringify(db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name",
  ).all());
}

let approvedManifest: string | undefined;
function assertApprovedSchema(db: DatabaseSync): void {
  if (approvedManifest === undefined) {
    const reference = new DatabaseSync(":memory:");
    try {
      reference.exec(INITIAL_SCHEMA_SQL);
      approvedManifest = schemaManifest(reference);
    } finally {
      reference.close();
    }
  }
  if (schemaManifest(db) !== approvedManifest) {
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

function handle(db: DatabaseSync, metadata: StoreMetadataRow): DurableStore {
  return {
    database: db,
    storeUuid: metadata.store_uuid,
    schemaVersion: metadata.schema_version,
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

function readAndValidateStore(db: DatabaseSync): StoreMetadataRow {
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
  for (const table of REQUIRED_TABLES) {
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
  if (
    metadata.schema_version !== CURRENT_SCHEMA_VERSION ||
    sqliteSchemaVersion !== CURRENT_SCHEMA_VERSION ||
    metadata.schema_version !== sqliteSchemaVersion
  ) {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "store schema requires an explicitly approved migration",
    );
  }

  const migrations = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all();
  if (
    migrations.length !== 1 ||
    migrations[0]?.version !== CURRENT_SCHEMA_VERSION ||
    migrations[0]?.name !== INITIAL_MIGRATION_NAME ||
    migrations[0]?.checksum !== INITIAL_MIGRATION_CHECKSUM
  ) {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_CHECKSUM_MISMATCH",
      "store migration ledger does not match the approved schema",
    );
  }

  assertApprovedSchema(db);

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

  return metadata;
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

  const storeUuid = (options.storeUuid ?? randomUUID)();
  if (!isStoreUuid(storeUuid)) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store UUID generator returned an invalid UUID");
  }
  const appliedAt = (options.now ?? (() => new Date().toISOString()))();
  const db = openStorageConnection(options, undefined, true);

  try {
    withImmediateTransaction(db, (tx) => {
      tx.exec(INITIAL_SCHEMA_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, ?, ?)",
      ).run(storeUuid, APPLICATION_ID, CURRENT_SCHEMA_VERSION, appliedAt);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(
        CURRENT_SCHEMA_VERSION,
        INITIAL_MIGRATION_NAME,
        INITIAL_MIGRATION_CHECKSUM,
        appliedAt,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.exec(
        `PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${CURRENT_SCHEMA_VERSION};`,
      );
    });
    return handle(db, readAndValidateStore(db));
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
function preflightStore(databasePath: string): StoreMetadataRow {
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
    return readAndValidateStore(reader);
  } catch (error) {
    if (error instanceof StoreLifecycleError) throw error;
    throw new StoreLifecycleError("STORAGE_CORRUPT", "read-only store preflight failed", { cause: error });
  } finally {
    reader?.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

export function openStore(options: StorageConnectionOptions): DurableStore {
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }

  const preflight = preflightStore(databasePath);
  const validateWriter = (writer: DatabaseSync): StoreMetadataRow => {
    const metadata = readAndValidateStore(writer);
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
    return handle(db, validateWriter(db));
  } catch (error) {
    return closeAfterFailure(
      db,
      error instanceof StoreLifecycleError
        ? error
        : new StoreLifecycleError("STORAGE_CORRUPT", "store validation failed", { cause: error }),
    );
  }
}
