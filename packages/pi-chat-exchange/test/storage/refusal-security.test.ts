import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { initializeStore, openStore } from "../../src/storage/store.js";
import { readRuntimeIdentity } from "../../src/storage/runtime.js";

const roots: string[] = [];
function location() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-r2-refusal-"));
  roots.push(root);
  const directory = join(root, "database");
  mkdirSync(directory, { mode: 0o700 });
  return { root, directory, filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function snapshot(directory: string) {
  return readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name)).toString("hex")]);
}

it.each(["", "-wal", "-shm"])("F2: dangling %s symlink is rejected before SQLite writes", (suffix) => {
  const options = location();
  const outside = join(options.root, "escaped.sqlite");
  symlinkSync(outside, join(options.directory, options.filename + suffix));
  expect(() => openStorageConnection(options)).toThrow();
  expect(existsSync(outside)).toBe(false);
  expect(readdirSync(options.directory)).toEqual([options.filename + suffix]);
});

it("F2: symlinked ancestor cannot create an escaped database or directory", () => {
  const options = location();
  const link = join(options.root, "ancestor");
  symlinkSync(options.directory, link);
  expect(() => openStorageConnection({ directory: join(link, "new"), filename: options.filename })).toThrow();
  expect(readdirSync(options.directory)).toEqual([]);
});

it.each(["foreign", "incompatible", "held", "drift"])("F3: refuses %s DELETE store without changing any persistent artifact", (kind) => {
  const options = location();
  const path = join(options.directory, options.filename);
  if (kind !== "foreign") initializeStore(options).close();
  const modifier = new DatabaseSync(path);
  modifier.exec("PRAGMA journal_mode=DELETE");
  if (kind === "foreign") modifier.exec("CREATE TABLE unrelated(id TEXT PRIMARY KEY)");
  if (kind === "incompatible") modifier.exec("PRAGMA user_version=0");
  if (kind === "drift") modifier.exec("DROP TRIGGER result_immutable");
  if (kind === "held") modifier.exec("UPDATE restore_hold SET held=1, reason='review', detected_at='now'");
  modifier.close();
  chmodSync(path, 0o600);
  const before = snapshot(options.directory);
  expect(() => openStore(options)).toThrow();
  expect(snapshot(options.directory)).toEqual(before);
});

it("F3: WAL refusal preserves existing DB/WAL/SHM bytes with a live writer", () => {
  const options = location();
  const writer = initializeStore(options);
  try {
    writer.database.exec("UPDATE restore_hold SET held=1, reason='review', detected_at='now'");
    const before = snapshot(options.directory);
    expect(() => openStore(options)).toThrow();
    expect(snapshot(options.directory)).toEqual(before);
  } finally { writer.close(); }
});

it("F3: revalidates compatibility on the selected writer before WAL setup", () => {
  const options = location();
  initializeStore(options).close();
  const path = join(options.directory, options.filename);
  const modifier = new DatabaseSync(path);
  modifier.exec("PRAGMA journal_mode=DELETE");
  modifier.close();
  let afterChange: ReturnType<typeof snapshot> = [];
  let runtimeChecks = 0;
  expect(() => openStore({ ...options, runtimeIdentity: () => {
    // First check precedes path preparation; second follows snapshot preflight.
    if (++runtimeChecks === 1) return readRuntimeIdentity();
    const changed = new DatabaseSync(path);
    changed.exec("PRAGMA user_version=0");
    changed.close();
    afterChange = snapshot(options.directory);
    return readRuntimeIdentity();
  } })).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
  expect(runtimeChecks).toBe(2);
  expect(snapshot(options.directory)).toEqual(afterChange);
});
