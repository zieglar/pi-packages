import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { NativeInboundPolicy } from "./native-inbound.js";

export interface NativeInboundIdentity {
  readonly runtimeSessionId: string;
  readonly endpointId: string;
  readonly exchangeId: string;
}
type NativeInboundReadIdentity = Omit<NativeInboundIdentity, "exchangeId"> & { readonly exchangeId?: string };

export type NativeInboundPolicyInspection =
  | { readonly status: "missing" }
  | { readonly status: "enabled" | "disabled"; readonly policy: NativeInboundPolicy; readonly revision: string }
  | { readonly status: "invalid"; readonly code: "INBOUND_POLICY_INVALID" };

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const fail = (): never => { throw new Error("INBOUND_POLICY_INVALID"); };
const time = (text: string): number => typeof text === "string" && /(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? Date.parse(text) : NaN;
const stamp = (stat: fs.BigIntStats): string => sha([stat.dev, stat.ino, stat.mtimeNs, stat.ctimeNs, stat.size].join(":"));

export function nativeInboundPolicyPath(profilePath: string, runtimeSessionId: string): string {
  if (!profilePath.startsWith("/") || !runtimeSessionId) fail();
  return join(profilePath + ".native-inbound", `${sha(runtimeSessionId)}.json`);
}

export function readNativeInboundPolicy(
  path: string,
  identity: NativeInboundReadIdentity,
  now: number,
): { readonly policy: NativeInboundPolicy; readonly revision: string } | undefined {
  const uid = typeof process.getuid === "function" ? process.getuid() : fail();
  if (!Number.isFinite(now)) fail();
  let raw: string | undefined;
  let revision: string;
  try {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.uid !== BigInt(uid) || (stat.mode & 0o077n) !== 0n || stat.nlink !== 1n || stat.size > 4096n) fail();
      revision = stamp(stat);
      raw = fs.readFileSync(fd, "utf8");
      if (stamp(fs.fstatSync(fd, { bigint: true })) !== revision) fail();
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail();
  }
  let value: unknown;
  try { value = JSON.parse(raw!); } catch { fail(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const policy = value as Record<string, unknown>;
  const keys = ["version", "enabled", "runtimeSessionId", "endpointId", "exchangeId", "from", "activatedAt", "afterAuditSequence", "maxAgeSeconds"];
  if (Object.keys(policy).sort().join() !== keys.sort().join() || policy.version !== 1 || typeof policy.enabled !== "boolean" ||
    policy.runtimeSessionId !== identity.runtimeSessionId || policy.endpointId !== identity.endpointId ||
    (identity.exchangeId !== undefined && policy.exchangeId !== identity.exchangeId) || typeof policy.exchangeId !== "string" || policy.exchangeId.length === 0 ||
    typeof policy.from !== "string" || policy.from.length === 0 || typeof policy.activatedAt !== "string" ||
    !Number.isSafeInteger(policy.afterAuditSequence) || (policy.afterAuditSequence as number) < 0 ||
    !Number.isSafeInteger(policy.maxAgeSeconds) || (policy.maxAgeSeconds as number) < 1 || (policy.maxAgeSeconds as number) > 300 ||
    !Number.isFinite(time(policy.activatedAt)) || time(policy.activatedAt) > now) fail();
  return { policy: policy as unknown as NativeInboundPolicy, revision: revision! };
}

export function inspectNativeInboundPolicy(path: string, identity: NativeInboundReadIdentity, now: number): NativeInboundPolicyInspection {
  try {
    const observed = readNativeInboundPolicy(path, identity, now);
    if (!observed) return { status: "missing" };
    return { status: observed.policy.enabled ? "enabled" : "disabled", ...observed };
  } catch {
    return { status: "invalid", code: "INBOUND_POLICY_INVALID" };
  }
}

function ensureDirectory(path: string): void {
  const directory = dirname(path);
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail();
  }
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n) fail();
  fs.chmodSync(directory, 0o700);
}

function writePolicy(path: string, policy: NativeInboundPolicy, now: number): NativeInboundPolicy {
  ensureDirectory(path);
  // Replacement is permitted only for a policy that already passes the same
  // ownership, link, mode, shape and current-Session identity checks. A bad
  // target is evidence to stop, not something activation may erase.
  try {
    fs.lstatSync(path);
    if (!readNativeInboundPolicy(path, policy, now)) fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail();
  }
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, path);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* nothing durable to clean */ }
    fail();
  }
  const verified = readNativeInboundPolicy(path, policy, now);
  if (!verified || JSON.stringify(verified.policy) !== JSON.stringify(policy)) return fail();
  return verified.policy;
}

export function enableNativeInboundPolicy(input: {
  readonly path: string;
  readonly identity: NativeInboundIdentity;
  readonly from: string;
  readonly afterAuditSequence: number;
  readonly now: number;
}): NativeInboundPolicy {
  if (!input.from || !Number.isSafeInteger(input.afterAuditSequence) || input.afterAuditSequence < 0 || !Number.isFinite(input.now)) fail();
  return writePolicy(input.path, {
    version: 1, enabled: true, ...input.identity, from: input.from,
    activatedAt: new Date(input.now).toISOString(), afterAuditSequence: input.afterAuditSequence, maxAgeSeconds: 300,
  }, input.now);
}

export function disableNativeInboundPolicy(input: {
  readonly path: string;
  readonly identity: NativeInboundIdentity;
  readonly now: number;
}): NativeInboundPolicy {
  const current = readNativeInboundPolicy(input.path, input.identity, input.now);
  if (!current) return fail();
  return writePolicy(input.path, { ...current.policy, enabled: false }, input.now);
}
