/** Private offline/live configuration history. No Store, Owner or transport authority. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseMultiSessionManifest, type MultiSessionManifest, type SessionRegistration } from "./multi-session-policy.js";
import { readPrivateMessagingFile, type MessagingPairOptions } from "./messaging-config.js";
import { TunnelRefusal } from "./codes.js";
import { parseHookRules, type CeHookRule } from "../hooks/config.js";
export interface LivePolicyV1Ref { readonly kind: "ce-live-session-v1"; readonly root: string; readonly policyId: string; readonly genesisDigest: string; }
export interface LivePolicyV2Ref { readonly kind: "ce-live-session-v2"; readonly root: string; readonly policyId: string; readonly genesisDigest: string; readonly profilePath: string; readonly upgradeSequence: number; }
export type LivePolicyRef = LivePolicyV1Ref | LivePolicyV2Ref;
export interface McpHookTarget { readonly ruleId: string; readonly endpointId: string; readonly runtimeSessionId: string; readonly epoch: number; }
export interface McpHookConsent { readonly generation: number; readonly bindingGeneration: string | null; readonly targets: readonly McpHookTarget[]; }
export interface LiveRegistration extends SessionRegistration { readonly payloadReadGeneration: number; readonly ackGeneration: number; readonly presenceDisclosure: boolean; readonly hookGeneration?: number; }
export interface LiveSnapshot { readonly ref: LivePolicyRef; readonly sequence: number; readonly digest: string; readonly manifest: Omit<MultiSessionManifest, "registrations"> & { readonly registrations: readonly LiveRegistration[]; readonly mcpHookConsent?: McpHookConsent }; }
export interface LiveReaderWatermark { sequence?: number; digest?: string; policyId?: string; }
type Manifest = LiveSnapshot["manifest"];
type Registration = Pick<LiveRegistration, "endpointId" | "runtimeSessionId" | "payloadRead" | "ack" | "presenceDisclosure">;
type Intent = { kind: "genesis" } | { kind: "register" | "reauthorize"; registration: Registration } | { kind: "revoke"; endpointId: string }
  | { kind: "upgrade"; actorRuntimeSessionId: string; profileRevision: string; bindingGeneration: string }
  | { kind: "set-pi-hooks"; runtimeSessionId: string; endpointId: string; epoch: number; hooks: readonly CeHookRule[] }
  | { kind: "set-mcp-hooks"; actorRuntimeSessionId: string; bindingGeneration: string; targets: readonly McpHookTarget[] };
interface Envelope { kind: LivePolicyRef["kind"]; policyId: string; sequence: number; parentDigest: string | null; identityDigest: string; operationId: string; intent: Intent; manifestDigest: string; manifest: Manifest; }
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
  const v2 = raw.kind === "ce-live-session-v2";
  const r = closed(raw, ["kind", "root", "policyId", "genesisDigest", ...(v2 ? ["profilePath", "upgradeSequence"] : [])]);
  if (r.kind !== KIND && !v2 || typeof r.root !== "string") return fail();
  if (v2 && (integer(r.upgradeSequence) < 1 || typeof r.profilePath !== "string" || !isAbsolute(r.profilePath) || normalize(r.profilePath) !== r.profilePath)) return fail();
  directory(r.root); label(r.policyId); sha(r.genesisDigest); return Object.freeze({ ...raw });
}
function read(path: string, credentialFile?: string): Buffer | undefined {
  const data = readPrivateMessagingFile(path, credentialFile); if (data) acl(path); return data?.bytes;
}
function parseManifest(raw: unknown, sequence: number, v2 = false): Manifest {
  if (raw === null || typeof raw !== "object") return fail();
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.registrations)) return fail();
  const extras = r.registrations.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return fail();
    const e = entry as Record<string, unknown>;
    closed(e, ["endpointId", "runtimeSessionId", "epoch", "status", "payloadRead", "ack", "payloadReadGeneration", "ackGeneration", "presenceDisclosure", ...(Object.hasOwn(e, "hooks") ? ["hooks"] : []), ...(v2 ? ["hookGeneration"] : [])]);
    if (typeof e.presenceDisclosure !== "boolean" || integer(e.payloadReadGeneration) > sequence || integer(e.ackGeneration) > sequence) return fail();
    const { payloadReadGeneration, ackGeneration, presenceDisclosure, hookGeneration, ...base } = e;
    if (v2 && integer(hookGeneration) > sequence) return fail();
    return { base, payloadReadGeneration: payloadReadGeneration as number, ackGeneration: ackGeneration as number, presenceDisclosure, ...(v2 ? { hookGeneration: hookGeneration as number } : {}) };
  });
  const { mcpHookConsent, ...baseRaw } = r;
  if (!v2 && Object.hasOwn(r, "mcpHookConsent")) return fail();
  const consent = v2 ? parseConsent(mcpHookConsent, sequence) : undefined;
  const base = parseMultiSessionManifest({ ...baseRaw, registrations: extras.map(e => e.base) });
  return Object.freeze({ ...base, ...(consent ? { mcpHookConsent: consent } : {}), registrations: Object.freeze(base.registrations.map((e, i) => Object.freeze({ ...e,
    ...(v2 ? { hookGeneration: extras[i]!.hookGeneration! } : {}),
    payloadReadGeneration: extras[i]!.payloadReadGeneration, ackGeneration: extras[i]!.ackGeneration, presenceDisclosure: extras[i]!.presenceDisclosure }))) });
}
function registration(raw: unknown): Registration {
  const r = closed(raw, ["endpointId", "runtimeSessionId", "payloadRead", "ack", "presenceDisclosure"]);
  if (typeof r.payloadRead !== "boolean" || typeof r.ack !== "boolean" || typeof r.presenceDisclosure !== "boolean") return fail();
  return Object.freeze({ endpointId: label(r.endpointId), runtimeSessionId: label(r.runtimeSessionId), payloadRead: r.payloadRead, ack: r.ack, presenceDisclosure: r.presenceDisclosure });
}
function targets(raw: unknown): readonly McpHookTarget[] {
  if (!Array.isArray(raw) || raw.length > 64) return fail();
  const ids = new Set<string>();
  return Object.freeze(raw.map(value => { const r = closed(value, ["ruleId", "endpointId", "runtimeSessionId", "epoch"]);
    // Rule IDs follow the Hook grammar; identity fields retain the credential guard.
    const ruleId = r.ruleId; if (typeof ruleId !== "string" || ruleId.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ruleId) || ids.has(ruleId) || integer(r.epoch) < 1) return fail(); ids.add(ruleId);
    return Object.freeze({ ruleId, endpointId: label(r.endpointId), runtimeSessionId: label(r.runtimeSessionId), epoch: r.epoch as number }); }));
}
function parseConsent(raw: unknown, seq: number): McpHookConsent {
  const r = closed(raw, ["generation", "bindingGeneration", "targets"]); const t = targets(r.targets);
  if (integer(r.generation) > seq || r.bindingGeneration === null && t.length) return fail();
  return Object.freeze({ generation: r.generation as number, bindingGeneration: r.bindingGeneration === null ? null : sha(r.bindingGeneration), targets: t });
}
function intent(raw: unknown, v2 = false): Intent {
  const k = (raw as { kind?: unknown } | null)?.kind;
  if (k === "genesis") { closed(raw, ["kind"]); return { kind: k }; }
  if (k === "register" || k === "reauthorize") { const r = closed(raw, ["kind", "registration"]); return { kind: k, registration: registration(r.registration) }; }
  if (k === "revoke") { const r = closed(raw, ["kind", "endpointId"]); return { kind: k, endpointId: label(r.endpointId) }; }
  if (v2 && k === "upgrade") { const r = closed(raw, ["kind", "actorRuntimeSessionId", "profileRevision", "bindingGeneration"]); return { kind: k, actorRuntimeSessionId: label(r.actorRuntimeSessionId), profileRevision: sha(r.profileRevision), bindingGeneration: sha(r.bindingGeneration) }; }
  if (v2 && k === "set-pi-hooks") { const r = closed(raw, ["kind", "runtimeSessionId", "endpointId", "epoch", "hooks"]); if (integer(r.epoch) < 1 || !Array.isArray(r.hooks)) return fail(); let hooks: readonly CeHookRule[]; try { hooks = parseHookRules(r.hooks); } catch { return fail(); } return { kind: k, runtimeSessionId: label(r.runtimeSessionId), endpointId: label(r.endpointId), epoch: r.epoch as number, hooks }; }
  if (v2 && k === "set-mcp-hooks") { const r = closed(raw, ["kind", "actorRuntimeSessionId", "bindingGeneration", "targets"]); return { kind: k, actorRuntimeSessionId: label(r.actorRuntimeSessionId), bindingGeneration: sha(r.bindingGeneration), targets: targets(r.targets) }; }
  return fail();
}
function fixed(m: Manifest): Omit<Manifest, "registrations"> { const { registrations: _, ...rest } = m; return rest; }
function transform(m: Manifest, i: Intent, seq: number): Manifest {
  if (i.kind === "genesis") return fail();
  const v2 = m.mcpHookConsent !== undefined;
  if (i.kind === "upgrade") {
    if (v2) return fail();
    return parseManifest({ ...m, registrations: m.registrations.map(r => ({ ...r, hookGeneration: seq })), mcpHookConsent: { generation: seq, bindingGeneration: null, targets: [] } }, seq, true);
  }
  if (i.kind === "set-pi-hooks") {
    if (!v2 || !m.registrations.some(r => r.status === "active" && r.endpointId === i.endpointId && r.runtimeSessionId === i.runtimeSessionId && r.epoch === i.epoch)) return fail();
    return parseManifest({ ...m, registrations: m.registrations.map(r => r.endpointId === i.endpointId ? { ...r, hooks: i.hooks, hookGeneration: seq } : r) }, seq, true);
  }
  if (i.kind === "set-mcp-hooks") {
    if (!v2 || i.targets.some(t => !m.registrations.some(r => r.status === "active" && r.endpointId === t.endpointId && r.runtimeSessionId === t.runtimeSessionId && r.epoch === t.epoch))) return fail();
    return parseManifest({ ...m, mcpHookConsent: { generation: seq, bindingGeneration: i.bindingGeneration, targets: i.targets } }, seq, true);
  }
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
    next = { ...old, ...r, ...(v2 && !old ? { hooks: [], hookGeneration: seq } : {}), epoch: restoring ? old!.epoch + 1 : old?.epoch ?? 1, status: "active",
      payloadReadGeneration: restoring || !old || old.payloadRead !== r.payloadRead ? seq : old.payloadReadGeneration,
      ackGeneration: restoring || !old || old.ack !== r.ack ? seq : old.ackGeneration };
  }
  return parseManifest({ ...m, registrations: old ? m.registrations.map(r => r === old ? next : r) : [...m.registrations, next] }, seq, v2);
}
const slot = (root: string, seq: number): string => join(root, `${String(seq).padStart(6, "0")}.json`);
function envelope(bytes: Buffer, v2 = false): Envelope {
  let raw: unknown; try { raw = JSON.parse(bytes.toString("utf8")); } catch { return fail(); }
  const r = closed(raw, ["kind", "policyId", "sequence", "parentDigest", "identityDigest", "operationId", "intent", "manifestDigest", "manifest"]);
  if (r.kind !== (v2 ? "ce-live-session-v2" : KIND)) return fail();
  const seq = integer(r.sequence); const m = parseManifest(r.manifest, seq, v2);
  if (r.parentDigest !== null) sha(r.parentDigest);
  if (sha(r.identityDigest) !== digest(fixedIdentity(m, v2)) || sha(r.manifestDigest) !== digest(m)) return fail();
  return { kind: v2 ? "ce-live-session-v2" : KIND, policyId: label(r.policyId), sequence: seq, parentDigest: r.parentDigest as string | null,
    identityDigest: sha(r.identityDigest), operationId: label(r.operationId), intent: intent(r.intent, v2), manifestDigest: sha(r.manifestDigest), manifest: m };
}
/** Deterministic test seam for a commit that lands during a read. Production callers omit it. */
export interface LiveReaderSeam { readonly afterMissingSlot?: (sequence: number) => void; }
function maxSlotIndex(root: string): number {
  let max = -1;
  for (const name of fs.readdirSync(root)) if (/^\d{6}\.json$/.test(name)) max = Math.max(max, Number(name.slice(0, 6)));
  return max;
}
function history(ref: LivePolicyRef, credentialFile?: string, seam?: LiveReaderSeam): { snapshots: LiveSnapshot[]; envelopes: Envelope[]; bytes: number; upgraded: boolean } {
  const snapshots: LiveSnapshot[] = []; const envelopes: Envelope[] = [];
  let total = 0; let seq = 0;
  let bytes = read(slot(ref.root, 0), credentialFile); if (!bytes) return fail();
  for (;;) {
    total += bytes.length; if (total > 64 * 1024 * 1024) return fail();
    const v2 = ref.kind === "ce-live-session-v2" && seq >= ref.upgradeSequence;
    const e = envelope(bytes, v2); const d = hash(bytes); const prev = snapshots.at(-1);
    if (e.policyId !== ref.policyId || e.sequence !== seq || e.parentDigest !== (prev?.digest ?? null)) return fail();
    if (!prev) {
      if (d !== ref.genesisDigest || e.intent.kind !== "genesis" || e.manifest.registrations.some(r => r.payloadReadGeneration !== 0 || r.ackGeneration !== 0)) return fail();
    } else {
      if (v2 && (seq === ref.upgradeSequence ? e.intent.kind !== "upgrade" : e.intent.kind === "upgrade")) return fail();
      if (!isDeepStrictEqual(fixedIdentity(prev.manifest, v2), fixedIdentity(e.manifest, v2)) || !isDeepStrictEqual(transform(prev.manifest, e.intent, seq), e.manifest)) return fail();
    }
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
  const upgraded = ref.kind !== "ce-live-session-v2" || seq >= ref.upgradeSequence;
  return { snapshots, envelopes, bytes: total, upgraded };
}
export function readLivePolicy(raw: LivePolicyRef, options: { readonly credentialFile?: string; readonly watermark?: LiveReaderWatermark; readonly seam?: LiveReaderSeam } = {}): LiveSnapshot {
  const ref = reference(raw); const h = history(ref, options.credentialFile, options.seam);
  // A pinned v2 reference only reads a chain whose upgrade marker was published.
  if (!h.upgraded) return fail();
  const tip = h.snapshots.at(-1)!; const w = options.watermark;
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
function fixedIdentity(m: Manifest, v2: boolean) { if (!v2) return fixed(m); const { mcpHookConsent: _, ...rest } = fixed(m); return rest; }
function makeEnvelope(policyId: string, sequence: number, parentDigest: string | null, operationId: string, i: Intent, manifest: Manifest): Envelope {
  const v2 = manifest.mcpHookConsent !== undefined;
  return { kind: v2 ? "ce-live-session-v2" : KIND, policyId, sequence, parentDigest, identityDigest: digest(fixedIdentity(manifest, v2)), operationId, intent: i, manifestDigest: digest(manifest), manifest };
}
const defaultIo = (): Io => ({ openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, linkSync: fs.linkSync });
/** Isolated offline preparation only. The caller supplies an existing empty private root. */
export function initializeLivePolicy(input: { readonly root: string; readonly manifest: MultiSessionManifest; readonly credentialFile?: string }): LivePolicyV1Ref {
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
/** Offline preparation of the pinned v2 reference for the same immutable history.
 *  No publication happens here and no genesis is reset. */
export function prepareLivePolicyUpgrade(v1: LivePolicyRef, profilePath: string): LivePolicyV2Ref {
  const ref = reference(v1);
  if (ref.kind !== KIND) return fail();
  if (!isAbsolute(profilePath) || normalize(profilePath) !== profilePath) return fail();
  const tip = readLivePolicy(ref);
  if (tip.sequence >= 65536) return fail();
  return Object.freeze({ kind: "ce-live-session-v2", root: ref.root, policyId: ref.policyId, genesisDigest: ref.genesisDigest, profilePath, upgradeSequence: tip.sequence + 1 });
}
function ownerOf(e: Envelope): string | undefined {
  switch (e.intent.kind) {
    case "genesis": return undefined;
    case "register": case "reauthorize": return e.intent.registration.runtimeSessionId;
    case "revoke": { const endpointId = e.intent.endpointId; return e.manifest.registrations.find(r => r.endpointId === endpointId)?.runtimeSessionId; }
    // New intents carry their trusted actor in the closed intent record. The
    // actor is publication attribution only, never an Owner or capability.
    case "upgrade": return e.intent.actorRuntimeSessionId;
    case "set-pi-hooks": return e.intent.runtimeSessionId;
    case "set-mcp-hooks": return e.intent.actorRuntimeSessionId;
    default: return fail();
  }
}
/** Read-only proof for an explicitly identified configuration publication.
 * Locator attribution is evidence, never ownership or execution authority. */
export function readLiveHookPublication(input: { readonly ref: LivePolicyV2Ref; readonly runtimeSessionId: string; readonly operationId: string; readonly credentialFile: string }): {
  readonly sequence: number;
  readonly intent: Extract<Intent, { kind: "upgrade" | "set-mcp-hooks" }>;
  readonly snapshot: LiveSnapshot;
} {
  const ref = reference(input.ref);
  if (ref.kind !== "ce-live-session-v2") return fail();
  const runtime = label(input.runtimeSessionId); const operation = label(input.operationId);
  const reconciled = createLivePolicyRegistration({ ref, credentialFile: input.credentialFile }).reconcile({ runtimeSessionId: runtime });
  const record = reconciled.find(r => r.operationId === operation);
  if (!record || record.outcome !== "PUBLISHED") return fail();
  const h = history(ref, input.credentialFile);
  if (!h.upgraded) return fail();
  const e = h.envelopes[record.sequence];
  if (!e || e.operationId !== operation || ownerOf(e) !== runtime || (e.intent.kind !== "upgrade" && e.intent.kind !== "set-mcp-hooks")) return fail();
  return Object.freeze({ sequence: record.sequence, intent: Object.freeze(e.intent), snapshot: h.snapshots[record.sequence]! });
}
export function createLivePolicyRegistration(options: { readonly ref: LivePolicyRef; readonly credentialFile?: string; readonly io?: MessagingPairOptions["io"] }) {
  const ref = reference(options.ref); const io = { ...defaultIo(), ...options.io }; const watermark: LiveReaderWatermark = {};
  const load = (): LiveSnapshot => readLivePolicy(ref, { ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }), watermark });
  function evidenceHistory(): ReturnType<typeof history> {
    if (ref.kind === "ce-live-session-v2") {
      const marker = read(slot(ref.root, ref.upgradeSequence), options.credentialFile);
      if (marker) {
        let raw: unknown; try { raw = JSON.parse(marker.toString("utf8")); } catch { return fail(); }
        if ((raw as { kind?: unknown } | null)?.kind === KIND) {
          // Only an explicitly v1 marker-slot envelope selects the original
          // reader. Validate the full original chain before classifying a lost
          // upgrade race; malformed v2 never falls back to v1.
          envelope(marker);
          return history({ kind: KIND, root: ref.root, policyId: ref.policyId, genesisDigest: ref.genesisDigest }, options.credentialFile);
        }
      }
    }
    return history(ref, options.credentialFile);
  }
  function reconcile(input: { readonly runtimeSessionId: string }): readonly LiveReconciliation[] {
    const runtime = label(input.runtimeSessionId); reference(ref);
    const names = fs.readdirSync(ref.root).filter(n => n.startsWith(locatorPrefix(runtime)));
    if (names.length > 1024) return fail();
    const h = evidenceHistory();
    for (const e of h.envelopes.slice(1)) {
      const owner = ownerOf(e);
      if (owner === undefined) return fail();
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
    return publishFrom(current, i, operationId);
  }
  function publishFrom(current: LiveSnapshot, i: Intent, operationId?: string, verify?: () => LiveSnapshot): LivePublication {
    if (current.sequence >= 65536) return fail();
    i = intent(i, ref.kind === "ce-live-session-v2");
    const next = transform(current.manifest, i, current.sequence + 1);
    const runtime = ownerOf({ kind: KIND, policyId: ref.policyId, sequence: current.sequence + 1, parentDigest: current.digest,
      identityDigest: "0".repeat(64), operationId: "pending", intent: i, manifestDigest: "0".repeat(64), manifest: current.manifest });
    if (!runtime) return fail();
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
    if ((verify ?? load)().digest !== current.digest) return conflict();
    try { io.linkSync(prepared, slot(ref.root, e.sequence)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const observed = evidenceHistory();
        if (observed.snapshots[current.sequence]?.digest !== current.digest || !observed.snapshots[e.sequence]) return fail();
        return conflict();
      }
      throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.livePolicy.publicationUnknown");
    }
    let durability: "synced" | "uncertain" = "synced";
    try { syncDir(ref.root, io); } catch { durability = "uncertain"; }
    return Object.freeze({ snapshot: load(), durability, operationId: op });
  }
  /** Publishes the unique v2 upgrade marker into the prepared next slot.
   *  The original v1 tip is read before the marker and the pinned v2 chain is
   *  read afterwards. There is no rebase and no second attempt. */
  function upgrade(input: { readonly expectedDigest: string; readonly actorRuntimeSessionId: string; readonly profileRevision: string; readonly bindingGeneration: string; readonly operationId?: string }): LivePublication {
    if (ref.kind !== "ce-live-session-v2") return fail();
    const v1ref: LivePolicyV1Ref = { kind: KIND, root: ref.root, policyId: ref.policyId, genesisDigest: ref.genesisDigest };
    let tip: LiveSnapshot;
    try { tip = readLivePolicy(v1ref, { ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }) }); }
    catch { return fail(); }
    sha(input.expectedDigest);
    if (tip.digest !== input.expectedDigest) return conflict();
    if (tip.sequence + 1 !== ref.upgradeSequence) return fail();
    // Upgrade must account for every old writer's durable requests, including
    // actors with no committed registration yet. Locators are bounded per actor.
    const actors = new Set<string>(tip.manifest.registrations.map(r => r.runtimeSessionId));
    const names = fs.readdirSync(ref.root).filter(n => n.startsWith(".live-intent-"));
    for (const name of names) {
      const l = parseLocator(read(join(ref.root, name), options.credentialFile) ?? fail());
      actors.add(l.runtimeSessionId);
    }
    for (const actor of actors) if (reconcile({ runtimeSessionId: actor }).some(r => r.outcome === "NOT_OBSERVED" || r.outcome === "UNKNOWN")) return fail();
    const intent: Intent = { kind: "upgrade", actorRuntimeSessionId: label(input.actorRuntimeSessionId), profileRevision: sha(input.profileRevision), bindingGeneration: sha(input.bindingGeneration) };
    return publishFrom(tip, intent, input.operationId, () => readLivePolicy(v1ref, { ...(options.credentialFile === undefined ? {} : { credentialFile: options.credentialFile }) }));
  }
  return {
    register: (input: { readonly expectedDigest: string; readonly registration: Registration; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "register", registration: registration(input.registration) }, input.operationId),
    reauthorize: (input: { readonly expectedDigest: string; readonly registration: Registration; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "reauthorize", registration: registration(input.registration) }, input.operationId),
    revoke: (input: { readonly expectedDigest: string; readonly endpointId: string; readonly operationId?: string }): LivePublication => publish(input.expectedDigest, { kind: "revoke", endpointId: label(input.endpointId) }, input.operationId),
    upgrade,
    setPiHooks: (input: { readonly expectedDigest: string; readonly runtimeSessionId: string; readonly endpointId: string; readonly epoch: number; readonly hooks: readonly CeHookRule[]; readonly operationId?: string }): LivePublication =>
      publish(input.expectedDigest, { kind: "set-pi-hooks", runtimeSessionId: label(input.runtimeSessionId), endpointId: label(input.endpointId), epoch: integer(input.epoch), hooks: input.hooks }, input.operationId),
    setMcpHooks: (input: { readonly expectedDigest: string; readonly actorRuntimeSessionId: string; readonly bindingGeneration: string; readonly targets: readonly McpHookTarget[]; readonly operationId?: string }): LivePublication =>
      publish(input.expectedDigest, { kind: "set-mcp-hooks", actorRuntimeSessionId: label(input.actorRuntimeSessionId), bindingGeneration: sha(input.bindingGeneration), targets: input.targets }, input.operationId),
    reconcile,
  };
}
