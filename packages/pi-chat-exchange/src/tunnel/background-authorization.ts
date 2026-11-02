import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";

type AuthorizationState = "granted" | "revoked";
export type BackgroundAuthorizationInspection =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; state: AuthorizationState; scopeDigest: string };
/** A committed record is durable only after the directory entry was synced.
 * `uncertain` means the rename happened but the directory sync did not
 * complete; callers must stop the current grant/connection flow. */
export type AuthorizationCommitResult = { committed: true; durability: "synced" | "uncertain" };
export type BackgroundSelectionInspection =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; profilePath: string; clientPath: string };
/** Fault-injection seam for write/file-fsync/rename/dir-fsync only. */
export interface AuthorizationFileSystemSeam {
  writeSync: typeof writeSync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
}
export interface BackgroundAuthorizationStoreOptions {
  directory?: string;
  now?: () => number;
  filesystem?: Partial<AuthorizationFileSystemSeam>;
  /** Test seam for the Darwin ACL probe. Production always uses /bin/ls. */
  readAcl?: (path: string) => string;
}

const refusal = () => new TunnelRefusal("CE_TUNNEL_BACKGROUND_UNAUTHORIZED");
const digestPattern = /^[a-f0-9]{64}$/;
const SELECTION_FILE = "selection.json";
function checkedPath(value: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value) || value.split("/").includes("..")) throw refusal();
  return value;
}
function owner(): number {
  if (typeof process.geteuid !== "function" || constants.O_NOFOLLOW === undefined) throw refusal();
  return process.geteuid();
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function privateRecord(stat: Stats, uid: number): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.size <= 8192;
}
/** macOS ACL grants are independent of POSIX mode. Only absent ACLs or
 * deny-only ACLs are admitted; unknown output or probe failure is fail-closed.
 * The OS utility is fixed and never discovered through PATH. */
