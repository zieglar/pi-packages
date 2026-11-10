import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { CeHookRule } from '../dist/hooks/config.js';

export type DesktopTargetOutcome = {
  readonly status: 'DISABLED' | 'CAPTURED' | 'UNAVAILABLE' | 'PREPARED';
  readonly messageId: string;
  readonly reason?: 'disabled' | 'unavailable' | 'CAPTURE_LOCK_BUSY' | 'CAPTURE_TOO_LATE' | 'BEFORE_CAPTURE_CUTOFF' | 'CAPTURE_QUEUE_FULL' | 'CAPTURE_QUEUE_EXPIRED' | 'INBOUND_AUTHORITY_CHANGED';
  readonly taskId?: string;
  readonly idempotencyKey?: string;
};
export interface DesktopTargetRunOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly shell: false;
}
export type DesktopTargetRun = (command: string, args: readonly string[], options: DesktopTargetRunOptions) => Promise<{ stdout: string }>;
export interface DesktopTargetBridge {
  readonly ready: { readonly runtimeSessionId: string; readonly endpointId: string; readonly captureAfterAuditSequence: number };
  capture(input: { messageId: string; auditSequence: number }): Promise<DesktopTargetOutcome>;
  prepare(input: { messageId: string; taskId: string }): Promise<DesktopTargetOutcome>;
}

/** Delivery guard: the generation must be current AND the inbound policy must still authorize it. */
export function createDeliveryGuard(options: { readonly isCurrent: () => boolean; readonly isAuthorized: () => boolean }): () => boolean {
  return () => {
    try {
      return options.isCurrent() === true && options.isAuthorized() === true;
    } catch {
      return false;
    }
  };
}

/** Serializes at most 20 pending captures; waiting over 10s releases model delivery without sampling. */
export function createCaptureScheduler(options: { maxPending?: number; maxWaitMs?: number } = {}): { readonly run: (messageId: string, task: () => Promise<DesktopTargetOutcome>) => Promise<DesktopTargetOutcome> } {
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  return {
    run(messageId, task) {
      if (pending >= (options.maxPending ?? 20)) return Promise.resolve({ status: 'UNAVAILABLE', messageId, reason: 'CAPTURE_QUEUE_FULL' });
      pending++;
      const deadline = performance.now() + (options.maxWaitMs ?? 10000);
      let expired = false;
      let timer: ReturnType<typeof setTimeout>;
      const expiration = new Promise<DesktopTargetOutcome>(resolve => {
        timer = setTimeout(() => { expired = true; resolve({ status: 'UNAVAILABLE', messageId, reason: 'CAPTURE_QUEUE_EXPIRED' }); }, options.maxWaitMs ?? 10000);
        timer.unref?.();
      });
      const start = (): Promise<DesktopTargetOutcome> | DesktopTargetOutcome => {
        clearTimeout(timer);
        if (expired || performance.now() >= deadline) return { status: 'UNAVAILABLE', messageId, reason: 'CAPTURE_QUEUE_EXPIRED' };
        return task();
      };
      const result = queue.then(start, start);
      queue = result.then(() => { pending--; }, () => { pending--; });
      return Promise.race([result, expiration]);
    },
  };
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value);
const absolute = (value: unknown): value is string => text(value) && isAbsolute(value) && normalize(value) === value;
function privateJson(path: string): Record<string, unknown> {
  // Refuse symlinked ancestors as well as a symlink at the final component.
  if (realpathSync(path) !== path) throw new Error('config path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16384) throw new Error('private config');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config object');
    return value as Record<string, unknown>;
  } finally { closeSync(fd); }
}
const runPython: DesktopTargetRun = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, [...args], { ...options, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
});

