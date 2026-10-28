import type { SqliteConnection, SqliteDriver, SqliteRow, SqliteStatement, SqliteAuthorizerPolicy, SqliteInputValue } from "./sqlite-driver.js";

/** Self-contained factory: stringified for the MCP child probe. Keep no module
 * captures except the type-only import (erased at build time). */
export function createNodeSqliteDriver(sqliteModule?: typeof import("node:sqlite")): SqliteDriver {
  const { DatabaseSync, constants } = sqliteModule ?? process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const stateError = (message: string): Error => Object.assign(new Error(message), { code: "ERR_INVALID_STATE" });
  return {
    kind: "node-sqlite",
    open(path, options = {}): SqliteConnection {
      const db = new DatabaseSync(path, {
        readOnly: options.readOnly ?? false,
        defensive: options.defensive ?? true,
        timeout: options.timeout ?? 0,
      });
      let closed = false;
      let policy: SqliteAuthorizerPolicy = "off";
      let externalAuthorizer = false;
      let denials = 0;
      const ensureOpen = (): void => { if (closed) throw stateError("database is not open"); };
      return {
        prepare(sql: string): SqliteStatement {
          ensureOpen();
          const statement = db.prepare(sql);
          return {
            get: (...args: SqliteInputValue[]) => { ensureOpen(); return statement.get(...args) as SqliteRow | undefined; },
            all: (...args: SqliteInputValue[]) => { ensureOpen(); return statement.all(...args) as SqliteRow[]; },
            run: (...args: SqliteInputValue[]) => { ensureOpen(); return { changes: Number(statement.run(...args).changes) }; },
          };
        },
        exec(sql: string): void { ensureOpen(); db.exec(sql); },
        close(): void {
          ensureOpen();
          try { db.close(); } finally {
            closed = true;
          }
        },
        get isTransaction(): boolean { ensureOpen(); return db.isTransaction; },
        enableDefensive(enabled: boolean): void { ensureOpen(); db.enableDefensive(enabled); },
        setAuthorizer(callback: ((action: number) => number) | null): void { ensureOpen(); externalAuthorizer = true; db.setAuthorizer(callback); },
        setAuthorizerPolicy(next: SqliteAuthorizerPolicy): void {
          ensureOpen();
          if (next === "off" && externalAuthorizer) return;
          externalAuthorizer = false;
          policy = next;
          if (next === "deny-transaction-control") denials = 0;
          db.setAuthorizer((action) => {
            const deny = policy === "deny-all"
              || (policy === "deny-transaction-control" && (action === constants.SQLITE_TRANSACTION || action === constants.SQLITE_SAVEPOINT));
            if (deny) {
              denials += 1;
              return constants.SQLITE_DENY;
            }
            return constants.SQLITE_OK;
          });
        },
        authorizerDenials(): number { ensureOpen(); return externalAuthorizer ? 0 : denials; },
      };
    },
  };
}