function darwinAclOutput(path: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    return execFileSync("/bin/ls", ["-lde", path], {
      cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      shell: false, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16_384,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw refusal(); }
}

/** Directory injection is solely for isolated tests; production uses the OS account home. */
export function createBackgroundAuthorizationStore(options: BackgroundAuthorizationStoreOptions = {}) {
  const home = userInfo().homedir;
  const directory = options.directory ?? join(home, ".config/pi-chat-exchange/background-authorization");
  const now = options.now ?? Date.now;
  const seam = options.filesystem ?? {};
  const writeBytes = seam.writeSync ?? writeSync;
  const syncFile = seam.fsyncSync ?? fsyncSync;
  const moveFile = seam.renameSync ?? renameSync;

  function path(profilePath: string): string {
    checkedPath(directory);
    return join(directory, `${createHash("sha256").update(checkedPath(profilePath)).digest("hex")}.json`);
  }
  function selectionPath(): string {
    checkedPath(directory);
    return join(directory, SELECTION_FILE);
  }
  /** Rejects allow ACLs and unrecognised ACL output. Never mutates the path. */
  function assertAclSafe(target: string): void {
    const output = options.readAcl ? options.readAcl(target) : darwinAclOutput(target);
    if (output === undefined) return;
    const lines = output.trimEnd().split("\n");
    const header = lines.shift() ?? "";
    if (!/^[bcdlps-][rwxStTs-]{9}[+@ ]/.test(header)) throw refusal();
    for (const entry of lines) {
      if (!/^\s*\d+: \S+ deny [a-z_,]+$/.test(entry)) throw refusal();
    }
    if (header[10] === "+" && lines.length === 0) throw refusal();
  }
  function trustedDirectory(uid: number, create: boolean): boolean {
    checkedPath(directory);
    const chain: string[] = [];
    for (let cursor = directory; ; cursor = dirname(cursor)) {
      chain.unshift(cursor);
      if (dirname(cursor) === cursor) break;
    }
    let absent = false;
    for (const entry of chain) {
      let stat: Stats;
      try { stat = lstatSync(entry); }
      catch (error) {
        if (!missing(error)) throw error;
        if (!create) { absent = true; continue; }
        mkdirSync(entry, { mode: 0o700 });
        stat = lstatSync(entry);
      }
      const inHome = entry === home || entry.startsWith(`${home}/`);
      const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) ||
          ((stat.mode & 0o022) !== 0 && !stickyRoot) ||
          (inHome && entry !== home && stat.uid !== uid) ||
          (entry === directory && (stat.uid !== uid || (stat.mode & 0o7777) !== 0o700))) throw refusal();
      assertAclSafe(entry);
    }
    return !absent;
  }
  /** Reads a private record file without healing or repairing it. */
  function readPrivateRecord(file: string, uid: number): { kind: "absent" | "invalid" | "valid"; record?: Record<string, unknown> } {
    let fd: number | undefined;
    try {
      let before: Stats;
      try { before = lstatSync(file); }
      catch (error) { if (missing(error)) return { kind: "absent" }; throw error; }
      if (!privateRecord(before, uid)) return { kind: "invalid" };
      assertAclSafe(file);
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (!privateRecord(opened, uid) || opened.dev !== before.dev || opened.ino !== before.ino) return { kind: "invalid" };
      const buffer = Buffer.alloc(8193);
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 8192) return { kind: "invalid" };
      const data: unknown = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) return { kind: "invalid" };
      return { kind: "valid", record: data as Record<string, unknown> };
    } catch { return { kind: "invalid" }; }
    finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* No raw filesystem errors escape inspection. */ } } }
  }
  /** Durable commit of one private record: write, file sync, rename, directory sync.
   * Failures before the rename are refusals; the previous record still stands.
   * A failure after the rename returns `uncertain` and never claims rollback. */
  function commitRecord(file: string, bytes: Buffer): AuthorizationCommitResult {
    let fd: number | undefined;
    let temp: string | undefined;
    let renamed = false;
    try {
      temp = join(directory, `.${randomUUID()}.tmp`);
      fd = openSync(temp, constants.O_EXCL | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
      const uid = owner();
      if (!privateRecord(fstatSync(fd), uid)) throw refusal();
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeBytes(fd, bytes, offset, bytes.length - offset);
        if (count === 0) throw refusal();
        offset += count;
      }
      syncFile(fd);
      closeSync(fd);
      fd = undefined;
      trustedDirectory(uid, false);
      assertAclSafe(temp);
      moveFile(temp, file);
      renamed = true;
      temp = undefined;
      try {
        fd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        syncFile(fd);
        closeSync(fd);
        fd = undefined;
      } catch { return { committed: true, durability: "uncertain" }; }
      return { committed: true, durability: "synced" };
    } catch {
      if (renamed) return { committed: true, durability: "uncertain" };
      throw refusal();
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort cleanup. */ } }
      if (temp !== undefined) { try { unlinkSync(temp); } catch { /* Only remove this write's exclusive temporary file. */ } }
    }
  }

  function inspect(profilePath: string): BackgroundAuthorizationInspection {
    try {
      const file = path(profilePath);
      const uid = owner();
      if (!trustedDirectory(uid, false)) return { kind: "absent" };
      const found = readPrivateRecord(file, uid);
      if (found.kind !== "valid" || !found.record) return found.kind === "absent" ? { kind: "absent" } : { kind: "invalid" };
      const record = found.record;
      const keys = ["version", "uid", "profilePath", "state", "scopeDigest", "updatedAt"];
      if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) ||
          record.version !== 1 || record.uid !== uid || record.profilePath !== profilePath ||
          (record.state !== "granted" && record.state !== "revoked") ||
          typeof record.scopeDigest !== "string" || !digestPattern.test(record.scopeDigest) ||
          !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) return { kind: "invalid" };
      // A prior writer may have observed rename but not directory-sync success.
      // Re-establish durability before a visible grant can authorize a fresh process.
      if (record.state === "granted") {
        const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
        try { syncFile(directoryFd); } finally { closeSync(directoryFd); }
      }
      return { kind: "valid", state: record.state, scopeDigest: record.scopeDigest };
    } catch { return { kind: "invalid" }; }
  }

  function write(profilePath: string, state: AuthorizationState, scopeDigest: string): AuthorizationCommitResult {
    try {
      const file = path(profilePath);
      const uid = owner();
      const updatedAt = now();
      if ((state !== "granted" && state !== "revoked") || typeof scopeDigest !== "string" || !digestPattern.test(scopeDigest) || !Number.isSafeInteger(updatedAt) || updatedAt < 0) throw refusal();
      trustedDirectory(uid, true);
      const existing = lstatSync(file, { throwIfNoEntry: false });
      if (existing) { if (existing.nlink !== 1) throw refusal(); assertAclSafe(file); }
      const bytes = Buffer.from(JSON.stringify({ version: 1, uid, profilePath, state, scopeDigest, updatedAt }));
      if (bytes.length > 8192) throw refusal();
      return commitRecord(file, bytes);
    } catch (error) {
      if ((error as { code?: string })?.code === "CE_TUNNEL_BACKGROUND_UNAUTHORIZED") throw error;
      throw refusal();
    }
  }

  /** Non-authoritative launch selection. The per-profile grant stays separate. */
  function readSelection(): BackgroundSelectionInspection {
    try {
      const uid = owner();
      if (!trustedDirectory(uid, false)) return { kind: "absent" };
      const found = readPrivateRecord(selectionPath(), uid);
      if (found.kind === "absent") return { kind: "absent" };
      if (found.kind !== "valid" || !found.record) return { kind: "invalid" };
      const record = found.record;
      const keys = ["version", "uid", "profilePath", "clientPath", "updatedAt"];
      if (Object.keys(record).length !== keys.length || !keys.every(key => Object.hasOwn(record, key)) ||
          record.version !== 1 || record.uid !== uid ||
          typeof record.profilePath !== "string" || typeof record.clientPath !== "string" ||
          !Number.isSafeInteger(record.updatedAt) || (record.updatedAt as number) < 0) return { kind: "invalid" };
      try {
        checkedPath(record.profilePath);
        checkedPath(record.clientPath);
      } catch { return { kind: "invalid" }; }
      const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
      try { syncFile(directoryFd); } finally { closeSync(directoryFd); }
      return { kind: "valid", profilePath: record.profilePath, clientPath: record.clientPath };
    } catch { return { kind: "invalid" }; }
  }

  function writeSelection(profilePath: string, clientPath: string): AuthorizationCommitResult {
    try {
      const uid = owner();
      const updatedAt = now();
      const normalizedProfile = checkedPath(profilePath);
      const normalizedClient = checkedPath(clientPath);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw refusal();
      trustedDirectory(uid, true);
      const file = selectionPath();
      const existing = lstatSync(file, { throwIfNoEntry: false });
      if (existing) { if (existing.nlink !== 1) throw refusal(); assertAclSafe(file); }
      const bytes = Buffer.from(JSON.stringify({ version: 1, uid, profilePath: normalizedProfile, clientPath: normalizedClient, updatedAt }));
      if (bytes.length > 8192) throw refusal();
      return commitRecord(file, bytes);
    } catch (error) {
      if ((error as { code?: string })?.code === "CE_TUNNEL_BACKGROUND_UNAUTHORIZED") throw error;
      throw refusal();
    }
  }
  return { inspect, write, path, selectionPath, readSelection, writeSelection };
}
