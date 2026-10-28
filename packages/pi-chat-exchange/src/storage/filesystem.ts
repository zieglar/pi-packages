import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  openSync,
  lstatSync,
  mkdirSync,
  statfsSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class FilesystemSafetyError extends Error {
  readonly code = "STORAGE_FILESYSTEM_UNSAFE";

  constructor(message: string) {
    super(message);
    this.name = "FilesystemSafetyError";
  }
}

const DARWIN_LOCAL_FILESYSTEM_NAMES = new Set(["apfs", "hfs"]);
const LOCAL_FILESYSTEM_TYPES: Readonly<Record<string, ReadonlySet<number>>> = {
  linux: new Set([
    0xef53, // ext2/3/4
    0x58465342, // XFS
    0x9123683e, // Btrfs
    0x2fc12fc1, // ZFS
  ]),
};

function assertOwned(stat: Stats, label: string): void {
  if (typeof process.getuid !== "function") {
    throw new FilesystemSafetyError(`${label} ownership cannot be established on this platform`);
  }
  if (stat.uid !== process.getuid()) {
    throw new FilesystemSafetyError(`${label} is not owned by the current user`);
  }
}
function assertMode(stat: Stats, expected: number, label: string): void {
  const actual = Number(stat.mode) & 0o777;
  if (actual !== expected) {
    throw new FilesystemSafetyError(
      `${label} must have mode ${expected.toString(8)}; received ${actual.toString(8)}`,
    );
  }
}

function isWithin(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

function assertDarwinLocalFilesystem(directory: string | undefined): void {
  if (directory === undefined || !isAbsolute(directory)) {
    throw new FilesystemSafetyError("a real mounted directory is required to verify the Darwin filesystem");
  }
  let directoryDevice: number;
  try { directoryDevice = lstatSync(directory).dev; } catch {
    throw new FilesystemSafetyError("unable to verify the Darwin filesystem identity");
  }
  let output: string;
  try {
    output = execFileSync("/sbin/mount", {
      encoding: "utf8", shell: false, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new FilesystemSafetyError("unable to verify the local Darwin filesystem");
  }
  let match: { point: string; name: string } | undefined;
  for (const line of output.split(/\r?\n/)) {
    const entry = /^.+? on (.+?) \(([^,\s]+)(?:,|\))/.exec(line);
    if (entry === null) continue;
    const point = entry[1];
    const name = entry[2];
    if (point === undefined || name === undefined) continue;
    let mountedDevice: number;
    try { mountedDevice = lstatSync(point).dev; } catch { continue; }
    // st_dev identifies the filesystem. Longest point only orders duplicate records deterministically.
    if (mountedDevice === directoryDevice) {
      if (match === undefined || point.length > match.point.length) match = { point, name };
    }
  }
  if (match === undefined || !DARWIN_LOCAL_FILESYSTEM_NAMES.has(match.name)) {
    throw new FilesystemSafetyError("filesystem type is not approved as local on darwin");
  }
}

export function assertLocalFilesystemType(platform: string, type: number, directory?: string): void {
  if (platform === "darwin") {
    // VFS type numbers are registration-dependent. Use mount identity instead of
    // treating a hosted runner's 0x19 or this machine's 0x1a as APFS constants.
    assertDarwinLocalFilesystem(directory);
    return;
  }
  const approved = LOCAL_FILESYSTEM_TYPES[platform];
  if (approved === undefined || !approved.has(type)) {
    throw new FilesystemSafetyError(
      `filesystem type 0x${type.toString(16)} is not approved as local on ${platform}`,
    );
  }
}

export function withRestrictiveUmask<T>(callback: () => T): T {
  const previous = process.umask(0o077);
  try {
    return callback();
  } finally {
    process.umask(previous);
  }
}

export interface DatabasePathOptions {
  readonly directory: string;
  readonly filename: string;
}

export function pathStat(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

function assertRealAncestors(directory: string): void {
  const parent = dirname(directory);
  if (parent !== directory) assertRealAncestors(parent);
  const stat = pathStat(directory);
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new FilesystemSafetyError("database path components must be real directories");
  }
}

// O_EXCL refuses a preexisting name (including dangling links); O_NOFOLLOW
// protects the final component. SQLite opens by pathname afterwards: not a
// defense against concurrent path replacement by an equivalently privileged actor.
export function exclusivelyCreateDatabase(path: string): void {
  closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
}

export function prepareDatabasePath(options: DatabasePathOptions): string {
  if (!isAbsolute(options.directory)) {
    throw new FilesystemSafetyError("an explicit absolute database directory is required");
  }
  if (
    options.filename.length === 0 ||
    options.filename === "." ||
    options.filename === ".." ||
    basename(options.filename) !== options.filename
  ) {
    throw new FilesystemSafetyError("database filename must be one contained path component");
  }

  const directory = resolve(options.directory);
  const productionPiDirectory = resolve(homedir(), ".pi");
  if (isWithin(directory, productionPiDirectory)) {
    throw new FilesystemSafetyError("durable storage requires an explicit non-production-Pi directory");
  }

  assertRealAncestors(directory);
  withRestrictiveUmask(() => {
    if (pathStat(directory) === undefined) mkdirSync(directory, { mode: 0o700 });
  });

  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new FilesystemSafetyError("database directory must be a real directory, not a symlink");
  }
  assertOwned(directoryStat, "database directory");
  assertMode(directoryStat, 0o700, "database directory");
  assertLocalFilesystemType(process.platform, statfsSync(directory).type, directory);

  const databasePath = resolve(directory, options.filename);
  if (dirname(databasePath) !== directory) {
    throw new FilesystemSafetyError("database path escapes its explicit directory");
  }
  return databasePath;
}

export function assertSecureDatabaseArtifacts(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const stat = pathStat(path);
    if (stat === undefined) continue;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new FilesystemSafetyError(`${path} must be a regular file, not a symlink`);
    }
    assertOwned(stat, path);
    assertMode(stat, 0o600, path);
  }
}
