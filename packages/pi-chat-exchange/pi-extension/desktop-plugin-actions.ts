import { execFile } from 'node:child_process';
import { constants, fstatSync, openSync, realpathSync, closeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { CeHookRule } from '../dist/hooks/config.js';
import { findDesktopTargetHook } from './desktop-target.js';

export type DesktopPendingProjection = {
  readonly id: string;
  readonly state: 'WAITING_FOR_OPERATOR' | 'READY_TO_RETRY' | 'UNKNOWN';
  readonly revision: number;
  readonly record: { readonly auditSequence: number; readonly targetTitle: string };
};
export type DesktopActionResult = { readonly state: 'READY' | 'UNKNOWN'; readonly pending?: Readonly<Record<string, unknown>> };
export type DesktopReadinessResult = {
  readonly state: 'READY' | 'DEGRADED' | 'UNKNOWN';
  readonly code: string;
  readonly messageSubmitted: false;
  readonly phases: Readonly<Record<string, string>>;
};
export type DesktopPluginRun = (command: string, args: readonly string[], options: {
  readonly env: NodeJS.ProcessEnv; readonly timeout: number; readonly maxBuffer: number; readonly shell: false;
}) => Promise<{ stdout: string }>;
export interface DesktopPluginActions {
  listPending(): Promise<readonly DesktopPendingProjection[]>;
  status(): Promise<DesktopReadinessResult>;
  retryOnce(id: string, revision: number): Promise<DesktopActionResult>;
  dismiss(id: string, revision: number): Promise<DesktopActionResult>;
  testReadiness(): Promise<DesktopReadinessResult>;
}

const text = (value: unknown, maximum = 512): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const absolute = (value: unknown): value is string => text(value, 4096) && isAbsolute(value) && normalize(value) === value;
const safeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const itemId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function ownerFile(path: string, privateContents: boolean): boolean {
  if (!absolute(path) || realpathSync(path) !== path) return false;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    const forbiddenMode = privateContents ? 0o077 : 0o022;
    return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & forbiddenMode) === 0 &&
      stat.nlink === 1 && stat.size <= 262144;
  } finally { closeSync(fd); }
}

const runPython: DesktopPluginRun = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], { ...options, encoding: 'utf8' }, (error, stdout) => {
    if (error) { reject(error); return; }
    resolve({ stdout });
  });
});

function parseObject(stdout: string): Record<string, unknown> | undefined {
  try {
    if (Buffer.byteLength(stdout) > 32768) return undefined;
    const value: unknown = JSON.parse(stdout);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function parsePending(value: unknown): DesktopPendingProjection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const record = item.record;
  if (!itemId(item.id) || !['WAITING_FOR_OPERATOR', 'READY_TO_RETRY', 'UNKNOWN'].includes(String(item.state)) ||
      !safeInteger(item.revision) || !record || typeof record !== 'object' || Array.isArray(record)) return undefined;
  const details = record as Record<string, unknown>;
  if (!safeInteger(details.auditSequence) || !text(details.targetTitle)) return undefined;
  return item as DesktopPendingProjection;
}

const unavailableReadiness = (): DesktopReadinessResult => Object.freeze({ state: 'UNKNOWN',
  code: 'DESKTOP_ACTION_UNAVAILABLE', messageSubmitted: false, phases: Object.freeze({}) });

export function createDesktopPluginActions(options: {
  readonly hooks: readonly CeHookRule[];
  readonly runtimeSessionId: string;
  readonly endpointId: string;
  readonly epoch: number;
  readonly hookGeneration: number;
  readonly run?: DesktopPluginRun;
}): DesktopPluginActions | undefined {
  try {
    if (!text(options.runtimeSessionId, 128) || !text(options.endpointId) || !safeInteger(options.epoch) ||
        !safeInteger(options.hookGeneration)) return undefined;
    const hook = findDesktopTargetHook(options.hooks);
    if (hook === undefined || hook.scope !== 'workspace' || !absolute(hook.command) ||
        !/^python(?:3(?:\.\d+)?)?$/.test(basename(hook.command))) return undefined;
    const status = hook.status;
    const config = status?.args[3];
    if (status === undefined || status.command !== hook.command || status.args.length !== 4 ||
        status.args[0] !== '-B' || status.args[2] !== '--config' || !absolute(config)) return undefined;
    const owner = dirname(config);
    const statusProbe = join(owner, 'tools/ce-chatgpt-wake/status_probe.py');
    const script = join(owner, 'tools/ce-chatgpt-wake/desktop_control.py');
    if (status.args[1] !== statusProbe || !ownerFile(statusProbe, false) || !ownerFile(script, true)) return undefined;
    const base = ['-B', script, '--config', config, '--runtime-session-id', options.runtimeSessionId,
      '--endpoint-id', options.endpointId, '--epoch', String(options.epoch),
      '--hook-generation', String(options.hookGeneration)];
    const run = options.run ?? runPython;
    const invoke = async (tail: readonly string[]): Promise<Record<string, unknown> | undefined> => {
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['HOME', 'PATH', 'LANG', 'TMPDIR']) if (process.env[key] !== undefined) env[key] = process.env[key];
        const { stdout } = await run(hook.command, [...base, ...tail], { env, timeout: 20000,
          maxBuffer: 32768, shell: false });
        return parseObject(stdout);
      } catch { return undefined; }
    };
    const boundedAction = async (action: 'retry-pending' | 'dismiss-pending', id: string,
      revision: number): Promise<DesktopActionResult> => {
      if (!itemId(id) || !safeInteger(revision) || revision < 1) return { state: 'UNKNOWN' };
      const result = await invoke(['--item-id', id, '--revision', String(revision), action]);
      if (result?.state !== 'READY' || !result.pending || typeof result.pending !== 'object' ||
          Array.isArray(result.pending)) return { state: 'UNKNOWN' };
      const pending = result.pending as Record<string, unknown>;
      if (pending.id !== id || !safeInteger(pending.revision) || !text(pending.state, 64)) return { state: 'UNKNOWN' };
      return { state: 'READY', pending };
    };
    return Object.freeze({
      async listPending() {
        const result = await invoke(['list-pending']);
        if (result?.state !== 'READY' || !Array.isArray(result.items)) return Object.freeze([]);
        const items = result.items.map(parsePending);
        return items.every(Boolean) ? Object.freeze(items as DesktopPendingProjection[]) : Object.freeze([]);
      },
      async status() {
        const result = await invoke(['status']);
        if (!result || !['READY', 'DEGRADED', 'UNKNOWN'].includes(String(result.state)) ||
            !text(result.code, 80)) return unavailableReadiness();
        return Object.freeze({ state: result.state as DesktopReadinessResult['state'], code: result.code,
          messageSubmitted: false as const, phases: Object.freeze({}) });
      },
      retryOnce: (id: string, revision: number) => boundedAction('retry-pending', id, revision),
      dismiss: (id: string, revision: number) => boundedAction('dismiss-pending', id, revision),
      async testReadiness() {
        const result = await invoke(['readiness-test']);
        if (!result || !['READY', 'DEGRADED', 'UNKNOWN'].includes(String(result.state)) ||
            !text(result.code, 80) || result.messageSubmitted !== false || !result.phases ||
            typeof result.phases !== 'object' || Array.isArray(result.phases) ||
            Object.values(result.phases).some(value => !text(value, 80))) return unavailableReadiness();
        return result as DesktopReadinessResult;
      },
    });
  } catch { return undefined; }
}
