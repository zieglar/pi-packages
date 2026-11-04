/** Same-user local challenge: instantaneous observation, never a send reservation. */
import fs from "node:fs";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual as equal } from "node:util";
import { readLivePolicy, type LivePolicyRef, type LiveSnapshot } from "./live-session-policy.js";
import type { LiveProcessIdentity, LiveObservationOwner, LiveObservationBound } from "./live-adoption-observation.js";
interface Options { readonly ref: LivePolicyRef; readonly identity: LiveProcessIdentity; readonly launchDigest: string; }
interface Facts { readonly snapshot: LiveSnapshot; readonly owner: LiveObservationOwner; readonly bound: LiveObservationBound; }
type Result = { readonly kind: "OBSERVED" | "BLOCKED" | "UNVERIFIED" };
const unknown = (): Result => ({ kind: "UNVERIFIED" });
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096;
function row(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || Object.keys(v).some(k => !keys.includes(k))) throw Error("invalid probe");
  return v as Record<string, unknown>;
}
function checkDirectory(path: string, privateDirectory = false): void {
  if (fs.realpathSync(path) !== path) throw Error("noncanonical probe directory");
  const s = fs.lstatSync(path);
  const uid = process.geteuid?.();
  const sticky = s.uid === 0 && (s.mode & 0o1000) !== 0;
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 && s.uid !== uid || !sticky && (s.mode & 0o022) !== 0 || privateDirectory && (s.uid !== uid || (s.mode & 0o7777) !== 0o700)) throw Error("unsafe probe directory");
  if (process.platform === "darwin") {
    const output = execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
    const [header = "", ...entries] = output.trimEnd().split("\n");
    if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header) || entries.some(entry => !/^\s*\d+: \S+ deny [a-z_,]+$/.test(entry)) || header[10] === "+" && !entries.length) throw Error("unsafe probe ACL");
  }
}
function pathFor(o: Options, create = false): string {
  if (!hex(o.launchDigest) || !integer(o.identity.pid) || o.identity.pid < 1 || !text(o.identity.startedKey)) throw Error("invalid probe identity");
  readLivePolicy(o.ref); // Canonical private directory and ancestor ACL checks.
  // macOS per-user temporary roots exceed Unix socket limits. Use one short,
  // canonical system temporary root, then require an owner-only per-UID directory.
  const temporaryRoot = fs.realpathSync("/tmp");
  for (let p = temporaryRoot; ; p = dirname(p)) { checkDirectory(p); if (dirname(p) === p) break; }
  const directory = join(temporaryRoot, `ce-probe-${process.geteuid!()}`);
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  checkDirectory(directory, true);
  const name = createHash("sha256").update(JSON.stringify([o.ref.root, o.ref.policyId, o.ref.genesisDigest, o.identity.pid, o.identity.startedKey, o.launchDigest])).digest("hex").slice(0, 40);
  const path = join(directory, `${name}.sock`);
  if (Buffer.byteLength(path) > 103) throw Error("probe path too long");
  return path;
}
const targets = (s: LiveSnapshot) => s.manifest.registrations.filter(r => r.status === "active").map(({ endpointId, epoch, payloadReadGeneration, ackGeneration }) => ({ endpointId, epoch, payloadReadGeneration, ackGeneration }));
function socketStat(path: string): fs.Stats {
  const s = fs.lstatSync(path);
  if (!s.isSocket() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o600) throw Error("unsafe probe socket");
  return s;
}
const same = (a: fs.Stats, b: fs.Stats): boolean => a.dev === b.dev && a.ino === b.ino;
export async function startLiveAdoptionProbe(o: Options & { readonly observe: () => Facts }): Promise<{ close(): Promise<void> }> {
  const path = pathFor(o, true);
  try { fs.lstatSync(path); throw Error("probe exists"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const clients = new Set<net.Socket>();
  const server = net.createServer(socket => {
    if (clients.size >= 4) { socket.destroy(); return; }
    clients.add(socket); const deadline = setTimeout(() => socket.destroy(), 500);
    socket.on("error", () => socket.destroy()); socket.on("close", () => { clearTimeout(deadline); clients.delete(socket); });
    let bytes = Buffer.alloc(0); let handled = false;
    socket.on("data", chunk => {
      if (handled) { socket.destroy(); return; }
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 256) { socket.destroy(); return; }
      if (!bytes.includes(10)) return;
      handled = true;
      try {
        const request = row(JSON.parse(bytes.toString("utf8")), ["kind", "nonce"]);
        if (request.kind !== "ce-live-probe-v1" || !hex(request.nonce)) throw Error("invalid challenge");
        const { snapshot, owner, bound } = o.observe();
        if (!equal(snapshot.ref, o.ref)) throw Error("foreign policy");
        const response = { nonce: request.nonce, launchDigest: o.launchDigest, identity: o.identity, ref: o.ref, policy: { sequence: snapshot.sequence, digest: snapshot.digest, targets: targets(snapshot) },
          owner: { endpointId: owner.endpointId, registered: owner.registered, participantId: owner.participantId ?? null, sessionId: owner.sessionId ?? null, exchangeId: owner.exchangeId ?? null, fencingToken: owner.fencingToken ?? null, lease: owner.lease, leaseExpiresAt: owner.leaseExpiresAt ?? null }, bound, observedAt: new Date().toISOString() };
        const output = Buffer.from(`${JSON.stringify(response)}\n`);
        if (output.length > 65536) throw Error("oversized probe");
        socket.end(output);
      } catch { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, () => { server.removeListener("error", reject); resolve(); }); });
  fs.chmodSync(path, 0o600);
  const owned = socketStat(path);
  // Node unlinks a Unix socket path on close. Move only our inode away first,
  // so Node's automatic cleanup cannot remove a substituted path.
  let closed: Promise<void> | undefined;
  return { close() {
    if (closed) return closed;
    for (const socket of clients) socket.destroy();
    let moved: string | undefined;
    let substitute: string | undefined;
    try {
      const current = fs.lstatSync(path);
      if (same(current, owned)) { moved = `${path}.closing`; fs.renameSync(path, moved); }
      else { substitute = `${path}.preserved-${randomBytes(8).toString("hex")}`; fs.renameSync(path, substitute); }
    } catch { /* Missing socket is already unavailable. */ }
    closed = new Promise<void>(resolve => server.close(() => {
      if (moved) { try { if (same(fs.lstatSync(moved), owned)) fs.unlinkSync(moved); } catch {} }
      if (substitute) { try { fs.linkSync(substitute, path); fs.unlinkSync(substitute); } catch {} }
      resolve();
    }));
    return closed;
  } };
}
export async function queryLiveAdoptionProbe(o: Options & { readonly current: LiveSnapshot; readonly targetEndpointId: string; readonly owner: LiveObservationOwner; readonly now?: () => string }): Promise<Result> {
  let path: string; let before: fs.Stats;
  try { path = pathFor(o); before = socketStat(path); } catch { return unknown(); }
  const nonce = randomBytes(32).toString("hex");
  return new Promise<Result>(resolve => {
    const socket = net.connect(path); let bytes = Buffer.alloc(0); let done = false;
    const finish = (result: Result) => { if (done) return; done = true; socket.destroy(); resolve(result); };
    const deadline = setTimeout(() => finish(unknown()), 500);
    socket.on("error", () => finish(unknown())); socket.on("close", () => { clearTimeout(deadline); finish(unknown()); });
    socket.on("connect", () => { try { if (!same(before, socketStat(path))) return finish(unknown()); socket.write(`${JSON.stringify({ kind: "ce-live-probe-v1", nonce })}\n`); } catch { finish(unknown()); } });
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > 65536) return finish(unknown()); if (!bytes.includes(10)) return;
      try {
        const r = row(JSON.parse(bytes.toString("utf8")), ["nonce", "launchDigest", "identity", "ref", "policy", "owner", "bound", "observedAt"]);
        const id = row(r.identity, ["pid", "startedKey"]); const ref = row(r.ref, ["kind", "root", "policyId", "genesisDigest", ...(o.ref.kind === "ce-live-session-v2" ? ["profilePath", "upgradeSequence"] : [])]);
        const p = row(r.policy, ["sequence", "digest", "targets"]); const owner = row(r.owner, ["endpointId", "registered", "participantId", "sessionId", "exchangeId", "fencingToken", "lease", "leaseExpiresAt"]); const bound = row(r.bound, ["state", "renewal"]);
        const now = Date.parse(o.now?.() ?? new Date().toISOString()); const observed = typeof r.observedAt === "string" ? Date.parse(r.observedAt) : NaN;
        if (r.nonce !== nonce || r.launchDigest !== o.launchDigest || !equal(id, o.identity) || !equal(ref, o.ref) || !equal(o.current.ref, o.ref) || !integer(p.sequence) || !hex(p.digest) || p.sequence > o.current.sequence || p.sequence === o.current.sequence && p.digest !== o.current.digest || !Number.isFinite(now) || !Number.isFinite(observed) || observed > now || now - observed > 5000 || !Array.isArray(p.targets) || p.targets.length > 128) return finish(unknown());
        const labels = new Set<string>();
        for (const item of p.targets) { const t = row(item, ["endpointId", "epoch", "payloadReadGeneration", "ackGeneration"]); if (!text(t.endpointId) || labels.has(t.endpointId) || !integer(t.epoch) || !integer(t.payloadReadGeneration) || !integer(t.ackGeneration) || t.payloadReadGeneration > p.sequence || t.ackGeneration > p.sequence) return finish(unknown()); labels.add(t.endpointId); }
        const target = p.targets.find(t => t.endpointId === o.targetEndpointId); const current = targets(o.current).find(t => t.endpointId === o.targetEndpointId);
        if (!target || !current || !equal(target, current) || !["ACTIVE", "WRITE_BLOCKED", "CLOSING", "CLOSED"].includes(String(bound.state)) || !["RUNNING", "STOPPED"].includes(String(bound.renewal))) return finish(unknown());
        if (bound.state !== "ACTIVE" || bound.renewal !== "RUNNING") return finish({ kind: "BLOCKED" });
        for (const key of ["endpointId", "participantId", "sessionId", "exchangeId", "fencingToken"] as const) if (owner[key] !== o.owner[key]) return finish(unknown());
        if (owner.registered !== true || !o.owner.registered || owner.lease !== "ACTIVE" || o.owner.lease !== "ACTIVE" || typeof owner.leaseExpiresAt !== "string" || !o.owner.leaseExpiresAt || !Number.isFinite(Date.parse(owner.leaseExpiresAt)) || !Number.isFinite(Date.parse(o.owner.leaseExpiresAt)) || Date.parse(owner.leaseExpiresAt) <= now || Date.parse(o.owner.leaseExpiresAt) <= now) return finish({ kind: "BLOCKED" });
        finish({ kind: "OBSERVED" });
      } catch { finish(unknown()); }
    });
  });
}
