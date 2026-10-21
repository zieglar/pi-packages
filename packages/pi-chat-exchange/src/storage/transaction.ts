import { constants, type DatabaseSync, type StatementSync } from "node:sqlite";

export type TransactionStage = "begin" | "callback" | "commit" | "rollback";
export type TransactionOutcome = "ROLLED_BACK" | "COMMITTED" | "INDETERMINATE";

export class StorageTransactionError extends Error {
  readonly code: "STORAGE_TRANSACTION_BUSY" | "STORAGE_TRANSACTION_FAILED";
  readonly stage: TransactionStage;
  readonly outcome: TransactionOutcome;
  readonly retryable: boolean;

  constructor(
    message: string,
    stage: TransactionStage,
    options?: ErrorOptions & { readonly busy?: boolean; readonly outcome?: TransactionOutcome },
  ) {
    super(message, options);
    this.name = "StorageTransactionError";
    this.outcome = options?.outcome ?? "INDETERMINATE";
    this.retryable = options?.busy === true && this.outcome === "ROLLED_BACK";
    this.code = this.retryable ? "STORAGE_TRANSACTION_BUSY" : "STORAGE_TRANSACTION_FAILED";
    this.stage = stage;
  }
}

export class ConditionalMutationError extends Error {
  readonly code = "STORAGE_CONDITIONAL_MUTATION_FAILED";
  readonly outcome = "ROLLED_BACK";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ConditionalMutationError";
  }
}

// Only synchronous operations are exposed; neither the connection, authorizer,
// transaction controls nor iterators can escape through this capability.
export interface TransactionHandle {
  exec(sql: string): void;
  prepare(sql: string): Pick<StatementSync, "run" | "get" | "all">;
}

const invalidated = new WeakSet<DatabaseSync>();
function invalidate(db: DatabaseSync): void {
  invalidated.add(db);
  try { db.close(); } catch {
    // If close itself fails, poison authorization as well as helper reuse.
    try { db.setAuthorizer(() => constants.SQLITE_DENY); } catch { /* already unusable */ }
  }
}

function transactionActive(db: DatabaseSync, stage: TransactionStage, cause?: unknown): boolean {
  try { return db.isTransaction; } catch (error) {
    invalidate(db);
    throw new StorageTransactionError("cannot establish owned transaction state", stage, {
      cause: new AggregateError([cause, error], "transaction state is unreadable"),
      outcome: "INDETERMINATE",
    });
  }
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { errcode?: unknown };
  return typeof candidate.errcode === "number" && (candidate.errcode & 0xff) === 5;
}

function rollbackOwnedTransaction(db: DatabaseSync, cause: unknown): void {
  if (!transactionActive(db, "rollback", cause)) {
    invalidate(db);
    throw new StorageTransactionError("owned transaction ended unexpectedly", "callback", {
      cause, outcome: "INDETERMINATE",
    });
  }
  try {
    db.exec("ROLLBACK");
    if (db.isTransaction) throw new Error("transaction remains active after ROLLBACK");
  } catch (rollbackError) {
    invalidate(db);
    throw new StorageTransactionError("failed to prove storage transaction rollback", "rollback", {
      cause: new AggregateError([cause, rollbackError], "transaction and rollback both failed"),
      outcome: "INDETERMINATE",
    });
  }
}

// Void-only runtime acceptance. The returned value is never read, called,
// awaited, assimilated, or modified: only its identity against `undefined`
// is inspected, so hostile objects and Proxies expose no behavior here.
function assertVoidResult(result: unknown): void {
  if (result !== undefined) {
    throw new Error("storage transaction callbacks must be synchronous and return undefined");
  }
}

/** Strictly synchronous. Only an `undefined` callback result is accepted at runtime.
 * Unsupported results roll back before COMMIT without reading, calling, awaiting,
 * assimilating, or modifying the value. Promise lifecycle ownership — including
 * rejection handling — stays with the code that creates the Promise.
 * Normal return means COMMITTED. Errors carry conservative outcomes and retry policy.
 * This private primitive owns the connection's authorizer for its duration.
 * Raw connection owners are privileged; callbacks should use only the scoped handle.
 */
