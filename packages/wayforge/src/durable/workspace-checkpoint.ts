import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AuthoritativeTaskState } from "./state.js";
import { failure, success, type ExecutionResult } from "../types/result.js";

export type WorkspaceCheckpoint = NonNullable<AuthoritativeTaskState["workspace"]>;
type PathFingerprint = WorkspaceCheckpoint["changedPaths"][number];
type PathStatus = PathFingerprint["status"];

const MAX_GIT_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HASHED_FILE_BYTES = 32 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;
const MAX_PATHS = 500;

interface CaptureInput {
  readonly workspaceRoot: string;
  readonly taskWriteSet: readonly string[];
  readonly capturedAtMs: number;
}

interface StatusRecord {
  readonly path: string;
  readonly status: PathStatus;
}

function workspaceFailure(code: string, message: string): ExecutionResult<never> {
  return failure({ kind: "validation", scope: "task", confidence: "certain", code, message });
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(cwd: string, args: readonly string[]): Promise<ExecutionResult<string>> {
  return new Promise((done) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        shell: false,
      },
      (error, stdout) => {
        if (error !== null || stdout.includes("\uFFFD")) {
          done(workspaceFailure("workspace_git_inspection_failed", "bounded Git inspection failed"));
          return;
        }
        done(success(stdout));
      },
    );
  });
}

function safeRelativePath(root: string, rawPath: string): ExecutionResult<string> {
  if (rawPath.length === 0 || rawPath.includes("\0") || isAbsolute(rawPath)) {
    return workspaceFailure("workspace_path_unsafe", "workspace path is not a safe relative path");
  }
  const absolute = resolve(root, rawPath);
  const relation = relative(root, absolute);
  if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) {
    return workspaceFailure("workspace_path_unsafe", "workspace path escapes the canonical root");
  }
  return success(relation.replaceAll("\\", "/"));
}

function statusKind(code: string): PathStatus {
  if (code === "??") return "added";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code)) return "conflicting";
  if (code.includes("R") || code.includes("C")) return "renamed";
  if (code.includes("T")) return "type_changed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

function parseStatus(root: string, output: string): ExecutionResult<readonly StatusRecord[]> {
  const fields = output.split("\0");
  const records: StatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length === 0) continue;
    if (field.length < 4 || field[2] !== " ") {
      return workspaceFailure("workspace_status_unsafe", "Git status output could not be classified safely");
    }
    const code = field.slice(0, 2);
    const current = safeRelativePath(root, field.slice(3));
    if (!current.ok) return current;
    records.push({ path: current.value, status: statusKind(code) });
    if (code.includes("R") || code.includes("C")) {
      const originalRaw = fields[index + 1];
      if (originalRaw === undefined || originalRaw.length === 0) {
        return workspaceFailure("workspace_status_unsafe", "Git rename output is incomplete");
      }
      index += 1;
      const original = safeRelativePath(root, originalRaw);
      if (!original.ok) return original;
      records.push({ path: original.value, status: "deleted" });
    }
  }
  if (records.length > MAX_PATHS) {
    return workspaceFailure("workspace_too_many_paths", "workspace change set exceeds the bounded path limit");
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  return success(records);
}

function parseIndex(root: string, output: string): ExecutionResult<ReadonlyMap<string, string>> {
  const index = new Map<string, string>();
  for (const field of output.split("\0")) {
    if (field.length === 0) continue;
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t(.+)$/s.exec(field);
    if (match === null) return workspaceFailure("workspace_index_unsafe", "Git index output is invalid");
    const path = safeRelativePath(root, match[4] ?? "");
    if (!path.ok) return path;
    const value = sha256(`${match[1]}\0${match[2]}\0${match[3]}`);
    const previous = index.get(path.value);
    index.set(path.value, previous === undefined ? value : sha256(`${previous}\0${value}`));
  }
  return success(index);
}

async function hashRegularFile(path: string, size: number): Promise<ExecutionResult<string>> {
  if (size > MAX_HASHED_FILE_BYTES) {
    return workspaceFailure("workspace_file_too_large", "changed file exceeds the bounded hashing limit");
  }
  return new Promise((done) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", () => done(workspaceFailure("workspace_read_failed", "changed file could not be hashed")));
    stream.on("end", () => done(success(hash.digest("hex"))));
  });
}

