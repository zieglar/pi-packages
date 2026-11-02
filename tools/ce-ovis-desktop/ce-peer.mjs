#!/usr/bin/env node
// Operator-driven real Pi Session tools; tool results confer no desktop authority.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {requireRunning, runDesktop} from './execution.mjs';
import {loadTasks, authorizeTask} from './tasks.mjs';

process.umask(0o077);
const [mode, configFile] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const root = config.runDirectory;
const ce = path.join(config.modules, '@zieglar/pi-chat-exchange');
const pi = path.join(config.modules, '@earendil-works/pi-coding-agent');
const load = (p) => import(pathToFileURL(p).href);
if (JSON.parse(fs.readFileSync(ce + '/package.json')).version !== '0.3.0' || JSON.parse(fs.readFileSync(pi + '/package.json')).version !== '1.3.0') throw Error('RUNTIME_VERSION_MISMATCH');
const tasks = loadTasks(config);
const write = (name, value, directory = root) => {
  const tmp = path.join(directory, name + '.tmp');
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try {fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  fs.renameSync(tmp, path.join(directory, name));
};
const {SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession} = await load(pi + '/dist/index.js');
const {readSelectedMultiSessionPolicy, parseMultiSessionManifest} = await load(ce + '/dist/tunnel/multi-session-policy.js');
const {parseTunnelProfile} = await load(ce + '/dist/tunnel/background-manager.js');
const {publishMessagingGeneration} = await load(ce + '/dist/tunnel/messaging-config.js');
const {buildTunnelMcpCommand} = await load(ce + '/dist/tunnel/profile.js');
const profile = path.join(root, 'tunnel.yaml');
if (mode === 'prepare') {
  if (fs.existsSync(path.join(root, 'publication.json'))) throw Error('PREPARATION_ALREADY_EXISTS');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  const original = fs.readFileSync(config.existingProfile, 'utf8');
  const facts = parseTunnelProfile(original);
  const old = readSelectedMultiSessionPolicy(config.existingProfile);
  const native = SessionManager.create(root, path.join(root, 'sessions'));
  native.appendMessage({role: 'user', content: 'Operator-authorized CE Ovis test session; execute only the fixed test task', timestamp: Date.now()});
  const runtimeSessionId = native.getSessionId();
  const endpointId = config.endpointId;
  const binding = {version: 1, store: {directory: path.join(root, 'store'), file: 'ce-store.sqlite'}, exchange: {namespace: 'ce-ovis-desktop-test', idempotencyKey: config.testId}, endpoint: old.config.endpoint, recipients: [{adapter: 'pi', endpointId}], payloadRead: {enabled: true}, ack: {enabled: true}, lease: {ttlSeconds: 120, renewIntervalSeconds: 30}, admissionPolicy: {kind: 'ce-multi-session-v1', profilePath: profile}};
  const manifest = parseMultiSessionManifest({kind: 'ce-multi-session-v1', version: 1, identity: {tunnelId: facts.tunnelId, organizationId: facts.organizationId ?? null}, store: binding.store, exchange: binding.exchange, chatgptEndpoint: binding.endpoint, mcp: {payloadRead: true, ack: true}, registrations: [{endpointId, runtimeSessionId, epoch: 1, status: 'active', payloadRead: true, ack: true}]});
  fs.mkdirSync(path.join(root, '.ce-bindings'), {mode: 0o700, recursive: true});
  const pair = publishMessagingGeneration(profile, binding, manifest, {credentialFile: facts.keyFile});
  if (pair.durability !== 'synced') throw Error('PREPARATION_DURABILITY_UNKNOWN');
  const command = buildTunnelMcpCommand({nodePath: process.execPath, scriptPath: ce + '/dist/bin/mcp-stdio.js', bindingPath: pair.bindingPath});
  let local = original.replace(/^(      command:[ ]*)"[^\n]*"([ ]*)$/m, (_line, prefix, suffix) => `${prefix}"${command}"${suffix}`);
  local = local.replace(/^(  url_file:[ ]*).*$/m, `$1"${root}/health.url"`);
  const copied = parseTunnelProfile(local);
  if (copied.tunnelId !== facts.tunnelId || copied.organizationId !== facts.organizationId || copied.keyFile !== facts.keyFile || copied.mcpCommand !== command || copied.urlFile !== root + '/health.url') throw Error('LOCAL_PROFILE_IDENTITY_MISMATCH');
  fs.writeFileSync(profile, local, {mode: 0o600});
  const selected = readSelectedMultiSessionPolicy(profile);
  if (selected.manifest.registrations[0].runtimeSessionId !== runtimeSessionId) throw Error('REGISTRATION_MISMATCH');
  write('publication.json', {sessionFile: native.getSessionFile(), runtimeSessionId, endpointId, chatgptEndpoint: binding.endpoint.endpointId, originalProfileSha256: createHash('sha256').update(original).digest('hex'), preparedAt: new Date().toISOString()});
  console.log(JSON.stringify({prepared: true, endpointId, sameExistingCloudIdentity: true, isolatedStore: true}));
} else if (mode === 'run') {
  const publication = JSON.parse(fs.readFileSync(path.join(root, 'publication.json')));
  const end = Date.parse(config.deadline);
  if (!Number.isFinite(end) || end <= Date.now() || end - Date.now() > 15 * 60_000) throw Error('BOUNDED_WINDOW_REQUIRED');
  let stop = false;
  const window = {root,end,stopped:()=>stop};
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {stop = true;});
  const settingsManager = SettingsManager.inMemory({extensions: [], packages: [], cacheWarming: {enabled: false}});
  const resourceLoader = new DefaultResourceLoader({cwd: root, agentDir: path.join(root, 'agent'), settingsManager, noExtensions: true, additionalExtensionPaths: [ce + '/pi-extension/index.ts'], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true});
  await resourceLoader.reload();
  if (resourceLoader.getExtensions().errors.length) throw Error('CE_EXTENSION_LOAD_FAILED');
  const sessionManager = SessionManager.open(publication.sessionFile);
  if (sessionManager.getBranch().some(entry => entry.customType === 'ce-messaging-released')) throw Error('SESSION_ENDED_PREPARE_A_NEW_WINDOW');
  const {session} = await createAgentSession({cwd: root, agentDir: path.join(root, 'agent'), sessionManager, settingsManager, resourceLoader, tools: []});
  const {wrapRegisteredTool} = await load(pi + '/dist/core/extensions/wrapper.js');
  let sequence = 0;
  async function call(name, args) {
    const tool = session.extensionRunner.getAllRegisteredTools().find(t => t.definition.name === name);
    if (!tool || !['ce_send', 'ce_inbox_list', 'ce_read_payload', 'ce_ack'].includes(name)) throw Error('CE_TOOL_UNAVAILABLE');
    const result = await wrapRegisteredTool(tool, session.extensionRunner).execute(config.testId + '/' + (++sequence), args, undefined, undefined);
    if (result.isError || result.details?.ok === false) {
      write('tool-refusal.json', {name, code: result.details?.code ?? 'UNKNOWN', reason: result.details?.reason ?? null});
      throw Error('CE_TOOL_REFUSED_' + name);
    }
    return result;
  }
  let cursor = 0;
  let nextTask = 0;
  for (const task of tasks) fs.mkdirSync(task.recordRoot, {recursive:true,mode:0o700});
  try {
    await session.bindExtensions({mode: 'rpc', onError: () => {stop = true;}});
    await call('ce_inbox_list', {afterAuditSequence: 0, pageSize: 1, rawScanLimit: 1});
    write('peer-ready.json', {endpointId: publication.endpointId, deadline: config.deadline, actualPiSession: true, ceVersion: '0.3.0', inboxAdmissionProven: true});
    while (!stop && Date.now() < end && !fs.existsSync(path.join(root, 'stop-request'))) {
      const inbox = (await call('ce_inbox_list', {afterAuditSequence: cursor, pageSize: 20, rawScanLimit: 200})).details;
      for (const message of inbox.messages ?? []) {
        requireRunning(window);
        const read = await call('ce_read_payload', {messageId: message.messageId});
        if (read.details.from !== publication.chatgptEndpoint) throw Error('UNEXPECTED_SENDER');
        const text = read.content[1]?.text;
        const authorized = authorizeTask(text, tasks);
        const task = JSON.parse(text);
        const attemptFile = path.join(authorized.recordRoot, 'result-send-attempt.json');
        if (fs.existsSync(attemptFile)) continue;
        if (tasks[nextTask]?.taskId !== task.taskId) throw Error('TASK_ORDER_DENIED');
        const ack = (await call('ce_ack', {messageId: read.details.messageId, payloadDigest: read.details.payloadDigest, payloadLength: read.details.payloadLength, messageCreatedAuditSequence: read.details.auditSequence})).details;
        write('received.json', {messageId: message.messageId, taskId: task.taskId, receipt: ack, receivedAt: new Date().toISOString(), ceReception: 'ACKED_RECEPTION_ONLY'}, authorized.recordRoot);
        // Keep CE lease renewal/event loop live while Ovis is responding.
        requireRunning(window);
        const output = await runDesktop({python:config.python,bridge:config.bridge,task:authorized,env:process.env,window});
        const desktop = JSON.parse(output);
        requireRunning(window);
        const result = {schemaVersion: 1, taskId: task.taskId, ceReception: 'ACKED_RECEPTION_ONLY', scriptState: desktop.scriptState, ovisState: desktop.ovisState, submission: desktop.submission, response: desktop.response ?? null, reason: desktop.reason ?? null, noAutomaticResubmit: true};
        requireRunning(window);
        fs.writeFileSync(attemptFile, JSON.stringify({taskId: task.taskId, idempotencyKey: task.taskId + ':result', at: new Date().toISOString()}), {flag: 'wx', mode: 0o600});
        const sent = (await call('ce_send', {to: publication.chatgptEndpoint, text: JSON.stringify(result), idempotencyKey: task.taskId + ':result'})).details;
        write('returned.json', {result, ceSend: sent, remoteReceipt: 'AWAITING_CHATGPT_ACK'}, authorized.recordRoot);
        if (desktop.scriptState !== 'FINISHED' || desktop.ovisState !== 'COMPLETED' || desktop.submission !== 'OBSERVED') throw Error('DESKTOP_NOT_COMPLETED_STOP_SEQUENCE');
        nextTask += 1;
      }
      cursor = inbox.continuationAuditSequence ?? cursor;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    write('peer-failure.json', {reason: error.message, noAutomaticReplay: true});
    process.exitCode = 1;
  } finally {
    await session.extensionRunner.emit({type: 'session_shutdown', reason: 'shutdown'});
    session.dispose();
    write('peer-closed.json', {closed: true, at: new Date().toISOString()});
  }
} else throw Error('usage: ce-peer.mjs prepare|run CONFIG');
