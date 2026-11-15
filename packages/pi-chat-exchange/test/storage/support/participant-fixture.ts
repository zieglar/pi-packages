import { createHmac } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SqliteConnection } from "../../../src/storage/sqlite-driver.js";
import { resolveSqliteDriver } from "../../../src/storage/sqlite-driver-selection.js";
import { expect } from "vitest";
import { openStorageConnection } from "../../../src/storage/connection.js";
import { createExchange } from "../../../src/storage/creation.js";
import {
  createParticipant,
  issueCapability,
  type ParticipantCreation,
} from "../../../src/storage/participant.js";
import { initializeStore, type DurableStore } from "../../../src/storage/store.js";

/** Shared B3-P1B fixture: a real file-backed v2 store with a deterministic
 * host secret, so tests can independently recompute capability digests and
 * prove that only digests are persisted. Nothing here is mocked: every
 * assertion runs against real SQLite and the real filesystem. */

export const SECRET = new Uint8Array(32).fill(0x5a);
export const SECRET_HEX = Buffer.from(SECRET).toString("hex");
export const NOW = "2026-10-10T00:00:00.000Z";
export const LATER = "2026-10-10T01:00:00.000Z";

export interface Fixture {
  readonly root: string;
  readonly directory: string;
  readonly filename: string;
  readonly databasePath: string;
  readonly store: DurableStore;
}

const fixtures: { root: string; store: DurableStore }[] = [];

export function fixture(label = "ce-b3-p1b-"): Fixture {
  const root = mkdtempSync(join(realpathSync(tmpdir()), label));
  const directory = join(root, "database");
  const filename = "store.sqlite";
  const store = initializeStore({
    directory,
    filename,
    busyTimeoutMs: 1_000,
    now: () => NOW,
    secretBytes: () => SECRET,
  });
  fixtures.push({ root, store });
  return { root, directory, filename, databasePath: join(directory, filename), store };
}

export function cleanupFixtures(): void {
  for (const { root, store } of fixtures.splice(0)) {
    try {
      store.close();
    } catch {
      /* invalidated connections are already closed */
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Independent read-only view of durable state. */
export function reader(active: Fixture): SqliteConnection {
  return resolveSqliteDriver().open(active.databasePath, { readOnly: true, defensive: true });
}

/** Privileged raw connection: accepted test/setup authority used to tamper
 * with durable state in negative controls. */
export function privileged(active: Fixture): SqliteConnection {
  const db = openStorageConnection({ directory: active.directory, filename: active.filename });
  const exec = db.exec.bind(db), prepare = db.prepare.bind(db);
  let permitInExplicitTransaction = false;
  const write = <T>(action: () => T): T => {
    if (db.isTransaction) {
      if (!permitInExplicitTransaction) {
        exec("INSERT OR IGNORE INTO v8_write_permit(singleton) VALUES (1)");
        permitInExplicitTransaction = true;
      }
      return action();
    }
    exec("BEGIN IMMEDIATE; INSERT INTO v8_write_permit(singleton) VALUES (1)");
    try { const result = action(); exec("DELETE FROM v8_write_permit WHERE singleton=1; COMMIT"); return result; }
    catch (error) { try { exec("ROLLBACK"); } catch {} throw error; }
  };
  db.prepare = sql => {
    const statement = prepare(sql);
    if (!/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql) || /\bv8_write_permit\b/i.test(sql)) return statement;
    const run = statement.run.bind(statement);
    statement.run = (...args) => write(() => run(...args));
    return statement;
  };
  db.exec = sql => {
    if (/^\s*(?:COMMIT|END)\s*;?\s*$/i.test(sql) && permitInExplicitTransaction) { exec("DELETE FROM v8_write_permit WHERE singleton=1"); permitInExplicitTransaction = false; }
    if (/^\s*ROLLBACK\s*;?\s*$/i.test(sql)) permitInExplicitTransaction = false;
    if (/\bv8_write_permit\b/i.test(sql)) return exec(sql);
    if (!db.isTransaction && /^\s*BEGIN\s*;/i.test(sql) && /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
      permitInExplicitTransaction = true;
      return exec(sql.replace(/^\s*BEGIN\s*;/i, "BEGIN; INSERT INTO v8_write_permit(singleton) VALUES (1);"));
    }
    return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\s+(?:INTO\s+|FROM\s+)?(?:participant|participant_session|participant_ownership|participant_capability|participant_fencing_high_water|exchange_membership|audit_event|message|exchange|delivery_cursor|delivery_ack_receipt|idempotency_record)\b/i.test(sql) ? write(() => exec(sql)) : exec(sql);
  };
  return db;
}

export function exchange(active: Fixture, idempotencyKey = "exchange-key"): string {
  return createExchange(active.store, { namespace: "owner", idempotencyKey }, { now: () => NOW }).exchange
    .exchangeId;
}

export function participant(
  active: Fixture,
  endpointId: string,
  idempotencyKey = `create-${endpointId}`,
  adapter = "adapter-a",
): ParticipantCreation {
  return createParticipant(
    active.store,
    { endpoint: { adapter, endpointId }, idempotencyKey },
    { now: () => NOW },
  );
}

export function capabilityFor(
  active: Fixture,
  participantId: string,
  scope: "create" | "bind" | "join" | "attach" | "resume" | "takeover" | "send" | "ack" | "read" | "payload_read",
  options: { readonly expiresAt?: string; readonly now?: string; readonly sessionId?: string } = {},
): string {
  return issueCapability(
    active.store,
    {
      participantId,
      scope,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    },
    { now: () => options.now ?? NOW },
  ).capability;
}

/** Independent reimplementation of the documented capability derivation:
 * HMAC-SHA256 keyed by the host secret over the generation, Participant,
 * scope, and token. Tests use it to forge, to bind to the wrong generation,
 * and to prove the persisted digest is not the plaintext token. */
export function expectedDigest(
  generation: number,
  participantId: string,
  scope: string,
  capability: string,
  secretHex = SECRET_HEX,
): string {
  return createHmac("sha256", secretHex)
    .update(
      ["chat-exchange/capability", "v1", String(generation), participantId, scope, capability.slice("cap_".length)].join(
        "\n",
      ),
      "utf8",
    )
    .digest("hex");
}

export function rowCounts(active: Fixture): Record<string, string> {
  const view = reader(active);
  try {
    const scalar = (table: string): string =>
      String(view.prepare(`SELECT CAST(count(*) AS TEXT) AS n FROM ${table}`).get()!.n);
    return {
      participant: scalar("participant"),
      capability: scalar("participant_capability"),
      session: scalar("participant_session"),
      membership: scalar("exchange_membership"),
      ownership: scalar("participant_ownership"),
      fencing: scalar("participant_fencing_high_water"),
      cursor: scalar("delivery_cursor"),
      audits: scalar("audit_event"),
      records: scalar("idempotency_record"),
      messages: scalar("message"),
    };
  } finally {
    view.close();
  }
}

export function auditRows(active: Fixture, exchangeId: string): { sequence: number; kind: string; subject: string }[] {
  const view = reader(active);
  try {
    return view
      .prepare("SELECT sequence, kind, subject_id FROM audit_event WHERE exchange_id = ? ORDER BY sequence")
      .all(exchangeId)
      .map((row) => ({
        sequence: Number(row.sequence),
        kind: String(row.kind),
        subject: String(row.subject_id),
      }));
  } finally {
    view.close();
  }
}

export function expectRefusal(run: () => unknown, code: string): unknown {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return error;
  }
  throw new Error(`expected the operation to fail with ${code}`);
}
