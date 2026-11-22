import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { CeHookRule } from '../dist/hooks/config.js';

const DESKTOP_REFUSAL_REASONS = [
  'AUTO_CONFIG_INVALID', 'AUTO_CONFIG_LIMIT_INVALID', 'AUTO_CONFIG_OWNER_INVALID', 'AUTO_CONFIG_PATH_INVALID',
  'BEFORE_CAPTURE_CUTOFF', 'CAPTURE_LOCK_BUSY', 'CAPTURE_POLICY_CHANGED', 'CAPTURE_STATE_UNCERTAIN', 'CAPTURE_TOO_LATE',
  'CHATGPT_BUSY', 'CONVERSATION_DENIED', 'CURRENT_TITLE_MISSING', 'DESKTOP_COMMAND_FAILED', 'DRAFT_NOT_EMPTY',
  'DRAFT_STATE_UNKNOWN', 'GUARD_NOT_AUTOMATIC', 'INBOUND_AUDIT_DENIED', 'INBOUND_CLAIM_REQUIRED',
  'INBOUND_MESSAGE_MISSING', 'INBOUND_METADATA_DENIED', 'INPUT_OR_SEND_AMBIGUOUS', 'INTAKE_OWNER_CHANGED',
  'NATIVE_SESSION_CHANGED', 'NATIVE_SESSION_FILE_UNSAFE', 'OWNER_LEASE_EXPIRED', 'OWNING_ENTRY_CHANGED',
  'PRIVATE_FILE_INVALID', 'PRIVATE_FILE_TOO_LARGE', 'PRIVATE_STATE_REQUIRED', 'RECEIPT_POLICY_REQUIRED',
  'REPLY_ALREADY_COMMITTED', 'REPLY_ASSOCIATION_NOT_PRIOR', 'REPLY_BINDING_DENIED', 'REPLY_CONFIRMATION_DENIED',
  'REPLY_KEY_CONFLICT', 'REPLY_KEY_INVALID', 'REPLY_KEY_UNCERTAIN', 'REQUEST_NOT_RECEIVED', 'RUNTIME_AUTHORITY_DENIED',
  'SNAPSHOT_DENIED', 'SNAPSHOT_INCOMPLETE', 'TARGET_BINDING_UNAVAILABLE', 'TARGET_CURRENT_TITLE_MISSING',
  'TARGET_SNAPSHOT_DENIED', 'TARGET_SOURCE_TITLE_MISSING', 'TARGET_TITLE_AMBIGUOUS', 'TARGET_TITLE_MISMATCH',
  'TARGET_WINDOW_AMBIGUOUS', 'TARGET_WINDOW_CHANGED', 'UNIQUE_CHATGPT_WINDOW_REQUIRED', 'WAKE_ENTRY_CLOSED', 'WINDOW_DENIED',
] as const;
type DesktopRefusalReason = typeof DESKTOP_REFUSAL_REASONS[number];
const desktopRefusalReasons = new Set<string>(DESKTOP_REFUSAL_REASONS);
const desktopRefusalReason = (value: unknown): value is DesktopRefusalReason => typeof value === 'string' && desktopRefusalReasons.has(value);

export function desktopFailureSummary(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.status !== 'UNAVAILABLE' || !desktopRefusalReason(record.reason) || !text(record.messageId) ||
      !Number.isSafeInteger(record.auditSequence) || (record.auditSequence as number) < 0) return undefined;
  return `${record.reason} (message=${record.messageId} audit=${record.auditSequence})`;
}

