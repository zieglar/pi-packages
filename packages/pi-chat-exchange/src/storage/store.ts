import { constants, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveSqliteDriver } from "./sqlite-driver-selection.js";
import type { SqliteConnection as DatabaseSync, SqliteOutputValue as SQLOutputValue } from "./sqlite-driver.js";
import { assertStorageRuntimeEligibility, openStorageConnection, type StorageConnectionOptions } from "./connection.js";
import {
  FilesystemSafetyError,
  prepareDatabasePath,
  assertSecureDatabaseArtifacts,
  pathStat,
  withRestrictiveUmask,
} from "./filesystem.js";
import { assertHostRuntimeEligibility, RuntimeEligibilityError } from "./runtime.js";
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
  V3_FOUNDATION_CHECKSUM,
  V3_FOUNDATION_NAME,
  V3_FOUNDATION_SQL,
  V3_MIGRATION_CHECKSUM,
  V3_MIGRATION_NAME,
  V4_FOUNDATION_CHECKSUM,
  V4_FOUNDATION_NAME,
  V4_FOUNDATION_SQL,
  V4_MIGRATION_CHECKSUM,
  V4_MIGRATION_NAME,
  V5_FOUNDATION_CHECKSUM,
  V5_FOUNDATION_NAME,
  V5_FOUNDATION_SQL,
  V5_MIGRATION_CHECKSUM,
  V5_MIGRATION_NAME,
  V6_FOUNDATION_CHECKSUM,
  V6_FOUNDATION_NAME,
  V6_FOUNDATION_SQL,
  V6_MIGRATION_CHECKSUM,
  V6_MIGRATION_NAME,
  V7_FOUNDATION_SQL,
  V7_FOUNDATION_NAME,
  V7_FOUNDATION_CHECKSUM,
} from "./schema.js";
import { withImmediateTransaction, StorageTransactionError } from "./transaction.js";
import { StoreLifecycleError } from "./errors.js";
import { assertTrustRootAbsent, createHostSecretFile, validateTrustRoot } from "./trust-root.js";
import { requireInstant } from "./participant-identity.js";
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
export type StoreConnection = DatabaseSync;

