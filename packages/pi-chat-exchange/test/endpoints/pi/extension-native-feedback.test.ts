import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { OwnershipFeedbackPort } from '../../../pi-extension/ownership-feedback.js';
import type { createNativeInbound } from '../../../pi-extension/native-inbound.js';

const fake = vi.hoisted(() => ({ begin: vi.fn(), renew: vi.fn(), end: vi.fn(), list: vi.fn(), read: vi.fn(), open: vi.fn(),
  bridge: vi.fn(), capture: vi.fn(), prepare: vi.fn(), nativeOptions: undefined as unknown, controlInput: undefined as unknown, legacyController: false, forbidden: vi.fn(() => { throw Error('FORBIDDEN subprocess'); }) }));
vi.mock('node:child_process', () => ({ execFile: fake.forbidden, execFileSync: fake.forbidden, spawn: fake.forbidden }));
vi.mock('../../../pi-extension/ownership-feedback.js', async original => ({ ...await original<typeof import('../../../pi-extension/ownership-feedback.js')>(), createOwnershipFeedbackBridge: fake.bridge }));
vi.mock('../../../pi-extension/native-inbound.js', async original => {
  const actual = await original<typeof import('../../../pi-extension/native-inbound.js')>();
  return { ...actual, createNativeInbound: (options: Parameters<typeof createNativeInbound>[0]) => {
    const wrapped = { ...options, controlWake: (input: Parameters<NonNullable<typeof options.controlWake>>[0]) => { fake.controlInput = input; options.controlWake!(input); } };
    fake.nativeOptions = wrapped;
    const controller = actual.createNativeInbound(wrapped);
    if (fake.legacyController) delete (controller as { feedbackProtocolVersion?: number }).feedbackProtocolVersion;
    return controller;
  } };
});
vi.mock('../../../pi-extension/desktop-target.js', async original => ({ ...await original<typeof import('../../../pi-extension/desktop-target.js')>(),
  createDesktopTargetBridge: () => ({ ready: {}, capture: fake.capture, prepare: fake.prepare }) }));
vi.mock('../../../dist/endpoints/pi/session-host.js', () => ({
  CeHostRefusal: class extends Error { constructor(readonly code: string) { super('host refusal'); } },
  CeSessionHost: class { beginSession = fake.begin; renew = fake.renew; end = fake.end; listInbox = fake.list; readMetadata = fake.read;
    drop() {} status() { return { registered: true, participantId: 'prt_test', sessionId: 'ses_test', exchangeId: 'ex-1' }; } },
}));
vi.mock('../../../dist/storage/store.js', () => ({ openStore: fake.open, initializeStore: fake.open }));
const incoming = `msg_${'A'.repeat(26)}`, request = `msg_${'B'.repeat(26)}`, outgoing = `msg_${'C'.repeat(26)}`;
const association = { kind: 'FEEDBACK' as const, messageId: incoming, requestMessageId: request, outgoingMessageId: outgoing,
  probeId: '12345678-1234-4234-8234-123456789abc', outcomeHint: 'MATCH' as const };
const terminal = { kind: 'TERMINAL' as const, messageId: incoming, requestMessageId: request, outgoingMessageId: outgoing,
  probeId: association.probeId, outcome: 'MATCH' as const, status: 'RECORDED' as const, suppressOrdinaryReply: true as const };