/** Observes desktop targets only; Python retains runtime and desktop authority. */
export function createDesktopTargetBridge(options: {
  hooks: readonly CeHookRule[];
  runtimeSessionId: string;
  endpointId: string;
  run?: DesktopTargetRun;
}): DesktopTargetBridge | undefined {
  try {
    const { runtimeSessionId, endpointId } = options;
    if (!text(runtimeSessionId) || !text(endpointId)) return undefined;
    const selected = options.hooks.filter(hook => hook.enabled && hook.event === 'ce.message.committed.v1' && hook.recipient.adapter === 'chatgpt');
    if (selected.length !== 1) return undefined;
    const hook = selected[0]!;
    const [flag, wake, configFlag, config, hookFlag] = hook.args;
    if (!absolute(hook.command) || !/^python(?:3(?:\.\d+)?)?$/.test(basename(hook.command)) || hook.args.length !== 5 || flag !== '-B' || configFlag !== '--config' || hookFlag !== '--hook' || !absolute(wake) || !absolute(config)) return undefined;
    const owner = dirname(config);
    if (config !== join(owner, 'config.json') || wake !== join(owner, 'tools/ce-chatgpt-wake/wake.py')) return undefined;
    const outer = privateJson(config);
    if (Object.keys(outer).length !== 1 || outer.autoWakeConfig !== join(owner, 'auto-wake.json')) return undefined;
    const auto = privateJson(outer.autoWakeConfig as string);
    const guard = auto.conversationGuard as Record<string, unknown> | undefined;
    const cutoff = guard?.captureAfterAuditSequence;
    if (auto.ownerDirectory !== owner || guard?.targetSelection !== 'desktop-at-intake' || typeof cutoff !== 'number' || !Number.isSafeInteger(cutoff) || cutoff < 0) return undefined;
    const command = hook.command;
    const base = ['-B', join(dirname(wake), 'receipt_target.py'), '--config', config, '--session-id', runtimeSessionId, '--endpoint-id', endpointId];
    const run = options.run ?? runPython;
    async function invoke(messageId: string, args: string[], prepare?: { taskId: string }): Promise<DesktopTargetOutcome> {
      const unavailable: DesktopTargetOutcome = { status: 'UNAVAILABLE', messageId, reason: 'unavailable' };
      if (!text(messageId) || (prepare && !text(prepare.taskId))) return unavailable;
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['HOME', 'PATH', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
        const { stdout } = await run(command, [...base, ...args], { env, timeout: 20000, maxBuffer: 16384, shell: false });
        if (Buffer.byteLength(stdout) > 16384) return unavailable;
        const value: unknown = JSON.parse(stdout);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
        const result = value as Record<string, unknown>;
        if (result.messageId !== messageId || Object.keys(result).some(key => !['status', 'messageId', 'reason', 'taskId', 'idempotencyKey'].includes(key))) return unavailable;
        if (result.status === 'DISABLED') return { status: 'DISABLED', messageId, reason: 'disabled' };
        if (result.status === 'UNAVAILABLE') {
          const reason = result.reason;
          return reason === 'CAPTURE_LOCK_BUSY' || reason === 'CAPTURE_TOO_LATE' || reason === 'BEFORE_CAPTURE_CUTOFF'
            ? { status: 'UNAVAILABLE', messageId, reason } : unavailable;
        }
        if (!prepare && result.status === 'CAPTURED') return { status: 'CAPTURED', messageId };
        if (prepare && result.status === 'PREPARED' && result.taskId === prepare.taskId && typeof result.idempotencyKey === 'string' && /^ce-desktop-[a-f0-9]{64}$/.test(result.idempotencyKey)) return { status: 'PREPARED', messageId, taskId: prepare.taskId, idempotencyKey: result.idempotencyKey };
        return unavailable;
      } catch { return unavailable; }
    }
    return {
      ready: Object.freeze({ runtimeSessionId, endpointId, captureAfterAuditSequence: cutoff }),
      async capture({ messageId, auditSequence }) {
        if (!Number.isSafeInteger(auditSequence) || auditSequence <= cutoff) return { status: 'DISABLED', messageId, reason: 'disabled' };
        return invoke(messageId, ['--capture', messageId]);
      },
      prepare({ messageId, taskId }) {
        return invoke(messageId, ['--prepare-reply', messageId, '--task-id', taskId], { taskId });
      },
    };
  } catch { return undefined; }
}

export async function deliverAfterDesktopCapture(
  capturePromise: Promise<DesktopTargetOutcome>,
  isCurrent: () => boolean,
  deliver: () => void | Promise<void>,
  record?: (outcome: DesktopTargetOutcome) => void | Promise<void>,
  skipped?: () => void | Promise<void>,
): Promise<void> {
  let outcome: DesktopTargetOutcome | undefined;
  try { outcome = await capturePromise; } catch { /* Failed observation must not suppress model delivery. */ }
  if (!isCurrent()) { await skipped?.(); return; }
  try { if (outcome) await record?.(outcome); } catch { /* Recording is observational. */ }
  if (!isCurrent()) { await skipped?.(); return; }
  await deliver();
}
