/**
 * HANDOFF-CE-SESSION-ONBOARDING-01 — explicit OFFLINE migration of a legacy
 * `ce-multi-session-v1` profile into the live policy chain.
 *
 * Contract:
 * - The migration runs ONLY under the manager's verified STOPPED-only profile
 *   configuration lock. A running/pending/uncertain transport refuses it.
 * - The operator must present the exact current Profile revision and confirm.
 * - The live policy root is a NEW private 0700 directory under `.ce-bindings`;
 *   it holds the single writable live chain, never a copied manifest.
 * - The published launch document is a closed REFERENCE to that chain
 *   (`ce-live-launch-v1`), so the launch identity stays immutable and the
 *   manifest is not duplicated into a second editable file.
 * - The previous generation is retained. Nothing is stopped or started here:
 *   transport lifecycle remains an explicit operator action.
 * - The Profile is repointed to the new immutable binding with an O_EXCL temp
 *   file, fsync, a final lock/revision re-check and one rename. An uncertain
 *   rename is reported as uncertain and never retried or rolled back.
 *
 * This module never reads a credential, mutates a Store, an Owner or a
 * capability, and never performs a network operation.
 */
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { parseMcpBindingConfig, type McpBindingConfig } from "../host/mcp-binding-config.js";
import { TunnelRefusal } from "./codes.js";
import { parseTunnelProfile } from "./background-manager.js";
import { replaceTunnelMcpBindingPath } from "./profile.js";
import { publishMessagingGeneration, readPrivateMessagingFile, type MessagingPairOptions } from "./messaging-config.js";
import { initializeLivePolicy, type LivePolicyRef } from "./live-session-policy.js";
import { readSelectedMultiSessionPolicy } from "./multi-session-policy.js";
import type { BackgroundTunnelManager } from "./background-manager.js";

const LAUNCH_DOCUMENT_KIND = "ce-live-launch-v1" as const;
const invalid = (field: string): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);
const conflict = (): TunnelRefusal => new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "messaging.liveMigration");
const MAX_PROFILE_BYTES = 65_536;

export interface LiveSessionMigrationOptions {
  readonly profilePath: string;
  /** The real manager: its profile configuration lock is the only authority. */
  readonly manager: Pick<BackgroundTunnelManager, "withProfileConfigurationLock">;
  /** Test-only filesystem seams; production uses the real syscalls. */
  readonly io?: MessagingPairOptions["io"] & Partial<Pick<typeof fs, "renameSync">>;
}