type Result = { content: Array<{ type: 'text'; text: string }>; details?: unknown; isError?: boolean; terminate?: boolean };
type Tool = { name: string; reachesTools?: () => string[]; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<Result> };
const roots: string[] = [], shutdowns: Array<() => Promise<void>> = [];
beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('CE_')) vi.stubEnv(key, undefined);
  fake.legacyController = false;
  vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-11-06T12:00:01Z'));
  fake.begin.mockImplementation((endpointId: string) => ({ endpointId, participantId: 'prt_test', sessionId: 'ses_test', exchangeId: 'ex-1' }));
  fake.renew.mockReturnValue({ fencingToken: 1, expiresAt: '2026-11-06T12:02:00Z' }); fake.end.mockReturnValue({ released: true, detached: true });
  fake.open.mockReturnValue({ close: vi.fn() }); fake.capture.mockResolvedValue({ status: 'CAPTURED', messageId: incoming });
});
afterEach(async () => {
  for (const stop of shutdowns.splice(0)) await stop();
  expect(fake.forbidden).not.toHaveBeenCalled(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(classification: unknown = association, options: { absent?: boolean; invalid?: boolean } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ce-extension-feedback-'))); roots.push(root);
  const session = '12345678-1234-4234-8234-123456789abc'; const policyPath = join(root, 'native.json');
  const allowlist = { sessions: { [session]: { endpointId: 'pi/A' } }, store: { directory: root, file: 'ce-store.sqlite' }, payloadRead: { enabled: true } };
  const allowlistPath = join(root, 'allowlist.json'); fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  vi.stubEnv('CE_ALLOWLIST', allowlistPath); vi.stubEnv('CE_NATIVE_INBOUND_POLICY', policyPath);
  fs.writeFileSync(policyPath, JSON.stringify({ version: 1, enabled: true, runtimeSessionId: session, endpointId: 'pi/A', exchangeId: 'ex-1', from: 'chatgpt/main',
    activatedAt: '2026-11-06T12:00:00Z', afterAuditSequence: 100, maxAgeSeconds: 300 }), { mode: 0o600 });
  const text = 'PRIVATE_CONTROL_BODY_SENTINEL';
  const metadata = { messageId: incoming, exchangeId: 'ex-1', from: 'chatgpt/main', to: 'pi/A', payloadDigest: createHash('sha256').update(text).digest('hex'),
    payloadLength: Buffer.byteLength(text), auditSequence: 101, createdAt: '2026-11-06T12:00:01Z' };
  fake.list.mockReturnValue({ messages: [{ messageId: incoming, auditSequence: 101 }], continuationAuditSequence: 101, scanBudgetExhausted: false });
  fake.read.mockReturnValue(metadata);
  const classify = vi.fn(() => classification), consume = vi.fn(async () => terminal);
  if (options.invalid) fake.bridge.mockImplementation(() => { throw Error('INBOUND_FEEDBACK_UNAVAILABLE'); });
  else fake.bridge.mockReturnValue(options.absent ? undefined : { classify, consume } as unknown as OwnershipFeedbackPort);
  if (!options.absent) fs.writeFileSync(`${policyPath}.task-ownership.json`, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  const entries: Array<Record<string, unknown>> = [], tools: Tool[] = [];
  const events = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
  const sendMessage = vi.fn();
  const { default: extension } = await import('../../../pi-extension/index.js');
  extension({ on: (event: string, fn: (event: unknown, ctx: unknown) => Promise<void>) => events.set(event, fn), registerTool: (tool: Tool) => tools.push(tool), registerCommand: vi.fn(),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data }), sendMessage } as any);
  let actualSession = session;
  const executeTool = vi.fn(async (name: string) => ({ toolCall: { type: 'toolCall' as const, id: 'nested', name, arguments: {} }, isError: false,
    result: { details: metadata, content: name === 'ce_read_payload' ? [{ type: 'text', text: 'untrusted' }, { type: 'text', text }] : [] } }));
  const ctx = { mode: 'interactive', hasUI: false, cwd: root, executeTool, sessionManager: { getSessionId: () => actualSession, getSessionFile: () => undefined,
    getBranch: () => [], getEntries: () => entries }, ui: { notify: vi.fn() } };
  await events.get('session_start')!({ reason: 'startup' }, ctx);
  shutdowns.push(() => events.get('session_shutdown')!({ reason: 'quit' }, ctx));
  const tool = tools.find(tool => tool.name === 'ce_receive_task')!;
  return { root, session, policyPath, entries, tools, sendMessage, consume, classify, tool, ctx, text,
    switchSession: () => { actualSession = 'different'; }, receive: () => tool.execute('receive', { messageId: incoming }, undefined, undefined, ctx) };
}
it('wires the fixed allowlist DB and dispatches dedicated control without desktop capture or ordinary instructions', async () => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(1000);
  expect(fake.bridge).toHaveBeenCalledWith(expect.objectContaining({ policyPath: f.policyPath, databasePath: join(f.root, 'ce-store.sqlite'), runtimeSessionId: f.session, endpointId: 'pi/A' }));
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
  const [message, options] = f.sendMessage.mock.calls[0]!;
  expect(message.customType).toBe('ce-inbound-feedback-request'); expect(options).toEqual({ triggerTurn: true, deliverAs: 'followUp' });
  expect(message.content).toContain(`ce_receive_task`); expect(message.content).toContain(incoming);
  expect(message.content).not.toContain('ce_send'); expect(message.content).not.toContain('ce_prepare_desktop_reply');
  expect(fake.capture).not.toHaveBeenCalled(); expect(fake.prepare).not.toHaveBeenCalled();
});
it('returns only terminal metadata with Pi skip-follow-up semantics and keeps the registered read tool closure', async () => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(1000);
  const result = await f.receive(); expect(result).toMatchObject({ details: terminal, terminate: true });
  expect(JSON.stringify(result)).not.toContain(f.text); expect(f.tool.reachesTools!()).toEqual(['ce_read', 'ce_read_payload']);
  expect(f.consume).toHaveBeenCalledTimes(1); expect(fake.capture).not.toHaveBeenCalled();
});
it('BLOCKED never asks the Agent to run any task and cannot prepare a desktop reply', async () => {
  const f = await fixture({ kind: 'BLOCKED', reason: 'FEEDBACK_PROBE_UNVERIFIED' }); await vi.advanceTimersByTimeAsync(1000);
  expect(f.sendMessage).not.toHaveBeenCalled(); expect(fake.capture).not.toHaveBeenCalled();
  expect((await f.receive()).isError).toBe(true);
  const prepare = f.tools.find(tool => tool.name === 'ce_prepare_desktop_reply')!;
  expect((await prepare.execute('prepare', { messageId: incoming, taskId: 'untrusted' }, undefined, undefined, f.ctx)).isError).toBe(true);
  expect(fake.prepare).not.toHaveBeenCalled();
});
it.each(['read-refused', 'consume-unknown', 'controller-closed'])('a known control refusal %s still terminates the follow-up', async kind => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(1000);
  if (kind === 'read-refused') f.ctx.executeTool.mockRejectedValueOnce(new Error('private read refusal'));
  if (kind === 'consume-unknown') f.consume.mockRejectedValueOnce(new Error('private consume uncertainty'));
  if (kind === 'controller-closed') { fs.unlinkSync(f.policyPath); await vi.advanceTimersByTimeAsync(1000); }
  const result = await f.receive();
  expect(result).toMatchObject({ isError: true, terminate: true, details: { suppressOrdinaryReply: true } });
  expect(JSON.stringify(result)).not.toContain(f.text);
  expect(JSON.stringify(result)).not.toContain('private');
});
it.each(['policy', 'generation'])('dedicated delivery checks current %s authority again', async changed => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(1000);
  const options = fake.nativeOptions as Parameters<typeof createNativeInbound>[0];
  const args = fake.controlInput as Parameters<NonNullable<typeof options.controlWake>>[0];
  expect(args.messageId).toBe(incoming);
  if (changed === 'policy') fs.unlinkSync(f.policyPath); else f.switchSession();
  expect(() => options.controlWake!(args)).toThrow(); expect(f.sendMessage).toHaveBeenCalledTimes(1);
});
it('no sidecar preserves ordinary wake, capture and nonterminating task text', async () => {
  const f = await fixture({ kind: 'NONE' }, { absent: true }); await vi.advanceTimersByTimeAsync(1000);
  expect(fake.capture).toHaveBeenCalledTimes(1);
  const result = await f.receive(); expect(JSON.stringify(result)).toContain(f.text); expect(result.terminate).toBeUndefined();
});

