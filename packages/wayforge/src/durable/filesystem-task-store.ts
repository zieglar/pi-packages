import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { DurableTaskStore, TaskLease } from "./contracts.js";
import {
  deserializeTaskState,
  serializeTaskState,
  type AuthoritativeTaskState,
} from "./state.js";
import type { TaskId } from "../types/identity.js";
import type { ExecutionResult, FailureKind } from "../types/result.js";
import { failure, success } from "../types/result.js";

const STATE_FILE = "state.json";
const BACKUP_FILE = "state.prev.json";
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const LEASE_CLAIM_DIRECTORY = "lease.claim";
const LEASE_METADATA_FILE = "lease.json";
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;

function storeFailure(
  code: string,
  message: string,
  kind: FailureKind = "validation",
): ExecutionResult<never> {
  return failure({ kind, scope: "task", confidence: "certain", code, message });
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

function validLeaseTtl(ttlMs: number): boolean {
  return Number.isInteger(ttlMs) && ttlMs > 0 && ttlMs <= MAX_LEASE_TTL_MS;
}

function cloneState(state: AuthoritativeTaskState): ExecutionResult<AuthoritativeTaskState> {
  try {
    const parsed = deserializeTaskState(serializeTaskState(state));
    return parsed.ok
      ? parsed
      : storeFailure("schema_violation", "task state is outside the authoritative allowlist");
  } catch {
    return storeFailure("schema_violation", "task state is outside the authoritative allowlist");
  }
}

/** Deterministic, collision-free filesystem component for a bounded task ID. */
export function durableTaskDirectoryName(taskId: string): string {
  const encoded = Buffer.from(taskId, "utf8").toString("base64url");
  return `task-${encoded.length === 0 ? "empty" : encoded}`;
}

/** Authoritative task root beneath one Pi agent directory. */
export function durableTaskStoreRoot(agentDirectory: string): string {
  return join(resolve(agentDirectory), "wayforge", "tasks");
}
export interface FilesystemDurableTaskStoreOptions {
  readonly now?: () => number;
}

interface LeaseMetadata {
  readonly taskId: string;
  readonly ownerToken: string;
  readonly leaseGeneration: number;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
  readonly pid: number;
}

const LEASE_METADATA_KEYS = new Set([
  "taskId",
  "ownerToken",
  "leaseGeneration",
  "acquiredAtMs",
  "expiresAtMs",
  "pid",
]);

function validLeaseMetadata(value: unknown): value is LeaseMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !LEASE_METADATA_KEYS.has(key))) return false;
  return (
    typeof record.taskId === "string" &&
    record.taskId.length > 0 &&
    typeof record.ownerToken === "string" &&
    /^[a-f0-9]{32}$/.test(record.ownerToken) &&
    Number.isInteger(record.leaseGeneration) &&
    Number(record.leaseGeneration) > 0 &&
    Number.isInteger(record.acquiredAtMs) &&
    Number.isInteger(record.expiresAtMs) &&
    Number(record.expiresAtMs) >= Number(record.acquiredAtMs) &&
    Number.isInteger(record.pid)
  );
}


interface TaskPaths {
  readonly directory: string;
  readonly state: string;
  readonly backup: string;
  readonly claim: string;
}

/**
 * Filesystem-backed authoritative task store.
 *
 * Each committed snapshot is written to a random exclusive temporary file,
 * fsynced, atomically renamed, then followed by a directory fsync. Backups are
 * diagnostic/recovery evidence only and are never promoted automatically.
 */
export class FilesystemDurableTaskStore implements DurableTaskStore {
  private readonly configuredRoot: string;
  private canonicalRoot: string | undefined;
  private readonly now: () => number;

  constructor(root: string, options: FilesystemDurableTaskStoreOptions = {}) {
    this.configuredRoot = resolve(root);
    this.now = options.now ?? (() => Date.now());
  }

  async create(state: AuthoritativeTaskState): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const rootResult = await this.ensureRoot();
    if (!rootResult.ok) return rootResult;
    const cloned = cloneState(state);
    if (!cloned.ok) return cloned;
    if (cloned.value.revision !== 0) {
      return storeFailure("invalid_initial_revision", "new durable tasks must start at revision zero");
    }