export interface DurableStore {
  readonly database: StoreConnection;
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

const approvedManifests: Partial<Record<StoreShapeKind, string>> = {};
function approvedManifest(version: StoreShapeKind): string {
  const cached = approvedManifests[version];
  if (cached !== undefined) return cached;
  const reference = resolveSqliteDriver().open(":memory:");
  try {
    reference.exec(
      version === "v1"
        ? INITIAL_SCHEMA_SQL
        : version === "v2"
          ? V2_FOUNDATION_SQL
          : version === "v3"
            ? V3_FOUNDATION_SQL
            : version === "v4"
              ? V4_FOUNDATION_SQL
              : version === "v5"
                ? V5_FOUNDATION_SQL
                : version === "v6" ? V6_FOUNDATION_SQL : V7_FOUNDATION_SQL,
    );
    const manifest = schemaManifest(reference);
    approvedManifests[version] = manifest;
    return manifest;
  } finally {
    reference.close();
  }
}

function assertApprovedSchema(db: DatabaseSync, version: StoreShapeKind): void {
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

function handle(
  db: DatabaseSync,
  metadata: StoreMetadataRow,
  databasePath: string,
  schemaVersion = CURRENT_SCHEMA_VERSION,
): DurableStore {
  return {
    database: db,
    storeUuid: metadata.store_uuid,
    // The validated live schema version (PRAGMA user_version == ledger maximum),
    // not the initialization-time store_metadata.schema_version, which stays 1
    // for migrated stores and is never updated.
    schemaVersion,
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

export type StoreShapeKind = "v1" | "v2" | "v3" | "v4" | "v5" | "v6" | "v7";
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

/** Classify exact schema/ledger/identity. Historical recognition is retained for
 * existing private diagnostics; currentOnly refuses old shapes before constructing
 * any historical reference manifest. No initialization or migration runs here. */
export function classifyStoreShape(db: DatabaseSync, currentOnly = false): StoreShape {
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

  // SAFETY: each projected ledger field is validated structurally and against
  // exact approved tuples by ledgerMatches before any row is trusted.
  const migrations = db
    .prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
    .all() as unknown as MigrationLedgerRow[];

  const V1_LEDGER: readonly (readonly [number, string, string])[] = [[1, INITIAL_MIGRATION_NAME, INITIAL_MIGRATION_CHECKSUM]];
  const V2_MIGRATED_LEDGER: readonly (readonly [number, string, string])[] = [
    ...V1_LEDGER,
    [2, V2_MIGRATION_NAME, V2_MIGRATION_CHECKSUM],
  ];
  const V2_FRESH_LEDGER: readonly (readonly [number, string, string])[] = [[2, V2_FOUNDATION_NAME, V2_FOUNDATION_CHECKSUM]];
  const V3_STEP: readonly [number, string, string] = [3, V3_MIGRATION_NAME, V3_MIGRATION_CHECKSUM];
  const V3_LEDGERS: readonly (readonly (readonly [number, string, string])[])[] = [
    [...V2_MIGRATED_LEDGER, V3_STEP],
    [...V2_FRESH_LEDGER, V3_STEP],
    [[3, V3_FOUNDATION_NAME, V3_FOUNDATION_CHECKSUM]],
  ];
  // CE-0002-B3-P2C-A: every approved v3 lineage plus the explicit v4 step, or
  // a fresh v4 foundation.
  const V4_STEP: readonly [number, string, string] = [4, V4_MIGRATION_NAME, V4_MIGRATION_CHECKSUM];
  const V4_LEDGERS: readonly (readonly (readonly [number, string, string])[])[] = [
    ...V3_LEDGERS.map((ledger) => [...ledger, V4_STEP]),
    [[4, V4_FOUNDATION_NAME, V4_FOUNDATION_CHECKSUM]],
  ];
  // CE-ARCH-P3C-INDEX-001: every approved v4 lineage plus the explicit v5
  // index step, or a fresh v5 foundation.
  const V5_STEP: readonly [number, string, string] = [5, V5_MIGRATION_NAME, V5_MIGRATION_CHECKSUM];
  const V5_LEDGERS: readonly (readonly (readonly [number, string, string])[])[] = [
    ...V4_LEDGERS.map((ledger) => [...ledger, V5_STEP]),
    [[5, V5_FOUNDATION_NAME, V5_FOUNDATION_CHECKSUM]],
  ];
  // CE-0002-B3-P4C: every approved v5 lineage plus the capability-table
  // rebuild step, or a fresh v6 foundation.
  const V6_STEP: readonly [number, string, string] = [6, V6_MIGRATION_NAME, V6_MIGRATION_CHECKSUM];
  const V6_LEDGERS: readonly (readonly (readonly [number, string, string])[])[] = [
    ...V5_LEDGERS.map((ledger) => [...ledger, V6_STEP]),
    [[6, V6_FOUNDATION_NAME, V6_FOUNDATION_CHECKSUM]],
  ];
  const shapeVersion = ledgerMatches(migrations, V1_LEDGER)
    ? 1
    : ledgerMatches(migrations, V2_MIGRATED_LEDGER) || ledgerMatches(migrations, V2_FRESH_LEDGER)
      ? 2
      : V3_LEDGERS.some((ledger) => ledgerMatches(migrations, ledger))
        ? 3
        : V4_LEDGERS.some((ledger) => ledgerMatches(migrations, ledger))
          ? 4
          : V5_LEDGERS.some((ledger) => ledgerMatches(migrations, ledger))
            ? 5
            : V6_LEDGERS.some((ledger) => ledgerMatches(migrations, ledger))
              ? 6
              : ledgerMatches(migrations, [[7, V7_FOUNDATION_NAME, V7_FOUNDATION_CHECKSUM]]) ? 7 : undefined;
  if (shapeVersion === undefined) {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_CHECKSUM_MISMATCH",
      "store migration ledger does not match the approved schema",
    );
  }

  // Version coherence: `store_metadata.schema_version` is the schema version at
  // initialization — exactly the version of the ledger's first (foundation)
  // row — and is never updated (the v1 immutability trigger keeps it so). The
  // live version is `PRAGMA user_version`, which must equal the shape version
  // the ledger proves.
  const expectedMetadataVersion = migrations[0]?.version;
  if (
    metadata.schema_version !== expectedMetadataVersion ||
    sqliteSchemaVersion !== shapeVersion
  ) {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "store schema requires an explicitly approved migration",
    );
  }

  if (currentOnly && shapeVersion !== 7) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "unsupported Store; separate operator-approved Dev Reset required");
  }

  const requiredTables = shapeVersion === 1 ? V1_REQUIRED_TABLES : V2_REQUIRED_TABLES;
  for (const table of requiredTables) {
    if (!tables.has(table)) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", `required private table ${table} is missing`);
    }
  }
  if (shapeVersion === 7 && !tables.has("delivery_ack_receipt")) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "current receipt schema is missing");
  }
  assertApprovedSchema(db, shapeKind(shapeVersion));
  assertRestoreHoldReleased(db);
  return { kind: shapeKind(shapeVersion), metadata };
}

function shapeKind(version: number): StoreShapeKind {
  return version === 1
    ? "v1"
    : version === 2
      ? "v2"
      : version === 3
        ? "v3"
        : version === 4
          ? "v4"
          : version === 5
            ? "v5"
            : version === 6 ? "v6" : "v7";
}

/** Normal open is current-only. Old shapes are recognized for truthful refusal,
 * never upgraded or rebuilt through this path. The host root is checked on every open. */
function readAndValidateStore(db: DatabaseSync, databasePath: string): StoreMetadataRow {
  const shape = classifyStoreShape(db, true);
  if (shape.kind !== "v7") {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "unsupported Store; separate operator-approved Dev Reset required",
    );
  }
  validateTrustRoot(databasePath, db);
  return shape.metadata;
}

