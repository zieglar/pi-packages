import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import Module, { createRequire, register } from "node:module";
import { join } from "node:path";

const config = JSON.parse(process.argv[2]);
const deny = (route) => {
  appendFileSync(config.log, `${route}\n`);
  throw Object.assign(new Error(`test denies node:sqlite ${route}`), { code: "CE_TEST_SQLITE_DENIED" });
};
const isSqlite = (name) => name === "node:sqlite" || name === "sqlite";
const builtin = process.getBuiltinModule;
process.getBuiltinModule = function(name) {
  if (isSqlite(name)) return deny("builtin");
  return builtin.call(process, name);
};
const load = Module._load;
Module._load = function(name, ...args) {
  if (isSqlite(name)) return deny("cjs");
  return load.call(this, name, ...args);
};
register(new URL("./native-default-loader.mjs", import.meta.url), { data: { log: config.log } });

if (config.mode === "controls") {
  assert.throws(() => process.getBuiltinModule("node:sqlite"), { code: "CE_TEST_SQLITE_DENIED" });
  assert.throws(() => createRequire(import.meta.url)("node:sqlite"), { code: "CE_TEST_SQLITE_DENIED" });
  await assert.rejects(import("node:sqlite"), { code: "CE_TEST_SQLITE_DENIED" });
} else {
  // Import only after all three guards are active: eager imports also fail the test.
  const { resolveSqliteDriver } = await import("../../../dist/storage/sqlite-driver-selection.js");
  const database = join(config.home, "persistent-store", "store.sqlite");
  if (config.error) {
    assert.throws(() => {
      const driver = resolveSqliteDriver(config.options);
      // Reaching persistent storage after a Native refusal would be a regression.
      driver.open(database).close();
    }, { code: config.error });
    assert.equal(existsSync(join(config.home, "persistent-store")), false);
    assert.equal(existsSync(database), false);
  } else {
    const driver = resolveSqliteDriver(config.options);
    assert.equal(driver.kind, "rust-native");
    assert.equal(driver.nativeInfo.abiVersion, 1);
    assert.equal(driver.nativeInfo.middlewareVersion, "0.1.0");
    const connection = driver.open(join(config.home, "native.sqlite"));
    try {
      connection.exec("CREATE TABLE sample(value TEXT NOT NULL)");
      connection.prepare("INSERT INTO sample VALUES (?)").run("real native bytes");
      assert.equal(connection.prepare("SELECT value FROM sample").get().value, "real native bytes");
    } finally { connection.close(); }
    const reopened = driver.open(join(config.home, "native.sqlite"), { readOnly: true });
    try {
      assert.equal(reopened.prepare("SELECT value FROM sample").get().value, "real native bytes");
    } finally { reopened.close(); }
  }
}
process.stdout.write("native-default child passed\n");
