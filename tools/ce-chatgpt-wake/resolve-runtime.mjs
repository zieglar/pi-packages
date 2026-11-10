#!/usr/bin/env node
// Resolve selected CE policy and the native runtime's live CE binding. Never print credentials.
import { constants, createReadStream, openSync, closeSync, fstatSync, lstatSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

function privateJson(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || lstatSync(path).isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size > 65536) {
      throw new Error('NATIVE_PROOF_UNSAFE');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

export async function readNativeHistory(path) {
  // CE's existing lifecycle validator consumes append-order identifiers across branches/compaction.
  const history = [];
  let header;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error('NATIVE_SESSION_ENTRY_INVALID'); }
    if (entry === null || typeof entry !== 'object') throw new Error('NATIVE_SESSION_ENTRY_INVALID');
    if (!header) {
      if (entry.type !== 'session' || typeof entry.id !== 'string') throw new Error('NATIVE_SESSION_HEADER_INVALID');
      header = entry;
    } else {
      const relevant = entry.type === 'custom' && typeof entry.customType === 'string' && entry.customType.startsWith('ce-');
      history.push({ id: entry.id, type: entry.type, ...(relevant ? { customType: entry.customType, data: entry.data } : {}) });
    }
  }
  if (!header) throw new Error('NATIVE_SESSION_HEADER_INVALID');
  return { header, history };
}

export function assertNativeProcess(store, endpointId, runtimeSessionId) {
  const scope = createHash('sha256').update(JSON.stringify([store.directory, store.file, endpointId, runtimeSessionId])).digest('hex');
  const directory = join(store.directory, '.ce-session-process-mutex', scope);
  const slots = readdirSync(directory);
  if (!slots.length || slots.some(x => !/^[1-9][0-9]*$/.test(x))) throw new Error('NATIVE_PROCESS_PROOF_REQUIRED');
  const last = slots.map(Number).sort((a, b) => a - b).at(-1);
  if (last !== slots.length) throw new Error('NATIVE_PROCESS_PROOF_INVALID');
  const slot = join(directory, String(last));
  if (existsSync(join(slot, 'released.json'))) throw new Error('NATIVE_PROCESS_RELEASED');
  const owner = privateJson(join(slot, 'owner.json'));
  if (owner.version !== 1 || owner.scope !== scope || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.birth !== 'string') {
    throw new Error('NATIVE_PROCESS_PROOF_INVALID');
  }
  const observed = spawnSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart='],
    { encoding: 'utf8', timeout: 1000, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
  if (observed.status !== 0 || observed.stdout.trim() !== owner.birth) throw new Error('NATIVE_PROCESS_CHANGED');
  // This existing process marker is additional exclusion evidence. Policy and CE ownership remain authority.
}

export async function resolveRuntime(config) {
  const { header, history } = await readNativeHistory(config.nativeSessionFile);
  const require = createRequire(join(config.packageRoot, 'package.json'));
  const { createJiti } = require('jiti');
  const jiti = createJiti(join(config.packageRoot, 'package.json'), { fsCache: false, moduleCache: false });
  const api = await jiti.import(join(config.packageRoot, 'pi-extension/live-session-profile.ts'));
  const recovery = await jiti.import(join(config.packageRoot, 'pi-extension/session-recovery.ts'));
  const snapshot = api.readLiveSelectedSessionPolicy(config.profilePath, readFileSync(config.profilePath, 'utf8'));
  if (!snapshot) throw new Error('SELECTED_POLICY_ABSENT');
  const manifest = snapshot.manifest;
  const lifecycle = recovery.nativeSessionLifecycle(history, header.id, manifest.store);
  if (lifecycle.invalid || lifecycle.failures.length || lifecycle.releaseIntent || !lifecycle.mapping) throw new Error('NATIVE_BINDING_NOT_ACTIVE');
  const mapping = lifecycle.mapping;
  const registrations = manifest.registrations.filter(r => r.runtimeSessionId === header.id && r.status === 'active');
  if (registrations.length !== 1) throw new Error('ACTIVE_REGISTRATION_REQUIRED');
  const registration = registrations[0];
  assertNativeProcess(manifest.store, registration.endpointId, header.id);
  const hooks = (registration.hooks ?? []).filter(h => h.enabled && h.event === 'ce.message.committed.v1' &&
    h.recipient.adapter === manifest.chatgptEndpoint.adapter && h.recipient.endpointId === manifest.chatgptEndpoint.endpointId);
  const expectedArgs = ['-B', join(config.ownerDirectory, 'tools/ce-chatgpt-wake/wake.py'), '--config', join(config.ownerDirectory, 'config.json'), '--hook'];
  if (hooks.length !== 1 || hooks[0].command !== config.python || JSON.stringify(hooks[0].args) !== JSON.stringify(expectedArgs)) {
    throw new Error('SINGLE_OWNING_HOOK_REQUIRED');
  }
  const databasePath = resolve(manifest.store.directory, manifest.store.file);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let exchange;
  try {
    db.exec('PRAGMA query_only=ON');
    exchange = db.prepare('SELECT entity_id FROM idempotency_record WHERE namespace=? AND idempotency_key=?')
      .get(JSON.stringify(['exchange.create', manifest.exchange.namespace]), manifest.exchange.idempotencyKey);
  } finally { db.close(); }
  if (!exchange || manifest.chatgptEndpoint.adapter !== 'chatgpt' || mapping.endpointId !== registration.endpointId || mapping.exchangeId !== exchange.entity_id) {
    throw new Error('NATIVE_EXCHANGE_BINDING_REQUIRED');
  }
  return { hookSenderAdapter: 'pi', hookSenderEndpointId: registration.endpointId,
    hookRecipientAdapter: 'chatgpt', hookRecipientEndpointId: manifest.chatgptEndpoint.endpointId,
    hookExchangeId: exchange.entity_id, stateDir: config.stateDir, databasePath,
    runtimeSessionId: header.id, ceSessionId: mapping.sessionId, participantId: mapping.participantId,
    policySequence: snapshot.sequence, policyDigest: snapshot.digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(await resolveRuntime(config)));
  } catch { process.stderr.write('RUNTIME_AUTHORITY_DENIED\n'); process.exitCode = 1; }
}
