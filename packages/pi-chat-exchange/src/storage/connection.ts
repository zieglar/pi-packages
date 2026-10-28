import {
  assertSecureDatabaseArtifacts,
  prepareDatabasePath,
  exclusivelyCreateDatabase,
  pathStat,
  withRestrictiveUmask,
  type DatabasePathOptions,
} from "./filesystem.js";
import {
  assertRuntimeEligibility,
  readRuntimeIdentity,
  type RuntimeIdentity,
} from "./runtime.js";
import { resolveSqliteDriver } from "./sqlite-driver-selection.js";
import type { SqliteConnection, SqliteDriver, SqliteOutputValue } from "./sqlite-driver.js";

export const DEFAULT_BUSY_TIMEOUT_MS = 1_000;
export const MAX_BUSY_TIMEOUT_MS = 5_000;
export const WAL_AUTOCHECKPOINT_PAGES = 1_000;

export class ConnectionPolicyError extends Error {
  readonly code = "STORAGE_CONNECTION_POLICY_INVALID";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionPolicyError";
  }
}

export interface StorageConnectionOptions extends DatabasePathOptions {
  readonly busyTimeoutMs?: number;
  /** Private deterministic test seam; production callers omit this. */
  readonly runtimeIdentity?: () => RuntimeIdentity;
  /** Explicit driver injection for qualification/tests; otherwise the operator
   * selection file is used. No ambient environment fallback. */
  readonly driver?: SqliteDriver;
}

export function assertStorageRuntimeEligibility(options: StorageConnectionOptions): void {
  assertRuntimeEligibility((options.runtimeIdentity ?? (() => readRuntimeIdentity(options.driver)))());
}

function readPragma(db: SqliteConnection, name: string): SqliteOutputValue | undefined {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function assertPragma(db: SqliteConnection, name: string, expected: string | number): void {
  const actual = readPragma(db, name);
  if (actual !== expected) {
    throw new ConnectionPolicyError(
      `SQLite refused required PRAGMA ${name}: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function initializeWriterPolicy(db: SqliteConnection, busyTimeoutMs: number): void {
  db.enableDefensive(true);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA foreign_keys=ON;
    PRAGMA recursive_triggers=ON;
    PRAGMA trusted_schema=OFF;
    PRAGMA busy_timeout=${busyTimeoutMs};
    PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES};
  `);
  if (process.platform === "darwin") {
    db.exec("PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;");
  }

  assertPragma(db, "journal_mode", "wal");
  assertPragma(db, "synchronous", 2);
  assertPragma(db, "foreign_keys", 1);
  assertPragma(db, "recursive_triggers", 1);
  assertPragma(db, "trusted_schema", 0);
  assertPragma(db, "busy_timeout", busyTimeoutMs);
  assertPragma(db, "wal_autocheckpoint", WAL_AUTOCHECKPOINT_PAGES);
  if (process.platform === "darwin") {
    assertPragma(db, "fullfsync", 1);
    assertPragma(db, "checkpoint_fullfsync", 1);
  }
}

export function openStorageConnection(
  options: StorageConnectionOptions,
  validateExisting?: (db: SqliteConnection) => void,
  createExclusive = false,
): SqliteConnection {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new ConnectionPolicyError(
      `busy timeout must be an integer from 1 to ${MAX_BUSY_TIMEOUT_MS} milliseconds`,
    );
  }

  assertStorageRuntimeEligibility(options);

  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (createExclusive || pathStat(databasePath) === undefined) {
    if (validateExisting !== undefined) throw new ConnectionPolicyError("existing store disappeared before writer open");
    exclusivelyCreateDatabase(databasePath);
  }

  let db: SqliteConnection | undefined;
  try {
    const driver = options.driver ?? resolveSqliteDriver();
    db = withRestrictiveUmask(
      () => driver.open(databasePath, { defensive: true, timeout: busyTimeoutMs }),
    );
    // Revalidate identity/compatibility before persistent writer PRAGMAs.
    // A read transaction gives these checks one consistent schema/data snapshot.
    if (validateExisting !== undefined) {
      db.exec("BEGIN");
      try {
        validateExisting(db);
      } finally {
        db.exec("ROLLBACK");
      }
    }
    initializeWriterPolicy(db, busyTimeoutMs);
    assertSecureDatabaseArtifacts(databasePath);
    return db;
  } catch (error) {
    if (db !== undefined) db.close();
    if (error instanceof ConnectionPolicyError) throw error;
    throw new ConnectionPolicyError("failed to establish the required SQLite connection policy", {
      cause: error,
    });
  }
}
