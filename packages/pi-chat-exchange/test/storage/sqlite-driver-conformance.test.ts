import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "../../src/storage/sqlite-driver-node.js";
import { createRustNativeDriver } from "../../src/storage/sqlite-driver-rust.js";
import type { SqliteConnection, SqliteDriver } from "../../src/storage/sqlite-driver.js";

const nativePath = process.env.CE_TEST_NATIVE_MODULE === undefined
  ? fileURLToPath(new URL("../../native/ce-sqlite/target/release/ce-sqlite.node", import.meta.url))
  : resolve(process.cwd(), process.env.CE_TEST_NATIVE_MODULE);
if (process.env.CE_TEST_NATIVE_MODULE !== undefined && !existsSync(nativePath)) {
  throw new Error("explicit Native conformance artifact is missing");
}
const drivers: [string, () => SqliteDriver][] = [
  ["node", () => createNodeSqliteDriver()],
  ...(existsSync(nativePath) ? [["rust", () => createRustNativeDriver(createRequire(import.meta.url), nativePath)] as [string, () => SqliteDriver]] : []),
];
const roots: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function memory(driver: SqliteDriver): SqliteConnection {
  const db = driver.open(":memory:");
  connections.push(db);
  return db;
}
function fileDb(driver: SqliteDriver): SqliteConnection {
  const root = mkdtempSync(join(tmpdir(), "ce-driver-conformance-"));
  roots.push(root);
  const db = driver.open(join(root, "store.sqlite"), { defensive: true, timeout: 25 });
  connections.push(db);
  return db;
}

