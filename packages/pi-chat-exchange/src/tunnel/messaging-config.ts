/** Immutable ChatGPT/Pi configuration pairs. The existing profile command is
 * the only activation pointer. Final config files are linked without overwrite
 * and never replaced/deleted; failed saves retain unreferenced generations.
 * This module never creates a Store or CE authority and never reads credentials.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";
import { MCP_BINDING_CONFIG_VERSION, parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import type { CeRecipientRef } from "../host/endpoint-host.js";

export interface PiSideConfigInput {
  readonly chatgptEndpoint: CeRecipientRef;
  readonly piEndpoint: CeRecipientRef;
  readonly piSessionId: string;
  readonly exchangeNamespace: string;
  readonly exchangeIdempotencyKey: string;
  readonly store: { readonly directory: string; readonly file: string };
  readonly payloadRead: boolean;
  readonly ack: boolean;
}
interface FileIdentity { readonly dev: number; readonly ino: number; }
interface FileSnapshot extends FileIdentity { readonly bytes: Buffer; }
export interface MessagingPair {
  readonly bindingPath: string;
  readonly allowlistPath: string;
  readonly config: McpBindingConfig;
  readonly document: Record<string, unknown>;
}
export interface MessagingPairPublication extends MessagingPair { readonly durability: "synced" | "uncertain"; }
export interface MessagingPairOptions {
  readonly credentialFile?: string;
  readonly io?: Partial<Pick<typeof fs, "openSync" | "closeSync" | "writeFileSync" | "fsyncSync" | "linkSync">>;
}
type Io = Required<NonNullable<MessagingPairOptions["io"]>>;
const invalid = (field: string): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);
const conflict = (): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "messaging.generation");
const CREDENTIAL_SHAPED = /cap_[0-9a-f]{16,}/i;
const STORE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PAIR_NAME = /^messaging-([0-9a-f]{64})\.yaml$/;
const MAX_BYTES = 65_536;
const same = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
function label(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || !value.length || value.length > max || value.includes("\u0000") || CREDENTIAL_SHAPED.test(value)) throw invalid(field);
  return value;
}
function profileDirectory(profilePath: string): string {
  if (!isAbsolute(profilePath) || normalize(profilePath) !== profilePath) throw invalid("profile.path");
  return join(dirname(profilePath), ".ce-bindings");
}
/** Pure selection: an actual generation derives its sidecar from its binding.
 * The legacy basename is never written or replaced by messaging publication. */
