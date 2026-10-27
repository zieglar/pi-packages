import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cleanupFixtures, fixture } from "./support/participant-fixture.js";
import { openStore } from "../../src/storage/store.js";

afterEach(cleanupFixtures);
it("CUR-INIT-01/fresh-current-foundation: direct v7 with empty guarded receipt and coherent fresh ledger", () => {
  const f = fixture("ce-v7-");
  const db = f.store.database;
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  expect(db.prepare("SELECT count(*) AS n FROM delivery_ack_receipt").get()).toEqual({ n: 0 });
  expect(db.prepare("SELECT schema_version FROM store_metadata").get()).toEqual({ schema_version: 7 });
  expect(db.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 7 }]);
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("CUR-OPEN-01/exact-current: independent pinned object manifest and fresh reopen", () => {
  const f = fixture("ce-v7-");
  expect(f.store.schemaVersion).toBe(7);
  const text = readFileSync(new URL("./support/current-v7-manifest.json", import.meta.url), "utf8");
  const oracle = JSON.parse(text);
  expect(createHash("sha256").update(text).digest("hex")).toBe("191cbc1da3e3d09109a11c1443bdf2a2f1509cf33106e160fe6d9cf26a98cee3");
  expect(f.store.database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all()).toEqual(oracle.objects);
  expect(f.store.database.prepare("SELECT version,name,checksum FROM schema_migrations").all()).toEqual([oracle.ledger]);
  f.store.close();
  const reopened = openStore({ directory: f.directory, filename: f.filename });
  expect(reopened.schemaVersion).toBe(7);
  reopened.close();
});