export function withImmediateTransaction(db: DatabaseSync, callback: (tx: TransactionHandle) => void): void {
  if (invalidated.has(db)) {
    throw new StorageTransactionError("storage connection is invalidated", "begin");
  }
  if (transactionActive(db, "begin")) {
    throw new StorageTransactionError("nested storage transactions are not allowed", "begin");
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw new StorageTransactionError("failed to begin an immediate storage transaction", "begin", {
      cause: error, busy: isBusyError(error), outcome: "ROLLED_BACK",
    });
  }

  let capabilityActive = true;
  let ownerControl = false;
  let controlAttempted = false;
  const assertActive = (): void => {
    if (!capabilityActive) throw new StorageTransactionError("transaction handle is revoked", "callback");
    if (!db.isTransaction) throw new StorageTransactionError("owned transaction ended unexpectedly", "callback");
  };
  const tx: TransactionHandle = Object.freeze({
    exec(sql: string): void { assertActive(); db.exec(sql); },
    prepare(sql: string): Pick<StatementSync, "run" | "get" | "all"> {
      assertActive();
      const statement = db.prepare(sql);
      return Object.freeze({
        // Parameters extracts the named overload; the cast retains both overloads.
        // Every supplied argument is forwarded unchanged to SQLite's typed method.
        run: ((...args: Parameters<StatementSync["run"]>) => { assertActive(); return statement.run(...args); }) as StatementSync["run"],
        get: ((...args: Parameters<StatementSync["get"]>) => { assertActive(); return statement.get(...args); }) as StatementSync["get"],
        all: ((...args: Parameters<StatementSync["all"]>) => { assertActive(); return statement.all(...args); }) as StatementSync["all"],
      });
    },
  });

  try {
    try {
      // SQLite authorizes parsed actions, including previously prepared statements
      // invalidated by setAuthorizer. Not a SQL-prefix/regex filter.
      db.setAuthorizer((action) => {
        if (!ownerControl && (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT)) {
          controlAttempted = true;
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      assertVoidResult(callback(tx));
      if (controlAttempted) throw new Error("callback attempted owned transaction control");
      if (!db.isTransaction) throw new Error("owned transaction ended unexpectedly");
    } catch (error) {
      capabilityActive = false;
      ownerControl = true;
      rollbackOwnedTransaction(db, error);
      if (error instanceof ConditionalMutationError) throw error;
      throw new StorageTransactionError("storage transaction callback failed; " + (error instanceof Error ? error.message : "unsupported failure"), "callback", {
        cause: error, outcome: "ROLLED_BACK",
      });
    } finally {
      capabilityActive = false;
      ownerControl = true;
    }

    try {
      db.exec("COMMIT");
    } catch (error) {
      if (!transactionActive(db, "commit", error)) {
        invalidate(db);
        throw new StorageTransactionError("commit failed with an indeterminate outcome", "commit", {
          cause: error, outcome: "INDETERMINATE",
        });
      }
      rollbackOwnedTransaction(db, error);
      throw new StorageTransactionError("commit failed; active transaction rolled back", "commit", {
        cause: error, busy: isBusyError(error), outcome: "ROLLED_BACK",
      });
    }
    if (transactionActive(db, "commit")) {
      invalidate(db);
      throw new StorageTransactionError("active transaction after COMMIT; outcome indeterminate", "commit");
    }
  } finally {
    capabilityActive = false;
    if (!invalidated.has(db)) {
      try { db.setAuthorizer(null); } catch { invalidate(db); }
    }
  }
}

export function requireSingleRowChange(
  result: { readonly changes: number | bigint },
  operation: string,
): void {
  if (result.changes !== 1 && result.changes !== 1n) {
    throw new ConditionalMutationError(
      `${operation} required exactly one matching row; changed ${String(result.changes)}`,
    );
  }
}
