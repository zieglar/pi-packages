import type { DatabaseSync } from "node:sqlite";
import { openStorageConnection, type StorageConnectionOptions } from "./connection.js";
import { StoreLifecycleError } from "./errors.js";
import { assertSecureDatabaseArtifacts, pathStat, prepareDatabasePath } from "./filesystem.js";
import {
  V2_ADDITIVE_SQL,
  V2_MIGRATION_CHECKSUM,
  V2_MIGRATION_NAME,
  V3_ADDITIVE_SQL,
  V3_MIGRATION_CHECKSUM,
  V3_MIGRATION_NAME,
  V4_ADDITIVE_SQL,
  V4_MIGRATION_CHECKSUM,
  V4_MIGRATION_NAME,
} from "./schema.js";
import { assertPreV4SessionState } from "./session-state.js";
import {
  classifyStoreShape,
  openMigratedStore,
  openStore,
  preflightStoreShape,
  type DurableStore,
  type StoreShapeKind,
} from "./store.js";
import { classifyRecoveryFailure } from "./recovery.js";
import { withImmediateTransaction, type TransactionHandle } from "./transaction.js";
import {
  assertTrustRootAbsent,
  createHostSecretFile,
  validateTrustRoot,
} from "./trust-root.js";

/**
 * Explicit store migrations (CE-0002-B3-P1A v1→v2; CE-0002-B3-P2A-R1 v2→v3;
 * CE-0002-B3-P2C-A v3→v4). Migration is a dedicated, host-local operator
 * action — never a side effect of opening a store. A normal `openStore` of a
 * recognized non-current store refuses with STORAGE_MIGRATION_REQUIRED; only
 * this entry point performs migrations, and only along explicitly approved
 * paths: {1→2}, {2→3}, {3→4}, and the chains {1→3}, {2→4}, {1→4}. Each step
 * commits independently: an interrupted or refused later step leaves a valid
 * store at the earlier version, and the remaining step can be approved and
 * retried on its own.
 *
 * The migrations modify no pre-existing object: each applies only additive
 * DDL, appends the approved ledger row (the ledger is insert-only by trigger),
 * and advances `PRAGMA user_version` — all inside one owned BEGIN IMMEDIATE
 * transaction per step. `store_metadata` is never UPDATEd (its immutability
 * trigger would abort the attempt) and the store UUID is preserved and
 * re-verified. The v1→v2 step bootstraps host trust-root generation 1; the
 * v2→v3 step re-validates the existing trust root and never creates, rotates,
 * or deletes a secret. Interruption rolls the interrupted step back; an orphan
 * host-secret file from an interrupted v1→v2 attempt is never overwritten or
 * deleted automatically and blocks retry until the operator removes it. No
 * downgrade path exists; tamper and drift refuse; nothing is repaired
 * silently.
 *
 * v2→v3 (B3-P2A-R1) additionally refuses — fail closed, zero writes — when
 * historical `participant_session` rows bind one Session to more than one
 * Participant: the v3 durable uniqueness rule rejects conflicting history
 * rather than repairing it. Legacy v2 ownership rows keep their NULL
 * `lease_started_at` and are permanently unauthorizable (treated as expired);
 * no lease start is ever fabricated from an untrusted TTL.
 *
 * v3→v4 (B3-P2C-A) appends only the Session lifecycle triggers. It
 * re-validates the existing trust root (never rotates it) and preserves every
 * Session row untouched. No pre-v4 operation ever detaches a Session, so any
 * pre-v4 Session row that is not exactly ATTACHED (NULL `detached_at`,
 * revision 1) — or an ownership row referencing a detached Session — is
 * foreign state: the migration refuses it (STORAGE_CORRUPT) with zero writes
 * and never repairs it. For a v2 or v3 source the check also runs on the
 * disposable preflight snapshot before any step, so a chain that would fail
 * at the v4 step refuses before its earlier steps commit.
 */

