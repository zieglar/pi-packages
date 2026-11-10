import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeInbound } from '../../../pi-extension/native-inbound.js';

const incoming = `msg_${'A'.repeat(26)}`;
const request = `msg_${'B'.repeat(26)}`;
const outgoing = `msg_${'C'.repeat(26)}`;
const association = { kind: 'FEEDBACK' as const, messageId: incoming, requestMessageId: request, outgoingMessageId: outgoing,
  probeId: '12345678-1234-4234-8234-123456789abc', outcomeHint: 'MATCH' as const };
const terminal = { kind: 'TERMINAL' as const, messageId: incoming, requestMessageId: request, outgoingMessageId: outgoing,
  probeId: association.probeId, outcome: 'MATCH' as const, status: 'RECORDED' as const, suppressOrdinaryReply: true as const };
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), 'ce-feedback-')); roots.push(root);
  const policyPath = join(root, 'native.json');
  const policy = { version: 1, enabled: true, runtimeSessionId: 'session-A', endpointId: 'pi/A', exchangeId: 'ex-1', from: 'chatgpt/main',
    activatedAt: '2026-11-06T12:00:00Z', afterAuditSequence: 100, maxAgeSeconds: 300 };
  fs.writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
  const text = JSON.stringify({ protocol: 'ce.task-owner-feedback.v1', outcome: 'MATCH', privateBody: 'must never reach Agent' });
  const metadata = { messageId: incoming, exchangeId: 'ex-1', from: 'chatgpt/main', to: 'pi/A', createdAt: '2026-11-06T12:00:01Z',
    auditSequence: 101, payloadLength: Buffer.byteLength(text), payloadDigest: createHash('sha256').update(text).digest('hex') };
  const entries: Array<Record<string, unknown>> = [];
  const append = vi.fn((customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); });
  const wake = vi.fn(), controlWake = vi.fn();
  const classify = vi.fn((_metadata: unknown): unknown => association);
  const consume = vi.fn(async (_input: unknown): Promise<unknown> => terminal);
  const executeTool = vi.fn(async (name: string) => ({ toolCall: { type: 'toolCall' as const, id: 'nested', name, arguments: {} }, isError: false,
    result: { content: name === 'ce_read_payload' ? [{ type: 'text' as const, text: 'untrusted' }, { type: 'text' as const, text }] : [], details: metadata } }));
  const create = (enabled = true) => {
    const options = { policyPath, runtimeSessionId: 'session-A', endpointId: 'pi/A', getSessionId: () => 'session-A', getEntries: () => entries,
      append, listInbox: () => ({ messages: [{ messageId: incoming, auditSequence: 101 }], continuationAuditSequence: 101, scanBudgetExhausted: false }),
      readMetadata: () => metadata, wake, controlWake, ...(enabled ? { feedback: { classify, consume } } : {}), now: () => Date.parse('2026-11-06T12:00:01Z') };
    // The unimplemented optional port is intentionally exercised before production changes.
    return createNativeInbound(options as Parameters<typeof createNativeInbound>[0]);
  };
  return { policyPath, metadata, text, entries, append, wake, controlWake, classify, consume, executeTool, create };
}
it('exposes the loaded feedback protocol capability for reload verification', () => {
  const f = fixture(); expect(f.create()).toHaveProperty('feedbackProtocolVersion', 1);
});


