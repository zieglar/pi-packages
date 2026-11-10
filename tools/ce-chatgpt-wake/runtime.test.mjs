import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolveRuntime, readNativeHistory } from './resolve-runtime.mjs';
import { V7_FOUNDATION_SQL } from '../../packages/pi-chat-exchange/dist/storage/current-schema.js';

// Replace only signed-policy loading. Use the real CE native lifecycle validator,
// real current schema, real filesystem/process evidence and actual resolver.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cew-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { packageRoot: join(root, 'package'), profilePath: join(root, 'selected.json'),
    nativeSessionFile: join(root, 'native.jsonl'), ownerDirectory: root,
    python: '/usr/bin/python3', stateDir: join(root, 'state') };
  const store = { directory: root, file: 'store.sqlite' };
  const endpoint = 'pi/runtime-test'; const native = 'native-session-uuid';
  const mapping = { endpointId: endpoint, participantId: 'prt_test', sessionId: 'ses_current', exchangeId: 'ho_current' };
  const history = [{ type: 'session', id: native }, { id: 'mapping', parentId: null, type: 'custom', customType: 'ce-mapping', data: mapping }];
  const writeHistory = () => writeFileSync(config.nativeSessionFile, history.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
  writeHistory();
  const rule = { enabled: true, event: 'ce.message.committed.v1', recipient: { adapter: 'chatgpt', endpointId: 'chatgpt/test' },
    command: config.python, args: ['-B', join(root, 'tools/ce-chatgpt-wake/wake.py'), '--config', join(root, 'config.json'), '--hook'] };
  const snapshot = { sequence: 5, digest: 'a'.repeat(64), manifest: { store, exchange: { namespace: 'space', idempotencyKey: 'key' },
    chatgptEndpoint: rule.recipient, registrations: [{ endpointId: endpoint, runtimeSessionId: native, status: 'active', hooks: [rule] }] } };
  writeFileSync(config.profilePath, JSON.stringify(snapshot), { mode: 0o600 });
  mkdirSync(join(config.packageRoot, 'node_modules/jiti'), { recursive: true, mode: 0o700 });
  writeFileSync(join(config.packageRoot, 'package.json'), '{}', { mode: 0o600 });
  const recoveryUrl = pathToFileURL(fileURLToPath(new URL('../../packages/pi-chat-exchange/pi-extension/session-recovery.ts', import.meta.url))).href;
  writeFileSync(join(config.packageRoot, 'node_modules/jiti/index.js'),
    `exports.createJiti=()=>({import:async p=>p.endsWith('/session-recovery.ts')?import(${JSON.stringify(recoveryUrl)}):({readLiveSelectedSessionPolicy:(_p,text)=>JSON.parse(text)})});`, { mode: 0o600 });
  const db = new DatabaseSync(join(root, store.file));
  db.exec(V7_FOUNDATION_SQL);
  db.prepare('INSERT INTO idempotency_record(namespace,idempotency_key,request_digest,entity_id,created_at) VALUES(?,?,?,?,?)')
    .run(JSON.stringify(['exchange.create', 'space']), 'key', 'a'.repeat(64), mapping.exchangeId, new Date().toISOString());
  db.close();
  const scope = createHash('sha256').update(JSON.stringify([root, store.file, endpoint, native])).digest('hex');
  const slot = join(root, '.ce-session-process-mutex', scope, '1');
  mkdirSync(slot, { recursive: true, mode: 0o700 });
  const birth = spawnSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }).stdout.trim();
  const owner = { version: 1, scope, pid: process.pid, birth, processToken: 'process', handleToken: 'handle' };
  writeFileSync(join(slot, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
  return { config, history, writeHistory, mapping, snapshot, slot, owner };
}

test('real current schema and canonical mapping resolve distinct native and CE identities', async t => {
  const f = fixture(t);
  const r = await resolveRuntime(f.config);
  assert.equal(r.runtimeSessionId, 'native-session-uuid');
  assert.equal(r.ceSessionId, 'ses_current');
  assert.equal(r.hookExchangeId, 'ho_current');
});

test('old active registration cannot revive a released native process', async t => {
  const f = fixture(t);
  writeFileSync(join(f.slot, 'released.json'), JSON.stringify(f.owner), { mode: 0o600 });
  await assert.rejects(resolveRuntime(f.config), /NATIVE_PROCESS_RELEASED/);
});

test('switch to another native file cannot inherit old active registration', async t => {
  const f = fixture(t);
  f.history[0].id = 'different-native-session'; f.writeHistory();
  await assert.rejects(resolveRuntime(f.config), /ACTIVE_REGISTRATION_REQUIRED/);
});

test('canonical lifecycle rejects confirmed release even with old active registration and process', async t => {
  const f = fixture(t);
  f.history.push({ id: 'release', type: 'custom', customType: 'ce-messaging-released',
    data: { ...f.mapping, piSessionId: 'native-session-uuid', intent: 'shutdown' } });
  f.writeHistory();
  await assert.rejects(resolveRuntime(f.config), /NATIVE_BINDING_NOT_ACTIVE/);
});

test('append-order lifecycle preserves mapping across compacted conversation ancestry', async t => {
  const f = fixture(t);
  f.history.push({ id: 'new-branch', parentId: null, type: 'message', message: { content: 'private text' } });
  f.writeHistory();
  assert.equal((await resolveRuntime(f.config)).ceSessionId, 'ses_current');
  assert.equal(JSON.stringify(await readNativeHistory(f.config.nativeSessionFile)).includes('private text'), false);
});

test('exact existing Hook command is required', async t => {
  const f = fixture(t);
  f.snapshot.manifest.registrations[0].hooks[0].args.push('--other');
  writeFileSync(f.config.profilePath, JSON.stringify(f.snapshot));
  await assert.rejects(resolveRuntime(f.config), /SINGLE_OWNING_HOOK_REQUIRED/);
});
