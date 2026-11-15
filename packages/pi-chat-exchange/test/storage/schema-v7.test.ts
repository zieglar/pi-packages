import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorageConnection } from "../../src/storage/connection.js";
import { APPLICATION_ID, SQLITE_APPLICATION_ID, V7_FOUNDATION_CHECKSUM, V7_FOUNDATION_NAME, V7_FOUNDATION_SQL } from "../../src/storage/schema.js";
import { createHostSecretFile } from "../../src/storage/trust-root.js";
import { classifyStoreShape, openStore } from "../../src/storage/store.js";
import { migrateStore } from "../../src/storage/migration.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function historicalV7() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-v7-pinned-")); roots.push(root);
  const options = { directory: join(root, "db"), filename: "store.sqlite" };
  const db = openStorageConnection(options, undefined, true);
  const now = "2026-01-01T00:00:00.000Z";
  db.exec(V7_FOUNDATION_SQL);
  db.prepare("INSERT INTO store_metadata VALUES (1,?,?,?,?)").run("018f5f43-52f8-7c5a-8f64-9d5e06d24a9a", APPLICATION_ID, 7, now);
  db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(7, V7_FOUNDATION_NAME, V7_FOUNDATION_CHECKSUM, now);
  db.exec("INSERT INTO restore_hold(singleton,held) VALUES (1,0)");
  const digest = createHostSecretFile(join(options.directory, options.filename), () => new Uint8Array(32).fill(0x37));
  db.prepare("INSERT INTO host_trust_root VALUES (1,?,?,1)").run(digest, now);
  db.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=7`);
  return { db, options };
}
it("retains the v7 schema and coherent historical ledger for explicit migration", () => {
  const { db } = historicalV7();
  try {
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({ schema_version: 7 });
    expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 7 }]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(classifyStoreShape(db).kind).toBe("v7");
  } finally { db.close(); }
});
it("preserves the independent pinned v7 manifest and explicitly migrates before reopening", () => {
  const { db, options } = historicalV7();
  const text = readFileSync(new URL("./support/current-v7-manifest.json", import.meta.url), "utf8");
  const oracle = JSON.parse(text);
  expect(createHash("sha256").update(text).digest("hex")).toBe("191cbc1da3e3d09109a11c1443bdf2a2f1509cf33106e160fe6d9cf26a98cee3");
  expect(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(oracle.objects);
  expect(db.prepare("SELECT version,name,checksum FROM schema_migrations").all()).toEqual([oracle.ledger]);
  db.close();
  expect(() => openStore(options)).toThrow();
  const migrated = migrateStore({ ...options, fromVersion: 7, toVersion: 8 });
  expect(migrated.schemaVersion).toBe(8);
  const current = migrated.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all();
  for (const oldObject of oracle.objects) expect(current).toContainEqual(oldObject);
  const addedTables = current.filter(row => row.type === "table" && !oracle.objects.some((old: { type: unknown; name: unknown }) => old.type === "table" && old.name === row.name)).map(row => row.name);
  expect(addedTables).toEqual(["message_association", "native_session_binding", "selected_session_binding", "v8_write_permit"]);
  expect(current.filter(row => row.type === "trigger" && String(row.name).startsWith("v8_guard_"))).toHaveLength(81);
  expect(current.some(row => row.type === "index" && row.name === "idx_message_association_request")).toBe(true);
  const addedNonGuardTriggers = current.filter(row => row.type === "trigger" && !String(row.name).startsWith("v8_guard_") && !oracle.objects.some((old: { type: unknown; name: unknown }) => old.type === "trigger" && old.name === row.name)).map(row => row.name);
  expect(addedNonGuardTriggers).toEqual(["message_association_immutable", "message_association_nodelete", "message_association_required", "message_endpoints_immutable", "native_session_binding_immutable", "native_session_binding_nodelete", "selected_session_binding_immutable", "selected_session_binding_nodelete"]);
  migrated.close();
  const reopened = openStore(options);
  expect(reopened.schemaVersion).toBe(8);
  reopened.close();
});
