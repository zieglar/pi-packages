import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CeHookRule } from '../../../src/hooks/config.js';
import { createDesktopPluginActions } from '../../../pi-extension/desktop-plugin-actions.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ce-desktop-actions-'))); roots.push(root);
  const tools = join(root, 'tools/ce-chatgpt-wake'); mkdirSync(tools, { recursive: true });
  for (const name of ['wake.py', 'desktop_control.py']) writeFileSync(join(tools, name), '# test\n', { mode: 0o600 });
  writeFileSync(join(tools, 'status_probe.py'), '# test\n', { mode: 0o644 });
  const config = join(root, 'config.json'); const auto = join(root, 'auto-wake.json');
  writeFileSync(config, JSON.stringify({ autoWakeConfig: auto }), { mode: 0o600 });
  writeFileSync(auto, JSON.stringify({ ownerDirectory: root, conversationGuard: {
    targetSelection: 'desktop-at-intake', captureAfterAuditSequence: 10 } }), { mode: 0o600 });
  const hook: CeHookRule = { id: 'ce-agent-desktop-wake', enabled: true, scope: 'workspace',
    event: 'ce.message.committed.v1', recipient: { adapter: 'chatgpt', endpointId: 'chatgpt/main' },
    command: '/usr/bin/python3', args: ['-B', join(tools, 'wake.py'), '--config', config, '--hook'],
    timeoutMs: 30000, status: { label: 'Desktop', command: '/usr/bin/python3',
      args: ['-B', join(tools, 'status_probe.py'), '--config', auto], timeoutMs: 2000 } };
  const run = vi.fn(async (_command: string, args: readonly string[], _options?: unknown) => ({ stdout: args.at(-1) === 'list-pending'
    ? JSON.stringify({ state: 'READY', items: [] })
    : JSON.stringify({ state: 'READY', code: 'DESKTOP_RUNTIME_READY', messageSubmitted: false,
        phases: { initial: 'EMPTY', write: 'ATTEMPTED', readback: 'EXACT', cleanup: 'OBSERVED_EMPTY' } }) }));
  const create = () => createDesktopPluginActions({ hooks: [hook], runtimeSessionId: 'session-1',
    endpointId: 'pi/session-1', epoch: 2, hookGeneration: 4, run });
  return { root, tools, config, auto, hook, run, create };
}

describe('desktop plugin actions', () => {
  it('pins every action to the exact current Session registration', async () => {
    const f = fixture(); const actions = f.create()!;
    expect(await actions.listPending()).toEqual([]);
    const [, args, rawOptions] = f.run.mock.calls[0]!;
    const options = rawOptions as { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number; shell: false };
    expect(args).toEqual(['-B', join(f.tools, 'desktop_control.py'), '--config', f.auto,
      '--runtime-session-id', 'session-1', '--endpoint-id', 'pi/session-1', '--epoch', '2',
      '--hook-generation', '4', 'list-pending']);
    expect(options).toMatchObject({ timeout: 20000, maxBuffer: 32768, shell: false });
    if (process.env.TMPDIR !== undefined) expect(options.env).toMatchObject({ TMPDIR: process.env.TMPDIR });
  });

  it('runs a non-submitting readiness test and validates the result', async () => {
    const f = fixture();
    expect(await f.create()!.testReadiness()).toMatchObject({ state: 'READY',
      code: 'DESKTOP_RUNTIME_READY', messageSubmitted: false });
    expect((f.run.mock.calls[0]![1] as readonly string[]).at(-1)).toBe('readiness-test');
    f.run.mockResolvedValue({ stdout: JSON.stringify({ state: 'READY', code: 'DESKTOP_RUNTIME_READY',
      messageSubmitted: true, phases: {} }) });
    expect((await f.create()!.testReadiness()).state).toBe('UNKNOWN');
  });

  it('reads the non-mutating current-Session Desktop action status', async () => {
    const f = fixture(); f.run.mockResolvedValue({ stdout: JSON.stringify({
      state: 'DEGRADED', code: 'COMPOSER_CLEANUP_UNKNOWN' }) });
    expect(await f.create()!.status()).toEqual({ state: 'DEGRADED',
      code: 'COMPOSER_CLEANUP_UNKNOWN', messageSubmitted: false, phases: {} });
    expect((f.run.mock.calls[0]![1] as readonly string[]).at(-1)).toBe('status');
  });

  it('passes bounded item identity and revision for retry and dismiss', async () => {
    const f = fixture(); const item = 'a'.repeat(64);
    f.run.mockResolvedValue({ stdout: JSON.stringify({ state: 'READY', pending: {
      id: item, state: 'COMPLETED', revision: 2 } }) });
    await f.create()!.retryOnce(item, 1);
    expect(f.run.mock.calls[0]![1]).toContain('retry-pending');
    expect(f.run.mock.calls[0]![1]).toContain(item);
    await f.create()!.dismiss(item, 1);
    expect(f.run.mock.calls[1]![1]).toContain('dismiss-pending');
  });

  it('refuses ambiguity, wrong scope, missing script and invalid runtime identity', () => {
    const f = fixture();
    expect(createDesktopPluginActions({ hooks: [f.hook, f.hook], runtimeSessionId: 's', endpointId: 'e',
      epoch: 1, hookGeneration: 1 })).toBeUndefined();
    expect(createDesktopPluginActions({ hooks: [{ ...f.hook, scope: 'session' }], runtimeSessionId: 's',
      endpointId: 'e', epoch: 1, hookGeneration: 1 })).toBeUndefined();
    rmSync(join(f.tools, 'desktop_control.py'));
    expect(f.create()).toBeUndefined();
    expect(createDesktopPluginActions({ hooks: [f.hook], runtimeSessionId: '', endpointId: 'e',
      epoch: 1, hookGeneration: 1 })).toBeUndefined();
  });

  it('accepts a readable status probe but refuses one writable outside the owner', () => {
    const f = fixture();
    expect(f.create()).toBeDefined();
    chmodSync(join(f.tools, 'status_probe.py'), 0o664);
    expect(f.create()).toBeUndefined();
  });

  it('contains timeouts, malformed JSON and unknown child results', async () => {
    const f = fixture(); f.run.mockRejectedValue(new Error('timeout secret'));
    expect(await f.create()!.listPending()).toEqual([]);
    for (const stdout of ['no json', JSON.stringify({ state: 'READY', items: [{ title: 'secret' }] })]) {
      f.run.mockResolvedValue({ stdout });
      expect(await f.create()!.listPending()).toEqual([]);
    }
  });
});
