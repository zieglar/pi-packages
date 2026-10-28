import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createNodeSqliteDriver } from "../../src/storage/sqlite-driver-node.js";
import { createRustNativeDriver } from "../../src/storage/sqlite-driver-rust.js";
import { initializeStore, openStore, type DurableStore } from "../../src/storage/store.js";

const nativePath = process.env.CE_TEST_NATIVE_MODULE === undefined
  ? fileURLToPath(new URL("../../native/ce-sqlite/target/release/ce-sqlite.node", import.meta.url))
  : resolve(process.cwd(), process.env.CE_TEST_NATIVE_MODULE);
const roots: string[] = [];
const stores: DurableStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) { try { store.close(); } catch { /* already closed */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), "ce-driver-cross-"));
  roots.push(value);
  return value;
}

it("opens one WAL database in both directions without changing values", () => {
  const node = createNodeSqliteDriver();
  const rust = createRustNativeDriver(createRequire(import.meta.url), nativePath);
  const path = join(root(), "cross.sqlite");
  let db = node.open(path);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('node')");
  db.close();
  db = rust.open(path);
  expect(db.prepare("SELECT v FROM t").get()).toMatchObject({ v: "node" });
  db.prepare("INSERT INTO t VALUES ('rust')").run();
  db.close();
  db = node.open(path, { readOnly: true });
  expect(db.prepare("SELECT v FROM t ORDER BY rowid").all().map((row) => row.v)).toEqual(["node", "rust"]);
  db.close();
});

it("opens the same schema v7 Store under Node, Rust and Node again", () => {
  const node = createNodeSqliteDriver();
  const rust = createRustNativeDriver(createRequire(import.meta.url), nativePath);
  const directory = root();
  const options = { directory, filename: "store.sqlite", secretBytes: () => new Uint8Array(32).fill(0x31) };
  let store = initializeStore({ ...options, driver: node });
  stores.push(store);
  expect(store.schemaVersion).toBe(7);
  store.close();
  store = openStore({ ...options, driver: rust });
  stores.push(store);
  expect(store.schemaVersion).toBe(7);
  store.close();
  store = openStore({ ...options, driver: node });
  stores.push(store);
  expect(store.schemaVersion).toBe(7);
  expect(store.database.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
});
