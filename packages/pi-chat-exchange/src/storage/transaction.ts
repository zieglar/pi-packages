import type { DatabaseSync } from "node:sqlite";

export type TransactionStage = "begin" | "callback" | "commit" | "rollback";

export class StorageTransactionError extends Error {
  readonly code: "STORAGE_TRANSACTION_BUSY" | "STORAGE_TRANSACTION_FAILED";
  readonly stage: TransactionStage;

  constructor(
    message: string,
    stage: TransactionStage,
    options?: ErrorOptions & { readonly busy?: boolean },
  ) {
    super(message, options);
    this.name = "StorageTransactionError";
    this.code = options?.busy === true ? "STORAGE_TRANSACTION_BUSY" : "STORAGE_TRANSACTION_FAILED";
    this.stage = stage;
  }
}

export class ConditionalMutationError extends Error {
  readonly code = "STORAGE_CONDITIONAL_MUTATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ConditionalMutationError";
  }
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { errcode?: unknown; message?: unknown };
  return (
    candidate.errcode === 5 ||
    (typeof candidate.message === "string" && /database is (?:locked|busy)/i.test(candidate.message))
  );
}

function rollbackActiveTransaction(db: DatabaseSync, cause: unknown): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch (rollbackError) {
    throw new StorageTransactionError("failed to roll back an active storage transaction", "rollback", {
      cause: new AggregateError([cause, rollbackError], "transaction and rollback both failed"),
    });
  }
}

function isPromiseLike(value: unknown): boolean {
  return (
    (typeof value === "object" && value !== null && "then" in value) ||
    (typeof value === "function" && "then" in value)
  );
}

export function withImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
  if (db.isTransaction) {
    throw new StorageTransactionError("nested storage transactions are not allowed", "begin");
  }

  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw new StorageTransactionError("failed to begin an immediate storage transaction", "begin", {
      cause: error,
      busy: isBusyError(error),
    });
  }

  let result: T;
  try {
    result = callback();
    if (isPromiseLike(result)) {
      throw new StorageTransactionError(
        "storage transaction callbacks must be synchronous and must not return a Promise",
        "callback",
      );
    }
  } catch (error) {
    rollbackActiveTransaction(db, error);
    if (error instanceof StorageTransactionError || error instanceof ConditionalMutationError) {
      throw error;
    }
    throw new StorageTransactionError("storage transaction callback failed", "callback", {
      cause: error,
    });
  }

  try {
    db.exec("COMMIT");
  } catch (error) {
    const remainedActive = db.isTransaction;
    if (remainedActive) rollbackActiveTransaction(db, error);
    throw new StorageTransactionError(
      remainedActive
        ? "storage transaction commit failed and the active transaction was rolled back"
        : "storage transaction commit failed after SQLite ended the transaction",
      "commit",
      { cause: error, busy: isBusyError(error) },
    );
  }

  if (db.isTransaction) {
    const error = new StorageTransactionError(
      "SQLite reported an active transaction after COMMIT",
      "commit",
    );
    rollbackActiveTransaction(db, error);
    throw error;
  }

  return result;
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