export interface MigrateStoreOptions extends StorageConnectionOptions {
  /** Explicit approved path: single steps { 1→2 }, { 2→3 }, { 3→4 }, or the
   * chains { 1→3 }, { 2→4 }, { 1→4 }. */
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Private deterministic test seam; production callers omit this. */
  readonly now?: () => string;
  /** Private deterministic test seam; production callers omit this. */
  readonly secretBytes?: () => Uint8Array;
  /** Private deterministic test seam invoked inside the owned transaction of
   * each step immediately before commit; production callers omit this. */
  readonly beforeCommit?: () => void;
}

/** Runs one migration step against the on-disk store: preflight the expected
 * source shape on a disposable snapshot, then re-validate the live writer and
 * apply the step body inside one owned IMMEDIATE transaction. Transaction
 * outcomes (BUSY / ROLLED_BACK / INDETERMINATE) propagate unchanged: no retry,
 * no repair. */
function runMigrationStep(
  options: MigrateStoreOptions,
  databasePath: string,
  expectKind: StoreShapeKind,
  body: (tx: TransactionHandle, appliedAt: string) => void,
  validateExtra?: (writer: DatabaseSync) => void,
): void {
  const preflight = preflightStoreShape(databasePath);
  if (preflight.kind !== expectKind) {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_NOT_REQUIRED",
      "store does not require the requested migration step",
    );
  }
  const validateWriter = (writer: DatabaseSync): void => {
    const shape = classifyStoreShape(writer);
    if (shape.kind !== expectKind) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
    }
    if (shape.metadata.store_uuid !== preflight.metadata.store_uuid) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store identity changed since preflight");
    }
    validateExtra?.(writer);
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
      body(tx, appliedAt);
      options.beforeCommit?.();
    });
  } catch (error) {
    try {
      db.close();
    } catch {
      // The transaction helper may already have invalidated the connection.
    }
    // A proven rollback caused by a typed lifecycle refusal (for example the
    // conflicting-historical-bindings rejection) keeps that refusal as the
    // top-level classification, with the transaction error preserved as cause.
    // BUSY, INDETERMINATE, and unclassified outcomes propagate unchanged.
    throw classifyRecoveryFailure(error);
  }
  db.close();
}

/** v1→v2 (accepted CE-0002-B3-P1A): additive v2 DDL, approved ledger row,
 * trust-root generation 1 bootstrap, user_version advance. */
function migrateV1toV2(options: MigrateStoreOptions, databasePath: string): void {
  // Trust-root bootstrap accompanies the migration. A preexisting secret is
  // ambiguous (interrupted earlier attempt or external placement): refuse
  // rather than overwrite.
  assertTrustRootAbsent(databasePath);
  const secretDigest = createHostSecretFile(databasePath, options.secretBytes);
  runMigrationStep(options, databasePath, "v1", (tx, appliedAt) => {
    const userVersion = tx.prepare("PRAGMA user_version").get();
    if (Object.values(userVersion ?? {})[0] !== 1) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
    }
    tx.exec(V2_ADDITIVE_SQL);
    tx.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(2, V2_MIGRATION_NAME, V2_MIGRATION_CHECKSUM, appliedAt);
    tx.prepare(
      "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (1, ?, ?, 1)",
    ).run(secretDigest, appliedAt);
    tx.exec("PRAGMA user_version=2;");
  });
}

/** v2→v3 (CE-0002-B3-P2A-R1): additive v3 DDL (persisted lease start,
 * Session-bound resume capability column, durable Session uniqueness), approved
 * ledger row, user_version advance. The existing trust root is re-validated,
 * never rotated. Conflicting historical Session bindings refuse the migration
 * with zero writes rather than being repaired. */