export interface LiveSessionMigrationResult {
  readonly kind: "saved";
  /** Digest of the Profile text after the repoint. */
  readonly revision: string;
  readonly bindingPath: string;
  readonly durability: "synced" | "uncertain";
  readonly ref: LivePolicyRef;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

function readProfileText(profilePath: string): string {
  if (!isAbsolute(profilePath) || normalize(profilePath) !== profilePath) throw invalid("profile.path");
  const selected = readPrivateMessagingFile(profilePath);
  if (selected === undefined) throw invalid("profile.read");
  return selected.bytes.toString("utf8");
}

/** The private configuration directory that holds every generation. */
function bindingsDirectory(profilePath: string): string {
  const directory = join(dirname(profilePath), ".ce-bindings");
  let stat: fs.Stats;
  try { stat = fs.lstatSync(directory); } catch { throw invalid("messaging.directory"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) {
    throw invalid("messaging.directory");
  }
  return directory;
}

/** Create the NEW empty private live root. It is never reused or recycled. */
function createLiveRoot(profilePath: string): string {
  const root = join(bindingsDirectory(profilePath), `live-policy-${randomUUID()}`);
  fs.mkdirSync(root, { mode: 0o700 });
  fs.chmodSync(root, 0o700);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o700) {
    throw invalid("messaging.livePolicy.root");
  }
  if (fs.realpathSync(root) !== root) throw invalid("messaging.livePolicy.root");
  return root;
}

export function createLiveSessionMigration(options: LiveSessionMigrationOptions) {
  const { profilePath } = options;
  const io = { openSync: fs.openSync, closeSync: fs.closeSync, writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync,
    linkSync: fs.linkSync, renameSync: fs.renameSync, ...options.io };

  const revision = (): string => sha256(readProfileText(profilePath));

  const migrate = (input: { readonly expectedRevision: string; readonly confirm: true }): Promise<LiveSessionMigrationResult> =>
    options.manager.withProfileConfigurationLock((guard) => {
      try {
        if (guard.profilePath !== profilePath) throw invalid("profile.path");
        // Every refusal below happens BEFORE the first write.
        if (input.confirm !== true) throw invalid("messaging.liveMigration.confirm");
        const text = readProfileText(profilePath);
        const currentRevision = sha256(text);
        if (currentRevision !== input.expectedRevision) throw conflict();
        const facts = parseTunnelProfile(text);
        if (facts.mcpCommand === undefined) throw invalid("messaging.liveMigration.command");
        // The legacy generation must still be the selected, verified one.
        const snapshot = readSelectedMultiSessionPolicy(profilePath);
        if (snapshot.revision !== currentRevision) throw conflict();

        // OneConnect requires both MCP-wide opt-ins. Refuse before preparing
        // any live files; migration must never widen the operator's ceilings.
        if (!snapshot.manifest.mcp.payloadRead || !snapshot.manifest.mcp.ack) {
          throw invalid("messaging.liveMigration.globalCeiling");
        }
        const root = createLiveRoot(profilePath);
        const ref = initializeLivePolicy({ root, manifest: snapshot.manifest, credentialFile: facts.keyFile });
        const config: McpBindingConfig = parseMcpBindingConfig({ version: 1, ...snapshot.config, admissionPolicy: ref });
        // The launch document references the chain; it never copies the manifest.
        const document = { kind: LAUNCH_DOCUMENT_KIND, version: 1, ref };
        const pair = publishMessagingGeneration(profilePath, config, document, { io, credentialFile: facts.keyFile });
        if (pair.durability !== "synced") throw invalid("messaging.liveMigration.publicationUncertain");

        const command = replaceTunnelMcpBindingPath(facts.mcpCommand, pair.bindingPath);
        const quoted = `"${facts.mcpCommand}"`;
        if (text.split(quoted).length !== 2) throw invalid("messaging.liveMigration.command");
        const nextText = text.replace(quoted, `"${command}"`);
        if (Buffer.byteLength(nextText) > MAX_PROFILE_BYTES) throw invalid("messaging.liveMigration.profile");
        if (parseTunnelProfile(nextText).mcpCommand !== command) throw invalid("messaging.liveMigration.command");

        const temporary = `${profilePath}.${randomUUID()}.tmp`;
        const fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o7777) !== 0o600) throw invalid("profile.permissions");
          io.writeFileSync(fd, nextText, "utf8");
          io.fsyncSync(fd);
        } finally { io.closeSync(fd); }
        const directory = io.openSync(dirname(profilePath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          io.fsyncSync(directory);
          guard.assertIntact();
          if (sha256(readProfileText(profilePath)) !== input.expectedRevision) throw conflict();
          // The sole activation commit. A throwing rename may have taken effect:
          // it is reported as uncertain, never retried and never rolled back.
          try { io.renameSync(temporary, profilePath); }
          catch { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "messaging.liveMigration.commitUncertain"); }
          let durability: "synced" | "uncertain" = "synced";
          try { io.fsyncSync(directory); } catch { durability = "uncertain"; }
          return { kind: "saved", revision: sha256(nextText), bindingPath: pair.bindingPath, durability, ref };
        } finally { try { io.closeSync(directory); } catch { /* no post-commit rollback */ } }
      } catch (error) { if (error instanceof TunnelRefusal) throw error; throw invalid("messaging.liveMigration"); }
    });

  return { revision, migrate };
}
