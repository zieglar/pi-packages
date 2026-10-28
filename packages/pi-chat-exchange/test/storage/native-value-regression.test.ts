import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "../../src/storage/sqlite-driver-node.js";
import { createRustNativeDriver } from "../../src/storage/sqlite-driver-rust.js";

const nativePath = process.env.CE_TEST_NATIVE_MODULE === undefined
  ? fileURLToPath(new URL("../../native/ce-sqlite/target/release/ce-sqlite.node", import.meta.url))
  : resolve(process.cwd(), process.env.CE_TEST_NATIVE_MODULE);

// Require the artifact: this lane must fail instead of silently skipping Native.
const drivers = [
  ["node", () => createNodeSqliteDriver()],
  ["rust", () => createRustNativeDriver(createRequire(import.meta.url), nativePath)],
] as const;

describe.each(drivers)("value regressions: %s", (_name, driver) => {
  it("get stops before a second row whose SQLite evaluation fails", () => {
    const db = driver().open(":memory:");
    try {
      const query = db.prepare("SELECT 7 AS v UNION ALL SELECT abs(-9223372036854775808)");
      expect(query.get()?.v).toBe(7);
      expect(() => query.all()).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 1 }));
    } finally { db.close(); }
  });

  it("binds missing positional parameters to NULL and rejects excess parameters", () => {
    const db = driver().open(":memory:");
    try {
      const query = db.prepare("SELECT ? AS a, ? AS b");
      expect(query.get()).toMatchObject({ a: null, b: null });
      expect(query.get(3)).toMatchObject({ a: 3, b: null });
      expect(() => query.get(1, 2, 3)).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 25 }));
      db.exec("CREATE TABLE t(a, b)");
      db.prepare("INSERT INTO t VALUES (?, ?)").run(9);
      expect(db.prepare("SELECT * FROM t").get()).toMatchObject({ a: 9, b: null });
      expect(() => db.prepare("INSERT INTO t VALUES (?, ?)").run(1, 2, 3)).toThrowError(expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 25 }));
    } finally { db.close(); }
  });

  it("copies input and output BLOB bytes including subarray offsets", () => {
    const db = driver().open(":memory:");
    try {
      db.exec("CREATE TABLE t(b BLOB)");
      const input = new Uint8Array([99, 1, 255, 88]);
      db.prepare("INSERT INTO t VALUES (?)").run(input.subarray(1, 3));
      input.fill(0);
      const bytes = db.prepare("SELECT b FROM t").get()!.b as Uint8Array;
      expect(Array.from(bytes)).toEqual([1, 255]);
      bytes.fill(4);
      expect(Array.from(db.prepare("SELECT b FROM t").get()!.b as Uint8Array)).toEqual([1, 255]);
      expect(Array.from(db.prepare("SELECT ? AS b").get(new Uint8Array())!.b as Uint8Array)).toEqual([]);
    } finally { db.close(); }
  });

  it("returns all rows beyond 10000 and enforces both safe INTEGER boundaries", () => {
    const db = driver().open(":memory:");
    try {
      const rows = db.prepare("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<10005) SELECT x FROM c").all();
      expect(rows).toHaveLength(10005);
      expect(rows.at(-1)?.x).toBe(10005);
      expect(db.prepare("SELECT 9007199254740991 AS a, -9007199254740991 AS b").get()).toMatchObject({ a: Number.MAX_SAFE_INTEGER, b: Number.MIN_SAFE_INTEGER });
      for (const sql of ["SELECT 9007199254740992", "SELECT -9007199254740992"]) {
        expect(() => db.prepare(sql).get()).toThrowError(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
      }
    } finally { db.close(); }
  });
});

it("rejects unsupported Native values consistently without crashing or stderr", () => {
  // Isolate the native input boundary so a memory fault cannot kill Vitest.
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require('node:assert/strict');
    const { NativeConnection } = require(${JSON.stringify(nativePath)});
    const db = new NativeConnection(':memory:');
    db.exec('CREATE TABLE t(v)');
    const values = [{}, [], new DataView(new ArrayBuffer(8)), new ArrayBuffer(8),
      new Int8Array(1), new Uint8ClampedArray(1), new Uint16Array(1), new Int16Array(1),
      new Uint32Array(1), new Int32Array(1), new Float32Array(1), new Float64Array(1),
      new BigInt64Array(1), new BigUint64Array(1), undefined, true, 1n, Symbol('x'), () => {}];
    for (const value of values) {
      for (const call of [() => db.query('SELECT ?', [value], 1), () => db.execute('INSERT INTO t VALUES (?)', [value])]) {
        assert.throws(call, error => {
          assert.ok(error.message.startsWith('\\u0001CE_SQLITE'));
          assert.equal(JSON.parse(error.message.slice('\\u0001CE_SQLITE'.length)).code, 'ERR_INVALID_ARG_TYPE');
          return true;
        });
      }
    }
    assert.deepEqual(db.query('SELECT ?', [Buffer.from([2, 3])], 1)[1][0][0], new Uint8Array([2, 3]));
    assert.equal(db.query('SELECT 42', [], 1)[1][0][0], 42);
    db.close();
  `], { encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
});
