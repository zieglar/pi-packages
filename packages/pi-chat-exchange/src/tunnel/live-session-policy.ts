/** Private offline/live configuration history. No Store, Owner or transport authority. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseMultiSessionManifest, type MultiSessionManifest, type SessionRegistration } from "./multi-session-policy.js";
import { readPrivateMessagingFile, type MessagingPairOptions } from "./messaging-config.js";
import { TunnelRefusal } from "./codes.js";
export interface LivePolicyRef { readonly kind: "ce-live-session-v1"; readonly root: string; readonly policyId: string; readonly genesisDigest: string; }
export interface LiveRegistration extends SessionRegistration { readonly payloadReadGeneration: number; readonly ackGeneration: number; readonly presenceDisclosure: boolean; }
export interface LiveSnapshot { readonly ref: LivePolicyRef; readonly sequence: number; readonly digest: string; readonly manifest: Omit<MultiSessionManifest, "registrations"> & { readonly registrations: readonly LiveRegistration[] }; }
export interface LiveReaderWatermark { sequence?: number; digest?: string; policyId?: string; }
type Manifest = LiveSnapshot["manifest"];
type Registration = Pick<LiveRegistration, "endpointId" | "runtimeSessionId" | "payloadRead" | "ack" | "presenceDisclosure">;
type Intent = { kind: "genesis" } | { kind: "register" | "reauthorize"; registration: Registration } | { kind: "revoke"; endpointId: string };
interface Envelope { kind: "ce-live-session-v1"; policyId: string; sequence: number; parentDigest: string | null; identityDigest: string; operationId: string; intent: Intent; manifestDigest: string; manifest: Manifest; }
interface Locator { kind: "ce-live-locator-v1"; policyId: string; runtimeSessionId: string; parentSequence: number; parentDigest: string; sequence: number; operationId: string; intentDigest: string; candidateDigest: string; }
export interface LivePublication { readonly snapshot: LiveSnapshot; readonly durability: "synced" | "uncertain"; readonly operationId: string; }
export interface LiveReconciliation { readonly operationId: string; readonly sequence: number; readonly outcome: "PUBLISHED" | "COMPETING_COMMIT" | "NOT_OBSERVED" | "UNKNOWN"; }
const KIND = "ce-live-session-v1" as const;
const fail = (): never => { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.livePolicy"); };
const conflict = (): never => { throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "messaging.livePolicy"); };
const hash = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");
const json = (v: unknown): string => JSON.stringify(v);
const digest = (v: unknown): string => hash(json(v));
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return fail();
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) return fail();
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(v, k); if (!d || !("value" in d) || !d.enumerable) return fail(); }
  return v as Record<string, unknown>;
}
function label(v: unknown): string { if (typeof v !== "string" || !v.length || v.length > 256 || /[\u0000-\u001f\u007f]|cap_[0-9a-f]{16,}/i.test(v)) return fail(); return v; }
function sha(v: unknown): string { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) return fail(); return v; }
function integer(v: unknown): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 65536) return fail(); return v; }
function acl(path: string): void {
  if (process.platform !== "darwin") return;
  const output = execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
  const [header = "", ...lines] = output.trimEnd().split("\n");
  if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header) || lines.some(l => !/^\s*\d+: \S+ deny [a-z_,]+$/.test(l)) || header[10] === "+" && !lines.length) fail();
}
function directory(root: string): void {
  if (!isAbsolute(root) || normalize(root) !== root || root === "/" || fs.realpathSync(root) !== root) fail();
  for (let p = root; ; p = dirname(p)) {
    const s = fs.lstatSync(p); const sticky = s.uid === 0 && (s.mode & 0o1000) !== 0;
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 && s.uid !== process.geteuid?.() || !sticky && (s.mode & 0o022) !== 0) fail();
    if (p === root && (s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o700)) fail();
    acl(p); if (dirname(p) === p) break;
  }
}
function reference(raw: LivePolicyRef): LivePolicyRef {
  const r = closed(raw, ["kind", "root", "policyId", "genesisDigest"]);
  if (r.kind !== KIND || typeof r.root !== "string") return fail();
  directory(r.root); label(r.policyId); sha(r.genesisDigest); return Object.freeze({ ...raw });
}
function read(path: string, credentialFile?: string): Buffer | undefined {
  const data = readPrivateMessagingFile(path, credentialFile); if (data) acl(path); return data?.bytes;
}
function parseManifest(raw: unknown, sequence: number): Manifest {
  if (raw === null || typeof raw !== "object") return fail();
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.registrations)) return fail();
  const extras = r.registrations.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return fail();
    const e = entry as Record<string, unknown>;
    closed(e, ["endpointId", "runtimeSessionId", "epoch", "status", "payloadRead", "ack", "payloadReadGeneration", "ackGeneration", "presenceDisclosure", ...(Object.hasOwn(e, "hooks") ? ["hooks"] : [])]);
    if (typeof e.presenceDisclosure !== "boolean" || integer(e.payloadReadGeneration) > sequence || integer(e.ackGeneration) > sequence) return fail();
    const { payloadReadGeneration, ackGeneration, presenceDisclosure, ...base } = e;
    return { base, payloadReadGeneration: payloadReadGeneration as number, ackGeneration: ackGeneration as number, presenceDisclosure };
  });
  const base = parseMultiSessionManifest({ ...r, registrations: extras.map(e => e.base) });
  return Object.freeze({ ...base, registrations: Object.freeze(base.registrations.map((e, i) => Object.freeze({ ...e,
    payloadReadGeneration: extras[i]!.payloadReadGeneration, ackGeneration: extras[i]!.ackGeneration, presenceDisclosure: extras[i]!.presenceDisclosure }))) });
}
function registration(raw: unknown): Registration {
  const r = closed(raw, ["endpointId", "runtimeSessionId", "payloadRead", "ack", "presenceDisclosure"]);
  if (typeof r.payloadRead !== "boolean" || typeof r.ack !== "boolean" || typeof r.presenceDisclosure !== "boolean") return fail();
  return Object.freeze({ endpointId: label(r.endpointId), runtimeSessionId: label(r.runtimeSessionId), payloadRead: r.payloadRead, ack: r.ack, presenceDisclosure: r.presenceDisclosure });
}
function intent(raw: unknown): Intent {
  const k = (raw as { kind?: unknown } | null)?.kind;
  if (k === "genesis") { closed(raw, ["kind"]); return { kind: k }; }
  if (k === "register" || k === "reauthorize") { const r = closed(raw, ["kind", "registration"]); return { kind: k, registration: registration(r.registration) }; }
  if (k === "revoke") { const r = closed(raw, ["kind", "endpointId"]); return { kind: k, endpointId: label(r.endpointId) }; }
  return fail();
}
function fixed(m: Manifest): Omit<Manifest, "registrations"> { const { registrations: _, ...rest } = m; return rest; }
function transform(m: Manifest, i: Intent, seq: number): Manifest {
  if (i.kind === "genesis") return fail();
  const old = m.registrations.find(r => r.endpointId === (i.kind !== "revoke" ? i.registration.endpointId : i.endpointId));
  let next: LiveRegistration;
  if (i.kind === "revoke") {
    if (!old || old.status !== "active") return fail();
    next = { ...old, status: "revoked" };
  } else {
    const r = i.registration;
    const restoring = i.kind === "reauthorize";
    if (restoring && (!old || old.status !== "revoked") || old && (old.runtimeSessionId !== r.runtimeSessionId || !restoring && old.status !== "active") || m.registrations.some(e => e.runtimeSessionId === r.runtimeSessionId && e.endpointId !== r.endpointId)) return fail();
    // An explicit new incarnation invalidates both loaded permission generations,
    // even when their booleans remain unchanged. Existing Hooks are retained.
    next = { ...old, ...r, epoch: restoring ? old!.epoch + 1 : old?.epoch ?? 1, status: "active",
      payloadReadGeneration: restoring || !old || old.payloadRead !== r.payloadRead ? seq : old.payloadReadGeneration,
      ackGeneration: restoring || !old || old.ack !== r.ack ? seq : old.ackGeneration };
  }
  return parseManifest({ ...m, registrations: old ? m.registrations.map(r => r === old ? next : r) : [...m.registrations, next] }, seq);
}
const slot = (root: string, seq: number): string => join(root, `${String(seq).padStart(6, "0")}.json`);
function envelope(bytes: Buffer): Envelope {
  let raw: unknown; try { raw = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
  const r = closed(raw, ["kind", "policyId", "sequence", "parentDigest", "identityDigest", "operationId", "intent", "manifestDigest", "manifest"]);
  if (r.kind !== KIND) return fail();
  const seq = integer(r.sequence); const m = parseManifest(r.manifest, seq);
  if (r.parentDigest !== null) sha(r.parentDigest);
  if (sha(r.identityDigest) !== digest(fixed(m)) || sha(r.manifestDigest) !== digest(m)) return fail();
  return { kind: KIND, policyId: label(r.policyId), sequence: seq, parentDigest: r.parentDigest as string | null,
    identityDigest: sha(r.identityDigest), operationId: label(r.operationId), intent: intent(r.intent), manifestDigest: sha(r.manifestDigest), manifest: m };
}
/** Deterministic test seam for a commit that lands during a read. Production callers omit it. */
export interface LiveReaderSeam { readonly afterMissingSlot?: (sequence: number) => void; }
function maxSlotIndex(root: string): number {
  let max = -1;
  for (const name of fs.readdirSync(root)) if (/^\d{6}\.json$/.test(name)) max = Math.max(max, Number(name.slice(0, 6)));
  return max;
}
function history(ref: LivePolicyRef, credentialFile?: string, seam?: LiveReaderSeam): { snapshots: LiveSnapshot[]; envelopes: Envelope[]; bytes: number } {
  const snapshots: LiveSnapshot[] = []; const envelopes: Envelope[] = [];
  let total = 0; let seq = 0;
  let bytes = read(slot(ref.root, 0), credentialFile); if (!bytes) return fail();
  for (;;) {
    total += bytes.length; if (total > 64 * 1024 * 1024) return fail();
    const e = envelope(bytes); const d = hash(bytes); const prev = snapshots.at(-1);
    if (e.policyId !== ref.policyId || e.sequence !== seq || e.parentDigest !== (prev?.digest ?? null)) return fail();
    if (!prev) {
      if (d !== ref.genesisDigest || e.intent.kind !== "genesis" || e.manifest.registrations.some(r => r.payloadReadGeneration !== 0 || r.ackGeneration !== 0)) return fail();
    } else if (!isDeepStrictEqual(fixed(prev.manifest), fixed(e.manifest)) || !isDeepStrictEqual(transform(prev.manifest, e.intent, seq), e.manifest)) return fail();
    if (envelopes.some(p => p.operationId === e.operationId)) return fail();
    envelopes.push(e); snapshots.push(Object.freeze({ ref, sequence: seq, digest: d, manifest: e.manifest }));
    const nextSeq = seq + 1;
    if (nextSeq > 65536) break;
    let next = read(slot(ref.root, nextSeq), credentialFile);
    if (!next) {
      seam?.afterMissingSlot?.(nextSeq);
      next = read(slot(ref.root, nextSeq), credentialFile);
    }
    if (!next) {
      const maxIdx = maxSlotIndex(ref.root);
      // Enumeration may see several concurrent appends after the absent read.
      // Verify the next contiguous slot; a real hole still refuses. Publication
      // separately compares expectedDigest and never rebases consent.
      if (maxIdx >= nextSeq) {
        next = read(slot(ref.root, nextSeq), credentialFile);
        if (!next) return fail();
      }
    }
    if (!next) break;
    seq = nextSeq; bytes = next;
  }
  return { snapshots, envelopes, bytes: total };
}
export function readLivePolicy(raw: LivePolicyRef, options: { readonly credentialFile?: string; readonly watermark?: LiveReaderWatermark; readonly seam?: LiveReaderSeam } = {}): LiveSnapshot {
  const ref = reference(raw); const h = history(ref, options.credentialFile, options.seam); const tip = h.snapshots.at(-1)!; const w = options.watermark;
  if (w) {
    if (w.sequence !== undefined && (w.policyId !== ref.policyId || !Number.isSafeInteger(w.sequence) || w.sequence < 0 || h.snapshots[w.sequence]?.digest !== w.digest)) fail();
    Object.assign(w, { sequence: tip.sequence, digest: tip.digest, policyId: ref.policyId });
  }
  return tip;
}
type Io = Required<NonNullable<MessagingPairOptions["io"]>>;
function syncDir(root: string, io: Io): void {
  const fd = io.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
}
function stage(root: string, bytes: Buffer, io: Io, credentialFile?: string): string {
  if (bytes.length > 65536) return fail();
  const path = join(root, `.live-stage-${randomUUID()}`);
  const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { io.writeFileSync(fd, bytes); io.fsyncSync(fd); } finally { io.closeSync(fd); }
  const checked = read(path, credentialFile); if (!checked?.equals(bytes)) return fail(); return path;
}
function makeEnvelope(policyId: string, sequence: number, parentDigest: string | null, operationId: string, i: Intent, manifest: Manifest): Envelope {
  return { kind: KIND, policyId, sequence, parentDigest, identityDigest: digest(fixed(manifest)), operationId, intent: i, manifestDigest: digest(manifest), manifest };
}
const defaultIo = (): Io => ({ openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync });
/** Isolated offline preparation only. The caller supplies an existing empty private root. */
export function initializeLivePolicy(input: { readonly root: string; readonly manifest: MultiSessionManifest; readonly credentialFile?: string }): LivePolicyRef {
  directory(input.root); if (fs.readdirSync(input.root).length) return fail();
  const base = parseMultiSessionManifest(input.manifest);
  const manifest = parseManifest({ ...base, registrations: base.registrations.map(r => ({ ...r, payloadReadGeneration: 0, ackGeneration: 0, presenceDisclosure: false })) }, 0);
  const policyId = randomUUID(); const bytes = Buffer.from(json(makeEnvelope(policyId, 0, null, randomUUID(), { kind: "genesis" }, manifest)));
  const io = defaultIo(); const path = stage(input.root, bytes, io, input.credentialFile);
  io.linkSync(path, slot(input.root, 0)); syncDir(input.root, io);
  return Object.freeze({ kind: KIND, root: input.root, policyId, genesisDigest: hash(bytes) });
}
const locatorPrefix = (runtime: string): string => `.live-intent-${hash(runtime)}-`;
function parseLocator(bytes: Buffer): Locator {
  let raw: unknown; try { raw = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
  const r = closed(raw, ["kind", "policyId", "runtimeSessionId", "parentSequence", "parentDigest", "sequence", "operationId", "intentDigest", "candidateDigest"]);
  if (r.kind !== "ce-live-locator-v1" || integer(r.sequence) !== integer(r.parentSequence) + 1) return fail();
  return { kind: "ce-live-locator-v1", policyId: label(r.policyId), runtimeSessionId: label(r.runtimeSessionId),
    parentSequence: integer(r.parentSequence), parentDigest: sha(r.parentDigest), sequence: integer(r.sequence),
    operationId: label(r.operationId), intentDigest: sha(r.intentDigest), candidateDigest: sha(r.candidateDigest) };
}
export function createLivePolicyRegistration(options: { readonly ref: LivePolicyRef; readonly credentialFile?: string; readonly io?: MessagingPairOptions["io"] }) {
  const ref = reference(options.ref); const io = { ...defaultIo(), ...options.io }; const watermark: LiveReaderWatermark = {};
  const load = (): LiveSnapshot => readLivePolicy(ref, { ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }), watermark });
  function reconcile(input: { readonly runtimeSessionId: string }): readonly LiveReconciliation[] {
    const runtime = label(input.runtimeSessionId); reference(ref);
    const names = fs.readdirSync(ref.root).filter(n => n.startsWith(locatorPrefix(runtime)));
    if (names.length > 1024) return fail();
    const h = history(ref, options.credentialFile);
    for (const e of h.envelopes.slice(1)) {
      const owner = e.intent.kind === "register" || e.intent.kind === "reauthorize" ? e.intent.registration.runtimeSessionId : e.manifest.registrations.find(r => e.intent.kind === "revoke" && r.endpointId === e.intent.endpointId)?.runtimeSessionId;
      if (owner === runtime && !names.includes(`${locatorPrefix(runtime)}${hash(e.operationId)}.json`)) fail();
    }
    return Object.freeze(names.sort().map(name => {
      const l = parseLocator(read(join(ref.root, name), options.credentialFile) ?? fail());
      if (l.policyId !== ref.policyId || l.runtimeSessionId !== runtime || name !== `${locatorPrefix(runtime)}${hash(l.operationId)}.json`) return fail();
      const parent = h.snapshots[l.parentSequence]; const candidate = h.snapshots[l.sequence]; const e = h.envelopes[l.sequence];
      if (parent?.digest !== l.parentDigest) return fail();
      const outcome = !candidate ? "NOT_OBSERVED" : candidate.digest === l.candidateDigest && e?.operationId === l.operationId && digest(e.intent) === l.intentDigest ? "PUBLISHED" : "COMPETING_COMMIT";
      return Object.freeze({ operationId: l.operationId, sequence: l.sequence, outcome });
    }));
  }
  function publish(expectedDigest: string, i: Intent, operationId?: string): LivePublication {
    sha(expectedDigest); const current = load(); if (current.digest !== expectedDigest) return conflict();
    if (current.sequence >= 65536) return fail();
    const next = transform(current.manifest, i, current.sequence + 1);
    const runtime = i.kind === "register" || i.kind === "reauthorize" ? i.registration.runtimeSessionId : current.manifest.registrations.find(r => i.kind === "revoke" && r.endpointId === i.endpointId)!.runtimeSessionId;
    const prior = reconcile({ runtimeSessionId: runtime });
    // Unresolved attempts never authorize replay or a new speculative publication.
    if (prior.some(r => r.outcome === "NOT_OBSERVED" || r.outcome === "UNKNOWN") || prior.length >= 1024) return fail();
    const op = label(operationId ?? randomUUID()); if (prior.some(r => r.operationId === op)) return conflict();
    const e = makeEnvelope(ref.policyId, current.sequence + 1, current.digest, op, i, next); const bytes = Buffer.from(json(e));
    const h = history(ref, options.credentialFile); if (h.bytes + bytes.length > 64 * 1024 * 1024) return fail();
    const prepared = stage(ref.root, bytes, io, options.credentialFile);
    const l: Locator = { kind: "ce-live-locator-v1", policyId: ref.policyId, runtimeSessionId: runtime, parentSequence: current.sequence, parentDigest: current.digest,
      sequence: e.sequence, operationId: op, intentDigest: digest(i), candidateDigest: hash(bytes) };
    const locator = stage(ref.root, Buffer.from(json(l)), io, options.credentialFile);
    io.linkSync(locator, join(ref.root, `${locatorPrefix(runtime)}${hash(op)}.json`)); syncDir(ref.root, io);
    if (load().digest !== expectedDigest) return conflict();
    try { io.linkSync(prepared, slot(ref.root, e.sequence)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { load(); return conflict(); }
      throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.livePolicy.publicationUnknown");
    }
    let durability: "synced" | "uncertain" = "synced";
    try { syncDir(ref.root, io); } catch { durability = "uncertain"; }
    return Object.freeze({ snapshot: load(), durability, operationId: op });
  }
  return {
    register: (input: { readonly expectedDigest: string; readonly registration: Registration; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "register", registration: registration(input.registration) }, input.operationId),
    reauthorize: (input: { readonly expectedDigest: string; readonly registration: Registration; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "reauthorize", registration: registration(input.registration) }, input.operationId),
    revoke: (input: { readonly expectedDigest: string; readonly endpointId: string; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "revoke", endpointId: label(input.endpointId) }, input.operationId),
    reconcile,
  };
}
