/** Real tunnel configuration domain. No UI, Keychain, Store, endpoint, child
 * process, or network operations. Credential bytes are only supplied by the
 * caller for Replace; existing key contents are NEVER opened/read.
 *
 * Each Replace writes a private immutable generation first. The profile rename
 * is the sole commit point. Old generations deliberately remain operator-owned:
 * deleting them could break a client still reading the previous profile.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_BINDING_CONFIG_MAX_BYTES, parseMcpBindingConfig } from "../host/mcp-binding-config.js";
import { TunnelRefusal } from "./codes.js";
import {
  checkKeyFileMetadata, createBackgroundTunnelManager, parseTunnelProfile, resolveTunnelProfilePath,
  type BackgroundTunnelManager, type TunnelProfileFacts,
} from "./background-manager.js";
import { buildTunnelMcpCommand, buildTunnelProfile, parseTunnelMcpCommand, replaceTunnelMcpBindingPath, serializeTunnelProfile, validateTunnelIdentity } from "./profile.js";

const MAX_PROFILE_BYTES = 65_536;
const invalid = (field: string): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);
function absolute(path: string, field: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path ||
      !/^[\x20\x21\x23-\x5B\x5D-\x7E]+$/.test(path)) throw invalid(field);
}

/** Identity of an already-opened file, used to refuse metadata-only aliases. */
type FileIdentity = Readonly<{ dev: number; ino: number }>;
function sameFile(identity: FileIdentity, stat: FileIdentity): boolean {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

/** Read a bounded, operator-owned ordinary configuration file through a
 * no-follow fd. Only ENOENT may represent an absent profile. */
function readConfiguration(path: string, max: number, field: string, absent: boolean,
  excluded?: readonly FileIdentity[]): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.size > max ||
      excluded?.some((identity) => sameFile(identity, stat))) throw invalid(field);
    const text = fs.readFileSync(fd, "utf8");
    if (Buffer.byteLength(text, "utf8") > max) throw invalid(field);
    return text;
  } catch (error) {
    if (fd === undefined && absent && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid(field);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Static formal JSON validation only. Does not even stat the configured Store.
 * Returns the selected reference, not endpoint/recipient/lease authority. */
export function validateTunnelBindingFile(path: string, credentialFile?: string): { readonly path: string } {
  absolute(path, "binding.path");
  try {
    let excluded: readonly FileIdentity[] | undefined;
    if (credentialFile !== undefined) {
      if (path === credentialFile) throw invalid("binding");
      try {
        // lstat excludes a binding hardlink to the credential link itself; stat
        // adds the link target without opening credential contents. The latter
        // prevents a binding path at a credential symlink target from passing
        // through to readConfiguration.
        const credentialEntry = fs.lstatSync(credentialFile);
        const credentialTarget = credentialEntry.isSymbolicLink() ? fs.statSync(credentialFile) : credentialEntry;
        excluded = [credentialEntry, credentialTarget];
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid("binding"); }
      const selected = fs.lstatSync(path);
      if (excluded?.some((identity) => sameFile(identity, selected))) throw invalid("binding");
    }
    // Recheck the opened fd before reading, so a concurrent path swap cannot
    // turn this static config read into a credential-content read.
    const text = readConfiguration(path, MCP_BINDING_CONFIG_MAX_BYTES, "binding", false, excluded)!;
    parseMcpBindingConfig(JSON.parse(text) as unknown);
  } catch { throw invalid("binding"); }
  return Object.freeze({ path });
}

export interface TunnelSetupInspection {
  readonly profilePath: string;
  readonly exists: boolean;
  /** Optimistic concurrency token. null means the profile was absent. */
  readonly revision: string | null;
  readonly tunnelId: string | undefined;
  readonly organizationId: string | undefined;
  readonly mcpCommand: string | undefined;
  readonly bindingPath: string | undefined;
  readonly credentialConfigured: boolean;
}
export type TunnelSetupCredential = { readonly kind: "keep" } | { readonly kind: "replace"; readonly secret: string };
export interface TunnelSetupSaveInput {
  readonly expectedRevision: string | null;
  readonly tunnelId: string;
  /** undefined/empty means Not configured, not preserve-the-old-value. */
  readonly organizationId?: string;
  readonly credential: TunnelSetupCredential;
  /** Required on first creation. On edit, omission keeps the old binding;
   * an explicit path authorizes a change after the caller's change review.
   * Executable/script/channel and unrelated YAML are always preserved. */
  readonly bindingPath?: string;
  readonly signal?: AbortSignal;
}
export type TunnelSetupSaveResult =
  | { readonly kind: "cancelled" }
  | { readonly kind: "saved"; readonly profilePath: string; readonly durability: "synced" | "uncertain" };
/** Small filesystem fault-injection boundary; production defaults are Node fs.
 * No read-credential operation exists in the transaction interface. */
export type SetupFileOperations = Pick<typeof fs, "openSync" | "closeSync" | "writeFileSync" | "fsyncSync" | "renameSync" | "unlinkSync">;
export interface TunnelProfileSetupOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly profilePath?: string;
  readonly manager?: Pick<BackgroundTunnelManager, "withProfileConfigurationLock">;
  readonly nodePath?: string;
  readonly mcpScriptPath?: string;
  readonly io?: Partial<SetupFileOperations>;
  /** Test seam; production creates a dedicated private generation directory. */
  readonly credentialDirectoryGuard?: (path: string) => CredentialDirectoryCleanup;
}
export interface TunnelProfileSetup {
  inspect(): TunnelSetupInspection;
  /** Static UI preflight with the current credential excluded internally. */
  validateBinding(path: string): { readonly path: string };
  save(input: TunnelSetupSaveInput): Promise<TunnelSetupSaveResult>;
}

/** Removes a credential directory this transaction created, or undefined when the
 * directory already existed and must therefore be left alone. */
type CredentialDirectoryCleanup = (() => void) | undefined;

/** Create a dedicated directory before a secret exists. On Darwin, chmod -N
 * removes inherited ACL entries before the generation is opened; a failed native
 * operation is a refusal, never a best-effort downgrade. */
function ensurePrivateCredentialDirectory(path: string): CredentialDirectoryCleanup {
  let created = false;
  try { fs.mkdirSync(path, { mode: 0o700 }); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalid("credential.directory"); }
  let stat: fs.Stats;
  try { stat = fs.lstatSync(path); } catch { throw invalid("credential.directory"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw invalid("credential.directory");
  }
  if (process.platform === "darwin") {
    try { execFileSync("/bin/chmod", ["-N", path], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000 }); }
    catch { throw invalid("credential.directory"); }
    try { stat = fs.lstatSync(path); } catch { throw invalid("credential.directory"); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) {
      throw invalid("credential.directory");
    }
  }
  return created ? () => { fs.rmdirSync(path); } : undefined;
}

/** Record only absent profile-directory entries before the manager can create
 * them. After the profile rename we sync from their known existing parent down,
 * avoiding symlinked system ancestors while making each new entry durable. */
function missingDirectoryLineage(directory: string): readonly string[] {
  const missing: string[] = [];
  for (let current = directory;; current = dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid("profile.directory");
      return missing.reverse();
    } catch (error) {
      if (error instanceof TunnelRefusal) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw invalid("profile.directory");
      const parent = dirname(current);
      if (parent === current) throw invalid("profile.directory");
      missing.push(current);
    }
  }
}

