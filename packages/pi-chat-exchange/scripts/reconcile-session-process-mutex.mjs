#!/usr/bin/env node
/** Offline operator-only local mutex receipt reconciliation. Never CE recovery.
 * Same-UID exclusion MUST be independently enforced for the entire window.
 * No retry, overwrite, unlink, Store open, or test acquisition is performed.
 *
 * Output is a closed set: the fixed OFFLINE banner on stdout, one fixed
 * outcome line on success, or one fixed refusal reason line on stderr. No
 * audit artifact is written, and no raw error text, derived absolute path,
 * owner byte, or inspection detail is ever printed.
 *
 * Publication mirrors the frozen session mutex retire() contract exactly:
 * write the exclusive release-pending.json with the exact original owner
 * bytes -> fsync the file -> fsync the slot, scope, root and Store
 * directories -> FULL revalidation (identities, expectations, inventory:
 * exactly owner.json plus our own release-pending.json, still no released.json)
 * -> the activation rename as THE commit point. NOTHING fallible runs after
 * the rename: a rename that throws is reconciled only against the exact
 * prepared inode+bytes, and any earlier failure keeps the pending artifact in
 * place for manual review with the fixed publication-uncertain refusal.
 *
 * Direct-execution guard: executed as a CLI (`node scripts/...`) the file runs
 * main(); imported as a module (the deterministic failure-injection tests) it
 * only exports the publication step and its helpers. The publication step's fs
 * operations are injectable as a TEST SEAM ONLY — the defaults are the real
 * operations, and no environmental variable can alter publication behavior.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";
import { pathToFileURL } from "node:url";

const OFFLINE = "All Pi/CE processes capable of opening this Store or acquiring this scope, including heartbeat, background launchers, auto-restart and recovery jobs, are stopped and inhibited for the entire inspection, reconciliation, durability check and reinspection window. No business operation, CE read/ACK, detach, takeover or recovery is authorized by this script. Do not resume until a separate authority decision.";
const RECONCILED = "local mutex receipt reconciled; no CE authority or business resumption authorized";
const PUBLICATION_UNCERTAIN = "publication uncertain; manual review required; no retry";
const UNEXPECTED = "unexpected local failure";
const required = ["store-dir", "store-file", "endpoint", "runtime-session", "slot", "owner-version", "owner-scope", "owner-pid", "owner-birth", "owner-process-token", "owner-handle-token", "owner-sha256", "store-dev", "store-ino", "slot-dev", "slot-ino", "owner-dev", "owner-ino"].map(s => `--expect-${s}`);
class Refusal extends Error {}
const refuse = reason => { throw new Refusal(reason); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
// Directory entries (size/nlink) legitimately change when our own pending or
// receipt is added, so directories are compared by dev/ino like the mutex
// module's own check(); slot CONTENT change is caught by the inventory check.
const key = s => ({ dev: s.dev, ino: s.ino });
const identity = s => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size });
function argumentsFor(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (![...required, "--offline-window-confirmed", "--owner-death-evidence"].includes(flag) || args.has(flag)) refuse("invalid or duplicate argument");
    if (flag === "--offline-window-confirmed") { args.set(flag, true); continue; }
    const value = argv[++i];
    if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.startsWith("--")) refuse("missing argument value");
    args.set(flag, value);
  }
  if ([...required, "--offline-window-confirmed", "--owner-death-evidence"].some(f => !args.has(f))) refuse("required explicit expectations, offline window and independent owner death evidence missing");
  return args;
}
function numeric(text, positive = false) {
  if (!(positive ? /^[1-9][0-9]*$/ : /^(0|[1-9][0-9]*)$/).test(text) || !Number.isSafeInteger(Number(text))) refuse("invalid numeric expectation");
  return Number(text);
}
function privateDir(path) {
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o700) refuse("directory must be private 0700 and owned by euid");
  return s;
}
function directoryChain(path) {
  if (!isAbsolute(path) || normalize(path) !== path || fs.realpathSync(path) !== path) refuse("directory must be canonical absolute without symlink components");
  const result = {};
  for (let current = path;; current = dirname(current)) {
    const s = fs.lstatSync(current);
    // As in acquire: OS-owned safe ancestors and root-owned sticky tmp are
    // permitted; every Store/mutex/scope/slot directory is strictly 0700.
    const stickyRoot = s.uid === 0 && (s.mode & 0o1000) !== 0;
    if (!s.isDirectory() || s.isSymbolicLink() || (!stickyRoot && (s.mode & 0o022) !== 0) || (s.uid !== 0 && s.uid !== process.geteuid?.())) refuse("unsafe ancestor");
    result[current] = { dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode };
    if (current === parse(current).root) return result;
  }
}
function regular(s) {
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || s.nlink !== 1 || (s.mode & 0o7777) !== 0o600) refuse("unsafe regular file");
}
function read(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd); regular(s);
    if (s.size < 1 || s.size > 4096) refuse("owner/receipt size invalid");
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== s.size || !same(s, fs.lstatSync(path))) refuse("file identity changed");
    return { bytes, identity: identity(s) };
  } finally { fs.closeSync(fd); }
}
function canonicalOwner(bytes, scope) {
  let o;
  try { o = JSON.parse(bytes.toString("utf8")); } catch { refuse("noncanonical owner JSON"); }
  if (o === null || typeof o !== "object" || o.version !== 1 || o.scope !== scope || !Number.isSafeInteger(o.pid) || o.pid <= 0 ||
      [o.birth, o.processToken, o.handleToken].some(v => typeof v !== "string" || !v.length || v.length > 256 || /[\u0000-\u001f\u007f]/.test(v)) ||
      !Buffer.from(JSON.stringify({ version: 1, scope, pid: o.pid, birth: o.birth, processToken: o.processToken, handleToken: o.handleToken })).equals(bytes)) refuse("noncanonical owner");
  return o;
}
function death(pid) {
  const r = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  if (r.status === 0 && r.stdout?.trim()) refuse("owner PID is live (birth mismatch does not authorize reconciliation)");
  if (r.error || r.signal || r.status !== 1 || r.stdout !== "" || r.stderr !== "") refuse("owner death ambiguous: ps did not definitively report no PID");
}
function sync(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Derive the reconciliation target (expectation accessor and canonical paths)
 *  from a parsed argument map. Pure derivation: no validation, no filesystem
 *  access. Exported so the publication step's tests build the exact target
 *  main() uses. */
