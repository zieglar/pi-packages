import type { DatabaseSync } from "node:sqlite";
import { openStorageConnection, type StorageConnectionOptions } from "./connection.js";
import { StoreLifecycleError } from "./errors.js";
import { assertSecureDatabaseArtifacts, pathStat, prepareDatabasePath } from "./filesystem.js";
import { classifyStoreShape, openStore, preflightStoreShape, type DurableStore } from "./store.js";
import { withImmediateTransaction } from "./transaction.js";
import { assertTrustRootAbsent, createHostSecretFile } from "./trust-root.js";

/**
 * Explicit operator-authorized Host Trust Root recovery (CE-0002-B3-P1A).
 *
 * Recovery is never automatic and never reachable from a normal open. It is
 * the approved response to a lost or deliberately rotated host secret:
 *
 * 1. The operator explicitly removes any old secret file first — this command
 *    refuses to overwrite an existing one (no silent overwrite).
 * 2. The store must be a fully valid v2 store apart from the trust root
 *    (integrity, identity, ledger, manifest, restore hold all validated).
 * 3. A fresh 256-bit secret file is created exclusively.
 * 4. One owned BEGIN IMMEDIATE transaction appends generation N+1 with the new
 *    fingerprint and revokes every existing capability row.
 *
 * The replacement secret inherits nothing: previous-generation capabilities
 * fail verification both by revocation and by generation binding, so every
 * Participant requires fresh explicit capability issuance after recovery.
 * Ambiguous states (existing secret, non-v2 store, missing generation row)
 * fail closed with no writes.
 */

export interface RecoverTrustRootOptions extends StorageConnectionOptions {
  /** Private deterministic test seam; production callers omit this. */
  readonly now?: () => string;
  /** Private deterministic test seam; production callers omit this. */
  readonly secretBytes?: () => Uint8Array;
  /** Private deterministic test seam invoked inside the owned transaction
   * immediately before commit; production callers omit this. */
  readonly beforeCommit?: () => void;
}

export function recoverTrustRoot(options: RecoverTrustRootOptions): DurableStore {
  const databasePath = prepareDatabasePath(options);
  assertSecureDatabaseArtifacts(databasePath);
  if (pathStat(databasePath) === undefined) {
    throw new StoreLifecycleError("STORAGE_FOREIGN_STORE", "no initialized store exists at the explicit path");
  }

  // No silent overwrite: an existing secret is ambiguous evidence and requires
  // explicit operator removal before recovery may proceed.
  assertTrustRootAbsent(databasePath);

  const preflight = preflightStoreShape(databasePath);
  if (preflight.kind !== "v2") {
    throw new StoreLifecycleError(
      "STORAGE_MIGRATION_REQUIRED",
      "trust-root recovery requires a migrated v2 store",
    );
  }

  const secretDigest = createHostSecretFile(databasePath, options.secretBytes);
  const appliedAt = (options.now ?? (() => new Date().toISOString()))();

  let db: DatabaseSync;
  try {
    db = openStorageConnection(options, (writer) => {
      const shape = classifyStoreShape(writer);
      if (shape.kind !== "v2") {
        throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store schema changed during recovery");
      }
      if (shape.metadata.store_uuid !== preflight.metadata.store_uuid) {
        throw new StoreLifecycleError("STORAGE_INCOMPATIBLE", "store identity changed since preflight");
      }
    });
  } catch (error) {
    if (error instanceof Error && error.cause instanceof StoreLifecycleError) throw error.cause;
    throw error;
  }
  try {
    withImmediateTransaction(db, (tx) => {
      const current = tx
        .prepare("SELECT generation FROM host_trust_root ORDER BY generation DESC LIMIT 1")
        .get() as { generation?: unknown } | undefined;
      if (
        current === undefined ||
        typeof current.generation !== "number" ||
        !Number.isSafeInteger(current.generation) ||
        current.generation < 1
      ) {
        throw new StoreLifecycleError("STORAGE_CORRUPT", "a v2 store has no host trust root generation");
      }
      tx.prepare(
        "INSERT INTO host_trust_root(generation, secret_digest, created_at, private_revision) VALUES (?, ?, ?, 1)",
      ).run(current.generation + 1, secretDigest, appliedAt);
      tx.prepare("UPDATE participant_capability SET revoked_at = ? WHERE revoked_at IS NULL").run(appliedAt);
      options.beforeCommit?.();
    });
  } catch (error) {
    // Transaction outcomes propagate unchanged: no automatic retry, no repair.
    try {
      db.close();
    } catch {
      // The transaction helper may already have invalidated the connection.
    }
    throw error;
  }
  db.close();

  // Proof of recovery is a full normal reopen under the new generation.
  return openStore(options);
}
