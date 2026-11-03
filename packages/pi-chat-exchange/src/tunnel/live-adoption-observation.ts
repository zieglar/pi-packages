/** Diagnostic/test-only file records. Production readiness uses the fresh nonce
 * probe; this module must never be used as a file-only readiness source. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readLivePolicy, type LivePolicyRef, type LiveSnapshot } from "./live-session-policy.js";
import { readPrivateMessagingFile } from "./messaging-config.js";
import { TunnelRefusal } from "./codes.js";

export interface LiveProcessIdentity { readonly pid: number; readonly startedKey: string; }
export interface LiveObservationOwner {
  readonly endpointId: string;
  readonly registered: boolean;
  readonly participantId: string | undefined;
  readonly sessionId: string | undefined;
  readonly exchangeId: string | undefined;
  readonly fencingToken: number | undefined;
  readonly lease: string;
  readonly leaseExpiresAt: string | undefined;
}
export interface LiveObservationBound {
  readonly state: "ACTIVE" | "WRITE_BLOCKED" | "CLOSING" | "CLOSED";
  readonly renewal: "RUNNING" | "STOPPED";
}
interface Options {
  readonly ref: LivePolicyRef;
  readonly launchDigest: string;
  readonly identity: LiveProcessIdentity;
  readonly credentialFile?: string;
  readonly now?: () => string;
}
interface Target { readonly endpointId: string; readonly epoch: number; readonly payloadReadGeneration: number; readonly ackGeneration: number; }
interface Observation {
  readonly kind: "ce-live-observation-v1";
  readonly ref: LivePolicyRef;
  readonly launchDigest: string;
  readonly identity: LiveProcessIdentity;
  readonly writerSequence: number;
  readonly policySequence: number;
  readonly policyDigest: string;
  readonly owner: { readonly [K in keyof LiveObservationOwner]: Exclude<LiveObservationOwner[K], undefined> | (undefined extends LiveObservationOwner[K] ? null : never) };
  readonly bound: LiveObservationBound;
  readonly observedAt: string;
  readonly targets: readonly Target[];
}
const fail = (): never => { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.liveObservation"); };
const sha = (v: string): string => createHash("sha256").update(v).digest("hex");
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(k => !keys.includes(k))) return fail();
  return row;
}
function parse(raw: unknown): Observation {
  const r = object(raw, ["kind", "ref", "launchDigest", "identity", "writerSequence", "policySequence", "policyDigest", "owner", "bound", "observedAt", "targets"]);
  const ref = object(r.ref, ["kind", "root", "policyId", "genesisDigest"]);
  const id = object(r.identity, ["pid", "startedKey"]);
  const owner = object(r.owner, ["endpointId", "registered", "participantId", "sessionId", "exchangeId", "fencingToken", "lease", "leaseExpiresAt"]);
  const bound = object(r.bound, ["state", "renewal"]);
  if (r.kind !== "ce-live-observation-v1" || ref.kind !== "ce-live-session-v1" || !text(ref.root) || !text(ref.policyId) || !digest(ref.genesisDigest) ||
      !digest(r.launchDigest) || !digest(r.policyDigest) || !integer(id.pid) || id.pid < 1 || !text(id.startedKey) || !integer(r.writerSequence) || r.writerSequence < 1 || !integer(r.policySequence) || !instant(r.observedAt) ||
      !text(owner.endpointId) || typeof owner.registered !== "boolean" || (owner.participantId !== null && !text(owner.participantId)) || (owner.sessionId !== null && !text(owner.sessionId)) || (owner.exchangeId !== null && !text(owner.exchangeId)) || (owner.fencingToken !== null && (!integer(owner.fencingToken) || owner.fencingToken < 1)) || !text(owner.lease) || (owner.leaseExpiresAt !== null && !instant(owner.leaseExpiresAt)) ||
      !["ACTIVE", "WRITE_BLOCKED", "CLOSING", "CLOSED"].includes(String(bound.state)) || !["RUNNING", "STOPPED"].includes(String(bound.renewal)) || !Array.isArray(r.targets) || r.targets.length > 128) return fail();
  const labels = new Set<string>();
  for (const value of r.targets) {
    const t = object(value, ["endpointId", "epoch", "payloadReadGeneration", "ackGeneration"]);
    if (!text(t.endpointId) || labels.has(t.endpointId) || !integer(t.epoch) || !integer(t.payloadReadGeneration) || !integer(t.ackGeneration) || t.payloadReadGeneration > r.policySequence || t.ackGeneration > r.policySequence) return fail();
    labels.add(t.endpointId);
  }
  // SAFETY: the closed JSON record and every nested field were checked above.
  return r as unknown as Observation;
}
function pathFor(options: Options): string {
  if (!digest(options.launchDigest) || !integer(options.identity.pid) || options.identity.pid < 1 || !text(options.identity.startedKey)) return fail();
  // Reuse live policy's canonical private directory, ancestor and ACL checks.
  // This read verifies configuration only and changes no registry or Owner.
  readLivePolicy(options.ref, options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile });
  return join(options.ref.root, `.live-observation-${options.identity.pid}-${sha(options.identity.startedKey)}.json`);
}
function targets(snapshot: LiveSnapshot): readonly Target[] {
  return snapshot.manifest.registrations.filter(r => r.status === "active").map(({ endpointId, epoch, payloadReadGeneration, ackGeneration }) => ({ endpointId, epoch, payloadReadGeneration, ackGeneration }));
}
const rank = { ACTIVE: 0, WRITE_BLOCKED: 1, CLOSING: 2, CLOSED: 3 } as const;
export function createLiveAdoptionRecorder(options: Options): { readonly record: (snapshot: LiveSnapshot, owner: LiveObservationOwner, bound: LiveObservationBound) => void } {
  let sequence = 0;
  let state: LiveObservationBound["state"] = "ACTIVE";
  let failed = false;
  return Object.freeze({ record(snapshot: LiveSnapshot, owner: LiveObservationOwner, bound: LiveObservationBound): void {
    if (failed || rank[bound.state] < rank[state] || !isDeepStrictEqual(snapshot.ref, options.ref)) return fail();
    state = bound.state;
    try {
      const path = pathFor(options);
      readPrivateMessagingFile(path, options.credentialFile);
      const record = parse({ kind: "ce-live-observation-v1", ref: options.ref, launchDigest: options.launchDigest, identity: options.identity, writerSequence: ++sequence, policySequence: snapshot.sequence, policyDigest: snapshot.digest,
        owner: { endpointId: owner.endpointId, registered: owner.registered, participantId: owner.participantId ?? null, sessionId: owner.sessionId ?? null, exchangeId: owner.exchangeId ?? null, fencingToken: owner.fencingToken ?? null, lease: owner.lease, leaseExpiresAt: owner.leaseExpiresAt ?? null },
        bound: { state: bound.state, renewal: bound.renewal }, observedAt: options.now?.() ?? new Date().toISOString(), targets: targets(snapshot) });
      const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > 65536) return fail();
      const temp = join(options.ref.root, `.live-observation-tmp-${randomUUID()}`);
      let fd: number | undefined;
      try {
        fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        readPrivateMessagingFile(temp, options.credentialFile);
        fs.renameSync(temp, path);
        const directory = fs.openSync(options.ref.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(temp, { force: true });
      }
    } catch { failed = true; return fail(); }
  } });
}
export function readLiveAdoptionObservation(options: Options & { readonly current: LiveSnapshot; readonly targetEndpointId: string; readonly owner: LiveObservationOwner;
  /** Must query the exact live process synchronously, binding this record's
   * identity and sequence to its actual bound state. File age is insufficient.
   * Missing IPC support must leave this absent, never substitute a cached fact. */
  readonly verifyBound?: (record: Readonly<Observation>) => boolean;
}): { readonly kind: "OBSERVED" | "BLOCKED" | "UNVERIFIED" } {
  try {
    const file = readPrivateMessagingFile(pathFor(options), options.credentialFile);
    if (!file) return { kind: "UNVERIFIED" };
    const record = parse(JSON.parse(file.bytes.toString("utf8")));
    const now = options.now?.() ?? new Date().toISOString();
    if (!instant(now) || Date.parse(now) < Date.parse(record.observedAt) || Date.parse(now) - Date.parse(record.observedAt) > 5000 ||
        !isDeepStrictEqual(record.ref, options.ref) || !isDeepStrictEqual(options.current.ref, options.ref) || !isDeepStrictEqual(record.identity, options.identity) || record.launchDigest !== options.launchDigest ||
        record.policySequence > options.current.sequence || record.policySequence === options.current.sequence && record.policyDigest !== options.current.digest) return { kind: "UNVERIFIED" };
    const observed = record.targets.find(t => t.endpointId === options.targetEndpointId);
    const current = targets(options.current).find(t => t.endpointId === options.targetEndpointId);
    if (!observed || !current || !isDeepStrictEqual(observed, current)) return { kind: "UNVERIFIED" };
    if (record.bound.state !== "ACTIVE" || record.bound.renewal !== "RUNNING") return { kind: "BLOCKED" };
    const owner = options.owner;
    if (record.owner.participantId !== owner.participantId || record.owner.sessionId !== owner.sessionId || record.owner.exchangeId !== owner.exchangeId || record.owner.fencingToken !== owner.fencingToken || record.owner.endpointId !== owner.endpointId) return { kind: "UNVERIFIED" };
    if (record.bound.state !== "ACTIVE" || record.bound.renewal !== "RUNNING" || !owner.registered || owner.lease !== "ACTIVE" || record.owner.lease !== "ACTIVE" || !owner.leaseExpiresAt || !record.owner.leaseExpiresAt || Date.parse(owner.leaseExpiresAt) <= Date.parse(now) || Date.parse(record.owner.leaseExpiresAt!) <= Date.parse(now)) return { kind: "BLOCKED" };
    if (options.verifyBound?.(record) !== true) return { kind: "UNVERIFIED" };
    return { kind: "OBSERVED" };
  } catch { return { kind: "UNVERIFIED" }; }
}
