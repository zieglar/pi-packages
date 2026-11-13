/** Metadata-only /new observations. The local Pi extension/OS user is trusted;
 * hashes correlate its two lifecycle events, not an authority or a signature.
 * These files never grant Endpoint permissions or move message/task state. */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readPrivateMessagingFile } from "./messaging-config.js";
import { readLivePolicy, type LivePolicyRef, type LiveSnapshot } from "./live-session-policy.js";
import type { SessionSwitchResult } from "../control/mcp/endpoint-discovery.js";

const closed = { additionalProperties: false } as const;
const label = Type.String({ minLength: 1, maxLength: 256 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$" });
const time = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" });
const Departure = Type.Object({
  version: Type.Literal(1), source: Type.Literal("pi.session_shutdown.new"),
  policyId: label, genesisDigest: digest, runtimeSessionId: label, endpointId: label, epoch: Type.Integer({ minimum: 1 }),
  sessionFileDigest: digest, targetSessionFileDigest: digest, observedAt: time,
}, closed);
const Arrival = Type.Object({
  version: Type.Literal(1), source: Type.Literal("pi.session_start.new"),
  departureDigest: digest, runtimeSessionId: label, previousSessionFileDigest: digest, sessionFileDigest: digest, observedAt: time,
}, closed);
type DepartureRecord = Static<typeof Departure>;
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const key = (runtimeSessionId: string, endpointId: string, epoch: number): string => hash(JSON.stringify([runtimeSessionId, endpointId, epoch]));
const unavailable = (): never => { throw new Error("session switch unavailable"); };

function directory(ref: LivePolicyRef, create = false): string {
  const path = join(ref.root, "session-switches");
  if (create) {
    try { fs.mkdirSync(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o700) return unavailable();
  return path;
}
function record<T extends TSchema>(path: string, schema: T): { value: Static<T>; bytes: Buffer } {
  const file = readPrivateMessagingFile(path);
  if (file === undefined || file.bytes.length > 4096) return unavailable();
  let value: unknown;
  try { value = JSON.parse(file.bytes.toString("utf8")); } catch { return unavailable(); }
  if (!Value.Check(schema, value)) return unavailable();
  const stamp = (value as { observedAt: string }).observedAt;
  const date = new Date(stamp);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== stamp) return unavailable();
  return { value: value as Static<T>, bytes: file.bytes };
}
function conflicting(path: string): false {
  try {
    const fd = fs.openSync(`${path}.conflict`, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = fs.openSync(dirname(path), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return false;
}
function equivalent(a: unknown, b: unknown): boolean {
  // Both operands have already passed their closed record schema.
  return JSON.stringify({ ...(a as Record<string, unknown>), observedAt: null }) ===
    JSON.stringify({ ...(b as Record<string, unknown>), observedAt: null });
}
/** Publish by link, never rename over a prior observation. A failed/partial stage
 * is not a selected half; an existing conflicting half cannot be overwritten. */
function publish<T extends TSchema>(parent: string, name: string, schema: T, value: Static<T>): boolean {
  if (!Value.Check(schema, value)) return false;
  const path = join(parent, name);
  if (fs.existsSync(`${path}.conflict`)) return false;
  if (fs.existsSync(path)) return equivalent(record(path, schema).value, value) || conflicting(path);
  const stage = join(parent, `.stage-${randomUUID()}`);
  const fd = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.linkSync(stage, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  fs.unlinkSync(stage);
  const dir = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return equivalent(record(path, schema).value, value) || conflicting(path);
}
function candidates(parent: string, matches: (name: string) => boolean): string[] {
  const names = fs.readdirSync(parent).filter(matches);
  if (names.length > 128) return unavailable();
  return names;
}
function inPolicy(value: DepartureRecord, snapshot: LiveSnapshot): boolean {
  return value.policyId === snapshot.ref.policyId && value.genesisDigest === snapshot.ref.genesisDigest;
}

export function observeSessionDeparture(ref: LivePolicyRef, input: {
  readonly runtimeSessionId: string; readonly endpointId: string; readonly epoch: number;
  readonly sessionFile: string | undefined; readonly targetSessionFile: string | undefined;
}): boolean {
  try {
    if (input.sessionFile === undefined || input.targetSessionFile === undefined || !isAbsolute(input.sessionFile) ||
        !isAbsolute(input.targetSessionFile) || input.sessionFile === input.targetSessionFile) return false;
    const snapshot = readLivePolicy(ref);
    const registration = snapshot.manifest.registrations.find(r => r.status === "active" && r.runtimeSessionId === input.runtimeSessionId && r.endpointId === input.endpointId && r.epoch === input.epoch);
    if (registration === undefined) return false;
    const value: DepartureRecord = {
      version: 1, source: "pi.session_shutdown.new", policyId: ref.policyId, genesisDigest: ref.genesisDigest,
      runtimeSessionId: input.runtimeSessionId, endpointId: input.endpointId, epoch: input.epoch,
      sessionFileDigest: hash(input.sessionFile), targetSessionFileDigest: hash(input.targetSessionFile), observedAt: new Date().toISOString(),
    };
    return publish(directory(ref, true), `${key(value.runtimeSessionId, value.endpointId, value.epoch)}-${value.targetSessionFileDigest}.departure.json`, Departure, value);
  } catch { return false; }
}

export function observeSessionArrival(ref: LivePolicyRef, input: {
  readonly runtimeSessionId: string; readonly previousSessionFile: string | undefined; readonly sessionFile: string | undefined;
}): boolean {
  try {
    if (input.previousSessionFile === undefined || input.sessionFile === undefined || !isAbsolute(input.previousSessionFile) ||
        !isAbsolute(input.sessionFile) || input.previousSessionFile === input.sessionFile) return false;
    const snapshot = readLivePolicy(ref);
    const parent = directory(ref);
    const current = hash(input.sessionFile);
    const names = candidates(parent, name => /^[a-f0-9]{64}-[a-f0-9]{64}\.departure\.json$/.test(name) && name.endsWith(`-${current}.departure.json`));
    // More than one departing source for this destination is not resolved by time.
    if (names.length !== 1) return false;
    if (fs.existsSync(join(parent, `${names[0]}.conflict`))) return false;
    const departure = record(join(parent, names[0]!), Departure);
    const d = departure.value;
    if (!inPolicy(d, snapshot) || d.targetSessionFileDigest !== current || d.sessionFileDigest !== hash(input.previousSessionFile) || d.runtimeSessionId === input.runtimeSessionId) return false;
    return publish(parent, names[0]!.replace(".departure.json", ".arrival.json"), Arrival, {
      version: 1, source: "pi.session_start.new", departureDigest: hash(departure.bytes), runtimeSessionId: input.runtimeSessionId,
      previousSessionFileDigest: d.sessionFileDigest, sessionFileDigest: current, observedAt: new Date().toISOString(),
    });
  } catch { return false; }
}

export function discoverSessionSwitch(snapshot: LiveSnapshot, previousEndpointId: string, visibleEndpoints: readonly string[]): SessionSwitchResult {
  const unknown = { status: "unknown" as const, previousEndpointId };
  try {
    if (!visibleEndpoints.includes(previousEndpointId)) return unknown;
    const old = snapshot.manifest.registrations.find(r => r.endpointId === previousEndpointId && r.status === "active" && r.presenceDisclosure);
    if (old === undefined) return unknown;
    const parent = directory(snapshot.ref);
    const prefix = `${key(old.runtimeSessionId, old.endpointId, old.epoch)}-`;
    const names = candidates(parent, name => name.startsWith(prefix) && /^[a-f0-9]{64}-[a-f0-9]{64}\.departure\.json$/.test(name));
    if (names.length !== 1) return unknown;
    if (fs.existsSync(join(parent, `${names[0]}.conflict`)) || fs.existsSync(join(parent, names[0]!.replace(".departure.json", ".arrival.json.conflict")))) return unknown;
    const departure = record(join(parent, names[0]!), Departure);
    const d = departure.value;
    if (!inPolicy(d, snapshot) || d.runtimeSessionId !== old.runtimeSessionId || d.endpointId !== old.endpointId || d.epoch !== old.epoch || names[0] !== `${prefix}${d.targetSessionFileDigest}.departure.json`) return unknown;
    const a = record(join(parent, names[0]!.replace(".departure.json", ".arrival.json")), Arrival).value;
    if (a.departureDigest !== hash(departure.bytes) || a.previousSessionFileDigest !== d.sessionFileDigest || a.sessionFileDigest !== d.targetSessionFileDigest || a.runtimeSessionId === d.runtimeSessionId) return unknown;
    const successors = snapshot.manifest.registrations.filter(r => r.runtimeSessionId === a.runtimeSessionId && r.status === "active");
    // A later epoch cannot reuse a pre-authorization arrival. /new creates a new
    // UUID; only its first independent authorization can match this observation.
    if (successors.length !== 1) return unknown;
    const next = successors[0]!;
    if (next.epoch !== 1 || !next.presenceDisclosure || !visibleEndpoints.includes(next.endpointId) || next.endpointId === previousEndpointId) return unknown;
    return { status: "verified", previousEndpointId, successorEndpointId: next.endpointId, source: "pi.new.lifecycle", observedAt: a.observedAt };
  } catch { return unknown; }
}