export function initializeStore(options: InitializeStoreOptions): DurableStore {
  assertStorageRuntimeEligibility(options);
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

  let storeUuid: string;
  let appliedAt: string;
  try {
    storeUuid = (options.storeUuid ?? randomUUID)();
    appliedAt = requireInstant((options.now ?? (() => new Date().toISOString()))(), "initialization time");
    if (!isStoreUuid(storeUuid)) throw new Error("invalid UUID");
  } catch {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store initialization identity generation failed");
  }
  const db = openStorageConnection(options, undefined, true);

  // Host Trust Root bootstrap (B3-P1A): the secret file is created before the
  // schema transaction. A crash between the two leaves DB file plus orphan
  // secret; the next attempt refuses at STORAGE_ALREADY_INITIALIZED or at the
  // pre-creation absence check — operator review, never automatic cleanup.
  try {
    const generated = options.secretBytes;
    const safeSecretBytes = generated === undefined ? undefined : () => {
      try { return generated(); } catch { throw new Error("host secret generation failed"); }
    };
    const secretDigest = createHostSecretFile(databasePath, safeSecretBytes);
    withImmediateTransaction(db, (tx) => {
      tx.exec(V7_FOUNDATION_SQL);
      tx.prepare(
        "INSERT INTO store_metadata(singleton, store_uuid, application_id, schema_version, created_at) VALUES (1, ?, ?, ?, ?)",
      ).run(storeUuid, APPLICATION_ID, CURRENT_SCHEMA_VERSION, appliedAt);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(
        CURRENT_SCHEMA_VERSION,
        V7_FOUNDATION_NAME,
        V7_FOUNDATION_CHECKSUM,
        appliedAt,
      );
      tx.prepare("INSERT INTO restore_hold(singleton, held) VALUES (1, 0)").run();
      tx.prepare(
        "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
      ).run(secretDigest, appliedAt);
      tx.exec(
        `PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=${CURRENT_SCHEMA_VERSION};`,
      );
      // Full proof in the owned transaction, not a header-only admission.
      readAndValidateStore(db, databasePath);
    });
    return handle(db, readAndValidateStore(db, databasePath), databasePath);
  } catch (error) {
    return closeAfterFailure(
      db,
      error instanceof StorageTransactionError
        ? new StorageTransactionError("store initialization transaction failed", error.stage, {outcome:error.outcome,busy:error.retryable})
        : error instanceof StoreLifecycleError
          ? new StoreLifecycleError(error.code, error.message)
          : new StoreLifecycleError("STORAGE_CORRUPT", "store initialization failed"),
    );
  }
}

// SQLite readOnly alone can update/create WAL shared-memory artifacts. Validate
// a disposable DB+WAL snapshot instead; never let SQLite open the rejected source.
// Concurrent copying is not an atomic backup: corruption fails closed, and the
// selected original is revalidated before writer setup and before handle return.
function withStoreSnapshot<T>(databasePath: string, validate: (reader: DatabaseSync) => T): T {
  assertHostRuntimeEligibility();
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
    reader = withRestrictiveUmask(() => resolveSqliteDriver().open(snapshot, { readOnly: true, defensive: true }));
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
export function preflightStoreShape(
  databasePath: string,
  validateExtra?: (reader: DatabaseSync, shape: StoreShape) => void,
): StoreShape {
  return withStoreSnapshot(databasePath, (reader) => {
    const shape = classifyStoreShape(reader);
    validateExtra?.(reader, shape);
    return shape;
  });
}

export function openStore(options: StorageConnectionOptions): DurableStore {
  assertStorageRuntimeEligibility(options);
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

/** @internal Proof open used only by the explicit migration for a non-current
 * target shape: the migrated store is structurally validated (integrity,
 * identity, ledger, manifest, restore hold) and its trust root re-validated,
 * but the normal-open current-version gate is not applied, since a migration
 * to an intermediate version deliberately stops below current. Never use this
 * to serve ordinary operations. */
export function openMigratedStore(options: StorageConnectionOptions, kind: StoreShapeKind): DurableStore {
  assertStorageRuntimeEligibility(options);
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }
  const preflight = preflightStoreShape(databasePath);
  if (preflight.kind !== kind) {
    throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "migrated store does not have the approved target shape");
  }
  const validateWriter = (writer: DatabaseSync): StoreMetadataRow => {
    const shape = classifyStoreShape(writer);
    if (shape.kind !== kind || shape.metadata.store_uuid !== preflight.metadata.store_uuid) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "migrated store does not have the approved target shape");
    }
    validateTrustRoot(databasePath, writer);
    return shape.metadata;
  };
  let db: DatabaseSync;
  try {
    db = openStorageConnection(options, validateWriter);
  } catch (error) {
    if (error instanceof Error && error.cause instanceof StoreLifecycleError) throw error.cause;
    throw new StoreLifecycleError("STORAGE_CORRUPT", "failed to open the migrated SQLite store", { cause: error });
  }
  try {
    return handle(db, validateWriter(db), databasePath, Number(kind.slice(1)));
  } catch (error) {
    return closeAfterFailure(
      db,
      error instanceof StoreLifecycleError
        ? error
        : new StoreLifecycleError("STORAGE_CORRUPT", "migrated store validation failed", { cause: error }),
    );
  }
}