export function deriveReconciliationTarget(args) {
  const expect = name => args.get(`--expect-${name}`);
  const storeDir = expect("store-dir");
  const storeFile = expect("store-file");
  const scopeKey = hash(JSON.stringify([storeDir, storeFile, expect("endpoint"), expect("runtime-session")]));
  const root = join(storeDir, ".ce-session-process-mutex");
  const scope = join(root, scopeKey);
  const slot = join(scope, expect("slot"));
  return { args, expect, storeDir, storeFile, slotNumber: Number(expect("slot")), scopeKey, root, scope, slot,
    marker: join(slot, "owner.json"), receiptPath: join(slot, "released.json"), pendingPath: join(slot, "release-pending.json") };
}

/** FULL revalidation of the target against every expectation: ancestor chain,
 *  private directories, Store file, slot identities, scope inventory,
 *  historical slots, the exact target-slot inventory, and the owner marker's
 *  shape, identity, fields and raw-byte hash. Returns the comparable snapshot
 *  and refuses on any mismatch. Exported so the publication step's tests can
 *  capture the pre-publication snapshot main() compares against. */
export function validateReconciliationTarget(target, expectedInventory) {
  const { expect, storeDir, storeFile, scopeKey, root, scope, slot, marker, slotNumber } = target;
  const expectedIdentity = (name, s) => { if (String(s.dev) !== expect(`${name}-dev`) || String(s.ino) !== expect(`${name}-ino`)) refuse(`${name} identity expectation mismatch`); };
  const chain = directoryChain(scope);
  for (const path of [storeDir, root, scope, slot]) privateDir(path);
  const store = fs.lstatSync(join(storeDir, storeFile));
  if (!store.isFile() || store.isSymbolicLink() || store.nlink !== 1 || store.uid !== process.geteuid?.() || (store.mode & 0o7077) !== 0) refuse("unsafe Store file");
  expectedIdentity("store", store); expectedIdentity("slot", fs.lstatSync(slot));
  const entries = fs.readdirSync(scope).sort((a, b) => Number(a) - Number(b));
  if (entries.length !== slotNumber || entries.some((s, i) => s !== String(i + 1))) refuse("scope slots must be contiguous with target terminal");
  const historical = [];
  for (let n = 1; n < slotNumber; n++) {
    const path = join(scope, String(n)); const dir = privateDir(path);
    if (JSON.stringify(fs.readdirSync(path).sort()) !== JSON.stringify(["owner.json", "released.json"])) refuse("historical slot inventory invalid");
    const owner = read(join(path, "owner.json")); const receipt = read(join(path, "released.json")); canonicalOwner(owner.bytes, scopeKey);
    if (!owner.bytes.equals(receipt.bytes)) refuse("historical receipt mismatch");
    historical.push({ directory: identity(dir), owner: owner.identity, receipt: receipt.identity, hash: hash(owner.bytes) });
  }
  // A pre-existing pending or receipt in the target slot is unsafe inventory:
  // it is refused here, before any write of our own.
  if (JSON.stringify(fs.readdirSync(slot).sort()) !== JSON.stringify(expectedInventory)) refuse("target slot inventory must be exactly owner.json; existing receipts and extra files refused");
  const owner = read(marker);
  const parsed = canonicalOwner(owner.bytes, scopeKey); expectedIdentity("owner", owner.identity);
  for (const [field, flag] of [["version", "version"], ["scope", "scope"], ["pid", "pid"], ["birth", "birth"], ["processToken", "process-token"], ["handleToken", "handle-token"]]) if (String(parsed[field]) !== expect(`owner-${flag}`)) refuse(`owner ${field} expectation mismatch`);
  if (hash(owner.bytes) !== expect("owner-sha256")) refuse("owner raw-byte hash mismatch");
  return { chain, store: identity(store), slot: key(fs.lstatSync(slot)), historical, owner: { ...owner, bytes: owner.bytes.toString("base64") } };
}

