import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openStorageConnection } from "../../src/storage/connection.js";
import { initializeStore, openStore } from "../../src/storage/store.js";

const roots: string[] = [];
function location() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-r2-schema-"));
  roots.push(root);
  return { directory: join(root, "database"), filename: "store.sqlite" };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function seed(db: ReturnType<typeof openStorageConnection>) {
  db.exec(`
    INSERT INTO exchange(exchange_id, state, created_at) VALUES ('e', 'OPEN', 'now');
    INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state,
      payload_digest, payload_length, created_at) VALUES ('m', 'e', '{}', '{}', 'CREATED', '${"a".repeat(64)}', 0, 'now');
    INSERT INTO attempt(attempt_id, message_id, endpoint_json, consumer_id, instance_id,
      fencing_token, lease_expires_at, dispatch, transport, created_at)
      VALUES ('a', 'm', '{}', 'c', 'i', 1, 'now', 'started', 'failed', 'now');
    INSERT INTO result(result_id, exchange_id, message_id, attempt_id, source_endpoint_json,
      transport, runtime, body, result_digest, settled_at)
      VALUES ('r', 'e', 'm', 'a', '{}', 'failed', 'settled', 'original', '${"b".repeat(64)}', 'now');
    INSERT INTO audit_event(event_id, exchange_id, sequence, kind, subject_id, created_at)
      VALUES ('audit', 'e', 1, 'original', 'm', 'now');
  `);
}

it.each(["result", "audit_event", "schema_migrations", "store_metadata"] as const)(
  "F1: %s rejects REPLACE, UPDATE, and DELETE without changing rows", (table) => {
    const store = initializeStore(location());
    try {
      seed(store.database);
      const before = store.database.prepare(`SELECT * FROM ${table}`).all();
      const columns = Object.keys(before[0]!);
      const changedColumn = { result: "body", audit_event: "kind", schema_migrations: "checksum", store_metadata: "created_at" }[table]!;
      const values = columns.map((column) => column === changedColumn ? "c".repeat(64) : before[0]![column]!);
      const replace = store.database.prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      expect(() => replace.run(...values)).toThrow(/immutable/);
      // Also collide on a secondary UNIQUE key while changing the primary key.
      if (table !== "store_metadata") {
        values[0] = table === "schema_migrations" ? 2 : "replacement-id";
        expect(() => replace.run(...values)).toThrow(/immutable/);
      }
      expect(() => store.database.exec(`UPDATE ${table} SET ${columns[0]} = ${columns[0]}`)).toThrow(/immutable/);
      expect(() => store.database.exec(`DELETE FROM ${table}`)).toThrow(/immutable/);
      expect(store.database.prepare(`SELECT * FROM ${table}`).all()).toEqual(before);
      expect(store.database.prepare("PRAGMA recursive_triggers").get()).toEqual({ recursive_triggers: 1 });
    } finally { store.close(); }
  },
);

it.each([
  "DROP TRIGGER result_immutable",
  "DROP TRIGGER audit_event_nodelete; CREATE TRIGGER audit_event_nodelete BEFORE DELETE ON audit_event BEGIN SELECT 1; END",
  "ALTER TABLE exchange ADD COLUMN unauthorized TEXT",
  "DROP INDEX idx_result_correlation",
  "DROP INDEX idx_result_correlation; CREATE INDEX idx_result_correlation ON result(result_id)",
  "CREATE TABLE unauthorized (id TEXT)",
  "CREATE VIEW unauthorized AS SELECT * FROM exchange",
  "DROP TABLE fencing_high_water; CREATE TABLE fencing_high_water(message_id TEXT PRIMARY KEY, fencing_token INTEGER, private_revision INTEGER)",
])("F5: refuses live schema drift: %s", (sql) => {
  const options = location();
  initializeStore(options).close();
  const modifier = openStorageConnection(options);
  modifier.exec(sql);
  modifier.close();
  expect(() => {
    const reopened = openStore(options);
    reopened.close();
  }).toThrowError(expect.objectContaining({ code: "STORAGE_INCOMPATIBLE" }));
});