function syncCommittedProfileDirectories(profileDirectory: string, missing: readonly string[], io: SetupFileOperations): boolean {
  const directories = missing.length === 0 ? [profileDirectory] : [dirname(missing[0]!), ...missing];
  try {
    for (const directory of directories) {
      const fd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
    }
    return true;
  } catch { return false; }
}

const revisionOf = (text: string | undefined): string | null => text === undefined ? null : createHash("sha256").update(text, "utf8").digest("hex");
/** Preserve every unrelated byte, notably MCP command/channel/comments. */
function updateProfile(text: string, input: TunnelSetupSaveInput, keyFile: string, mcpCommand?: string): string {
  let next = text.replace(/^  tunnel_id:.*$/m, () => `  tunnel_id: "${input.tunnelId}"`)
    .replace(/^  api_key:.*$/m, () => `  api_key: "file:${keyFile}"`);
  next = next.replace(/^  organization_id:.*\n?/m, "");
  if (input.organizationId) next = next.replace(/^(  tunnel_id:.*)$/m, `$1\n  organization_id: "${input.organizationId}"`);
  if (mcpCommand !== undefined) {
    next = next.replace(/^(      command:[ ]*)"[^"]*"([ ]*)$/m,
      (_line, prefix: string, suffix: string) => `${prefix}"${mcpCommand}"${suffix}`);
  }
  return next;
}

