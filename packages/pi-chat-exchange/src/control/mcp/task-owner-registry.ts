import fs from "node:fs";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import { validMessageId, validRegisteredTaskOwner, type TaskOwnerPort } from "./task-owner.js";

const MAX_BYTES = 16_384;
const INVALID = "CE_MCP_TASK_OWNERSHIP_INVALID";

export interface TaskOwnershipSidecar {
  readonly schemaVersion: 1;
  readonly registryDirectory: string;
  readonly piEndpoint?: string;
}

export interface TaskOwnerScope {
  readonly exchangeId: string;
  readonly from: string;
  readonly to: string;
}

function invalid(): never { throw new Error(INVALID); }

function parseFlatUniqueJson(bytes: Buffer): Record<string, unknown> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.values(value).some(item => typeof item === "object" && item !== null)) return invalid();
    const keys = new Set<string>();
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (!/^\s*:/.test(text.slice((match.index ?? 0) + match[0].length))) continue;
      const key: unknown = JSON.parse(match[0]);
      if (typeof key !== "string" || keys.has(key)) return invalid();
      keys.add(key);
    }
    return value as Record<string, unknown>;
  } catch { return invalid(); }
}

function assertPrivateDirectory(directory: string): void {
  if (!isAbsolute(directory) || resolve(directory) !== directory) return invalid();
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) return invalid();
  }
  const info = fs.lstatSync(directory);
  if ((info.mode & 0o7777) !== 0o700 || (process.geteuid !== undefined && info.uid !== process.geteuid())) return invalid();
}

function readPrivateBounded(path: string): Buffer {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1 ||
      (process.geteuid !== undefined && info.uid !== process.geteuid())) return invalid();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_BYTES) return invalid();
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}

export function loadTaskOwnershipSidecar(configPath: string): TaskOwnershipSidecar | undefined {
  if (!isAbsolute(configPath) || resolve(configPath) !== configPath) return invalid();
  const path = `${configPath}.task-ownership.json`;
  try { fs.lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return invalid();
  }
  try {
    const value = parseFlatUniqueJson(readPrivateBounded(path));
    const expectedKeys = "piEndpoint" in value ? 3 : 2;
    if (Object.keys(value).length !== expectedKeys || value.schemaVersion !== 1 || typeof value.registryDirectory !== "string" ||
      value.registryDirectory.includes("\0") || !isAbsolute(value.registryDirectory) || resolve(value.registryDirectory) !== value.registryDirectory) return invalid();
    const piEndpoint = value.piEndpoint;
    if ("piEndpoint" in value && (typeof piEndpoint !== "string" || !/^pi\/[A-Za-z0-9-]{1,64}$/.test(piEndpoint))) return invalid();
    return { schemaVersion: 1, registryDirectory: value.registryDirectory,
      ...(typeof piEndpoint === "string" ? { piEndpoint } : {}) };
  } catch { return invalid(); }
}

export function createTaskOwnerRegistryPort(directory: string, scope: TaskOwnerScope): TaskOwnerPort {
  return Object.freeze({ lookup(messageId: string): unknown {
    const unverified = { messageId, ownerStatus: "UNVERIFIED" as const };
    if (!validMessageId(messageId)) return unverified;
    try {
      assertPrivateDirectory(directory);
      const candidate = parseFlatUniqueJson(readPrivateBounded(join(directory, `${messageId}.json`)));
      if (!validRegisteredTaskOwner(candidate) || candidate.messageId !== messageId || candidate.exchangeId !== scope.exchangeId ||
        candidate.from !== scope.from || candidate.to !== scope.to || candidate.taskOwner !== scope.from) return unverified;
      return candidate;
    } catch { return unverified; }
  } });
}
