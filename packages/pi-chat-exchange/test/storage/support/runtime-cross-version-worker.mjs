// Qualification-only real CE Store worker. Synthetic inputs; no credentials or payloads emitted.
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { initializeStore, openStore } from '../../../src/storage/store.ts';
import { createExchange, createMessage, readMessageInTransaction, readMessagePayloadBodyInTransaction } from '../../../src/storage/creation.ts';
import { withImmediateTransaction } from '../../../src/storage/transaction.ts';
import { readRuntimeIdentity, assertRuntimeEligibility } from '../../../src/storage/runtime.ts';
const config = JSON.parse(process.argv[2]);
const emit = value => writeSync(1, JSON.stringify(value) + '\n');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const BASELINE_BYTES = [1, 2, 3, 4];
// BLOB values are normalized to plain arrays so hashes stay identical across runtimes.
const stableRow = row => Object.fromEntries(Object.entries(row).map(([name, cell]) =>
  [name, cell instanceof Uint8Array || Buffer.isBuffer(cell) ? Array.from(cell) : cell]));
const rowHash = rows => hash(rows.map(stableRow));
let store;
try {
  const identity = readRuntimeIdentity();
  assertRuntimeEligibility(identity);
  const options = { directory: config.directory, filename: 'store.sqlite', busyTimeoutMs: 20 };
  store = config.initialize ? initializeStore(options) : openStore(options);
  const db = store.database;
  const boundary = () => {
    emit({ event: 'boundary', transaction: db.isTransaction });
    // Explicit stdout boundary, not timing, orders the parent SIGKILL.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    throw new Error('qualification boundary was not terminated');
  };
  const exchange = createExchange(store, { namespace: 'runtime-qualification', idempotencyKey: 'exchange' });
  const created = createMessage(store, {
    exchangeId: exchange.exchange.exchangeId,
    from: { adapter: 'pi', endpointId: 'synthetic-sender' },
    to: { adapter: 'chatgpt', endpointId: 'synthetic-recipient' },
    payload: new Uint8Array(BASELINE_BYTES), idempotencyKey: config.key,
  }, config.operation === 'crash-write' ? { afterAuditInsert: boundary } : {});
  // Replay the original baseline through the production idempotency path: this
  // re-reads and re-validates the durable message content (digest recompute).
  const baselineReplay = createMessage(store, {
    exchangeId: exchange.exchange.exchangeId,
    from: { adapter: 'pi', endpointId: 'synthetic-sender' },
    to: { adapter: 'chatgpt', endpointId: 'synthetic-recipient' },
    payload: new Uint8Array(BASELINE_BYTES), idempotencyKey: 'baseline',
  });
  if (baselineReplay.disposition !== 'REPLAYED') throw new Error('baseline replay was not idempotent');
  const namespace = JSON.stringify(['message.create', exchange.exchange.exchangeId]);
  const durableRows = db.prepare('SELECT idempotency_key FROM message WHERE idempotency_key IS NOT NULL ORDER BY idempotency_key').all()
    .map(({ idempotency_key: key }) => {
      const message = db.prepare('SELECT * FROM message WHERE idempotency_key=?').get(key);
      const record = db.prepare('SELECT * FROM idempotency_record WHERE namespace=? AND idempotency_key=?').get(namespace, key);
      let payloadBytes;
      withImmediateTransaction(db, tx => {
        const stored = readMessageInTransaction(tx, exchange.exchange.exchangeId, message.message_id);
        if (stored === undefined) throw new Error('stored message missing');
        payloadBytes = Array.from(readMessagePayloadBodyInTransaction(tx, stored));
      });
      return { key, messageId: message.message_id, messageHash: rowHash([message]),
        auditHash: rowHash(db.prepare('SELECT * FROM audit_event WHERE subject_id=? ORDER BY sequence').all(message.message_id)),
        recordHash: rowHash([record]), payloadReadHash: hash(payloadBytes) };
    });
  if (config.operation === 'commit-write') boundary();
  const pragma = name => Object.values(db.prepare(`PRAGMA ${name}`).get())[0];
  const messages = db.prepare('SELECT message_id, idempotency_key FROM message ORDER BY idempotency_key').all();
  const audits = db.prepare("SELECT subject_id FROM audit_event WHERE kind='message_created' ORDER BY subject_id").all();
  emit({ event: 'result', identity, executable: process.execPath,
    storeUuid: store.storeUuid, schemaVersion: store.schemaVersion,
    applicationId: pragma('application_id'), userVersion: pragma('user_version'),
    ledgerHash: hash(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()),
    trustRootHash: hash(db.prepare('SELECT * FROM host_trust_root ORDER BY generation').all()),
    schemaHash: hash(db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()),
    integrity: db.prepare('PRAGMA integrity_check').all(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
    policy: { wal: pragma('journal_mode'), synchronous: pragma('synchronous'), foreignKeys: pragma('foreign_keys'), trustedSchema: pragma('trusted_schema') },
    disposition: created.disposition, messageId: created.message.messageId, messages, audits,
    records: db.prepare("SELECT entity_id FROM idempotency_record WHERE namespace=? ORDER BY entity_id").all(JSON.stringify(['message.create', exchange.exchange.exchangeId])),
    baselineReplayId: baselineReplay.message.messageId, durableRows,
  });
} catch (error) {
  emit({ event: 'error', code: error?.code, stage: error?.stage, outcome: error?.outcome });
  process.exitCode = 1;
} finally { store?.close(); }