export function piAllowlistPath(profilePath: string, bindingPath?: string): string {
  const directory = profileDirectory(profilePath);
  if (bindingPath === undefined) return join(dirname(profilePath), "pi-allowlist.json");
  if (dirname(bindingPath) !== directory || !PAIR_NAME.test(basename(bindingPath))) throw invalid("messaging.generation");
  return `${bindingPath}.pi-allowlist.json`;
}
export function isMessagingBinding(bindingPath: string): boolean { return PAIR_NAME.test(basename(bindingPath)); }
export function isManagedPiAllowlist(profilePath: string, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const marker = (value as Record<string, unknown>).managedBy;
  return typeof marker === "object" && marker !== null && !Array.isArray(marker) &&
    (marker as Record<string, unknown>).kind === "ce-tunnel-messaging-v1" &&
    (marker as Record<string, unknown>).profilePath === profilePath;
}
export function validMessagingStore(directory: unknown, file: unknown): boolean {
  return typeof directory === "string" && directory.length <= 4096 && !directory.includes("\u0000") &&
    isAbsolute(directory) && normalize(directory) === directory && directory !== "/" && !directory.endsWith("/") &&
    !CREDENTIAL_SHAPED.test(directory) && typeof file === "string" && STORE_FILE.test(file) &&
    !file.includes("..") && !CREDENTIAL_SHAPED.test(file);
}
export function buildPiAllowlistDocument(input: PiSideConfigInput): Record<string, unknown> {
  const chatgptAdapter = label(input.chatgptEndpoint.adapter, "messaging.chatgpt.adapter", 64);
  if (chatgptAdapter !== "chatgpt" || input.piEndpoint.adapter !== "pi") throw invalid("messaging.adapter");
  const chatgptId = label(input.chatgptEndpoint.endpointId, "messaging.chatgpt.endpointId");
  const piId = label(input.piEndpoint.endpointId, "messaging.pi.endpointId");
  if (chatgptId === piId) throw invalid("messaging.recipients");
  const session = label(input.piSessionId, "messaging.piSessionId");
  const namespace = label(input.exchangeNamespace, "messaging.exchangeNamespace");
  const idempotencyKey = label(input.exchangeIdempotencyKey, "messaging.exchangeIdempotencyKey");
  if (!validMessagingStore(input.store.directory, input.store.file)) throw invalid("messaging.store");
  return {
    exchangeNamespace: namespace, exchangeIdempotencyKey: idempotencyKey, leaseTtlSeconds: 120,
    payloadRead: { enabled: input.payloadRead === true }, ack: { enabled: input.ack === true },
    store: { directory: input.store.directory, file: input.store.file },
    recipients: [{ adapter: chatgptAdapter, endpointId: chatgptId }], sessions: { [session]: { endpointId: piId } },
  };
}
function credentialIdentities(file: string | undefined): readonly FileIdentity[] {
  if (file === undefined) return [];
  try { const link = fs.lstatSync(file); return link.isSymbolicLink() ? [link, fs.statSync(file)] : [link]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw invalid("messaging.credential"); }
}
/** Bounded private no-follow configuration snapshot; credential aliases are excluded before reads. */
export function readPrivateMessagingFile(path: string, credentialFile?: string): FileSnapshot | undefined {
  if (path === credentialFile) throw invalid("messaging.credential");
  const excluded = credentialIdentities(credentialFile);
  let selected: fs.Stats;
  try { selected = fs.lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw invalid("messaging.read"); }
  const safe = (s: fs.Stats): boolean => s.isFile() && !s.isSymbolicLink() && s.uid === process.geteuid?.() &&
    (s.mode & 0o7777) === 0o600 && s.size <= MAX_BYTES && !excluded.some((id) => same(id, s));
  if (!safe(selected)) throw invalid("messaging.permissions");
  let fd: number;
  try { fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch { throw invalid("messaging.read"); }
  try {
    const opened = fs.fstatSync(fd);
    if (!safe(opened) || !same(selected, opened)) throw invalid("messaging.read");
    const buffer = Buffer.alloc(MAX_BYTES + 1); let length = 0;
    while (length < buffer.length) { const count = fs.readSync(fd, buffer, length, buffer.length - length, length); if (count === 0) break; length += count; }
    const after = fs.fstatSync(fd);
    if (length > MAX_BYTES || length !== opened.size || !safe(after) || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw conflict();
    return { dev: opened.dev, ino: opened.ino, bytes: Buffer.from(buffer.subarray(0, length)) };
  } finally { fs.closeSync(fd); }
}
function digest(binding: Buffer, allowlist: Buffer): string {
  return createHash("sha256").update(binding).update("\u0000").update(allowlist).digest("hex");
}
function syncDirectory(path: string, io: Io): void {
  const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
/** Never rename over, unlink, or truncate a final pathname. Completed or partial
 * staging files are retained; they are not selected by any profile. */
function publishOne(path: string, bytes: Buffer, io: Io, credentialFile?: string): void {
  const previous = readPrivateMessagingFile(path, credentialFile);
  if (previous !== undefined) { if (!previous.bytes.equals(bytes)) throw conflict(); return; }
  const stage = join(dirname(path), `.messaging-stage-${randomUUID()}`);
  const fd = io.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.geteuid?.()) throw invalid("messaging.permissions");
    io.writeFileSync(fd, bytes); io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  try { io.linkSync(stage, path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalid("messaging.write");
    const raced = readPrivateMessagingFile(path, credentialFile);
    if (raced === undefined || !raced.bytes.equals(bytes)) throw conflict();
  }
}
function matches(config: McpBindingConfig, input: PiSideConfigInput): boolean {
  return config.managed?.adapter === "chatgpt" && config.endpoint.adapter === "chatgpt" &&
    config.endpoint.endpointId === input.chatgptEndpoint.endpointId && config.recipients.length === 1 &&
    config.recipients[0]!.adapter === "pi" && config.recipients[0]!.endpointId === input.piEndpoint.endpointId &&
    config.store.directory === input.store.directory && config.store.file === input.store.file &&
    config.exchange.namespace === input.exchangeNamespace && config.exchange.idempotencyKey === input.exchangeIdempotencyKey &&
    config.payloadRead.enabled === input.payloadRead && config.ack.enabled === input.ack;
}
export function publishMessagingPair(profilePath: string, config: McpBindingConfig, input: PiSideConfigInput, options: MessagingPairOptions = {}): MessagingPairPublication {
  const document = { ...buildPiAllowlistDocument(input), managedBy: { kind: "ce-tunnel-messaging-v1", profilePath } };
  if (!matches(config, input) || config.store.directory !== profileDirectory(profilePath)) throw invalid("messaging.configuration");
  return publishMessagingGeneration(profilePath, config, document, options);
}
/** Low-level immutable pair writer. Callers must validate their mode-specific document first. */
export function publishMessagingGeneration(profilePath: string, config: McpBindingConfig, document: Record<string, unknown>, options: MessagingPairOptions = {}): MessagingPairPublication {
  const directory = profileDirectory(profilePath);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) throw invalid("messaging.directory");
  const binding = Buffer.from(`${JSON.stringify({ version: MCP_BINDING_CONFIG_VERSION, ...config }, null, 2)}\n`);
  const allowlist = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (binding.length > MAX_BYTES || allowlist.length > MAX_BYTES) throw invalid("messaging.size");
  const bindingPath = join(directory, `messaging-${digest(binding, allowlist)}.yaml`);
  const allowlistPath = piAllowlistPath(profilePath, bindingPath);
  const io: Io = { openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync, ...options.io };
  try {
    publishOne(bindingPath, binding, io, options.credentialFile);
    publishOne(allowlistPath, allowlist, io, options.credentialFile);
  } catch (error) { if (error instanceof TunnelRefusal) throw error; throw invalid("messaging.write"); }
  let durability: "synced" | "uncertain" = "synced";
  try { syncDirectory(directory, io); } catch { durability = "uncertain"; }
  return { bindingPath, allowlistPath, config, document, durability };
}
export function readMessagingPair(profilePath: string, bindingPath: string, credentialFile?: string): MessagingPair | undefined {
  const pair = readMessagingGeneration(profilePath, bindingPath, credentialFile);
  if (pair !== undefined && !isManagedPiAllowlist(profilePath, pair.document)) throw invalid("messaging.provenance");
  return pair;
}
/** Digest verification alone is not authorization; consumers validate the complete mode-specific schema. */
export function readMessagingGeneration(profilePath: string, bindingPath: string, credentialFile?: string): MessagingPair | undefined {
  if (!isMessagingBinding(bindingPath)) return undefined;
  const allowlistPath = piAllowlistPath(profilePath, bindingPath);
  const binding = readPrivateMessagingFile(bindingPath, credentialFile);
  const allowlist = readPrivateMessagingFile(allowlistPath, credentialFile);
  if (binding === undefined || allowlist === undefined || basename(bindingPath) !== `messaging-${digest(binding.bytes, allowlist.bytes)}.yaml`) throw invalid("messaging.generation");
  try {
    const config = parseMcpBindingConfig(JSON.parse(binding.bytes.toString("utf8")));
    const document = JSON.parse(allowlist.bytes.toString("utf8")) as Record<string, unknown>;
    return { bindingPath, allowlistPath, config, document };
  } catch { throw invalid("messaging.configuration"); }
}
