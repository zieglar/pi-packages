import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseHookRules, type CeHookRule } from "../dist/hooks/config.js";
import type { LivePolicyRef } from "../dist/tunnel/live-session-policy.js";

const VERSION = 2;
const MAX_BYTES = 65_536;
const unavailable = (): never => { throw new Error("workspace Hook profile unavailable"); };
const conflict = (): never => { throw new Error("workspace Hook profile conflict"); };

export interface WorkspaceHookProfileSnapshot {
  readonly revision: number;
  readonly digest: string;
  readonly hooks: readonly CeHookRule[];
  readonly operationId: string | null;
  readonly policyDigest: string | null;
}
export interface WorkspaceHookProfilePending {
  readonly expectedRevision: number;
  readonly hooks: readonly CeHookRule[];
  readonly operationId: string;
  readonly actorRuntimeSessionId: string;
  readonly endpointId: string;
  readonly epoch: number;
  readonly expectedPolicyDigest: string;
}
export interface WorkspaceHookAdoption {
  readonly runtimeSessionId: string;
  readonly endpointId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly profileDigest: string;
  readonly policyDigest: string;
  readonly operationId: string;
}

function workspaceDigest(workspace: string): string {
  if (!isAbsolute(workspace)) return unavailable();
  const canonical = fs.realpathSync(workspace);
  const stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return unavailable();
  return createHash("sha256").update(JSON.stringify(["ce-workspace-hook-profile-v2", canonical])).digest("hex");
}

function privateDirectory(path: string, create: boolean): string {
  if (create) {
    try { fs.mkdirSync(path, { recursive: false, mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) return unavailable();
  return path;
}

function profileRoot(ref: LivePolicyRef, workspace: string, create: boolean): { readonly path: string; readonly workspaceDigest: string } {
  const digest = workspaceDigest(workspace);
  const profiles = privateDirectory(join(ref.root, "workspace-hook-profiles"), create);
  return { path: privateDirectory(join(profiles, digest), create), workspaceDigest: digest };
}

function readPrivateFile(path: string): Buffer {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_BYTES) return unavailable();
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function parseRecord(bytes: Buffer, workspace: string, revision: number, parentDigest: string | null): WorkspaceHookProfileSnapshot {
  if (bytes.length > MAX_BYTES) return unavailable();
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return unavailable(); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== 8) return unavailable();
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || value.workspaceDigest !== workspace || value.revision !== revision || value.parentDigest !== parentDigest ||
      typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) || !Array.isArray(value.hooks) ||
      (value.operationId !== null && (typeof value.operationId !== "string" || value.operationId.length < 1 || value.operationId.length > 256)) ||
      (value.policyDigest !== null && (typeof value.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.policyDigest)))) return unavailable();
  const unsigned = Buffer.from(`${JSON.stringify({ version: VERSION, workspaceDigest: workspace, revision, parentDigest, hooks: value.hooks, operationId: value.operationId, policyDigest: value.policyDigest })}\n`);
  if (createHash("sha256").update(unsigned).digest("hex") !== value.digest) return unavailable();
  const hooks = parseHookRules(value.hooks);
  if (hooks.some(rule => rule.scope !== "workspace")) return unavailable();
  return Object.freeze({ revision, digest: value.digest, hooks, operationId: value.operationId as string | null, policyDigest: value.policyDigest as string | null });
}

