import { isAbsolute, normalize } from "node:path";
import type { CeRecipientRef } from "../host/endpoint-host.js";
import { CE_MESSAGE_COMMITTED_EVENT, type CeCommittedMessageEvent } from "./events.js";

export const CE_HOOK_DEFAULT_TIMEOUT_MS = 30_000;
export const CE_HOOK_MIN_TIMEOUT_MS = 1_000;
export const CE_HOOK_MAX_TIMEOUT_MS = 60_000;
export const CE_HOOK_STATUS_DEFAULT_TIMEOUT_MS = 2_000;
export const CE_HOOK_STATUS_MIN_TIMEOUT_MS = 100;
export const CE_HOOK_STATUS_MAX_TIMEOUT_MS = 10_000;
export type CeHookScope = "session" | "workspace";

export interface CeHookStatusProbe {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface CeHookRule {
  readonly id: string;
  readonly event: typeof CE_MESSAGE_COMMITTED_EVENT;
  readonly recipient: CeRecipientRef;
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly enabled: boolean;
  readonly scope: CeHookScope;
  readonly status?: CeHookStatusProbe;
}
export type CeLegacyHookRule = Omit<CeHookRule, "scope">;
export type CeStoredHookRule = CeHookRule | CeLegacyHookRule;

export class CeHookConfigError extends Error {
  readonly code = "CE_HOOK_CONFIG_INVALID" as const;
  constructor(readonly field: string) {
    super(`CE_HOOK_CONFIG_INVALID at ${field}`);
    this.name = "CeHookConfigError";
  }
}

function refuse(field: string): never {
  throw new CeHookConfigError(field);
}

function fields(value: unknown, field: string, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(field);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse(field);
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) refuse(field);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) refuse(`${field}.${key}`);
    result[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(result, key)) refuse(`${field}.${key}`);
  return result;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) refuse(field);
  return value;
}

function recipient(value: unknown, field: string): CeRecipientRef {
  const input = fields(value, field, ["adapter", "endpointId"], ["adapter", "endpointId"]);
  return Object.freeze({
    adapter: text(input.adapter, `${field}.adapter`, 64),
    endpointId: text(input.endpointId, `${field}.endpointId`, 256),
  });
}

function command(value: unknown, field: string): string {
  const parsed = text(value, field, 4096);
  if (!isAbsolute(parsed) || normalize(parsed) !== parsed || parsed === "/") refuse(field);
  return parsed;
}

function timeout(value: unknown, field: string): number {
  if (value === undefined) return CE_HOOK_DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < CE_HOOK_MIN_TIMEOUT_MS || value > CE_HOOK_MAX_TIMEOUT_MS) refuse(field);
  return value;
}

function statusProbe(value: unknown, field: string): CeHookStatusProbe {
  const input = fields(value, field, ["label", "command", "args", "timeoutMs"], ["label", "command"]);
  let args: readonly string[] = Object.freeze([]);
  if (input.args !== undefined) {
    if (!Array.isArray(input.args) || input.args.length > 16) refuse(`${field}.args`);
    args = Object.freeze(input.args.map((arg, index) => text(arg, `${field}.args[${index}]`, 4096)));
  }
  const timeoutMs = input.timeoutMs === undefined ? CE_HOOK_STATUS_DEFAULT_TIMEOUT_MS : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < CE_HOOK_STATUS_MIN_TIMEOUT_MS || timeoutMs > CE_HOOK_STATUS_MAX_TIMEOUT_MS) refuse(`${field}.timeoutMs`);
  return Object.freeze({
    label: text(input.label, `${field}.label`, 32),
    command: command(input.command, `${field}.command`),
    args,
    timeoutMs,
  });
}

/** Parse already-loaded local JSON. No file, environment, message or process input
 * can supply a command; only this static configuration becomes execution authority. */
function parseRules(raw: unknown, allowLegacy: boolean): readonly CeStoredHookRule[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > 64) refuse("hooks");
  const rules: CeStoredHookRule[] = [];
  const ids = new Set<string>();
  for (const [index, value] of raw.entries()) {
    const field = `hooks[${index}]`;
    const input = fields(value, field, ["id", "event", "recipient", "command", "args", "timeoutMs", "enabled", "scope", "status"],
      ["id", "event", "recipient", "command", ...(allowLegacy ? [] : ["scope"])]);
    const id = text(input.id, `${field}.id`, 64);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || ids.has(id)) refuse(`${field}.id`);
    ids.add(id);
    if (input.event !== CE_MESSAGE_COMMITTED_EVENT) refuse(`${field}.event`);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") refuse(`${field}.enabled`);
    let args: readonly string[] = Object.freeze([]);
    if (input.args !== undefined) {
      if (!Array.isArray(input.args) || input.args.length > 32) refuse(`${field}.args`);
      args = Object.freeze(input.args.map((arg, argIndex) => text(arg, `${field}.args[${argIndex}]`, 4096)));
    }
    if ((!allowLegacy && input.scope === undefined) ||
        (input.scope !== undefined && input.scope !== "session" && input.scope !== "workspace")) refuse(`${field}.scope`);
    const parsedRecipient = recipient(input.recipient, `${field}.recipient`);
    if (input.scope === "workspace" && parsedRecipient.adapter !== "chatgpt") refuse(`${field}.scope`);
    rules.push(Object.freeze({
      id,
      event: CE_MESSAGE_COMMITTED_EVENT,
      recipient: parsedRecipient,
      command: command(input.command, `${field}.command`),
      args,
      timeoutMs: timeout(input.timeoutMs, `${field}.timeoutMs`),
      enabled: input.enabled ?? true,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
      ...(input.status === undefined ? {} : { status: statusProbe(input.status, `${field}.status`) }),
    }));
  }
  return Object.freeze(rules);
}

export function parseHookRules(raw: unknown): readonly CeHookRule[] {
  return parseRules(raw, false) as readonly CeHookRule[];
}

/** Historical immutable policy data only. Legacy rules remain unscoped and are
 * never executable or eligible for workspace inheritance. */
export function parseStoredHookRules(raw: unknown): readonly CeStoredHookRule[] {
  return parseRules(raw, true);
}

export function isScopedHookRule(rule: CeStoredHookRule): rule is CeHookRule {
  return Object.hasOwn(rule, "scope");
}

export function matchesHookRule(rule: CeHookRule, event: CeCommittedMessageEvent): boolean {
  return rule.enabled && rule.event === event.event &&
    rule.recipient.adapter === event.recipient.adapter &&
    rule.recipient.endpointId === event.recipient.endpointId;
}
