import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CeHookRule } from '../../../src/hooks/config.js';
import { createCaptureScheduler, createDeliveryGuard, createDesktopTargetBridge, deliverAfterDesktopCapture } from '../../../pi-extension/desktop-target.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ce-target-'))); roots.push(root);
  const config = join(root, 'config.json');
  const auto = join(root, 'auto-wake.json');
  writeFileSync(config, JSON.stringify({ autoWakeConfig: auto }), { mode: 0o600 });
  writeFileSync(auto, JSON.stringify({ ownerDirectory: root, conversationGuard: { targetSelection: 'desktop-at-intake', captureAfterAuditSequence: 10, mode: 'explicit-only' } }), { mode: 0o600 });
  const hook: { -readonly [K in keyof CeHookRule]: CeHookRule[K] } = { id: 'wake', enabled: true, event: 'ce.message.committed.v1', recipient: { adapter: 'chatgpt', endpointId: 'chatgpt/main' }, command: '/usr/bin/python3', args: ['-B', join(root, 'tools/ce-chatgpt-wake/wake.py'), '--config', config, '--hook'], timeoutMs: 30000 };
  const run = vi.fn(async () => ({ stdout: JSON.stringify({ status: 'CAPTURED', messageId: 'm' }) }));
  return { root, config, auto, hook, run, create: () => createDesktopTargetBridge({ hooks: [hook], runtimeSessionId: 's', endpointId: 'ep', run }) };
}
describe('desktop target bridge', () => {
  it('captures with bound argv, limited environment and execution limits', async () => {
    const f = fixture(); const bridge = f.create()!;
    expect(bridge.ready).toEqual({ runtimeSessionId: 's', endpointId: 'ep', captureAfterAuditSequence: 10 });
    expect(await bridge.capture({ messageId: 'm', auditSequence: 11 })).toEqual({ status: 'CAPTURED', messageId: 'm' });
    const [command, args, options] = f.run.mock.calls[0] as unknown as [string, string[], any];
    expect(command).toBe('/usr/bin/python3');
    expect(args).toEqual(['-B', join(f.root, 'tools/ce-chatgpt-wake/receipt_target.py'), '--config', f.config, '--session-id', 's', '--endpoint-id', 'ep', '--capture', 'm']);
    expect(options).toMatchObject({ timeout: 20000, maxBuffer: 16384, shell: false });
    expect(Object.keys(options.env).every(k => ['HOME', 'PATH', 'LANG'].includes(k))).toBe(true);
  });
  it('disables old observations without invoking Python', async () => {
    const f = fixture(); expect((await f.create()!.capture({ messageId: 'm', auditSequence: 10 })).status).toBe('DISABLED'); expect(f.run).not.toHaveBeenCalled();
  });
  it('requires explicit opt-in and private nofollow configs', () => {
    const f = fixture(); chmodSync(f.auto, 0o644); expect(f.create()).toBeUndefined(); chmodSync(f.auto, 0o600);
    writeFileSync(f.auto, JSON.stringify({ ownerDirectory: f.root })); expect(f.create()).toBeUndefined();
    rmSync(f.auto); symlinkSync(f.config, f.auto); expect(f.create()).toBeUndefined();
  });
  it('rejects ambiguity, unsafe commands and mismatched owner paths', () => {
    const f = fixture();
    expect(createDesktopTargetBridge({ hooks: [f.hook, f.hook], runtimeSessionId: 's', endpointId: 'ep' })).toBeUndefined();
    f.hook.args = [...f.hook.args, 'extra']; expect(f.create()).toBeUndefined();
    f.hook.args = ['-B', '/elsewhere/tools/ce-chatgpt-wake/wake.py', '--config', f.config, '--hook']; expect(f.create()).toBeUndefined();
    f.hook.command = '/bin/sh'; expect(f.create()).toBeUndefined();
  });
  it('rejects unknown output and mismatched prepare identities', async () => {
    const f = fixture(); f.run.mockResolvedValue({ stdout: '{"status":"OTHER","messageId":"m"}' });
    expect((await f.create()!.capture({ messageId: 'm', auditSequence: 11 })).status).toBe('UNAVAILABLE');
    const key = `ce-desktop-${'a'.repeat(64)}`;
    f.run.mockResolvedValue({ stdout: JSON.stringify({ status: 'PREPARED', messageId: 'm', taskId: 'wrong', idempotencyKey: key }) });
    expect((await f.create()!.prepare({ messageId: 'm', taskId: 't' })).status).toBe('UNAVAILABLE');
    f.run.mockResolvedValue({ stdout: JSON.stringify({ status: 'PREPARED', messageId: 'm', taskId: 't', idempotencyKey: 'caller-chosen' }) });
    expect((await f.create()!.prepare({ messageId: 'm', taskId: 't' })).status).toBe('UNAVAILABLE');
    f.run.mockResolvedValue({ stdout: JSON.stringify({ status: 'PREPARED', messageId: 'm', taskId: 't', idempotencyKey: key }) });
    expect(await f.create()!.prepare({ messageId: 'm', taskId: 't' })).toMatchObject({ status: 'PREPARED', idempotencyKey: key });
    expect((f.run.mock.calls.at(-1) as unknown as any[])[1].slice(-4)).toEqual(['--prepare-reply', 'm', '--task-id', 't']);
  });
  it('rejects malformed, oversized, foreign-message and title-bearing output', async () => {
    const f = fixture();
    for (const stdout of ['not json', 'x'.repeat(16385), JSON.stringify({ status: 'CAPTURED', messageId: 'other' }), JSON.stringify({ status: 'CAPTURED', messageId: 'm', title: 'untrusted' })]) {
      f.run.mockResolvedValue({ stdout });
      expect((await f.create()!.capture({ messageId: 'm', auditSequence: 11 })).status).toBe('UNAVAILABLE');
    }
    f.run.mockResolvedValue({ stdout: JSON.stringify({ status: 'DISABLED', messageId: 'm', reason: 'secret arbitrary text' }) });
    expect(await f.create()!.capture({ messageId: 'm', auditSequence: 11 })).toEqual({ status: 'DISABLED', messageId: 'm', reason: 'disabled' });
  });
  it('requires private outer config, exact pointer, valid cutoff and runtime IDs', () => {
    const f = fixture(); chmodSync(f.config, 0o644); expect(f.create()).toBeUndefined(); chmodSync(f.config, 0o600);
    writeFileSync(f.config, JSON.stringify({ autoWakeConfig: join(f.root, 'elsewhere.json') })); expect(f.create()).toBeUndefined();
    writeFileSync(f.config, JSON.stringify({ autoWakeConfig: f.auto }));
    writeFileSync(f.auto, JSON.stringify({ ownerDirectory: f.root, conversationGuard: { targetSelection: 'desktop-at-intake', captureAfterAuditSequence: 1.5 } })); expect(f.create()).toBeUndefined();
    expect(createDesktopTargetBridge({ hooks: [f.hook], runtimeSessionId: '', endpointId: 'ep' })).toBeUndefined();
    f.hook.enabled = false; expect(f.create()).toBeUndefined();
  });
  it('rechecks generation after recording and tolerates record failure', async () => {
    let current = true; const deliver = vi.fn();
    const outcome = Promise.resolve({ status: 'CAPTURED' as const, messageId: 'm' });
    await deliverAfterDesktopCapture(outcome, () => current, deliver, () => { current = false; });
    expect(deliver).not.toHaveBeenCalled();
    await deliverAfterDesktopCapture(outcome, () => true, deliver, () => { throw new Error('record failed'); });
    expect(deliver).toHaveBeenCalledOnce();
  });
  it('preserves only known capture refusal reasons from the helper', async () => {
    const f = fixture(); const bridge = f.create()!;
    for (const reason of ['CAPTURE_LOCK_BUSY', 'CAPTURE_TOO_LATE', 'private credential detail']) {
      f.run.mockResolvedValue({ stdout: JSON.stringify({ status: 'UNAVAILABLE', messageId: 'm', reason }) });
      expect((await bridge.capture({ messageId: 'm', auditSequence: 11 })).reason).toBe(reason.startsWith('CAPTURE_') ? reason : 'unavailable');
    }
  });
  it('bounds pending captures and releases expired tasks without sampling later', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = createCaptureScheduler({ maxPending: 2, maxWaitMs: 100 });
      let release!: () => void;
      const first = scheduler.run('a', async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 'CAPTURED', messageId: 'a' }; });
      const capture = vi.fn(async () => ({ status: 'CAPTURED' as const, messageId: 'b' }));
      const second = scheduler.run('b', capture);
      expect(await scheduler.run('c', capture)).toMatchObject({ status: 'UNAVAILABLE', reason: 'CAPTURE_QUEUE_FULL' });
      await vi.advanceTimersByTimeAsync(101);
      expect(await second).toMatchObject({ status: 'UNAVAILABLE', reason: 'CAPTURE_QUEUE_EXPIRED' });
      release(); await first; await Promise.resolve();
      expect(capture).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it('rejects elapsed queue deadlines before a delayed timer callback runs', async () => {
    const scheduler = createCaptureScheduler({ maxWaitMs: 10 });
    let release!: () => void;
    const first = scheduler.run('a', async () => { await new Promise<void>(resolve => { release = resolve; }); return { status: 'CAPTURED', messageId: 'a' }; });
    await Promise.resolve();
    const capture = vi.fn(async () => ({ status: 'CAPTURED' as const, messageId: 'b' }));
    const second = scheduler.run('b', capture);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30);
    release();
    await first;
    expect(await second).toMatchObject({ status: 'UNAVAILABLE', reason: 'CAPTURE_QUEUE_EXPIRED' });
    expect(capture).not.toHaveBeenCalled();
  });
  it('serializes same-batch captures so no message loses its target', async () => {
    const scheduler = createCaptureScheduler(); const order: string[] = [];
    let release: (() => void) | undefined;
    const first = scheduler.run('a', async () => { order.push('first:start'); await new Promise<void>(resolve => { release = resolve; }); order.push('first:end'); return { status: 'CAPTURED' as const, messageId: 'a' }; });
    const second = scheduler.run('b', async () => { order.push('second:start'); return { status: 'CAPTURED' as const, messageId: 'b' }; });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release!();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });
  it('reports skipped after an asynchronous record revokes authorization', async () => {
    let current = true; const deliver = vi.fn(); const skipped = vi.fn();
    await deliverAfterDesktopCapture(Promise.resolve({ status: 'CAPTURED', messageId: 'm' }), () => current, deliver,
      async () => { await Promise.resolve(); current = false; }, skipped);
    expect(deliver).not.toHaveBeenCalled(); expect(skipped).toHaveBeenCalledOnce();
  });
  it('guards delivery against a revoked or replaced inbound policy', () => {
    const allowed = createDeliveryGuard({ isCurrent: () => true, isAuthorized: () => true });
    expect(allowed()).toBe(true);
    expect(createDeliveryGuard({ isCurrent: () => true, isAuthorized: () => false })()).toBe(false);
    expect(createDeliveryGuard({ isCurrent: () => false, isAuthorized: () => true })()).toBe(false);
    expect(createDeliveryGuard({ isCurrent: () => { throw new Error("policy invalid"); }, isAuthorized: () => true })()).toBe(false);
    expect(createDeliveryGuard({ isCurrent: () => true, isAuthorized: () => { throw new Error("session changed"); } })()).toBe(false);
  });
  it('reports a skipped delivery when authority is revoked during capture', async () => {
    const deliver = vi.fn(); const skipped = vi.fn();
    await deliverAfterDesktopCapture(Promise.resolve({ status: 'CAPTURED' as const, messageId: 'm' }), () => false, deliver, undefined, skipped);
    expect(deliver).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledOnce();
  });
  it('contains subprocess failures and still delivers only to current generation', async () => {
    const f = fixture(); f.run.mockRejectedValue(new Error('timeout credentials')); const result = f.create()!.capture({ messageId: 'm', auditSequence: 11 });
    expect((await result).status).toBe('UNAVAILABLE');
    const deliver = vi.fn(); await deliverAfterDesktopCapture(Promise.reject(new Error('failed')), () => true, deliver); expect(deliver).toHaveBeenCalledOnce();
    await deliverAfterDesktopCapture(result, () => false, deliver); expect(deliver).toHaveBeenCalledOnce();
  });
});
