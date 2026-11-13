/** Bounded Pi lifecycle observations only. These records confer no CE permissions,
 * process ownership, delivery receipt, or Task Owner authority. */
import fs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readPrivateMessagingFile } from "./messaging-config.js";
import type { LivePolicyRef, LiveSnapshot } from "./live-session-policy.js";
import type { CurrentBindingResult } from "../control/mcp/endpoint-discovery.js";

export const CURRENT_RUNTIME_TTL_MS = 5_000;
export const RUNTIME_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$";
const runtimeIdSchema = Type.String({ pattern: RUNTIME_ID_PATTERN });
const RecordSchema = Type.Object({ version: Type.Literal(1), runtimeId: runtimeIdSchema,
  observerId: Type.String({ pattern: "^[a-f0-9-]{36}$" }), policyId: Type.String({ minLength: 1, maxLength: 256 }),
  genesisDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }), sessionId: Type.String({ minLength: 1, maxLength: 256 }),
  state: Type.Union([Type.Literal("current"), Type.Literal("stopped")]),
  observedAt: Type.Integer({ minimum: 0 }), expiresAt: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
type Observation = Static<typeof RecordSchema>;
function directory(ref: LivePolicyRef, create = false): string {
  const path = join(ref.root, "current-runtimes");
  if (create) fs.mkdirSync(path, { mode: 0o700, recursive: true });
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) throw new Error("runtime observation unavailable");
  return path;
}

/** The caller owns the real Pi event/heartbeat boundary. Each factory gets a
 * distinct observer incarnation; competing writers are never a recency race. */
export function createCurrentRuntimeObserver(ref: LivePolicyRef, runtimeId: string, now = Date.now, observerId = randomUUID()) {
  if (!Value.Check(runtimeIdSchema, runtimeId) || !Value.Check(RecordSchema.properties.observerId, observerId)) throw new Error("invalid runtime scope");
  let sessionId: string | undefined;
  const write = (state: Observation["state"]): boolean => {
    if (sessionId === undefined) return false;
    let stage: string | undefined;
    try {
      const parent = directory(ref, true), time = now();
      const record: Observation = { version: 1, runtimeId, observerId, policyId: ref.policyId, genesisDigest: ref.genesisDigest,
        sessionId, state, observedAt: time, expiresAt: time + CURRENT_RUNTIME_TTL_MS };
      if (!Value.Check(RecordSchema, record)) return false;
      stage = join(parent, `${observerId}.${randomUUID()}.tmp`);
      fs.writeFileSync(stage, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      fs.renameSync(stage, join(parent, `${observerId}.json`));
      return true;
    } catch { return false; }
    finally { if (stage !== undefined) { try { fs.unlinkSync(stage); } catch { /* already published or unavailable */ } } }
  };
  return Object.freeze({
    observe(currentSessionId: string) { sessionId = currentSessionId; return write("current"); },
    stop() {
      if (!write("stopped")) return false;
      // Only this process incarnation is retired. Never collect another writer's
      // expired file: it may have refreshed since a reader inspected it.
      try { fs.unlinkSync(join(directory(ref), `${observerId}.json`)); } catch { /* the stopped record remains deny-only */ }
      return true;
    },
  });
}

/** Invalid evidence is deny-only, including an unreadable competing claim. A
 * short lease bounds abrupt-exit residue; this is not remote reachability. */
export function discoverCurrentRuntimes(snapshot: LiveSnapshot, visibleEndpoints: readonly string[], runtimeId?: string, now = Date.now()): {
  runtimes: { runtimeId: string }[]; currentBinding?: CurrentBindingResult;
} {
  const unknown = (): { runtimes: { runtimeId: string }[]; currentBinding?: CurrentBindingResult } => ({ runtimes: [],
    ...(runtimeId === undefined ? {} : { currentBinding: { status: "unknown" as const, runtimeId } }) });
  try {
    const parent = directory(snapshot.ref), names = fs.readdirSync(parent);
    const claims: Observation[] = [];
    for (const name of names) {
      if (name.endsWith(".tmp")) continue;
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) return unknown();
      const file = readPrivateMessagingFile(join(parent, name)); if (file === undefined) return unknown();
      const record: unknown = JSON.parse(file.bytes.toString("utf8"));
      if (!Value.Check(RecordSchema, record) || name !== `${record.observerId}.json` || record.policyId !== snapshot.ref.policyId || record.genesisDigest !== snapshot.ref.genesisDigest) return unknown();
      if (record.observedAt > now || record.expiresAt - record.observedAt !== CURRENT_RUNTIME_TTL_MS) return unknown();
      if (record.state !== "current" || record.expiresAt <= now) continue;
      claims.push(record);
      // Bound live output, not historical files left behind by crashes.
      if (claims.length > 128) return unknown();
    }
    const visible = (claim: Observation) => snapshot.manifest.registrations.find(r => r.runtimeSessionId === claim.sessionId && r.status === "active" && r.presenceDisclosure && visibleEndpoints.includes(r.endpointId));
    const runtimes = [...new Set(claims.filter(c => visible(c) !== undefined).map(c => c.runtimeId))].sort().map(runtimeId => ({ runtimeId }));
    if (runtimeId === undefined) return { runtimes };
    const matches = claims.filter(c => c.runtimeId === runtimeId);
    if (matches.length === 0 || matches.some(c => visible(c) === undefined)) return { runtimes, currentBinding: { status: "unknown", runtimeId } };
    if (matches.length > 1) return { runtimes, currentBinding: { status: "ambiguous", runtimeId } };
    const claim = matches[0]!, registration = visible(claim)!;
    return { runtimes, currentBinding: { status: "verified", runtimeId, endpointId: registration.endpointId,
      source: "pi.runtime.lifecycle", observedAt: new Date(claim.observedAt).toISOString(), expiresAt: new Date(claim.expiresAt).toISOString() } };
  } catch { return unknown(); }
}
