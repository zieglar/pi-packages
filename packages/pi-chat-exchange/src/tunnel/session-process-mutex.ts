/** Additional local exclusion, NEVER CE authority or expired-Owner takeover.
 *
 * Append-only slots avoid the check-then-unlink retirement race entirely. An
 * exclusive mkdir claims the next slot; its owner and immutable release receipt
 * are retained (only explicit drained local transfer may replace an owner). No automatic dead-marker reclamation is provided (even proven
 * dead processes require offline operator reconciliation). Partial/unknown files
 * block. This deliberately trades availability/disk growth for safe exclusion.
 *
 * Composition must wrap EVERY operation and heartbeat in run(), close admission,
 * stop heartbeat scheduling, await drain(), then either explicitly transfer the
 * still-attached CE handle OR perform CE end and release its confirmed result.
 * Uncertain cleanup/release latches forever and retains the marker. Transfer is
 * an explicit local object operation, never inferred from matching PIDs.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";

const processToken = randomUUID();
const refused = (): Error => Object.assign(new Error("CE_SESSION_PROCESS_MUTEX_REFUSED"), { code: "CE_SESSION_PROCESS_MUTEX_REFUSED" });
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException).code === "ENOENT";
interface Identity { readonly dev: number; readonly ino: number; }
function same(a: Identity, b: Identity): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** Fixed command/arguments and minimal environment; unknown is never proof.
 * No PID reuse/death inference is needed because this module never reclaims. */
function inspectSelf(): string | undefined {
  const result = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const birth = result.stdout?.trim();
  return result.status === 0 && birth !== undefined && /^\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}$/.test(birth) ? birth : undefined;
}
export interface SessionProcessMutexOptions {
  /** Existing canonical private Store directory. No Store is created here. */
  readonly store: { readonly directory: string; readonly file: string };
  readonly endpointId: string;
  /** Trusted Pi runtime identity, NOT cwd/display name/model arguments. */
  readonly runtimeSessionId: string;
  /** Trusted deterministic test seam. Production must omit. */
  readonly inspectSelf?: () => string | undefined;
}
export interface SessionProcessMutex {
  readonly handleToken: string;
  readonly markerPath: string;
  assertOwnership(): void;
  /** Includes async lifetime; use for EVERY admission, including heartbeat. */
  run<T>(operation: () => T): T;
  closeAdmission(): void;
  drain(): Promise<void>;
  /** Only closed+drained old handles; retains CE attachment, no CE operation. */
  explicitTransfer(): SessionProcessMutex;
  /** Call after CE end, never from a finally which masks cleanup uncertainty. */
  release(cleanup: { readonly released: boolean; readonly detached: boolean }): void;
}

/** Validate all ancestors, rejecting symlink aliases and writable non-sticky
 * parents. Root-owned sticky temporary ancestors are permitted; the Store and
 * mutex directories themselves must be private, owned by the effective UID.
 * Same-UID malicious modification is not an authority boundary; every later
 * check nevertheless detects inode/path/marker replacement and latches. */