/** The publication step's filesystem operations: the exclusive pending open,
 *  its write/fsync/fstat/close, the directory fsyncs, the strict artifact
 *  read, and the activation rename. Injectable ONLY as a deterministic test
 *  seam; the defaults are the real operations. */
export function defaultPublicationFsOperations() {
  return {
    open: path => fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600),
    fstat: fd => fs.fstatSync(fd),
    write: (fd, bytes) => fs.writeFileSync(fd, bytes),
    fsync: fd => fs.fsyncSync(fd),
    close: fd => fs.closeSync(fd),
    syncDir: path => sync(path),
    read: path => read(path),
    rename: (from, to) => fs.renameSync(from, to),
  };
}

/** The staged publication step. Sequence per the frozen retire() contract:
 *  exclusive pending write with the EXACT original owner bytes -> file fsync
 *  -> slot/scope/root/Store directory fsyncs -> FULL revalidation -> the
 *  activation rename as THE commit point, with NOTHING fallible after it. A
 *  throwing rename is reconciled only against the exact prepared inode+bytes.
 *  Any failure before the commit keeps the pending artifact in place; the
 *  caller never retries, overwrites, or unlinks. */
export function publishReleaseReceipt(target, first, fsOperations = {}) {
  const operations = { ...defaultPublicationFsOperations(), ...fsOperations };
  try {
    const original = Buffer.from(first.owner.bytes, "base64");
    const fd = operations.open(target.pendingPath);
    let pendingIdentity;
    try {
      regular(operations.fstat(fd));
      operations.write(fd, original);
      operations.fsync(fd);
      pendingIdentity = identity(operations.fstat(fd));
    } finally { operations.close(fd); }
    operations.syncDir(target.slot);
    operations.syncDir(target.scope);
    operations.syncDir(target.root);
    operations.syncDir(target.storeDir);
    // FULL revalidation after every durability operation and before the
    // activation rename: identities and expectations unchanged, inventory
    // exactly owner.json plus our own release-pending.json, still no receipt.
    if (JSON.stringify(validateReconciliationTarget(target, ["owner.json", "release-pending.json"])) !== JSON.stringify(first)) refuse("publication revalidation changed");
    const pending = operations.read(target.pendingPath);
    if (!same(pendingIdentity, pending.identity) || !pending.bytes.equals(original)) refuse("pending receipt identity or bytes uncertain");
    try { operations.rename(target.pendingPath, target.receiptPath); }
    catch {
      // A throwing rename can have committed. Accept ONLY the exact prepared
      // inode+bytes, mirroring the mutex module's own activation semantics.
      const committed = operations.read(target.receiptPath);
      if (!same(pendingIdentity, committed.identity) || !committed.bytes.equals(original)) refuse("rename outcome unverified");
    }
    // Commit point passed. Losing the directory entry after a power loss only
    // causes conservative refusal, never takeover.
    return;
  } catch {
    // Every publication failure — before or at the commit point — keeps the
    // pending artifact in place for manual review: fixed refusal, no retry,
    // no overwrite, no unlink, never another actor's pending file.
    throw new Refusal(PUBLICATION_UNCERTAIN);
  }
}