    const pathsResult = await this.pathsFor(cloned.value.taskId);
    if (!pathsResult.ok) return pathsResult;
    const paths = pathsResult.value;
    let createdDirectory = false;
    try {
      const existing = await this.inspectTaskDirectory(paths.directory);
      if (!existing.ok) return existing;
      if (existing.value === "directory") {
        const committed = await this.readCommittedFile(paths.state);
        if (!committed.ok) return committed;
        return storeFailure("task_already_exists", "task already exists in the durable store");
      }
      await mkdir(paths.directory, { mode: DIRECTORY_MODE });
      createdDirectory = true;
      await chmod(paths.directory, DIRECTORY_MODE);
      await this.atomicWrite(paths.state, `${serializeTaskState(cloned.value)}\n`);
      return success(cloned.value);
    } catch {
      if (createdDirectory) await rm(paths.directory, { recursive: true, force: true }).catch(() => undefined);
      return storeFailure("durable_store_io", "failed to create authoritative task state", "tool");
    }
  }

  async load(taskId: TaskId): Promise<ExecutionResult<AuthoritativeTaskState | null>> {
    const rootResult = await this.ensureRoot();
    if (!rootResult.ok) return rootResult;
    const pathsResult = await this.pathsFor(taskId);
    if (!pathsResult.ok) return pathsResult;
    const paths = pathsResult.value;

    const inspected = await this.inspectTaskDirectory(paths.directory);
    if (!inspected.ok) return inspected;
    if (inspected.value === "missing") return success(null);

    const serialized = await this.readCommittedFile(paths.state);
    if (!serialized.ok) return serialized;
    return this.parseCommittedState(serialized.value, taskId, paths.directory);
  }

  async list(): Promise<ExecutionResult<readonly AuthoritativeTaskState[]>> {
    const rootResult = await this.ensureRoot();
    if (!rootResult.ok) return rootResult;
    let entries;
    try {
      entries = await readdir(rootResult.value, { withFileTypes: true });
    } catch {
      return storeFailure("durable_store_io", "failed to scan authoritative task state", "tool");
    }

    const states: AuthoritativeTaskState[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.startsWith("task-")) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        return storeFailure("durable_store_unsafe_path", "task entry is not a safe directory");
      }
      const directory = join(rootResult.value, entry.name);
      const serialized = await this.readCommittedFile(join(directory, STATE_FILE));
      if (!serialized.ok) return serialized;
      const parsed = this.parseCommittedState(serialized.value, undefined, directory);
      if (!parsed.ok) return parsed;
      if (durableTaskDirectoryName(parsed.value.taskId) !== entry.name) {
        return storeFailure("durable_state_corrupt", "task state identity does not match its directory");
      }
      states.push(parsed.value);
    }
    states.sort((left, right) => left.taskId.localeCompare(right.taskId));
    return success(states);
  }

  async update(
    expectedRevision: number,
    next: AuthoritativeTaskState,
    lease?: TaskLease,
  ): Promise<ExecutionResult<AuthoritativeTaskState>> {
    const cloned = cloneState(next);
    if (!cloned.ok) return cloned;
    if (lease !== undefined) {
      const ownership = await this.validateLease(lease, false);
      if (!ownership.ok) return ownership;
      if (lease.taskId !== cloned.value.taskId || cloned.value.leaseGeneration !== lease.leaseGeneration) {
        return storeFailure("lease_token_mismatch", "lease does not fence the requested task state");
      }
    }
    const loaded = await this.load(cloned.value.taskId as TaskId);
    if (!loaded.ok) return loaded;
    if (loaded.value === null) {
      return storeFailure("task_not_found", "task does not exist in the durable store");
    }
    if (loaded.value.revision !== expectedRevision || cloned.value.revision !== expectedRevision + 1) {
      return storeFailure(
        "stale_task_revision",
        "expected revision mismatch or task revision does not increment by one",
      );
    }

    const pathsResult = await this.pathsFor(cloned.value.taskId);
    if (!pathsResult.ok) return pathsResult;
    try {
      await this.atomicWrite(pathsResult.value.backup, `${serializeTaskState(loaded.value)}\n`);
      await this.atomicWrite(pathsResult.value.state, `${serializeTaskState(cloned.value)}\n`);
      return success(cloned.value);
    } catch {
      return storeFailure("durable_store_io", "failed to update authoritative task state", "tool");
    }
  }

  async acquireLease(taskId: TaskId, ttlMs: number): Promise<ExecutionResult<TaskLease>> {
    if (!validLeaseTtl(ttlMs)) {
      return storeFailure("invalid_lease_ttl", "lease TTL must be a positive bounded integer");
    }
    const loaded = await this.load(taskId);
    if (!loaded.ok) return loaded;
    if (loaded.value === null) return storeFailure("task_not_found", "task does not exist in the durable store");
    const pathsResult = await this.pathsFor(taskId);
    if (!pathsResult.ok) return pathsResult;
    const paths = pathsResult.value;
    let generationFloor = loaded.value.leaseGeneration;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.readLeaseMetadata(paths.claim);
      if (existing.ok) {
        if (existing.value.expiresAtMs > this.now()) {
          return storeFailure("lease_contended", "an active lease is held by another claimant");
        }
        generationFloor = Math.max(generationFloor, existing.value.leaseGeneration);
        const reclaimed = await this.reclaimClaim(paths, existing.value.ownerToken);
        if (!reclaimed.ok) {
          if (reclaimed.failure.code === "lease_race") continue;
          return reclaimed;
        }
      } else if (existing.failure.code !== "lease_missing") {
        return existing;
      }

      const current = await this.load(taskId);
      if (!current.ok) return current;
      if (current.value === null) return storeFailure("task_not_found", "task does not exist in the durable store");
      const leaseGeneration = Math.max(generationFloor, current.value.leaseGeneration) + 1;
      const nowMs = this.now();
      const metadata: LeaseMetadata = {
        taskId,
        ownerToken: randomBytes(16).toString("hex"),
        leaseGeneration,
        acquiredAtMs: nowMs,
        expiresAtMs: nowMs + ttlMs,
        pid: process.pid,
      };
      const claimed = await this.createClaim(paths, metadata);
      if (!claimed.ok) {
        if (claimed.failure.code === "lease_contended") return claimed;
        return claimed;
      }
      const persisted = await this.persistLeaseGeneration(current.value, paths, leaseGeneration);
      if (!persisted.ok) {
        await this.removeOwnedClaim(paths, metadata).catch(() => undefined);
        return persisted;
      }
      return success({
        taskId,
        ownerToken: metadata.ownerToken,
        leaseGeneration,
        acquiredAtMs: metadata.acquiredAtMs,
        expiresAtMs: metadata.expiresAtMs,
      });
    }
    return storeFailure("lease_contended", "lease ownership changed during acquisition");
  }

  async heartbeatLease(lease: TaskLease, ttlMs: number): Promise<ExecutionResult<TaskLease>> {
    if (!validLeaseTtl(ttlMs)) {
      return storeFailure("invalid_lease_ttl", "lease TTL must be a positive bounded integer");
    }
    const ownership = await this.validateLease(lease, false);
    if (!ownership.ok) return ownership;
    const pathsResult = await this.pathsFor(lease.taskId);
    if (!pathsResult.ok) return pathsResult;
    const renewed: LeaseMetadata = {
      ...ownership.value,
      expiresAtMs: this.now() + ttlMs,
    };
    try {
      await this.atomicWrite(join(pathsResult.value.claim, LEASE_METADATA_FILE), `${JSON.stringify(renewed)}\n`);
    } catch {
      return storeFailure("durable_store_io", "failed to heartbeat the task lease", "tool");
    }
    return success({
      taskId: lease.taskId,
      ownerToken: renewed.ownerToken,
      leaseGeneration: renewed.leaseGeneration,
      acquiredAtMs: renewed.acquiredAtMs,
      expiresAtMs: renewed.expiresAtMs,
    });
  }

  async releaseLease(lease: TaskLease): Promise<ExecutionResult<void>> {
    const ownership = await this.validateLease(lease, true);
    if (!ownership.ok) return ownership;
    const pathsResult = await this.pathsFor(lease.taskId);
    if (!pathsResult.ok) return pathsResult;
    return this.removeOwnedClaim(pathsResult.value, ownership.value);
  }
  private async readLeaseMetadata(claimDirectory: string): Promise<ExecutionResult<LeaseMetadata>> {
    try {
      const claimInfo = await lstat(claimDirectory);
      if (claimInfo.isSymbolicLink() || !claimInfo.isDirectory()) {
        return storeFailure("durable_store_unsafe_path", "lease claim is not a safe directory");
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return storeFailure("lease_missing", "no active lease claim exists");
      }
      return storeFailure("durable_store_io", "failed to inspect the task lease", "tool");
    }

    let handle;
    try {
      handle = await open(
        join(claimDirectory, LEASE_METADATA_FILE),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.size > 16_384) {
        return storeFailure("lease_corrupt", "lease metadata is invalid");
      }
      const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      return validLeaseMetadata(parsed)
        ? success(parsed)
        : storeFailure("lease_corrupt", "lease metadata is invalid");
    } catch (error) {
      if (errorCode(error) === "ELOOP") {
        return storeFailure("durable_store_unsafe_path", "lease metadata is a symbolic link");
      }
      return storeFailure("lease_corrupt", "lease metadata is missing or unreadable");
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  private async createClaim(
    paths: TaskPaths,
    metadata: LeaseMetadata,
  ): Promise<ExecutionResult<void>> {
    const candidate = join(paths.directory, `.lease-candidate-${metadata.ownerToken}`);
    try {
      await mkdir(candidate, { mode: DIRECTORY_MODE });
      await chmod(candidate, DIRECTORY_MODE);
      await this.atomicWrite(
        join(candidate, LEASE_METADATA_FILE),
        `${JSON.stringify(metadata)}\n`,
      );
      await rename(candidate, paths.claim);
      await this.syncDirectory(paths.directory);
      return success(undefined);
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(errorCode(error) ?? "")) {
        return storeFailure("lease_contended", "another claimant acquired the task lease");
      }
      return storeFailure("durable_store_io", "failed to acquire the task lease", "tool");
    } finally {
      await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async reclaimClaim(
    paths: TaskPaths,
    ownerToken: string,
  ): Promise<ExecutionResult<void>> {
    const stale = join(paths.directory, `.lease-stale-${ownerToken}-${randomBytes(6).toString("hex")}`);
    try {
      await rename(paths.claim, stale);
      await this.syncDirectory(paths.directory);
      await rm(stale, { recursive: true, force: true });
      return success(undefined);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return storeFailure("lease_race", "another claimant already reclaimed the stale lease");
      }
      return storeFailure("durable_store_io", "failed to reclaim the stale task lease", "tool");
    }
  }

  private async persistLeaseGeneration(
    current: AuthoritativeTaskState,
    paths: TaskPaths,
    leaseGeneration: number,
  ): Promise<ExecutionResult<void>> {
    if (leaseGeneration <= current.leaseGeneration) {
      return storeFailure("lease_generation_conflict", "lease generation must increase monotonically");
    }
    const next: AuthoritativeTaskState = { ...current, leaseGeneration };
    try {
      await this.atomicWrite(paths.backup, `${serializeTaskState(current)}\n`);
      await this.atomicWrite(paths.state, `${serializeTaskState(next)}\n`);
      return success(undefined);
    } catch {
      return storeFailure("durable_store_io", "failed to persist the lease generation", "tool");
    }
  }

  private async validateLease(
    lease: TaskLease,
    allowExpired: boolean,
  ): Promise<ExecutionResult<LeaseMetadata>> {
    const rootResult = await this.ensureRoot();
    if (!rootResult.ok) return rootResult;
    const pathsResult = await this.pathsFor(lease.taskId);
    if (!pathsResult.ok) return pathsResult;
    const metadata = await this.readLeaseMetadata(pathsResult.value.claim);
    if (
      !metadata.ok ||
      metadata.value.taskId !== lease.taskId ||
      metadata.value.ownerToken !== lease.ownerToken ||
      metadata.value.leaseGeneration !== lease.leaseGeneration
    ) {
      return storeFailure("lease_token_mismatch", "lease token or generation does not match the active lease");
    }
    const state = await this.load(lease.taskId);
    if (!state.ok) return state;
    if (state.value === null || state.value.leaseGeneration !== lease.leaseGeneration) {
      return storeFailure("lease_token_mismatch", "lease generation is not authoritative for the task");
    }
    if (!allowExpired && metadata.value.expiresAtMs <= this.now()) {
      return storeFailure("lease_expired", "lease has expired and must be reacquired");
    }
    return metadata;
  }

  private async removeOwnedClaim(
    paths: TaskPaths,
    metadata: LeaseMetadata,
  ): Promise<ExecutionResult<void>> {
    const current = await this.readLeaseMetadata(paths.claim);
    if (
      !current.ok ||
      current.value.ownerToken !== metadata.ownerToken ||
      current.value.leaseGeneration !== metadata.leaseGeneration
    ) {
      return storeFailure("lease_token_mismatch", "lease token or generation does not match the active lease");
    }
    const released = join(
      paths.directory,
      `.lease-released-${metadata.ownerToken}-${randomBytes(6).toString("hex")}`,
    );
    try {
      await rename(paths.claim, released);
      await this.syncDirectory(paths.directory);
      await rm(released, { recursive: true, force: true });
      return success(undefined);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return storeFailure("lease_token_mismatch", "lease ownership changed before release");
      }
      return storeFailure("durable_store_io", "failed to release the task lease", "tool");
    }
  }


  private async ensureRoot(): Promise<ExecutionResult<string>> {
    try {
      await mkdir(this.configuredRoot, { recursive: true, mode: DIRECTORY_MODE });
      const rootStat = await lstat(this.configuredRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        return storeFailure("durable_store_unsafe_path", "durable task root is not a safe directory");
      }
      await chmod(this.configuredRoot, DIRECTORY_MODE);
      this.canonicalRoot = await realpath(this.configuredRoot);
      return success(this.canonicalRoot);
    } catch {
      return storeFailure("durable_store_io", "failed to initialize authoritative task storage", "tool");
    }
  }

  private async pathsFor(taskId: string): Promise<ExecutionResult<TaskPaths>> {
    const root = this.canonicalRoot;
    if (root === undefined) {
      return storeFailure("durable_store_io", "authoritative task storage is not initialized", "tool");
    }
    const directory = resolve(root, durableTaskDirectoryName(taskId));
    const relation = relative(root, directory);
    if (relation.length === 0 || relation.startsWith("..") || resolve(root, relation) !== directory) {
      return storeFailure("durable_store_unsafe_path", "task path escapes the authoritative root");
    }
    return success({
      directory,
      state: join(directory, STATE_FILE),
      backup: join(directory, BACKUP_FILE),
      claim: join(directory, LEASE_CLAIM_DIRECTORY),
    });
  }

  private async inspectTaskDirectory(
    directory: string,
  ): Promise<ExecutionResult<"missing" | "directory">> {
    try {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        return storeFailure("durable_store_unsafe_path", "task path is not a safe directory");
      }
      return success("directory");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return success("missing");
      return storeFailure("durable_store_io", "failed to inspect authoritative task storage", "tool");
    }
  }

  private async readCommittedFile(path: string): Promise<ExecutionResult<string>> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile()) {
        return storeFailure("durable_store_unsafe_path", "authoritative state path is not a regular file");
      }
      if (info.size > MAX_STATE_BYTES) {
        return storeFailure("durable_state_corrupt", "authoritative task state exceeds the size limit");
      }
      return success(await handle.readFile({ encoding: "utf8" }));
    } catch (error) {
      if (errorCode(error) === "ELOOP") {
        return storeFailure("durable_store_unsafe_path", "authoritative state path is a symbolic link");
      }
      return storeFailure("durable_state_corrupt", "authoritative task state is missing or unreadable");
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
    }
  }

  private parseCommittedState(
    serialized: string,
    expectedTaskId: TaskId | undefined,
    directory: string,
  ): ExecutionResult<AuthoritativeTaskState> {
    const parsed = deserializeTaskState(serialized);
    if (!parsed.ok) {
      return parsed.failure.code === "unsupported_version"
        ? parsed
        : storeFailure("durable_state_corrupt", "authoritative task state failed validation");
    }
    if (expectedTaskId !== undefined && parsed.value.taskId !== expectedTaskId) {
      return storeFailure("durable_state_corrupt", "task state identity does not match the requested task");
    }
    if (resolve(dirname(join(directory, STATE_FILE))) !== resolve(directory)) {
      return storeFailure("durable_store_unsafe_path", "state path escapes the task directory");
    }
    return success(parsed.value);
  }

  private async atomicWrite(target: string, contents: string): Promise<void> {
    const directory = dirname(target);
    const temporary = join(
      directory,
      `.${basename(target)}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`,
    );
    let handle;
    try {
      handle = await open(temporary, "wx", FILE_MODE);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      await this.syncDirectory(directory);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } catch (error) {
      const unsupported = new Set(["EINVAL", "ENOTSUP", "EBADF"]);
      if (process.platform !== "win32" || !unsupported.has(errorCode(error) ?? "")) throw error;
    } finally {
      await handle.close();
    }
  }
}
