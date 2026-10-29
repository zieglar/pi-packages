import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { NATIVE_COMPAT, type NativeCompat } from "./native-compat.js";
import type { NativeModuleInfo } from "./sqlite-driver.js";

const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function nativeCacheRoot(): string {
  return join(homedir(), ".config", "pi-chat-exchange", "native");
}

export function nativeTarget(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "aarch64-apple-darwin";
  if (process.platform === "darwin" && process.arch === "x64") return "x86_64-apple-darwin";
  if (process.platform === "linux" && process.arch === "x64") return "x86_64-unknown-linux-gnu";
  if (process.platform === "linux" && process.arch === "arm64") return "aarch64-unknown-linux-gnu";
  throw Object.assign(new Error(`unsupported Native target ${process.platform}/${process.arch}`), { code: "CE_NATIVE_TARGET_UNSUPPORTED" });
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function assetFor(manifest: NativeCompat, version: string, target: string) {
  if (!SEMVER.test(version)) fail("CE_NATIVE_VERSION_INVALID", "Native version must be canonical SemVer");
  const versionEntry = manifest.versions[version];
  if (versionEntry === undefined) fail("CE_NATIVE_VERSION_UNSUPPORTED", `Native version ${version} is not in the CE compatibility manifest`);
  const asset = versionEntry.assets[target];
  if (asset === undefined) fail("CE_NATIVE_TARGET_UNSUPPORTED", `Native version ${version} has no artifact for ${target}`);
  if (asset.asset !== `ce-sqlite-${version}-${target}.node`) {
    fail("CE_NATIVE_ASSET_INVALID", "Native asset name does not match the fixed version/target contract");
  }
  if (asset.sha256 === null || !/^[0-9a-f]{64}$/.test(asset.sha256)) {
    fail("CE_NATIVE_ARTIFACT_UNPINNED", `Native ${version}/${target} has no verified SHA-256 in the CE manifest; prepare and loading are refused`);
  }
  return asset;
}

/** POSIX locks and dlopen require a path that other accounts cannot replace.
 * Same-UID mutation remains outside this private-cache trust boundary. */
function assertCacheAncestors(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path) fail("CE_NATIVE_CACHE_UNSAFE", "Native cache path must be absolute and normalized");
  const uid = process.getuid?.();
  if (uid === undefined) fail("CE_NATIVE_CACHE_UNSAFE", "Native cache ownership is unavailable");
  let directory = dirname(path);
  for (;;) {
    const stat = lstatSync(directory);
    const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0)
      || ((stat.mode & 0o022) !== 0 && !stickyRoot)) {
      fail("CE_NATIVE_CACHE_UNSAFE", "Native cache ancestor is not privately controlled");
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("CE_NATIVE_CACHE_UNSAFE", "cached Native artifact must be a regular non-symlink file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("CE_NATIVE_CACHE_UNSAFE", "cached Native artifact owner mismatch");
  if ((stat.mode & 0o777) !== 0o600) fail("CE_NATIVE_CACHE_UNSAFE", "cached Native artifact must have mode 600");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensurePrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("CE_NATIVE_CACHE_UNSAFE", "Native cache directory must be a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("CE_NATIVE_CACHE_UNSAFE", "Native cache directory owner mismatch");
  if ((stat.mode & 0o777) !== 0o700) fail("CE_NATIVE_CACHE_UNSAFE", "Native cache directory must have mode 700");
}

function makePrivateDirectory(path: string): void {
  if (existsSync(path)) {
    ensurePrivateDirectory(path);
    return;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(path);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAtomic(path: string, contents: string): void {
  const directory = join(path, "..");
  makePrivateDirectory(directory);
  const temporary = join(directory, `.tmp-${randomUUID()}`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  fsyncDirectory(directory);
}

export interface NativeArtifactOptions {
  readonly version?: string;
  readonly root?: string;
  readonly manifest?: NativeCompat;
}

export interface VerifiedNativeArtifact {
  readonly path: string;
  readonly info: NativeModuleInfo;
  readonly module: unknown;
}

function artifactPaths(root: string, version: string, target: string, asset: string) {
  const directory = join(root, "ce-sqlite", version, target);
  return { directory, path: join(directory, asset), record: join(directory, "artifact.json") };
}

/** Runtime: only a cached, hash-pinned artifact can be loaded. No network access. */
export function loadVerifiedNativeArtifact(options: NativeArtifactOptions = {}): VerifiedNativeArtifact {
  const manifest = options.manifest ?? NATIVE_COMPAT;
  const version = options.version ?? manifest.defaultVersion;
  const root = options.root ?? nativeCacheRoot();
  const target = nativeTarget();
  const asset = assetFor(manifest, version, target);
  const paths = artifactPaths(root, version, target, asset.asset);
  if (!existsSync(paths.path)) fail("CE_NATIVE_CACHE_MISSING", `Native ${version}/${target} is not cached; run the explicit prepare command first`);
  assertCacheAncestors(paths.path);
  assertPrivateFile(paths.path);
  const actual = sha256File(paths.path);
  if (actual !== asset.sha256) fail("CE_NATIVE_HASH_MISMATCH", `cached Native artifact hash mismatch for ${version}/${target}`);
  assertCacheAncestors(paths.path);
  const native = createRequire(import.meta.url)(paths.path) as {
    abiVersion(): number;
    info(): string;
  };
  if (native.abiVersion() !== manifest.abiVersion) fail("CE_NATIVE_ABI_MISMATCH", `Native ABI ${native.abiVersion()} does not match CE ABI ${manifest.abiVersion}`);
  let info: NativeModuleInfo;
  try {
    info = JSON.parse(native.info()) as NativeModuleInfo;
  } catch {
    return fail("CE_NATIVE_INFO_INVALID", "Native module identity is not valid JSON");
  }
  if (info.middlewareVersion !== version || info.abiVersion !== manifest.abiVersion || info.target !== target) {
    fail("CE_NATIVE_IDENTITY_MISMATCH", `Native identity mismatch: expected ${version}/${target}`);
  }
  return { path: paths.path, info, module: native };
}

export interface PrepareNativeOptions extends NativeArtifactOptions {
  /** Test seam for a local HTTP fixture; production uses GitHub Releases only. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Explicit operator repair only; ordinary prepare never replaces a cache entry. */
  readonly repairCorrupt?: boolean;
}

/** Prepare: download a fixed asset to a temporary file, verify, and install
 * without overwriting another version or an existing good cache entry. */
export async function prepareNativeArtifact(options: PrepareNativeOptions = {}): Promise<VerifiedNativeArtifact> {
  const manifest = options.manifest ?? NATIVE_COMPAT;
  const version = options.version ?? manifest.defaultVersion;
  const root = options.root ?? nativeCacheRoot();
  const target = nativeTarget();
  const asset = assetFor(manifest, version, target);
  const paths = artifactPaths(root, version, target, asset.asset);
  if (existsSync(paths.path)) {
    try { return loadVerifiedNativeArtifact(options); }
    catch (error) {
      if (!options.repairCorrupt || (error as NodeJS.ErrnoException).code !== "CE_NATIVE_HASH_MISMATCH") throw error;
    }
  }

  const url = options.baseUrl === undefined
    ? `https://github.com/${manifest.repository}/releases/download/ce-sqlite-v${version}/${asset.asset}`
    : `${options.baseUrl.replace(/\/$/, "")}/${asset.asset}`;
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) fail("CE_NATIVE_DOWNLOAD_FAILED", `Native download failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_ASSET_BYTES) fail("CE_NATIVE_DOWNLOAD_FAILED", "Native asset exceeds the size limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) fail("CE_NATIVE_DOWNLOAD_FAILED", "Native asset is empty or exceeds the size limit");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== asset.sha256) fail("CE_NATIVE_HASH_MISMATCH", `downloaded Native artifact hash mismatch for ${version}/${target}`);

  makePrivateDirectory(paths.directory);
  assertCacheAncestors(paths.path);
  const temporary = join(paths.directory, `.download-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (options.repairCorrupt && existsSync(paths.path)) {
      // Recheck after download. Never replace unsafe entries or an already valid
      // artifact installed by a concurrent preparer. The downloaded bytes have
      // passed the fixed trust pin before the damaged file can be replaced.
      assertCacheAncestors(paths.path);
      assertPrivateFile(paths.path);
      if (sha256File(paths.path) !== asset.sha256) renameSync(temporary, paths.path);
      else unlinkSync(temporary);
    } else {
      // link() is atomic and never overwrites an existing cache entry.
      linkSync(temporary, paths.path);
      unlinkSync(temporary);
    }
    fsyncDirectory(paths.directory);
  } catch (error) {
    rmSync(temporary, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A concurrent preparer won; verify its entry instead of replacing it.
  }
  const record = {
    version,
    target,
    asset: asset.asset,
    sha256: actual,
    source: options.baseUrl === undefined ? "github-releases" : "fixture",
    preparedAt: new Date().toISOString(),
  };
  writeAtomic(paths.record, `${JSON.stringify(record, null, 2)}\n`);
  return loadVerifiedNativeArtifact(options);
}
