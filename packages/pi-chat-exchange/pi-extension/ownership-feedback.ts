import { execFile, execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { CeHookRule } from '../dist/hooks/config.js';
import type { CeReadResult } from '../dist/endpoints/pi/session-host.js';

export type FeedbackMetadata = Omit<CeReadResult, 'state'>;
export type FeedbackAssociation = { readonly kind: 'FEEDBACK'; readonly messageId: string; readonly requestMessageId: string; readonly outgoingMessageId: string; readonly probeId: string; readonly outcomeHint: 'MATCH' | 'WRONG_CONVERSATION' | 'UNVERIFIED' | 'UNKNOWN' };
export type FeedbackClassification = { readonly kind: 'NONE' } | { readonly kind: 'BLOCKED'; readonly reason: string } | FeedbackAssociation;
export type FeedbackTerminal = { readonly kind: 'TERMINAL'; readonly messageId: string; readonly requestMessageId: string; readonly outgoingMessageId: string; readonly probeId: string; readonly outcome: 'MATCH' | 'WRONG_CONVERSATION' | 'UNVERIFIED'; readonly status: 'RECORDED' | 'UNVERIFIED'; readonly suppressOrdinaryReply: true };
export interface OwnershipFeedbackPort {
  classify(metadata: FeedbackMetadata): FeedbackClassification;
  consume(input: { metadata: FeedbackMetadata; association: FeedbackAssociation; text: string }): Promise<FeedbackTerminal>;
}
const unavailable = (): never => { throw new Error('INBOUND_FEEDBACK_UNAVAILABLE'); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const messageId = (value: unknown): value is string => typeof value === 'string' && /^msg_[A-Z0-9]{26}$/.test(value);
const probeId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const absolute = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value) && normalize(value) === value;
const associationKeys = ['kind', 'messageId', 'requestMessageId', 'outgoingMessageId', 'probeId', 'outcomeHint'];
const terminalKeys = ['kind', 'messageId', 'requestMessageId', 'outgoingMessageId', 'probeId', 'outcome', 'status', 'suppressOrdinaryReply'];
export function validateFeedbackClassification(value: unknown, incoming: string): FeedbackClassification {
  if (!object(value)) return unavailable();
  if (value.kind === 'NONE' && keys(value, ['kind'])) return { kind: 'NONE' };
  if (value.kind === 'BLOCKED' && keys(value, ['kind', 'reason']) && typeof value.reason === 'string' && ['FEEDBACK_KEY_INVALID', 'FEEDBACK_PROBE_UNVERIFIED', 'FEEDBACK_OWNER_UNVERIFIED'].includes(value.reason)) return { kind: 'BLOCKED', reason: value.reason };
  if (value.kind !== 'FEEDBACK' || !keys(value, associationKeys) || value.messageId !== incoming || !messageId(value.messageId) || !messageId(value.requestMessageId) || !messageId(value.outgoingMessageId) || !probeId(value.probeId) || !['MATCH', 'WRONG_CONVERSATION', 'UNVERIFIED', 'UNKNOWN'].includes(value.outcomeHint as string)) return unavailable();
  return value as FeedbackAssociation;
}
export function validateFeedbackTerminal(value: unknown, association: FeedbackAssociation): FeedbackTerminal {
  if (!object(value) || !keys(value, terminalKeys) || value.kind !== 'TERMINAL' || value.messageId !== association.messageId || value.requestMessageId !== association.requestMessageId || value.outgoingMessageId !== association.outgoingMessageId || value.probeId !== association.probeId || !['MATCH', 'WRONG_CONVERSATION', 'UNVERIFIED'].includes(value.outcome as string) || !['RECORDED', 'UNVERIFIED'].includes(value.status as string) || value.suppressOrdinaryReply !== true || (value.status === 'UNVERIFIED' && value.outcome !== 'UNVERIFIED') || (value.status === 'RECORDED' && value.outcome !== association.outcomeHint) || (association.outcomeHint === 'UNKNOWN' && (value.outcome !== 'UNVERIFIED' || value.status !== 'UNVERIFIED'))) return unavailable();
  return value as FeedbackTerminal;
}
function privateJson(path: string): Record<string, unknown> {
  if (!absolute(path) || realpathSync(path) !== path) return unavailable();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1 || stat.size > 16384) return unavailable();
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!object(value)) return unavailable();
    return value;
  } finally { closeSync(fd); }
}
function parse<T>(stdout: string, validate: (value: unknown) => T): T {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 16384) return unavailable();
  try { return validate(JSON.parse(stdout) as unknown); } catch { return unavailable(); }
}
function environment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'PATH', 'LANG']) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
/** Optional local opt-in. An existing invalid sidecar never becomes an ordinary wake. */
export function createOwnershipFeedbackBridge(options: { policyPath: string; databasePath?: string | undefined; hooks: readonly CeHookRule[]; runtimeSessionId: string; endpointId: string }): OwnershipFeedbackPort | undefined {
  const sidecarPath = `${options.policyPath}.task-ownership.json`;
  try { lstatSync(sidecarPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; return unavailable(); }
  const trusted = () => {
    const sidecar = privateJson(sidecarPath);
    if (!keys(sidecar, ['schemaVersion', 'registryDirectory', 'observerConfig']) || sidecar.schemaVersion !== 1 || !absolute(options.databasePath) || !absolute(sidecar.registryDirectory) || realpathSync(sidecar.registryDirectory) !== sidecar.registryDirectory || !statSync(sidecar.registryDirectory).isDirectory()) return unavailable();
    const selected = options.hooks.filter(hook => hook.enabled && hook.event === 'ce.message.committed.v1' && hook.recipient.adapter === 'chatgpt');
    if (selected.length !== 1) return unavailable();
    const hook = selected[0]!;
    const [flag, wake, configFlag, config, hookFlag] = hook.args;
    if (!absolute(hook.command) || !/^python(?:3(?:\.\d+)?)?$/.test(basename(hook.command)) || hook.args.length !== 5 || flag !== '-B' || configFlag !== '--config' || hookFlag !== '--hook' || !absolute(wake) || !absolute(config)) return unavailable();
    const owner = dirname(config);
    if (config !== join(owner, 'config.json') || wake !== join(owner, 'tools/ce-chatgpt-wake/wake.py')) return unavailable();
    const outer = privateJson(config);
    if (!keys(outer, ['autoWakeConfig']) || outer.autoWakeConfig !== join(owner, 'auto-wake.json') || sidecar.observerConfig !== outer.autoWakeConfig) return unavailable();
    const auto = privateJson(outer.autoWakeConfig as string);
    if (auto.ownerDirectory !== owner || typeof auto.maxWaitSeconds !== 'number' || !Number.isInteger(auto.maxWaitSeconds) || auto.maxWaitSeconds < 1 || auto.maxWaitSeconds > 120 ||
      typeof auto.notificationTimeoutSeconds !== 'number' || !Number.isInteger(auto.notificationTimeoutSeconds) || auto.notificationTimeoutSeconds < 1 || auto.notificationTimeoutSeconds > 900) return unavailable();
    // A permitted manual notification can wait longer than metadata consumption.
    const consumeTimeoutMs = (auto.notificationTimeoutSeconds + auto.maxWaitSeconds + 20) * 1000;
    const base = ['-B', join(owner, 'tools/ce-chatgpt-wake/ownership_feedback.py'), '--sidecar', sidecarPath, '--database-path', options.databasePath, '--runtime-session-id', options.runtimeSessionId, '--endpoint-id', options.endpointId, '--action'];
    return { command: hook.command, base, consumeTimeoutMs };
  };
  try { trusted(); } catch { return unavailable(); }
  return {
    classify(metadata) {
      try {
        const { command, base } = trusted();
        const stdout = execFileSync(command, [...base, 'classify'], { input: JSON.stringify(metadata), encoding: 'utf8', env: environment(), timeout: 5000, maxBuffer: 16384, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        return parse(stdout, value => validateFeedbackClassification(value, metadata.messageId));
      } catch { return unavailable(); }
    },
    async consume(input) {
      try {
        const { command, base, consumeTimeoutMs } = trusted();
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = execFile(command, [...base, 'consume'], { encoding: 'utf8', env: environment(), timeout: consumeTimeoutMs, maxBuffer: 16384, shell: false }, (error, output) => error ? reject(error) : resolve(output));
          child.stdin?.on('error', reject);
          if (!child.stdin) { reject(new Error('stdin unavailable')); return; }
          child.stdin.end(JSON.stringify(input));
        });
        return parse(stdout, value => validateFeedbackTerminal(value, input.association));
      } catch { return unavailable(); }
    },
  };
}