function migrateV2toV3(options: MigrateStoreOptions, databasePath: string): void {
  // The v2 trust root must be intact before any v3 object exists: the live
  // secret artifact and the persisted generation fingerprint are re-validated
  // on the migration writer itself, never rotated or recreated.
  runMigrationStep(options, databasePath, "v2", (tx, appliedAt) => {
    const userVersion = tx.prepare("PRAGMA user_version").get();
    if (Object.values(userVersion ?? {})[0] !== 2) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
    }
    // Durable Session uniqueness: conflicting historical bindings are rejected,
    // never repaired.
    const conflict = tx
      .prepare(
        "SELECT session_id FROM participant_session GROUP BY session_id HAVING COUNT(DISTINCT participant_id) > 1 LIMIT 1",
      )
      .get();
    if (conflict !== undefined) {
      throw new StoreLifecycleError(
        "STORAGE_CORRUPT",
        "a Session is bound to more than one Participant; operator review required",
      );
    }
    tx.exec(V3_ADDITIVE_SQL);
    tx.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(3, V3_MIGRATION_NAME, V3_MIGRATION_CHECKSUM, appliedAt);
    tx.exec("PRAGMA user_version=3;");
  }, (writer) => validateTrustRoot(databasePath, writer));
}

/** v3→v4 (CE-0002-B3-P2C-A): additive Session lifecycle triggers, approved
 * ledger row, user_version advance. The existing trust root is re-validated,
 * never rotated. Every pre-v4 Session row must be exactly ATTACHED; foreign
 * lifecycle state refuses the migration with zero writes rather than being
 * repaired. Existing Session rows are never rewritten. */
function migrateV3toV4(options: MigrateStoreOptions, databasePath: string): void {
  runMigrationStep(options, databasePath, "v3", (tx, appliedAt) => {
    const userVersion = tx.prepare("PRAGMA user_version").get();
    if (Object.values(userVersion ?? {})[0] !== 3) {
      throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during migration");
    }
    // Re-checked on the live writer inside the owned transaction: the
    // preflight snapshot may predate a concurrent privileged write.
    assertPreV4SessionState(tx);
    tx.exec(V4_ADDITIVE_SQL);
    tx.prepare(
      "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
    ).run(4, V4_MIGRATION_NAME, V4_MIGRATION_CHECKSUM, appliedAt);
    tx.exec("PRAGMA user_version=4;");
  }, (writer) => validateTrustRoot(databasePath, writer));
}

const APPROVED_PATHS: readonly (readonly [number, number])[] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [1, 3],
  [2, 4],
  [1, 4],
];

export function migrateStore(options: MigrateStoreOptions): DurableStore {
  const approved = APPROVED_PATHS.some(
    ([fromVersion, toVersion]) => options.fromVersion === fromVersion && options.toVersion === toVersion,
  );
  if (!approved) {
    throw new StoreLifecycleError(
      "STORAGE_INCOMPATIBLE",
      "only the explicitly approved single-step and chained migration paths up to v4 are supported",
    );
  }
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }

  // Shape preflight precedes any artifact handling: a store that does not
  // require the requested migration is refused (zero writes) before any
  // trust-root absence check can run.
  const expectFrom: StoreShapeKind = options.fromVersion === 1 ? "v1" : options.fromVersion === 2 ? "v2" : "v3";
  const reachesV4 = options.toVersion === 4;
  const preflight = preflightStoreShape(databasePath, (reader, shape) => {
    // Whole-chain precondition (B3-P2C-A): when the path reaches v4 and the
    // source already carries Session rows (v2 or v3), foreign lifecycle state
    // refuses before any step commits. A v1 source has no Session table; its
    // v2 tables are created empty by the v1→v2 step.
    if (reachesV4 && shape.kind === expectFrom && (shape.kind === "v2" || shape.kind === "v3")) {
      assertPreV4SessionState(reader as unknown as Parameters<typeof assertPreV4SessionState>[0]);
    }
  });
  if (preflight.kind !== expectFrom) {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_NOT_REQUIRED",
      "store does not require the requested migration step",
    );
  }
  if (options.fromVersion === 1) migrateV1toV2(options, databasePath);
  if (options.fromVersion <= 2 && options.toVersion >= 3) migrateV2toV3(options, databasePath);
  if (reachesV4) migrateV3toV4(options, databasePath);

  // Proof of success is a full validated reopen: a normal current-version open
  // (including trust-root validation) when the target is current, otherwise a
  // shape-validated migration proof open for the intermediate target.
  if (options.toVersion === 2) return openMigratedStore(options, "v2");
  if (options.toVersion === 3) return openMigratedStore(options, "v3");
  return openStore(options);
}