export function readWorkspaceHookProfileSnapshot(ref: LivePolicyRef, workspace: string): WorkspaceHookProfileSnapshot | undefined {
  let root: ReturnType<typeof profileRoot>;
  try { root = profileRoot(ref, workspace, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let head: unknown;
  try { head = JSON.parse(readPrivateFile(join(root.path, "HEAD.json")).toString("utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (head === null || typeof head !== "object" || Array.isArray(head) || Reflect.ownKeys(head).length !== 2) return unavailable();
  const fields = head as Record<string, unknown>;
  if (!Number.isSafeInteger(fields.revision) || (fields.revision as number) < 1 || typeof fields.digest !== "string") return unavailable();
  let snapshot: WorkspaceHookProfileSnapshot | undefined;
  let parent: string | null = null;
  for (let revision = 1; revision <= (fields.revision as number); revision += 1) {
    snapshot = parseRecord(readPrivateFile(join(root.path, `${String(revision).padStart(12, "0")}.json`)), root.workspaceDigest, revision, parent);
    parent = snapshot.digest;
  }
  if (snapshot?.digest !== fields.digest) return unavailable();
  return snapshot;
}

export function readWorkspaceHookProfile(ref: LivePolicyRef, workspace: string): readonly CeHookRule[] | undefined {
  return readWorkspaceHookProfileSnapshot(ref, workspace)?.hooks;
}

export function writeWorkspaceHookProfile(ref: LivePolicyRef, workspace: string, hooks: readonly CeHookRule[], options: { readonly expectedRevision?: number; readonly operationId?: string; readonly policyDigest?: string; readonly commitPendingOperationId?: string } = {}): WorkspaceHookProfileSnapshot {
  const validated = parseHookRules(hooks);
  if (validated.some(rule => rule.scope !== "workspace")) return unavailable();
  const root = profileRoot(ref, workspace, true);
  const lock = join(root.path, "WRITE.lock");
  fs.mkdirSync(lock, { mode: 0o700 });
  try {
    const current = readWorkspaceHookProfileSnapshot(ref, workspace);
    const pending = readWorkspaceHookProfilePending(ref, workspace);
    if (pending !== undefined && pending.operationId !== options.commitPendingOperationId) throw new Error("workspace Hook profile pending");
    const revision = current?.revision ?? 0;
    if (options.expectedRevision !== undefined && options.expectedRevision !== revision) return conflict();
    const nextRevision = revision + 1;
    if (options.operationId !== undefined && (options.operationId.length < 1 || options.operationId.length > 256)) return unavailable();
    if (options.policyDigest !== undefined && !/^[a-f0-9]{64}$/.test(options.policyDigest)) return unavailable();
    const unsignedObject = { version: VERSION, workspaceDigest: root.workspaceDigest, revision: nextRevision, parentDigest: current?.digest ?? null, hooks: validated, operationId: options.operationId ?? null, policyDigest: options.policyDigest ?? null };
    const unsigned = Buffer.from(`${JSON.stringify(unsignedObject)}\n`);
    const digest = createHash("sha256").update(unsigned).digest("hex");
    const bytes = Buffer.from(`${JSON.stringify({ ...unsignedObject, digest }, null, 2)}\n`);
    if (bytes.length > MAX_BYTES) return unavailable();
    const record = join(root.path, `${String(nextRevision).padStart(12, "0")}.json`);
    try {
      const fd = fs.openSync(record, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || options.commitPendingOperationId === undefined) throw error;
      const staged = parseRecord(readPrivateFile(record), root.workspaceDigest, nextRevision, current?.digest ?? null);
      if (staged.operationId !== options.commitPendingOperationId || staged.digest !== digest || !isDeepStrictEqual(staged.hooks, validated)) return unavailable();
    }
    const headStage = join(root.path, `.head-${randomUUID()}`);
    const headFd = fs.openSync(headStage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(headFd, `${JSON.stringify({ revision: nextRevision, digest })}\n`); fs.fsyncSync(headFd); } finally { fs.closeSync(headFd); }
    fs.renameSync(headStage, join(root.path, "HEAD.json"));
    const directoryFd = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    return Object.freeze({ revision: nextRevision, digest, hooks: validated, operationId: options.operationId ?? null, policyDigest: options.policyDigest ?? null });
  } finally { fs.rmdirSync(lock); }
}

function parsePending(bytes: Buffer): WorkspaceHookProfilePending {
  if (bytes.length > MAX_BYTES) return unavailable();
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return unavailable(); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== 9) return unavailable();
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
      typeof value.operationId !== "string" || value.operationId.length < 1 || value.operationId.length > 256 ||
      typeof value.actorRuntimeSessionId !== "string" || value.actorRuntimeSessionId.length < 1 || value.actorRuntimeSessionId.length > 256 ||
      typeof value.endpointId !== "string" || value.endpointId.length < 1 || value.endpointId.length > 256 ||
      !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 || typeof value.expectedPolicyDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedPolicyDigest) ||
      typeof value.candidateDigest !== "string" || !Array.isArray(value.hooks)) return unavailable();
  const hooks = parseHookRules(value.hooks);
  if (hooks.some(rule => rule.scope !== "workspace") || createHash("sha256").update(JSON.stringify(hooks)).digest("hex") !== value.candidateDigest) return unavailable();
  return Object.freeze({ expectedRevision: value.expectedRevision as number, hooks, operationId: value.operationId, actorRuntimeSessionId: value.actorRuntimeSessionId,
    endpointId: value.endpointId, epoch: value.epoch as number, expectedPolicyDigest: value.expectedPolicyDigest });
}

export function readWorkspaceHookProfilePending(ref: LivePolicyRef, workspace: string): WorkspaceHookProfilePending | undefined {
  let root: ReturnType<typeof profileRoot>;
  try { root = profileRoot(ref, workspace, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try { return parsePending(readPrivateFile(join(root.path, "PENDING.json"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

export function reserveWorkspaceHookProfile(ref: LivePolicyRef, workspace: string, input: WorkspaceHookProfilePending): WorkspaceHookProfilePending {
  const root = profileRoot(ref, workspace, true);
  const current = readWorkspaceHookProfileSnapshot(ref, workspace);
  if ((current?.revision ?? 0) !== input.expectedRevision) return conflict();
  if (readWorkspaceHookProfilePending(ref, workspace) !== undefined) throw new Error("workspace Hook profile pending");
  const hooks = parseHookRules(input.hooks);
  if (hooks.some(rule => rule.scope !== "workspace")) return unavailable();
  const candidateDigest = createHash("sha256").update(JSON.stringify(hooks)).digest("hex");
  const bytes = Buffer.from(`${JSON.stringify({ version: VERSION, ...input, hooks, candidateDigest }, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) return unavailable();
  const fd = fs.openSync(join(root.path, "PENDING.json"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return parsePending(bytes);
}

export function commitWorkspaceHookProfilePending(ref: LivePolicyRef, workspace: string, input: { readonly operationId: string; readonly publicationOutcome: "PUBLISHED"; readonly policyDigest: string }): WorkspaceHookProfileSnapshot {
  const pending = readWorkspaceHookProfilePending(ref, workspace) ?? unavailable();
  if (pending.operationId !== input.operationId || input.publicationOutcome !== "PUBLISHED" || !/^[a-f0-9]{64}$/.test(input.policyDigest)) return unavailable();
  const current = readWorkspaceHookProfileSnapshot(ref, workspace);
  let committed: WorkspaceHookProfileSnapshot;
  if (current?.operationId === pending.operationId) committed = current;
  else committed = writeWorkspaceHookProfile(ref, workspace, pending.hooks, { expectedRevision: pending.expectedRevision, operationId: pending.operationId, policyDigest: input.policyDigest, commitPendingOperationId: pending.operationId });
  fs.unlinkSync(join(profileRoot(ref, workspace, false).path, "PENDING.json"));
  return committed;
}

export function cancelWorkspaceHookProfilePending(ref: LivePolicyRef, workspace: string, input: { readonly operationId: string; readonly publicationOutcome: "NOT_OBSERVED" }): void {
  const pending = readWorkspaceHookProfilePending(ref, workspace) ?? unavailable();
  if (pending.operationId !== input.operationId || input.publicationOutcome !== "NOT_OBSERVED") return unavailable();
  fs.unlinkSync(join(profileRoot(ref, workspace, false).path, "PENDING.json"));
}

function adoptionName(input: Pick<WorkspaceHookAdoption, "runtimeSessionId" | "endpointId" | "epoch">): string {
  if (!Number.isSafeInteger(input.epoch) || input.epoch < 1) return unavailable();
  return `${createHash("sha256").update(JSON.stringify(["ce-workspace-hook-adoption-v1", input.runtimeSessionId, input.endpointId, input.epoch])).digest("hex")}.json`;
}

function parseAdoption(bytes: Buffer): WorkspaceHookAdoption {
  let raw: unknown;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { return unavailable(); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || Reflect.ownKeys(raw).length !== 8) return unavailable();
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || typeof value.runtimeSessionId !== "string" || value.runtimeSessionId.length < 1 || value.runtimeSessionId.length > 256 ||
      typeof value.endpointId !== "string" || value.endpointId.length < 1 || value.endpointId.length > 256 || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.profileDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.profileDigest) ||
      typeof value.policyDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.policyDigest) || typeof value.operationId !== "string" || value.operationId.length < 1 || value.operationId.length > 256) return unavailable();
  return Object.freeze({ runtimeSessionId: value.runtimeSessionId, endpointId: value.endpointId, epoch: value.epoch as number, revision: value.revision as number,
    profileDigest: value.profileDigest, policyDigest: value.policyDigest, operationId: value.operationId });
}

export function recordWorkspaceHookAdoption(ref: LivePolicyRef, workspace: string, adoption: WorkspaceHookAdoption): void {
  const root = profileRoot(ref, workspace, true);
  const current = readWorkspaceHookProfileSnapshot(ref, workspace) ?? unavailable();
  if (current.revision !== adoption.revision || current.digest !== adoption.profileDigest) return conflict();
  const bytes = Buffer.from(`${JSON.stringify({ version: VERSION, ...adoption }, null, 2)}\n`);
  parseAdoption(bytes);
  const directory = privateDirectory(join(root.path, "adoptions"), true);
  const target = join(directory, adoptionName(adoption));
  try {
    const existing = parseAdoption(readPrivateFile(target));
    if (existing.revision > adoption.revision) return conflict();
    if (existing.revision === adoption.revision && existing.profileDigest === adoption.profileDigest && existing.policyDigest === adoption.policyDigest && existing.operationId === adoption.operationId) return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stage = join(directory, `.adoption-${randomUUID()}`);
  const fd = fs.openSync(stage, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(stage, target);
}

export function readWorkspaceHookAdoption(ref: LivePolicyRef, workspace: string, identity: Pick<WorkspaceHookAdoption, "runtimeSessionId" | "endpointId" | "epoch">): WorkspaceHookAdoption | undefined {
  let root: ReturnType<typeof profileRoot>;
  try { root = profileRoot(ref, workspace, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const directory = privateDirectory(join(root.path, "adoptions"), false);
    const adoption = parseAdoption(readPrivateFile(join(directory, adoptionName(identity))));
    if (adoption.runtimeSessionId !== identity.runtimeSessionId || adoption.endpointId !== identity.endpointId || adoption.epoch !== identity.epoch) return unavailable();
    return adoption;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
