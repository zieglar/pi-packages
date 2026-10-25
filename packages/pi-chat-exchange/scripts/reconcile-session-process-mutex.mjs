#!/usr/bin/env node
/** Offline operator-only local mutex receipt reconciliation. Never CE recovery.
 * Same-UID exclusion MUST be independently enforced for the entire window.
 * No retry, overwrite, unlink, Store open, or test acquisition is performed.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";

const OFFLINE = "All Pi/CE processes capable of opening this Store or acquiring this scope, including heartbeat, background launchers, auto-restart and recovery jobs, are stopped and inhibited for the entire inspection, reconciliation, durability check and reinspection window. No business operation, CE read/ACK, detach, takeover or recovery is authorized by this script. Do not resume until a separate authority decision.";
console.log(OFFLINE);
const required = ["store-dir", "store-file", "endpoint", "runtime-session", "slot", "owner-version", "owner-scope", "owner-pid", "owner-birth", "owner-process-token", "owner-handle-token", "owner-sha256", "store-dev", "store-ino", "slot-dev", "slot-ino", "owner-dev", "owner-ino"].map(s => `--expect-${s}`);
const audit = { argv: process.argv.slice(2), expectations: {}, uid: process.geteuid?.(), ps: [], fsync: [], outcome: "refused" };
const refuse = reason => { throw new Error(reason); };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = s => ({ dev: s.dev, ino: s.ino, uid: s.uid, mode: s.mode, nlink: s.nlink, size: s.size });
function argumentsFor(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (![...required, "--offline-window-confirmed", "--owner-death-evidence", "--audit-log"].includes(flag) || args.has(flag)) refuse("invalid or duplicate argument");
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
function regular(s, mode = 0o600) {
  if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || s.nlink !== 1 || (s.mode & 0o7777) !== mode) refuse("unsafe regular file");
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
  audit.ps.push({ status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.code ?? null });
  if (r.status === 0 && r.stdout?.trim()) refuse("owner PID is live (birth mismatch does not authorize reconciliation)");
  if (r.error || r.signal || r.status !== 1 || r.stdout !== "" || r.stderr !== "") refuse("owner death ambiguous: ps did not definitively report no PID");
}
function sync(path, directory = true) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : 0));
  try { fs.fsyncSync(fd); audit.fsync.push({ path, ok: true }); }
  catch (error) { audit.fsync.push({ path, ok: false, error: error.code ?? error.message }); throw error; }
  finally { fs.closeSync(fd); }
}
let args; let storeDir; let auditPath; let auditIdentity; let auditStoreIdentity;
try {
  args = argumentsFor(process.argv.slice(2));
  const expect = name => args.get(`--expect-${name}`);
  audit.expectations = Object.fromEntries(args);
  storeDir = expect("store-dir");
  const storeFile = expect("store-file");
  for (const value of [storeFile, expect("endpoint"), expect("runtime-session")]) if (value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) refuse("invalid scope input");
  if ([".", ".."].includes(storeFile) || basename(storeFile) !== storeFile || /[/\\]/.test(storeFile)) refuse("Store file must be a basename");
  const slotNumber = numeric(expect("slot"), true);
  if (slotNumber > 100000 || numeric(expect("owner-version"), true) !== 1) refuse("slot/version expectation invalid");
  numeric(expect("owner-pid"), true);
  for (const name of ["store", "slot", "owner"]) for (const field of ["dev", "ino"]) numeric(expect(`${name}-${field}`));
  for (const name of ["owner-scope", "owner-sha256"]) if (!/^[a-f0-9]{64}$/.test(expect(name))) refuse("invalid hash expectation");
  const scopeKey = hash(JSON.stringify([storeDir, storeFile, expect("endpoint"), expect("runtime-session")]));
  if (scopeKey !== expect("owner-scope")) refuse("scope expectation mismatch");
  const root = join(storeDir, ".ce-session-process-mutex"); const scope = join(root, scopeKey); const slot = join(scope, String(slotNumber));
  const marker = join(slot, "owner.json"); const receiptPath = join(slot, "released.json");
  const expectedIdentity = (name, s) => { if (String(s.dev) !== expect(`${name}-dev`) || String(s.ino) !== expect(`${name}-ino`)) refuse(`${name} identity expectation mismatch`); };
  function validate() {
    const chain = directoryChain(scope);
    for (const path of [storeDir, root, scope, slot]) privateDir(path);
    const store = fs.lstatSync(join(storeDir, storeFile));
    if (!store.isFile() || store.isSymbolicLink() || store.nlink !== 1 || store.uid !== process.geteuid?.() || (store.mode & 0o7077) !== 0) refuse("unsafe Store file");
    expectedIdentity("store", store); expectedIdentity("slot", fs.lstatSync(slot));
    // Refusal records may be appended only after the fixed Store and safe
    // destination have been independently validated, never to an unknown path.
    if (args.has("--audit-log") && auditPath === undefined) {
      const path = args.get("--audit-log");
      if (!isAbsolute(path) || normalize(path) !== path || dirname(path) !== storeDir || [storeFile, ".ce-session-process-mutex"].includes(basename(path))) refuse("audit log must be next to Store, not Store itself");
      try { const s = fs.lstatSync(path); regular(s); auditIdentity = identity(s); } catch (e) { if (e.code !== "ENOENT") throw e; }
      auditStoreIdentity = identity(fs.lstatSync(storeDir)); auditPath = path;
    }
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
    audit.finalInventory = fs.readdirSync(slot).sort();
    if (JSON.stringify(audit.finalInventory) !== '["owner.json"]') refuse("target slot inventory must be exactly owner.json; existing receipts and extra files refused");
    const owner = read(marker);
    audit.observedOwner = { identity: owner.identity, sha256: hash(owner.bytes), bytes: owner.bytes.toString("base64") };
    const parsed = canonicalOwner(owner.bytes, scopeKey); expectedIdentity("owner", owner.identity);
    for (const [field, flag] of [["version", "version"], ["scope", "scope"], ["pid", "pid"], ["birth", "birth"], ["processToken", "process-token"], ["handleToken", "handle-token"]]) if (String(parsed[field]) !== expect(`owner-${flag}`)) refuse(`owner ${field} expectation mismatch`);
    if (hash(owner.bytes) !== expect("owner-sha256")) refuse("owner raw-byte hash mismatch");
    return { chain, store: identity(store), slot: identity(fs.lstatSync(slot)), historical, owner: { ...owner, bytes: owner.bytes.toString("base64") } };
  }
  const first = validate();
  audit.scope = scopeKey; audit.inspection = first;
  death(Number(expect("owner-pid")));
  const second = validate();
  if (JSON.stringify(first) !== JSON.stringify(second)) refuse("inspection identity/bytes changed");
  death(Number(expect("owner-pid")));
  // Final filesystem reinspection after the second death guard; no async gap.
  if (JSON.stringify(first) !== JSON.stringify(validate())) refuse("final inspection changed");
  const original = Buffer.from(first.owner.bytes, "base64");
  const fd = fs.openSync(receiptPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  let receiptIdentity;
  try {
    regular(fs.fstatSync(fd)); fs.writeFileSync(fd, original);
    try { fs.fsyncSync(fd); audit.fsync.push({ path: receiptPath, ok: true }); }
    catch (error) { audit.fsync.push({ path: receiptPath, ok: false, error: error.code ?? error.message }); throw error; }
    receiptIdentity = identity(fs.fstatSync(fd));
  } finally { fs.closeSync(fd); }
  for (const path of [slot, scope, root, storeDir]) sync(path);
  const receipt = read(receiptPath); const owner = read(marker);
  if (!same(receiptIdentity, receipt.identity) || !receipt.bytes.equals(original) || !same(first.owner.identity, owner.identity) || !owner.bytes.equals(original)) refuse("published receipt/owner identity or bytes uncertain");
  audit.finalInventory = fs.readdirSync(slot).sort();
  if (JSON.stringify(audit.finalInventory) !== '["owner.json","released.json"]') refuse("final slot inventory uncertain");
  // Recheck all directory and Store identities after durability operations.
  if (JSON.stringify(directoryChain(scope)) !== JSON.stringify(first.chain)) refuse("final directory identity changed");
  for (const path of [storeDir, root, scope, slot]) privateDir(path);
  if (!same(first.slot, fs.lstatSync(slot)) || JSON.stringify(identity(fs.lstatSync(join(storeDir, storeFile)))) !== JSON.stringify(first.store)) refuse("final Store/slot identity changed");
  const finalSlots = fs.readdirSync(scope).sort((a, b) => Number(a) - Number(b));
  if (finalSlots.length !== slotNumber || finalSlots.some((s, i) => s !== String(i + 1))) refuse("final scope inventory changed");
  audit.receipt = { identity: receipt.identity, sha256: hash(receipt.bytes) }; audit.outcome = "local mutex receipt reconciled; no CE authority or business resumption authorized";
} catch (error) {
  audit.reason = error instanceof Error ? error.message : "unknown outcome";
  console.error(`session mutex reconciliation refused: ${audit.reason}; hard stop, no automatic retry or cleanup`);
  process.exitCode = 1;
}
try {
  if (auditPath !== undefined) {
    directoryChain(storeDir); privateDir(storeDir);
    if (!same(auditStoreIdentity, fs.lstatSync(storeDir))) refuse("audit Store directory identity changed");
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK |
      (auditIdentity === undefined ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
    const fd = fs.openSync(auditPath, flags, 0o600);
    try {
      const s = fs.fstatSync(fd); regular(s);
      if (!same(s, fs.lstatSync(auditPath)) || (auditIdentity !== undefined && !same(auditIdentity, s))) refuse("audit identity changed");
      fs.writeFileSync(fd, `${JSON.stringify(audit)}\n`); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    const fdDir = fs.openSync(storeDir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
  } else console.log(JSON.stringify(audit));
} catch (error) {
  console.error(`session mutex audit uncertain: ${error.message}; hard stop, no retry or cleanup`); process.exitCode = 1;
}
