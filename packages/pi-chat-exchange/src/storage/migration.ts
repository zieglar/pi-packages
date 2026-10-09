import type { DatabaseSync } from "node:sqlite";
import { openStorageConnection, type StorageConnectionOptions } from "./connection.js";
import { StoreLifecycleError } from "./errors.js";
import { assertSecureDatabaseArtifacts, pathStat, prepareDatabasePath } from "./filesystem.js";
import {
  CURRENT_SCHEMA_VERSION,
  V2_ADDITIVE_SQL,
  V2_MIGRATION_CHECKSUM,
  V2_MIGRATION_NAME,
} from "./schema.js";
import {
  classifyStoreShape,
  openStore,
  preflightStoreShape,
  type DurableStore,
} from "./store.js";
import { withImmediateTransaction } from "./transaction.js";
import {
  assertTrustRootAbsent,
  createHostSecretFile,
} from "./trust-root.js";

/**
 * Explicit v1→v2 migration (CE-0002-B3-P1A). Migration is a dedicated,
 * host-local operator action — never a side effect of opening a store. A
 * normal `openStore` of a recognized v1 store refuses with
 * STORAGE_MIGRATION_REQUIRED; only this entry point performs the migration.
 *
 * The migration modifies no v1 object: it applies the additive v2 DDL, appends
 * the approved v2 ledger row (the ledger is insert-only by trigger), bootstraps
 * host trust-root generation 1, and advances `PRAGMA user_version` — all inside
 * one owned BEGIN IMMEDIATE transaction. `store_metadata` is never UPDATEd
 * (its immutability trigger would abort the attempt) and the store UUID is
 * preserved and re-verified. Interruption rolls everything back to a valid v1
 * store; an orphan host-secret file from an interrupted attempt is never
 * overwritten or deleted automatically and blocks retry until the operator
 * removes it. No downgrade path exists; tamper and drift refuse; nothing is
 * repaired silently.
 */

export interface MigrateStoreOptions extends StorageConnectionOptions {
  /** Explicit approved path: exactly { fromVersion: 1, toVersion: 2 }. */
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Private deterministic test seam; production callers omit this. */
  readonly now?: () => string;
  /** Private deterministic test seam; production callers omit this. */
  readonly secretBytes?: () => Uint8Array;
  /** Private deterministic test seam invoked inside the owned transaction
   * immediately before commit; production callers omit this. */
  readonly beforeCommit?: () => void;
}

export function migrateStore(options: MigrateStoreOptions): DurableStore {
  if (options.fromVersion !== 1 || options.toVersion !== CURRENT_SCHEMA_VERSION) {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "only the explicitly approved v1 to v2 migration path is supported",
    );
  }
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }

  // Preflight on a disposable read-only snapshot: the store must be exactly a
  // recognized v1 store (integrity, identity, ledger, manifest, restore hold
  // all validated by shape classification).
  const preflight = preflightStoreShape(databasePath);
  if (preflight.kind !== "v1") {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_NOT_REQUIRED",
      "store does not require the v1 to v2 migration",
    );
  }

  // Trust-root bootstrap accompanies the migration. A preexisting secret is
  // ambiguous (interrupted earlier attempt or external placement): refuse
  // rather than overwrite.
  assertTrustRootAbsent(databasePath);
  const secretDigest = createHostSecretFile(databasePath, options.secretBytes);

  const validateWriter = (writer: DatabaseSync): void => {
    const shape = classifyStoreShape(writer);
    if (shape.kind !== "v1") {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
    }
    if (shape.metadata.store_uuid !== preflight.metadata.store_uuid) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store identity changed since preflight");
    }
  };

  const appliedAt = (options.now ?? (() => new Date().toISOString()))();
  let db: DatabaseSync;
  try {
    db = openStorageConnection(options, validateWriter);
  } catch (error) {
    if (error instanceof Error && error.cause instanceof StoreLifecycleError) throw error.cause;
    throw error;
  }
  try {
    withImmediateTransaction(db, (tx) => {
      const userVersion = tx.prepare("PRAGMA user_version").get();
      if (Object.values(userVersion ?? {})[0] !== 1) {
        throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
      }
      tx.exec(V2_ADDITIVE_SQL);
      tx.prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
      ).run(CURRENT_SCHEMA_VERSION, V2_MIGRATION_NAME, V2_MIGRATION_CHECKSUM, appliedAt);
      tx.prepare(
        "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
      ).run(secretDigest, appliedAt);
      tx.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION};`);
      options.beforeCommit?.();
    });
  } catch (error) {
    // Transaction outcomes (BUSY / ROLLED_BACK / INDETERMINATE) propagate
    // unchanged: no retry, no repair. The caller reconciles by reopening — a
    // rolled-back store still answers STORAGE_MIGRATION_REQUIRED.
    try {
      db.close();
    } catch {
      // The transaction helper may already have invalidated the connection.
    }
    throw error;
  }
  db.close();

  // Proof of success is a full normal reopen under the v2 contract, including
  // trust-root validation.
  return openStore(options);
}