describe.each(drivers)("SQLite driver conformance: %s", (_name, makeDriver) => {
  it("supports scalar/null/blob values and exact run changes", () => {
    const db = memory(makeDriver());
    db.exec("CREATE TABLE t(i INTEGER, r REAL, s TEXT, b BLOB, n TEXT)");
    const result = db.prepare("INSERT INTO t VALUES (?, ?, ?, ?, ?)").run(7, 1.5, "héllo", new Uint8Array([0, 255, 3]), null);
    expect(result.changes).toBe(1);
    const row = db.prepare("SELECT * FROM t").get()!;
    expect(row.i).toBe(7);
    expect(row.r).toBe(1.5);
    expect(row.s).toBe("héllo");
    expect(row.n).toBeNull();
    expect(row.b).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(row.b)).toBe(false);
    expect(Array.from(row.b as Uint8Array)).toEqual([0, 255, 3]);
    expect(db.prepare("SELECT 1 WHERE 0").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 WHERE 0").all()).toEqual([]);
    const objectRow = db.prepare("SELECT 1 AS a, 2 AS a, NULL AS n").get()!;
    expect(Object.getPrototypeOf(objectRow)).toBeNull();
    expect(objectRow.a).toBe(2);
    expect(db.prepare("SELECT 1.0 AS r").get()!.r).toBe(1);
  });

  it("returns every row without a hidden result-count cap", () => {
    const db = memory(makeDriver());
    const rows = db.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10005) SELECT x FROM c").all();
    expect(rows).toHaveLength(10005);
    expect(rows.at(-1)?.x).toBe(10005);
  });

  it("rejects unsafe INTEGER output and preserves safe boundaries", () => {
    const db = memory(makeDriver());
    expect(db.prepare("SELECT 9007199254740991 AS v, -9007199254740991 AS w").get()).toMatchObject({ v: 9007199254740991, w: -9007199254740991 });
    expect(() => db.prepare("SELECT 9007199254740993 AS v").get()).toThrowError(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  });

  it("reports SQLite extended error codes and argument/state errors", () => {
    const db = memory(makeDriver());
    db.exec("CREATE TABLE t(v TEXT UNIQUE, c INTEGER CHECK (c > 0))");
    db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1);
    expect(() => db.prepare("INSERT INTO t VALUES (?, ?)").run("a", 1)).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 2067, errstr: "constraint failed" }));
    expect(() => db.prepare("INSERT INTO t VALUES (?, ?)").run("b", 0)).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 275 }));
    expect(() => db.prepare("SELEC 1")).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 1 }));
    expect(() => db.prepare("")).toThrowError(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
  });

  it("keeps synchronous transaction state and commit/rollback behavior", () => {
    const db = memory(makeDriver());
    db.exec("CREATE TABLE t(v INTEGER)");
    expect(db.isTransaction).toBe(false);
    db.exec("BEGIN");
    expect(db.isTransaction).toBe(true);
    db.prepare("INSERT INTO t VALUES (1)").run();
    db.exec("ROLLBACK");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM t").get()!.n).toBe(0);
    db.exec("BEGIN");
    db.prepare("INSERT INTO t VALUES (2)").run();
    db.exec("COMMIT");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT v FROM t").get()!.v).toBe(2);
  });

  it("denies parsed transaction/savepoint actions and counts only denials", () => {
    const db = memory(makeDriver());
    db.exec("CREATE TABLE t(v INTEGER)");
    const savepoint = db.prepare("SAVEPOINT sp");
    db.setAuthorizerPolicy("deny-transaction-control");
    expect(() => db.exec("BEGIN")).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 23, errstr: "authorization denied" }));
    expect(() => savepoint.run()).toThrowError(expect.objectContaining({ errcode: 23 }));
    expect(() => db.prepare("COMMIT")).toThrowError(expect.objectContaining({ errcode: 23 }));
    expect(db.authorizerDenials()).toBeGreaterThan(0);
    db.setAuthorizerPolicy("off");
    db.exec("BEGIN");
    db.exec("ROLLBACK");
    expect(db.isTransaction).toBe(false);
    db.setAuthorizerPolicy("deny-all");
    expect(() => db.exec("SELECT 1")).toThrowError(expect.objectContaining({ errcode: 23 }));
    db.setAuthorizerPolicy("off");
    expect(db.prepare("SELECT 1 AS v").get()!.v).toBe(1);
  });

  it("enforces defensive mode without allowing writable_schema", () => {
    const db = memory(makeDriver());
    db.enableDefensive(true);
    db.exec("PRAGMA writable_schema=ON");
    expect(db.prepare("PRAGMA writable_schema").get()?.writable_schema).not.toBe(1);
  });

  it("invalidates the connection and prepared statements on close", () => {
    const db = memory(makeDriver());
    const statement = db.prepare("SELECT 1");
    db.close();
    expect(() => db.isTransaction).toThrowError(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    expect(() => db.prepare("SELECT 1")).toThrowError(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    expect(() => statement.get()).toThrowError(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
    expect(() => db.close()).toThrowError(expect.objectContaining({ code: "ERR_INVALID_STATE" }));
  });

  it("applies file connection policy, busy errors and read-only mode", () => {
    const driver = makeDriver();
    const root = mkdtempSync(join(tmpdir(), "ce-driver-file-"));
    roots.push(root);
    const path = join(root, "store.sqlite");
    const db = driver.open(path, { defensive: true, timeout: 25 });
    connections.push(db);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; CREATE TABLE t(v TEXT)");
    expect(db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
    expect(db.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA trusted_schema").get()).toMatchObject({ trusted_schema: 0 });
    db.exec("BEGIN IMMEDIATE");
    const other = driver.open(path, { defensive: true, timeout: 25 });
    connections.push(other);
    expect(() => other.exec("BEGIN IMMEDIATE")).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }));
    db.exec("ROLLBACK");
    other.close();
    db.close();
    const reader = driver.open(path, { readOnly: true, defensive: true });
    connections.push(reader);
    expect(() => reader.exec("CREATE TABLE denied(x)")).toThrowError(expect.objectContaining({ errcode: 8 }));
    reader.close();
    expect(() => driver.open(join(root, "missing.sqlite"), { readOnly: true })).toThrowError(expect.objectContaining({ errcode: 14 }));
  });
});