it('records current loaded feedback capability separately from E2E readiness', async () => {
  const f = await fixture();
  const ready = f.entries.filter(entry => entry.customType === 'ce-inbound-feedback-ready');
  expect(ready).toHaveLength(1);
  expect(ready[0]!.data).toMatchObject({ version: 1, protocol: 'ce.task-owner-feedback.v1',
    readiness: 'DISPATCH_LOADED_NOT_E2E', runtimeSessionId: f.session, endpointId: 'pi/A', pid: process.pid,
    observedAt: Date.now(), sidecarSha256: createHash('sha256').update(fs.readFileSync(`${f.policyPath}.task-ownership.json`)).digest('hex'),
    sourceSha256: { index: expect.stringMatching(/^[0-9a-f]{64}$/), native: expect.stringMatching(/^[0-9a-f]{64}$/), bridge: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  expect(f.classify).not.toHaveBeenCalled(); expect(f.consume).not.toHaveBeenCalled();
  expect(f.sendMessage).not.toHaveBeenCalled();
});
it('does not claim loaded feedback when the sidecar is absent', async () => {
  const f = await fixture({ kind: 'NONE' }, { absent: true });
  expect(f.entries.some(entry => entry.customType === 'ce-inbound-feedback-ready')).toBe(false);
});
it('a cached old native controller with opt-in stops intake without a readiness claim', async () => {
  fake.legacyController = true;
  const f = await fixture({ kind: 'NONE' }); await vi.advanceTimersByTimeAsync(1000);
  expect(f.entries.some(entry => entry.customType === 'ce-inbound-feedback-ready')).toBe(false);
  expect(fake.list).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
});
it('invalid feedback opt-in stops intake before an ordinary fallback', async () => {
  const f = await fixture({ kind: 'NONE' }, { invalid: true }); await vi.advanceTimersByTimeAsync(1000);
  expect(f.entries.some(entry => entry.customType === 'ce-inbound-feedback-ready')).toBe(false);
  expect(fake.list).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled();
});