function main() {
  console.log(OFFLINE);
  try {
    const args = argumentsFor(process.argv.slice(2));
    const target = deriveReconciliationTarget(args);
    const { expect, storeFile, scopeKey } = target;
    for (const value of [storeFile, expect("endpoint"), expect("runtime-session")]) if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) refuse("invalid scope input");
    if ([".", ".."].includes(storeFile) || basename(storeFile) !== storeFile || /[/\\]/.test(storeFile)) refuse("Store file must be a basename");
    const slotNumber = numeric(expect("slot"), true);
    if (slotNumber > 100000 || numeric(expect("owner-version"), true) !== 1) refuse("slot/version expectation invalid");
    numeric(expect("owner-pid"), true);
    for (const name of ["store", "slot", "owner"]) for (const field of ["dev", "ino"]) numeric(expect(`${name}-${field}`));
    for (const name of ["owner-scope", "owner-sha256"]) if (!/^[a-f0-9]{64}$/.test(expect(name))) refuse("invalid hash expectation");
    if (scopeKey !== expect("owner-scope")) refuse("scope expectation mismatch");
    const first = validateReconciliationTarget(target, ["owner.json"]);
    death(Number(expect("owner-pid")));
    if (JSON.stringify(first) !== JSON.stringify(validateReconciliationTarget(target, ["owner.json"]))) refuse("inspection identity/bytes changed");
    death(Number(expect("owner-pid")));
    // Final filesystem reinspection after the second death guard; no async gap.
    if (JSON.stringify(first) !== JSON.stringify(validateReconciliationTarget(target, ["owner.json"]))) refuse("final inspection changed");
    publishReleaseReceipt(target, first);
    console.log(RECONCILED);
  } catch (error) {
    const reason = error instanceof Refusal ? error.message : UNEXPECTED;
    console.error(`session mutex reconciliation refused: ${reason}; hard stop, no automatic retry or cleanup`);
    process.exitCode = 1;
  }
}

/** Direct-execution guard: as a CLI the file runs main(); imported as a module
 *  it only exports the publication step and its helpers for the tests. */
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try { return import.meta.url === pathToFileURL(process.argv[1]).href; } catch { return false; }
}
if (isDirectExecution()) main();