function directoryChain(path: string): Map<string, Identity> {
  if (!isAbsolute(path) || normalize(path) !== path || fs.realpathSync(path) !== path) throw refused();
  const chain = new Map<string, Identity>();
  let current = path;
  for (;;) {
    const s = fs.lstatSync(current);
    const stickyRoot = s.uid === 0 && (s.mode & 0o1000) !== 0;
    if (!s.isDirectory() || s.isSymbolicLink() || (!stickyRoot && (s.mode & 0o022) !== 0) || (s.uid !== 0 && s.uid !== process.geteuid?.())) throw refused();
    chain.set(current, { dev: s.dev, ino: s.ino });
    if (current === parse(current).root) break;
    current = dirname(current);
  }
  return chain;
}
function privateDir(path: string): void {
  const s = fs.lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o700) throw refused();
}
function mkdir(path: string): void {
  try { fs.mkdirSync(path, { mode: 0o700 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  privateDir(path);
}
function read(path: string): { bytes: string; identity: Identity } {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.geteuid?.() || (s.mode & 0o7777) !== 0o600 || s.nlink !== 1 || s.size < 1 || s.size > 4096) throw refused();
    const bytes = fs.readFileSync(fd, "utf8");
    if (!same(s, fs.lstatSync(path))) throw refused();
    return { bytes, identity: { dev: s.dev, ino: s.ino } };
  } finally { fs.closeSync(fd); }
}
function write(path: string, bytes: string): Identity {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes, "utf8"); fs.fsyncSync(fd); return fs.fstatSync(fd); }
  finally { fs.closeSync(fd); }
}
function syncDir(path: string): void {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function absent(path: string): boolean {
  try { fs.lstatSync(path); return false; } catch (e) { if (missing(e)) return true; throw e; }
}

export function acquireSessionProcessMutex(options: SessionProcessMutexOptions): SessionProcessMutex {
  try { return acquire(options); } catch { throw refused(); }
}
function acquire(options: SessionProcessMutexOptions): SessionProcessMutex {
  // Copy trusted input so caller mutation cannot redirect later ownership checks.
  const store = { ...options.store };
  const endpointId = options.endpointId; const runtimeSessionId = options.runtimeSessionId;
  const inspect = options.inspectSelf ?? inspectSelf;
  for (const value of [endpointId, runtimeSessionId, store.file]) {
    if (typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw refused();
  }
  if (store.file === "." || store.file === ".." || /[/\\]/.test(store.file)) throw refused();
  const birth = inspect();
  if (typeof birth !== "string" || !birth.length || birth.length > 256) throw refused();
  directoryChain(store.directory); privateDir(store.directory);
  const storePath = join(store.directory, store.file);
  let storeIdentity: Identity | undefined;
  const checkStore = () => {
    if (absent(storePath)) {
      if (storeIdentity !== undefined) throw refused();
      return;
    }
    const s = fs.lstatSync(storePath);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== process.geteuid?.() || (s.mode & 0o077) !== 0 ||
        (storeIdentity !== undefined && !same(storeIdentity, s))) throw refused();
    storeIdentity ??= { dev: s.dev, ino: s.ino };
  };
  checkStore();
  const root = join(store.directory, ".ce-session-process-mutex"); mkdir(root);
  const key = createHash("sha256").update(JSON.stringify([store.directory, store.file, endpointId, runtimeSessionId])).digest("hex");
  const scope = join(root, key); mkdir(scope);
  const chain = directoryChain(scope);
  const validatePaths = () => {
    const now = directoryChain(scope);
    for (const [path, id] of chain) if (!same(id, now.get(path)!)) throw refused();
    privateDir(store.directory); privateDir(root); privateDir(scope); checkStore();
  };
  validatePaths();
  // Immutable release receipts, not unlink/rename of a judged stale pathname.
  // A concurrent contender either observes a complete release or refuses.
  const entries = fs.readdirSync(scope);
  if (entries.length > 100_000 || entries.some((name) => !/^[1-9][0-9]*$/.test(name))) throw refused();
  let slot = 1;
  for (; slot <= entries.length; slot++) {
    const previous = join(scope, String(slot)); privateDir(previous);
    const owner = read(join(previous, "owner.json")).bytes;
    // Validate shape by exact canonical reconstruction, including unknown keys.
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(owner) as Record<string, unknown>; }
    catch { throw refused(); }
    if (parsed === null || typeof parsed !== "object") throw refused();
    if (parsed.version !== 1 || parsed.scope !== key || !Number.isSafeInteger(parsed.pid) || typeof parsed.birth !== "string" ||
        typeof parsed.processToken !== "string" || typeof parsed.handleToken !== "string" ||
        JSON.stringify({ version: 1, scope: key, pid: parsed.pid, birth: parsed.birth, processToken: parsed.processToken, handleToken: parsed.handleToken }) !== owner) throw refused();
    if (read(join(previous, "released.json")).bytes !== owner) throw refused();
  }
  const directory = join(scope, String(slot));
  fs.mkdirSync(directory, { mode: 0o700 }); // exclusive claim; EEXIST is refusal
  privateDir(directory);
  const directoryId = fs.lstatSync(directory);
  const handleToken = randomUUID();
  const markerPath = join(directory, "owner.json");
  const bytes = JSON.stringify({ version: 1, scope: key, pid: process.pid, birth, processToken, handleToken });
  const markerId = write(markerPath, bytes);
  syncDir(directory); syncDir(scope); syncDir(root); syncDir(store.directory);
  const makeHandle = (handleToken: string, bytes: string, markerId: Identity): SessionProcessMutex => {
  let closed = false; let done = false; let uncertain = false; let inFlight = 0; let drained = false;
  const waiters: Array<() => void> = [];
  const check = () => {
    if (uncertain || done) throw refused();
    try {
      validatePaths();
      privateDir(directory);
      if (!same(directoryId, fs.lstatSync(directory)) || inspect() !== birth ||
          !absent(join(directory, "released.json")) || !absent(join(scope, String(slot + 1)))) throw refused();
      const current = read(markerPath);
      if (!same(markerId, current.identity) || current.bytes !== bytes) throw refused();
    } catch { uncertain = true; throw refused(); }
  };
  const finish = () => { inFlight--; if (inFlight === 0) for (const resolve of waiters.splice(0)) resolve(); };
  const retire = () => {
    check();
    try {
      // Prepare and sync BEFORE the activation rename. A write/close/fsync
      // uncertainty must not publish reusable release bytes. No fallible
      // durability operation follows activation: losing this directory entry
      // after a power loss only causes conservative refusal, never takeover.
      const pending = join(directory, "release-pending.json");
      const pendingId = write(pending, bytes);
      syncDir(directory);
      const released = join(directory, "released.json");
      try { fs.renameSync(pending, released); }
      catch {
        // A throwing rename can have committed. Reconcile only the EXACT
        // inode+bytes we prepared; any unverified outcome latches below.
        const committed = read(released);
        if (!same(pendingId, committed.identity) || committed.bytes !== bytes) throw refused();
      }
      done = true;
    } catch { uncertain = true; throw refused(); }
  };
  const ready = () => { if (!closed || !drained || inFlight !== 0 || done || uncertain) throw refused(); };
  return Object.freeze({
    handleToken, markerPath,
    assertOwnership: () => { if (closed) throw refused(); check(); },
    run: <T>(operation: () => T): T => {
      if (closed) throw refused(); check(); inFlight++;
      try {
        const result = operation();
        if (result !== null && (typeof result === "object" || typeof result === "function") &&
            typeof (result as { then?: unknown }).then === "function") {
          return Promise.resolve(result).finally(finish) as T;
        }
        finish(); return result;
      } catch (error) { finish(); throw error; }
    },
    closeAdmission: () => { closed = true; },
    drain: async () => {
      if (!closed) throw refused();
      if (inFlight !== 0) await new Promise<void>((resolve) => waiters.push(resolve));
      drained = true;
    },
    explicitTransfer: () => {
      ready(); check();
      try {
        // No release receipt or acquisition gap: all other processes continue
        // to see an occupied slot. Only this closed/drained local object may
        // replace its exact owner marker with a fresh handle identity.
        const nextToken = randomUUID();
        const nextBytes = JSON.stringify({ version: 1, scope: key, pid: process.pid, birth, processToken, handleToken: nextToken });
        const pending = join(directory, `transfer-${nextToken}.json`);
        const nextId = write(pending, nextBytes);
        syncDir(directory);
        try { fs.renameSync(pending, markerPath); }
        catch {
          const committed = read(markerPath);
          if (!same(nextId, committed.identity) || committed.bytes !== nextBytes) throw refused();
        }
        done = true;
        return makeHandle(nextToken, nextBytes, nextId);
      } catch { uncertain = true; throw refused(); }
    },
    release: (cleanup: { readonly released: boolean; readonly detached: boolean }) => {
      ready();
      if (cleanup.released !== true || cleanup.detached !== true) { uncertain = true; throw refused(); }
      retire();
    },
  });
  };
  return makeHandle(handleToken, bytes, markerId);
}
