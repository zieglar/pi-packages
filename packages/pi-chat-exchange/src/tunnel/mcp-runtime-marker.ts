import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";

export interface McpRuntimeSourceIdentity {
  readonly packageVersion: string;
  readonly sourceDigest: string;
}
export interface McpRuntimeProcessIdentity { readonly pid: number; readonly startedKey: string; }
export type McpRuntimeInspection =
  | { readonly state: "CURRENT" | "STALE"; readonly packageVersion: string; readonly launchSourceDigest: string; readonly currentSourceDigest: string }
  | { readonly state: "UNVERIFIED" };

const DIGEST = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const markerPath = (bindingPath: string): string => `${bindingPath}.runtime.json`;

function readMarker(path: string): unknown {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); const uid = process.geteuid?.();
    if (!stat.isFile() || stat.size < 2 || stat.size > 4096 || (stat.mode & 0o7777) !== 0o600 || uid !== undefined && stat.uid !== uid) {
      throw Error("unsafe MCP runtime marker");
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) throw Error("runtime source symlink");
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile() && (name.endsWith(".js") || name.endsWith(".json"))) files.push(path);
    }
  };
  visit(root);
  return files;
}

/** Fingerprint the shipped MCP program, not the mutable working tree or config. */
export function mcpRuntimeSourceIdentity(packageRoot: string): McpRuntimeSourceIdentity {
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== "@zieglar/pi-chat-exchange" || typeof manifest.version !== "string" || !VERSION.test(manifest.version)) throw Error("invalid MCP package identity");
  const dist = join(packageRoot, "dist");
  const hash = createHash("sha256");
  for (const path of [manifestPath, ...filesUnder(dist)]) {
    const label = relative(packageRoot, path);
    const bytes = fs.readFileSync(path);
    hash.update(`${Buffer.byteLength(label)}:${label}:${bytes.length}:`).update(bytes);
  }
  return { packageVersion: manifest.version, sourceDigest: hash.digest("hex") };
}

export function writeMcpRuntimeMarker(input: {
  readonly bindingPath: string;
  readonly identity: McpRuntimeProcessIdentity;
  readonly source: McpRuntimeSourceIdentity;
}): void {
  if (!Number.isSafeInteger(input.identity.pid) || input.identity.pid < 1 || !input.identity.startedKey || input.identity.startedKey.length > 256 ||
      !VERSION.test(input.source.packageVersion) || !DIGEST.test(input.source.sourceDigest)) throw Error("invalid MCP runtime marker");
  const path = markerPath(input.bindingPath);
  const temp = `${path}.tmp-${randomUUID()}`;
  const bytes = Buffer.from(`${JSON.stringify({ version: 1, ...input.identity, packageVersion: input.source.packageVersion, sourceDigest: input.source.sourceDigest })}\n`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, path);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }
}

export function inspectMcpRuntimeMarker(input: {
  readonly bindingPath: string;
  readonly packageRoot: string;
  readonly process: McpRuntimeProcessIdentity;
}): McpRuntimeInspection {
  try {
    const raw = readMarker(markerPath(input.bindingPath));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { state: "UNVERIFIED" };
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join() !== "packageVersion,pid,sourceDigest,startedKey,version" || row.version !== 1 ||
        row.pid !== input.process.pid || row.startedKey !== input.process.startedKey || typeof row.packageVersion !== "string" || !VERSION.test(row.packageVersion) ||
        typeof row.sourceDigest !== "string" || !DIGEST.test(row.sourceDigest)) return { state: "UNVERIFIED" };
    const current = mcpRuntimeSourceIdentity(input.packageRoot);
    return { state: row.sourceDigest === current.sourceDigest ? "CURRENT" : "STALE", packageVersion: row.packageVersion,
      launchSourceDigest: row.sourceDigest, currentSourceDigest: current.sourceDigest };
  } catch { return { state: "UNVERIFIED" }; }
}
