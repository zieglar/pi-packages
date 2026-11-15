import { afterEach, expect, it } from "vitest";
import { cleanupFixtures, fixture } from "./support/participant-fixture.js";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStorageConnection } from "../../src/storage/connection.js";
import { migrateStore } from "../../src/storage/migration.js";
import { APPLICATION_ID, SQLITE_APPLICATION_ID, V7_FOUNDATION_SQL, V7_FOUNDATION_NAME, V7_FOUNDATION_CHECKSUM } from "../../src/storage/schema.js";
import { createHostSecretFile } from "../../src/storage/trust-root.js";
import { openStore } from "../../src/storage/store.js";
import { withImmediateTransaction } from "../../src/storage/transaction.js";

afterEach(cleanupFixtures);

it("creates a versioned association schema and blocks legacy unlinked writes", () => {
  const f = fixture("ce-task-association-");
  const db = f.store.database;
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='message_association'").get()).toEqual({ name: "message_association" });
  expect(() => db.prepare("INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, '{}', '{}', 'CREATED', ?, 0, x'', ?, 'legacy', 1)").run("msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", "0".repeat(64), "2026-01-01T00:00:00.000Z")).toThrow(/v8 writer required/i);
});

it("migrates a v7 Store atomically and prevents an already-open old connection from unlinked writes", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-v7-v8-"));
  const loc = { directory: join(root, "db"), filename: "store.sqlite" };
  const db = openStorageConnection(loc, undefined, true);
  const now = "2026-01-01T00:00:00.000Z";
  try {
    db.exec(V7_FOUNDATION_SQL);
    db.prepare("INSERT INTO store_metadata VALUES (1,?,?,?,?)").run("018f5f43-52f8-7c5a-8f64-9d5e06d24a9a", APPLICATION_ID, 7, now);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(7, V7_FOUNDATION_NAME, V7_FOUNDATION_CHECKSUM, now);
    db.exec("INSERT INTO restore_hold(singleton,held) VALUES (1,0)");
    const secret = createHostSecretFile(join(loc.directory, loc.filename), () => new Uint8Array(32).fill(0x33));
    db.prepare("INSERT INTO host_trust_root VALUES (1,?,?,1)").run(secret, now);
    db.prepare("INSERT INTO exchange(exchange_id,state,created_at) VALUES (?, 'OPEN', ?)").run("ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", now);
    db.prepare("INSERT INTO message(message_id,exchange_id,from_endpoint_json,to_endpoint_json,state,payload_digest,payload_length,payload_body,created_at,idempotency_key) VALUES (?,?,'{}','{}','CREATED',?,0,x'',?,'old')").run("msg_01ARZ3NDEKTSV4RRFFQ69G5FAW", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", "0".repeat(64), now);
    const exchangeId = "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const messageId = "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const participantIds: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const participantId = `prt_${String(i).padStart(26, "0")}`;
      const sessionId = `ses_${String(i).padStart(26, "0")}`;
      participantIds.push(participantId);
      db.prepare("INSERT INTO participant(participant_id,endpoint_adapter,endpoint_id,created_at) VALUES (?,?,?,?)").run(participantId, i === 1 ? "chatgpt" : "pi", `fixture-${i}`, now);
      db.prepare("INSERT INTO participant_session(participant_id,session_id,bound_at) VALUES (?,?,?)").run(participantId, sessionId, now);
      db.prepare("INSERT INTO participant_fencing_high_water(participant_id,fencing_token) VALUES (?,?)").run(participantId, i);
      db.prepare("INSERT INTO participant_ownership(participant_id,session_id,fencing_token,expires_at,lease_started_at) VALUES (?,?,?,?,?)").run(participantId, sessionId, i, i === 1 ? "2026-01-01T02:00:00.000Z" : "2026-01-01T00:30:00.000Z", i === 6 ? null : now);
      db.prepare("INSERT INTO exchange_membership(exchange_id,participant_id,join_boundary_seq,created_at) VALUES (?,?,?,?)").run(exchangeId, participantId, 1, now);
    }
    db.prepare("INSERT INTO audit_event(event_id,exchange_id,sequence,kind,subject_id,created_at,digest,length) VALUES (?,?,?,'message_created',?,?,?,0)").run("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", exchangeId, 1, messageId, now, "0".repeat(64));
    db.prepare("INSERT INTO delivery_ack_receipt(receipt_id,exchange_id,message_id,recipient_participant_id,ack_session_id,ack_fencing_token,trust_generation,payload_digest,payload_length,message_created_audit_seq,created_at) VALUES (?,?,?,?,?,1,1,?,0,1,?)").run("rcpt_01ARZ3NDEKTSV4RRFFQ69G5FAV", exchangeId, messageId, participantIds[0]!, `ses_${String(1).padStart(26, "0")}`, "0".repeat(64), now);
    const evidenceTables = ["message", "audit_event", "delivery_ack_receipt", "participant_ownership", "participant_fencing_high_water", "participant_session"];
    const evidenceBefore = evidenceTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    db.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=7`);
    expect(() => migrateStore({ ...loc, fromVersion: 7, toVersion: 8, beforeCommit: () => { throw Error("synthetic rollback"); } })).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    const migrated = migrateStore({ ...loc, fromVersion: 7, toVersion: 8 });
    expect(migrated.schemaVersion).toBe(8);
    expect(evidenceTables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(evidenceBefore);
    expect(db.prepare("SELECT message_id FROM message WHERE idempotency_key='old'").get()).toEqual({ message_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW" });
    expect(() => db.prepare("INSERT INTO message(message_id, exchange_id, from_endpoint_json, to_endpoint_json, state, payload_digest, payload_length, payload_body, created_at, idempotency_key, private_revision) VALUES (?, ?, '{}', '{}', 'CREATED', ?, 0, x'', ?, 'legacy', 1)").run("msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", "0".repeat(64), now)).toThrow(/v8 writer required/i);
    expect(() => db.prepare("UPDATE exchange SET state='CLOSED', closed_at=? WHERE exchange_id=?").run(now, "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(/v8 writer required/i);
    expect(db.prepare("SELECT 1 FROM v8_write_permit").get()).toBeUndefined();
    migrated.close();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it.each(["fencing-mismatch", "missing-session"] as const)("refuses v7 ownership with %s", corruption => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-v7-corrupt-owner-"));
  const loc = { directory: join(root, "db"), filename: "store.sqlite" };
  const db = openStorageConnection(loc, undefined, true);
  const now = "2026-01-01T00:00:00.000Z";
  const participantId = `prt_${"1".padStart(26, "0")}`, sessionId = `ses_${"1".padStart(26, "0")}`;
  try {
    db.exec(V7_FOUNDATION_SQL);
    db.prepare("INSERT INTO store_metadata VALUES (1,?,?,?,?)").run("018f5f43-52f8-7c5a-8f64-9d5e06d24a9a", APPLICATION_ID, 7, now);
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(7, V7_FOUNDATION_NAME, V7_FOUNDATION_CHECKSUM, now);
    db.exec("INSERT INTO restore_hold(singleton,held) VALUES (1,0)");
    const secret = createHostSecretFile(join(loc.directory, loc.filename), () => new Uint8Array(32).fill(0x33));
    db.prepare("INSERT INTO host_trust_root VALUES (1,?,?,1)").run(secret, now);
    db.prepare("INSERT INTO participant(participant_id,endpoint_adapter,endpoint_id,created_at) VALUES (?,'pi','fixture',?)").run(participantId, now);
    db.prepare("INSERT INTO participant_session(participant_id,session_id,bound_at) VALUES (?,?,?)").run(participantId, sessionId, now);
    db.prepare("INSERT INTO participant_fencing_high_water(participant_id,fencing_token) VALUES (?,1)").run(participantId);
    const badSession = corruption === "missing-session" ? `ses_${"2".padStart(26, "0")}` : sessionId;
    const badFence = corruption === "fencing-mismatch" ? 2 : 1;
    db.prepare("INSERT INTO participant_ownership(participant_id,session_id,fencing_token,expires_at,lease_started_at) VALUES (?,?,?,?,?)").run(participantId, badSession, badFence, "2026-01-01T02:00:00.000Z", now);
    db.exec(`PRAGMA application_id=${SQLITE_APPLICATION_ID}; PRAGMA user_version=7`);
    expect(() => migrateStore({ ...loc, fromVersion: 7, toVersion: 8 })).toThrow();
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 7 });
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='message_association'").get()).toBeUndefined();
    expect(db.prepare("SELECT session_id,fencing_token FROM participant_ownership WHERE participant_id=?").get(participantId)).toEqual({ session_id: badSession, fencing_token: badFence });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

it("refuses a Store containing a committed writer permit", () => {
  const f = fixture();
  f.store.database.exec("INSERT INTO v8_write_permit(singleton) VALUES (1)");
  expect(() => openStore({ directory: f.directory, filename: f.filename })).toThrow(/permit/i);
});

it("rolls back an orphan association and its temporary writer permit", () => {
  const f = fixture();
  expect(() => withImmediateTransaction(f.store.database, tx => {
    tx.prepare("INSERT INTO message_association(message_id,exchange_id,request_message_id,from_endpoint_json,to_endpoint_json,created_at) VALUES (?,?,?,?,?,?)").run(
      "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", "ho_01ARZ3NDEKTSV4RRFFQ69G5FAV", "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", "{}", "{}", "2026-01-01T00:00:00.000Z");
  })).toThrow();
  expect(f.store.database.prepare("SELECT 1 FROM message_association LIMIT 1").get()).toBeUndefined();
  expect(f.store.database.prepare("SELECT 1 FROM v8_write_permit LIMIT 1").get()).toBeUndefined();
});