export function createTunnelProfileSetup(options: TunnelProfileSetupOptions): TunnelProfileSetup {
  const profilePath = resolveTunnelProfilePath(options);
  absolute(profilePath, "profile");
  const manager = options.manager ?? createBackgroundTunnelManager({ env: options.env, profilePath });
  const io: SetupFileOperations = {
    openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, unlinkSync: fs.unlinkSync, ...options.io,
  };
  const credentialDirectoryGuard = options.credentialDirectoryGuard ?? ensurePrivateCredentialDirectory;
  const read = (): { text: string | undefined; facts: TunnelProfileFacts | undefined } => {
    const text = readConfiguration(profilePath, MAX_PROFILE_BYTES, "profile", true);
    return { text, facts: text === undefined ? undefined : parseTunnelProfile(text) };
  };
  const inspect = (): TunnelSetupInspection => {
    const { text, facts } = read();
    const bindingPath = facts?.mcpCommand === undefined ? undefined : parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
    let credentialConfigured = false;
    if (facts !== undefined) {
      try { checkKeyFileMetadata(facts.keyFile); credentialConfigured = true; } catch { /* Replace remains possible. */ }
    }
    return Object.freeze({ profilePath, exists: text !== undefined, revision: revisionOf(text),
      tunnelId: facts?.tunnelId, organizationId: facts?.organizationId, mcpCommand: facts?.mcpCommand,
      bindingPath, credentialConfigured });
  };
  const save = async (input: TunnelSetupSaveInput): Promise<TunnelSetupSaveResult> => {
    if (input.signal?.aborted) return { kind: "cancelled" };
    validateTunnelIdentity(input.tunnelId, input.organizationId);
    if (input.credential.kind !== "keep" && input.credential.kind !== "replace") throw invalid("credential");
    if (input.credential.kind === "replace" && (typeof input.credential.secret !== "string" ||
      !/^[\x20-\x7E]{1,4096}$/.test(input.credential.secret))) throw invalid("credential");
    const missingProfileDirectories = missingDirectoryLineage(dirname(profilePath));
    return manager.withProfileConfigurationLock((guard): TunnelSetupSaveResult => {
      if (input.signal?.aborted) return { kind: "cancelled" };
      if (guard.profilePath !== profilePath) throw invalid("setup.lock-profile");
      const { text, facts } = read();
      if (revisionOf(text) !== input.expectedRevision) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
      if (input.credential.kind === "keep") {
        if (facts === undefined) throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING");
        checkKeyFileMetadata(facts.keyFile);
      }
      const existingBinding = facts?.mcpCommand === undefined ? undefined : parseTunnelMcpCommand(facts.mcpCommand).bindingPath;
      if (facts !== undefined && existingBinding === undefined) throw invalid("mcp.commands");
      const bindingPath = input.bindingPath ?? existingBinding;
      if (bindingPath === undefined) throw invalid("binding.path");
      validateTunnelBindingFile(bindingPath, facts?.keyFile);
      const changedCommand = facts?.mcpCommand !== undefined && bindingPath !== existingBinding
        ? replaceTunnelMcpBindingPath(facts.mcpCommand, bindingPath) : undefined;
      const credentialDirectory = join(dirname(profilePath), ".credentials");
      const keyFile = input.credential.kind === "keep" ? facts!.keyFile : join(credentialDirectory, `credential-${randomUUID()}`);
      const nextText = text === undefined ? serializeTunnelProfile(buildTunnelProfile({
        tunnelId: input.tunnelId, ...(input.organizationId ? { organizationId: input.organizationId } : {}), keyFile,
        healthUrlFile: join(dirname(profilePath), "health.url"),
        mcpCommand: buildTunnelMcpCommand({ nodePath: options.nodePath ?? process.execPath,
          scriptPath: options.mcpScriptPath ?? fileURLToPath(new URL("../bin/mcp-stdio.js", import.meta.url)), bindingPath }),
      })) : updateProfile(text, input, keyFile, changedCommand);
      parseTunnelProfile(nextText); // Same decoder as real start, before any write.
      if (Buffer.byteLength(nextText, "utf8") > MAX_PROFILE_BYTES) throw invalid("profile.size");
      const temporaryProfile = `${profilePath}.${randomUUID()}.tmp`;
      const owned: { path: string; ino: number; dev: number }[] = [];
      let committed = false;
      let directoryFd: number | undefined;
      let cleanupCredentialDirectory: CredentialDirectoryCleanup;
      const create = (path: string, data: string): void => {
        const fd = io.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(fd);
          owned.push({ path, ino: stat.ino, dev: stat.dev });
          if (stat.mode !== 0o100600 || stat.uid !== process.geteuid?.()) throw invalid("setup.permissions");
          io.writeFileSync(fd, data, "utf8");
          io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
      };
      try {
        guard.assertIntact();
        if (input.signal?.aborted) return { kind: "cancelled" };
        if (input.credential.kind === "replace") cleanupCredentialDirectory = credentialDirectoryGuard(credentialDirectory);
        directoryFd = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        if (input.credential.kind === "replace") create(keyFile, input.credential.secret);
        create(temporaryProfile, nextText);
        // A directory fsync persists only that directory's own entries. The new
        // generation's name lives in .credentials, so both the profile directory
        // and .credentials must be synced before the profile can reference it.
        // Failure here is still precommit and refuses without any rollback claim.
        if (input.credential.kind === "replace") {
          const credentialDirectoryFd = io.openSync(credentialDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { io.fsyncSync(credentialDirectoryFd); } finally { io.closeSync(credentialDirectoryFd); }
        }
        io.fsyncSync(directoryFd);
        guard.assertIntact();
        if (input.signal?.aborted) return { kind: "cancelled" };
        if (revisionOf(read().text) !== input.expectedRevision) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
        checkKeyFileMetadata(keyFile);
        io.renameSync(temporaryProfile, profilePath); // SOLE COMMIT POINT
        committed = true;
        // A post-rename error cannot honestly be reported as an uncommitted
        // failure. Never delete/roll back an already referenced generation.
        const durability = syncCommittedProfileDirectories(dirname(profilePath), missingProfileDirectories, io) ? "synced" as const : "uncertain" as const;
        return { kind: "saved", profilePath, durability };
      } catch (error) {
        if (error instanceof TunnelRefusal) throw error;
        throw invalid("setup.transaction"); // Never forward fs messages/causes.
      } finally {
        let cleanupFailed = false;
        if (directoryFd !== undefined) { try { io.closeSync(directoryFd); } catch { /* no postcommit rollback */ } }
        if (!committed) {
          for (const file of owned.reverse()) {
            try {
              const stat = fs.lstatSync(file.path);
              if (stat.ino === file.ino && stat.dev === file.dev) io.unlinkSync(file.path);
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupFailed = true; }
          }
          if (cleanupCredentialDirectory !== undefined) {
            try { cleanupCredentialDirectory(); } catch { cleanupFailed = true; }
          }
        }
        if (cleanupFailed) throw invalid("setup.cleanup");
      }
    });
  };
  return { inspect, validateBinding: (path) => validateTunnelBindingFile(path, read().facts?.keyFile), save };
}
