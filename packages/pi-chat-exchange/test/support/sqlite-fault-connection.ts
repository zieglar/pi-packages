import { vi } from "vitest";
import * as selection from "../../src/storage/sqlite-driver-selection.js";
import type { SqliteConnection } from "../../src/storage/sqlite-driver.js";

/** Test-only method seam shared by every real selected adapter connection. */
export function faultConnection() {
  const driver = selection.resolveSqliteDriver();
  const originals = new WeakMap<SqliteConnection, Pick<SqliteConnection, "exec" | "prepare" | "close" | "enableDefensive" | "setAuthorizerPolicy">>();
  const methods = {
    exec(this: SqliteConnection, sql: string) { return originals.get(this)!.exec(sql); },
    prepare(this: SqliteConnection, sql: string) { return originals.get(this)!.prepare(sql); },
    close(this: SqliteConnection) { return originals.get(this)!.close(); },
    enableDefensive(this: SqliteConnection, enabled: boolean) { return originals.get(this)!.enableDefensive(enabled); },
    setAuthorizerPolicy(this: SqliteConnection, policy: Parameters<SqliteConnection["setAuthorizerPolicy"]>[0]) { return originals.get(this)!.setAuthorizerPolicy(policy); },
  };
  const state = { transactionState: false };
  vi.spyOn(selection, "resolveSqliteDriver").mockImplementation(() => ({
    ...driver,
    open(path, options) {
      const db = driver.open(path, options);
      originals.set(db, Object.fromEntries(Object.keys(methods).map(key => [key, db[key as keyof typeof methods].bind(db)])) as Pick<SqliteConnection, keyof typeof methods>);
      for (const key of Object.keys(methods) as (keyof typeof methods)[]) {
        Object.defineProperty(db, key, { configurable: true, value: (...args: unknown[]) => Reflect.apply(methods[key], db, args) });
      }
      const transaction = Object.getOwnPropertyDescriptor(db, "isTransaction")!.get!;
      Object.defineProperty(db, "isTransaction", { configurable: true, get: () => state.transactionState ? false : transaction.call(db) });
      return db;
    },
  }));
  return { methods, state };
}