export type DesktopTargetOutcome = {
  readonly status: 'DISABLED' | 'CAPTURED' | 'UNAVAILABLE' | 'PREPARED';
  readonly messageId: string;
  readonly reason?: 'disabled' | 'unavailable' | DesktopRefusalReason | 'CAPTURE_QUEUE_FULL' | 'CAPTURE_QUEUE_EXPIRED' | 'INBOUND_AUTHORITY_CHANGED';
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

export const AGENT_DESKTOP_HOOK_ID = 'ce-agent-desktop-wake';

export function desktopPreparationStatus(state: {
  readonly generation: 'ABSENT' | 'STOPPING' | 'FAILED' | 'ACTIVE';
  readonly nativeInbound: boolean;
  readonly desktopTarget: boolean;
}): 'READY' | `DISABLED (${string})` {
  if (state.generation === 'ABSENT') return 'DISABLED (NO_GENERATION)';
  if (state.generation === 'STOPPING') return 'DISABLED (GENERATION_STOPPING)';
  if (state.generation === 'FAILED') return 'DISABLED (GENERATION_FAILED)';
  if (!state.nativeInbound) return 'DISABLED (NATIVE_INBOUND_UNAVAILABLE)';
  if (!state.desktopTarget) return 'DISABLED (DESKTOP_BRIDGE_UNAVAILABLE)';
  return 'READY';
}

export function findDesktopTargetHook(hooks: readonly CeHookRule[]): CeHookRule | undefined {
  const selected = hooks.filter(hook => {
    try {
      if (hook.id !== AGENT_DESKTOP_HOOK_ID || !hook.enabled || hook.event !== 'ce.message.committed.v1' || hook.recipient.adapter !== 'chatgpt') return false;
      const [flag, wake, configFlag, config, hookFlag] = hook.args;
      if (!absolute(hook.command) || !/^python(?:3(?:\.\d+)?)?$/.test(basename(hook.command)) || hook.args.length !== 5 || flag !== '-B' || configFlag !== '--config' || hookFlag !== '--hook' || !absolute(wake) || !absolute(config)) return false;
      const owner = dirname(config);
      if (config !== join(owner, 'config.json') || wake !== join(owner, 'tools/ce-chatgpt-wake/wake.py')) return false;
      const outer = privateJson(config);
      if (Object.keys(outer).length !== 1 || outer.autoWakeConfig !== join(owner, 'auto-wake.json')) return false;
      const auto = privateJson(outer.autoWakeConfig as string);
      const guard = auto.conversationGuard as Record<string, unknown> | undefined;
      const cutoff = guard?.captureAfterAuditSequence;
      return auto.ownerDirectory === owner && guard?.targetSelection === 'desktop-at-intake' && typeof cutoff === 'number' && Number.isSafeInteger(cutoff) && cutoff >= 0;
    } catch { return false; }
  });
  return selected.length === 1 ? selected[0] : undefined;
}

/** Rebinds a validated Agent Desktop owner to the authoritative current Pi runtime. */
export function bindDesktopTargetOwner(options: {
  readonly hooks: readonly CeHookRule[];
  readonly packageRoot: string;
  readonly nativeSessionFile: string;
}): boolean {
  let temporary: string | undefined;
  try {
    if (!absolute(options.packageRoot) || !absolute(options.nativeSessionFile)) return false;
    const hook = findDesktopTargetHook(options.hooks);
    if (hook === undefined) return false;
    const config = hook.args[3]!;
    const outer = privateJson(config);
    const autoPath = outer.autoWakeConfig as string;
    const auto = privateJson(autoPath);
    temporary = join(dirname(autoPath), `.${basename(autoPath)}.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify({ ...auto, packageRoot: options.packageRoot, nativeSessionFile: options.nativeSessionFile }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, autoPath);
    temporary = undefined;
    return true;
  } catch {
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* Best-effort cleanup; binding remains fail closed. */ }
    }
    return false;
  }
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
  execFile(command, [...args], { ...options, encoding: 'utf8' }, (error, stdout) => {
    if (error) {
      reject(Object.assign(error, { stdout }));
      return;
    }
    resolve({ stdout });
  });
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
    const hook = findDesktopTargetHook(options.hooks);
    if (hook === undefined) return undefined;
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
      let stdout: string;
      try {
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['HOME', 'PATH', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
        ({ stdout } = await run(command, [...base, ...args], { env, timeout: 20000, maxBuffer: 16384, shell: false }));
      } catch (error) {
        const candidate = error && typeof error === 'object' ? (error as { stdout?: unknown }).stdout : undefined;
        if (typeof candidate !== 'string') return unavailable;
        stdout = candidate;
      }
      try {
        if (Buffer.byteLength(stdout) > 16384) return unavailable;
        const value: unknown = JSON.parse(stdout);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
        const result = value as Record<string, unknown>;
        if (result.messageId !== messageId || Object.keys(result).some(key => !['status', 'messageId', 'reason', 'taskId', 'idempotencyKey'].includes(key))) return unavailable;
        if (result.status === 'DISABLED') return { status: 'DISABLED', messageId, reason: 'disabled' };
        if (result.status === 'UNAVAILABLE') {
          const reason = result.reason;
          return desktopRefusalReason(reason) ? { status: 'UNAVAILABLE', messageId, reason } : unavailable;
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