async function fingerprint(
  root: string,
  record: StatusRecord,
  indexEntries: ReadonlyMap<string, string>,
): Promise<ExecutionResult<PathFingerprint>> {
  const absolute = resolve(root, record.path);
  const indexDigest = indexEntries.get(record.path);
  const base: PathFingerprint = indexDigest === undefined
    ? { path: record.path, status: record.status }
    : { path: record.path, status: record.status, indexDigest };
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      return success({ ...base, worktreeDigest: sha256(await readlink(absolute)), symlink: true });
    }
    if (info.isFile()) {
      const digest = await hashRegularFile(absolute, info.size);
      return digest.ok ? success({ ...base, worktreeDigest: digest.value }) : digest;
    }
    return success({ ...base, worktreeDigest: sha256(info.isDirectory() ? "directory" : "special") });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success({ ...base, missing: true });
    return workspaceFailure("workspace_read_failed", "changed path could not be inspected");
  }
}

async function resolveGitPath(root: string, value: string): Promise<ExecutionResult<string>> {
  try {
    return success(await realpath(resolve(root, value.trim())));
  } catch {
    return workspaceFailure("workspace_git_inspection_failed", "Git identity path could not be resolved");
  }
}

export async function captureWorkspaceCheckpoint(
  input: CaptureInput,
): Promise<ExecutionResult<WorkspaceCheckpoint>> {
  let root: string;
  try {
    root = await realpath(input.workspaceRoot);
  } catch {
    return workspaceFailure("workspace_root_invalid", "workspace root could not be canonicalized");
  }

  const writeSet: string[] = [];
  for (const rawPath of input.taskWriteSet) {
    const path = safeRelativePath(root, rawPath);
    if (!path.ok) return path;
    if (!writeSet.includes(path.value)) writeSet.push(path.value);
  }
  writeSet.sort((left, right) => left.localeCompare(right));
  if (writeSet.length > MAX_PATHS) {
    return workspaceFailure("workspace_too_many_paths", "task write set exceeds the bounded path limit");
  }

  const [topLevel, commonDir, gitDir, head, statusOutput, indexOutput] = await Promise.all([
    runGit(root, ["rev-parse", "--show-toplevel"]),
    runGit(root, ["rev-parse", "--git-common-dir"]),
    runGit(root, ["rev-parse", "--git-dir"]),
    runGit(root, ["rev-parse", "--verify", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["ls-files", "--stage", "-z"]),
  ]);
  if (!topLevel.ok) return topLevel;
  if (!commonDir.ok) return commonDir;
  if (!gitDir.ok) return gitDir;
  if (!head.ok) return head;
  if (!statusOutput.ok) return statusOutput;
  if (!indexOutput.ok) return indexOutput;

  let canonicalTop: string;
  try {
    canonicalTop = await realpath(topLevel.value.trim());
  } catch {
    return workspaceFailure("workspace_git_inspection_failed", "repository root could not be resolved");
  }
  if (canonicalTop !== root) {
    return workspaceFailure("workspace_root_mismatch", "workspace root must be the canonical repository root");
  }
  const common = await resolveGitPath(root, commonDir.value);
  if (!common.ok) return common;
  const worktree = await resolveGitPath(root, gitDir.value);
  if (!worktree.ok) return worktree;
  const statuses = parseStatus(root, statusOutput.value);
  if (!statuses.ok) return statuses;
  const index = parseIndex(root, indexOutput.value);
  if (!index.ok) return index;

  const changedPaths: PathFingerprint[] = [];
  for (const record of statuses.value) {
    const entry = await fingerprint(root, record, index.value);
    if (!entry.ok) return entry;
    changedPaths.push(entry.value);
  }
  changedPaths.sort((left, right) => left.path.localeCompare(right.path));
  const headCommit = head.value.trim();
  const workingStateDigest = sha256(JSON.stringify({ headCommit, changedPaths }));
  return success({
    workspaceRoot: root,
    repositoryId: sha256(common.value),
    worktreeId: sha256(worktree.value),
    headCommit,
    workingStateDigest,
    taskWriteSet: writeSet,
    changedPaths,
    capturedAtMs: input.capturedAtMs,
  });
}