it('classifies validated metadata before a dedicated append-before-effect control wake', () => {
  const f = fixture(); const c = f.create(); c.poll(); c.poll();
  expect(f.classify).toHaveBeenCalledExactlyOnceWith(f.metadata);
  expect(f.wake).not.toHaveBeenCalled(); expect(f.controlWake).toHaveBeenCalledTimes(1);
  expect(f.entries[0]).toMatchObject({ customType: 'ce-inbound-feedback', data: { association, metadata: f.metadata } });
  expect(f.append.mock.invocationCallOrder[0]).toBeLessThan(f.controlWake.mock.invocationCallOrder[0]!);
  expect(JSON.stringify(f.entries)).not.toContain(f.text);
});
it.each([false, true])('ordinary metadata stays an ordinary task when feedback opted in=%s', async enabled => {
  const f = fixture(); f.classify.mockReturnValue({ kind: 'NONE' }); const c = f.create(enabled); c.poll();
  expect(f.wake).toHaveBeenCalledTimes(1); expect(f.controlWake).not.toHaveBeenCalled();
  expect(await c.receive(incoming, { executeTool: f.executeTool })).toMatchObject({ text: f.text });
  expect(f.consume).not.toHaveBeenCalled();
});
it('BLOCKED persists one deny-only record, denies receive and never wakes', async () => {
  const f = fixture(); f.classify.mockReturnValue({ kind: 'BLOCKED', reason: 'FEEDBACK_PROBE_UNVERIFIED' }); const c = f.create(); c.poll(); f.create().poll();
  expect(f.classify).toHaveBeenCalledTimes(1); expect(f.entries).toHaveLength(1);
  expect(f.entries[0]).toMatchObject({ customType: 'ce-inbound-feedback-blocked', data: { messageId: incoming, reason: 'FEEDBACK_PROBE_UNVERIFIED' } });
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_FEEDBACK_BLOCKED');
  expect(f.wake).not.toHaveBeenCalled(); expect(f.controlWake).not.toHaveBeenCalled(); expect(f.executeTool).not.toHaveBeenCalled();
  expect(c.canPrepareDesktopReply(incoming)).toBe(false);
});
it('registered payload checks precede RETURNED and consume, and only terminal metadata is returned', async () => {
  const f = fixture(); const c = f.create(); c.poll();
  f.consume.mockImplementation(async input => {
    expect(input).toEqual({ metadata: f.metadata, association, text: f.text });
    expect(f.entries.at(-1)).toMatchObject({ customType: 'ce-inbound-receive', data: { status: 'RETURNED' } });
    return terminal;
  });
  const result = await c.receive(incoming, { executeTool: f.executeTool });
  expect(result).toEqual(terminal); expect(JSON.stringify(result)).not.toContain(f.text);
  expect(f.executeTool.mock.calls.map(call => call[0])).toEqual(['ce_read', 'ce_read_payload']);
  expect(f.entries.at(-1)).toMatchObject({ customType: 'ce-inbound-feedback-result', data: terminal });
  expect(c.canPrepareDesktopReply(incoming)).toBe(false);
  await expect(f.create().receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_ALREADY_ATTEMPTED');
  f.create().poll(); expect(f.controlWake).toHaveBeenCalledTimes(1); expect(f.consume).toHaveBeenCalledTimes(1);
});
it.each(['ce_read', 'ce_read_payload'])('permission refusal at %s prevents consume permanently', async refused => {
  const f = fixture(); const c = f.create(); c.poll();
  const allowed = f.executeTool.getMockImplementation()!;
  f.executeTool.mockImplementation(async name => name === refused ? Promise.reject(Error('refused')) : allowed(name));
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_READ_REFUSED');
  expect(f.consume).not.toHaveBeenCalled();
  await expect(f.create().receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_ALREADY_ATTEMPTED');
});
it('a digest mismatch prevents consume and cannot expose text', async () => {
  const f = fixture(); const c = f.create(); c.poll();
  const allowed = f.executeTool.getMockImplementation()!;
  f.executeTool.mockImplementation(async name => { const result = await allowed(name); if (name === 'ce_read_payload') result.result.content[1]!.text += 'tampered'; return result; });
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_PAYLOAD_MISMATCH');
  expect(f.consume).not.toHaveBeenCalled();
});
it('UNKNOWN and invalid bodies can be consumed only as terminal UNVERIFIED metadata', async () => {
  const f = fixture(); f.classify.mockReturnValue({ ...association, outcomeHint: 'UNKNOWN' });
  f.consume.mockResolvedValue({ ...terminal, outcome: 'UNVERIFIED', status: 'UNVERIFIED' });
  const c = f.create(); c.poll();
  expect(await c.receive(incoming, { executeTool: f.executeTool })).toEqual({ ...terminal, outcome: 'UNVERIFIED', status: 'UNVERIFIED' });
});
it.each(['transport', 'unknown-result', 'text-in-result', 'wrong-correlation'])('consume %s uncertainty is terminal and never falls back', async mode => {
  const f = fixture(); const c = f.create(); c.poll();
  if (mode === 'transport') f.consume.mockRejectedValue(Error(f.text));
  else f.consume.mockResolvedValue(mode === 'unknown-result' ? { kind: 'OTHER' } : mode === 'text-in-result' ? { ...terminal, text: f.text } : { ...terminal, probeId: 'another' });
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_FEEDBACK_UNAVAILABLE');
  await expect(f.create().receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_ALREADY_ATTEMPTED');
  expect(f.consume).toHaveBeenCalledTimes(1); expect(f.wake).not.toHaveBeenCalled();
  expect(JSON.stringify(f.entries)).not.toContain(f.text);
});
it('classifier failure stops before an ordinary wake and does not disclose diagnostics', () => {
  const f = fixture(); f.classify.mockImplementation(() => { throw Error(f.text); });
  expect(() => f.create().poll()).toThrow('INBOUND_FEEDBACK_UNAVAILABLE'); expect(f.wake).not.toHaveBeenCalled(); expect(f.controlWake).not.toHaveBeenCalled();
});
it('failed append and uncertain control delivery never trigger an ordinary fallback', () => {
  const f = fixture(); f.append.mockImplementationOnce(() => { throw Error('disk'); });
  expect(() => f.create().poll()).toThrow(); expect(f.controlWake).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled();
  f.controlWake.mockImplementation(() => { throw Error('unknown delivery'); });
  expect(() => f.create().poll()).toThrow('INBOUND_FEEDBACK_UNAVAILABLE'); f.create().poll();
  expect(f.controlWake).toHaveBeenCalledTimes(1); expect(f.wake).not.toHaveBeenCalled();
});
it('a result marker anywhere in full history denies receive even before a claim marker', async () => {
  const f = fixture(); f.entries.push({ type: 'custom', customType: 'ce-inbound-feedback-result', data: terminal });
  f.entries.push({ type: 'custom', customType: 'ce-inbound-feedback', data: { version: 1, runtimeSessionId: 'session-A', endpointId: 'pi/A',
    policyDigest: 'ignored', messageId: incoming, auditSequence: 101, admittedAt: Date.parse('2026-11-06T12:00:01Z'), metadata: f.metadata, association } });
  const c = f.create(); c.poll(); expect(f.controlWake).not.toHaveBeenCalled();
  expect(c.canPrepareDesktopReply(incoming)).toBe(false);
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_ALREADY_ATTEMPTED'); expect(f.consume).not.toHaveBeenCalled();
});
it.each([
  { ...association, probeId: undefined }, { ...association, messageId: request }, { ...association, outcomeHint: 'SUCCESS' }, { kind: 'NONE', text: 'private' },
])('invalid feedback classification never falls through: %j', value => {
  const f = fixture(); f.classify.mockReturnValue(value);
  expect(() => f.create().poll()).toThrow('INBOUND_FEEDBACK_UNAVAILABLE');
  expect(f.wake).not.toHaveBeenCalled(); expect(f.controlWake).not.toHaveBeenCalled();
});
it.each([{ exchangeId: 'other' }, { from: 'chatgpt/other' }, { to: 'pi/B' }])('source and policy scope validation precede classification: %j', patch => {
  const f = fixture(); Object.assign(f.metadata, patch); f.create().poll();
  expect(f.classify).not.toHaveBeenCalled(); expect(f.wake).not.toHaveBeenCalled(); expect(f.controlWake).not.toHaveBeenCalled();
});
it('a failed terminal result append cannot replay consume or permit desktop preparation', async () => {
  const f = fixture(); const c = f.create(); c.poll();
  const append = f.append.getMockImplementation()!;
  f.append.mockImplementation((kind, data) => { if (kind === 'ce-inbound-feedback-result') throw Error('disk'); append(kind, data); });
  await expect(c.receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_READ_UNKNOWN');
  expect(c.canPrepareDesktopReply(incoming)).toBe(false);
  await expect(f.create().receive(incoming, { executeTool: f.executeTool })).rejects.toThrow('INBOUND_ALREADY_ATTEMPTED');
  expect(f.consume).toHaveBeenCalledTimes(1); expect(JSON.stringify(f.entries)).not.toContain(f.text);
});
