/**
 * HANDOFF-CE-LOCAL-BACKGROUND-01 v3 — real background tunnel lifecycle.
 *
 * v10 amendments (Lane S v9 S9-1, Lane C v9 C9-1…3):
 * - The signal-phase "return unknown" contract is now pinned by a pending-run
 *   regression that actually reaches the signal branch (S9-1/C9-1).
 * - Identity resolution's ledger-preserving merge and stopped-not-resurrected
 *   behaviour each have a deterministic concurrency regression (C9-2).
 * - The write-ahead window (a record-backed run whose termination intent
 *   persisted but whose signal was never delivered) is disclosed: at-most-once
 *   guarantees zero EXTRA signals, never non-zero delivery.
 *
 * v9 amendments (Lane S v8 S8-1, S8-2):
 * - Identity resolution in refresh merges the identity upgrade onto the record
 *   re-read INSIDE the lock, preserving a concurrent stop's termRequestedAt
 *   and state; a run another session already stopped is never resurrected.
 *
 * v8 amendments (Lane C v7 F1–F4):
 * - The in-memory once-set is burned ONLY immediately before the signal, under
 *   the held lock — a lost lock can no longer permanently immunize a run.
 *   Note the write-ahead window: if a record-backed run's termRequestedAt
 *   persisted but the signal was never delivered (lock lost after the ledger
 *   write), that run is NOT re-signalled — at-most-once forbids the retry and
 *   permits zero deliveries here; a later stop only reports unconfirmed.
 * - A lost lock during the signal phase returns "unknown" (ownership
 *   retained), preserving the three-state termination contract instead of
 *   throwing MANAGER_BUSY out of terminateOwned.
 *
 * v7 amendments (Lane S v6 S6-1…5):
 * - The signal path is symmetric with persist: a SIGTERM (including the
 *   pending-run in-memory once-set branch) is only ever issued under a held
 *   lock token — the discipline is machine-enforced on both writes.
 *
 * v6 amendments (Lane S v5 S5-1…8, Lane C v5 C-v5-1…5):
 * - judgeLock: a leaked holder is reclaimed when EITHER the pid/startedKey
 *   judgement is stale OR the age threshold passed (leaked is an additional
 *   reclaim reason, never a replacement).
 * - persist() refuses a CORRUPT on-disk record too, and requires a held lock
 *   token outright (the lock discipline is machine-enforced, not advisory).
 * - stop() also terminates a pending unpersisted daemon that is NOT the disk
 *   record's run (in-memory once-set protected); a successful stop that left
 *   a live pending run says so in its note.
 * - A reclaimProbe seam (test-only) sits between the reclaim judgement and
 *   the rename, letting tests inject the exact interleavings F2 targets.
 *
 * v5 amendments (Lane S v4 F1–F7, Lane C v4 C-v4-1…7):
 * - persist() itself enforces the lock (assertLockIntact at entry) and refuses
 *   to overwrite a DIFFERENT run's non-stopped disk record — no code path can
 *   roll back another session's live ownership or termination ledger.
 * - Pending priority is narrowed to DISK-STOPPED records only (a live foreign
 *   run's record always wins the in-memory view).
 * - Lock reclaim compares inode+mtime of the judged directory against the
 *   grave after rename — a successor created during the judgement window is
 *   detected and rolled back even while it is still holderless.
 * - A stop/refresh that proves exit strips identityPending before the final
 *   persist, so an identity-pending run terminates cleanly.
 * - refresh's identity re-acquisition persists under the lock; holder-write
 *   self-clean only removes a lock that is still ours; leaked holders keep
 *   their startedKey and remain age-reclaimable; grave sweeping is prefixed
 *   to this lock and aged.
 *
 * v4 amendments (Lane S v3 S3-1…7, Lane C v3 C-v3-1…7):
 * - Lock reclaim verifies AFTER the rename that the grave holds the SAME lock
 *   that was judged stale (token match, or still holderless for the aged
 *   branch); a mismatch rolls the rename back and refuses BUSY, so a live
 *   successor's lock is never deleted. Critical sections additionally assert
 *   the lock is still ours before persist/signal.
 * - Pending ownership outranks a stale disk record of a DIFFERENT run
 *   (reloadRecord), so a stopped-record file can never hide a live pending
 *   daemon from stop/refresh.
 * - identityPending re-acquisition requires the command line to be EXACTLY
 *   `<client> run --profile-file <this profile>` — substring matching refused.
 * - Leaked-lock tokens are process-wide (module scope); a failed release
 *   rewrites the holder best-effort to preserve the token evidence.
 * - Quoted profile scalars are printable-ASCII only (no C0/C1/line
 *   separators), keeping gate values byte-identical to YAML decoding.
 * - refresh persists absence using the record re-read INSIDE the lock.
 *
 * v3 amendments (Lane S v2 S2-R1…R8, Lane C v2 C-v2-1…6):
 * - Lock is a mkdir DIRECTORY lock: creation is atomic cross-process; stale
 *   reclaim first renames the old dir to a unique grave (reclaimers are
 *   mutually exclusive) and then VERIFIES the grave is the judged-stale lock
 *   before deleting (v4). Holder-write failure self-cleans; an unparseable
 *   holder is reclaimable only after LOCK_STALE_MS (crash-safe by age).
 * - The termination ledger is authoritative: a record-backed run is signalled
 *   only AFTER termRequestedAt persists; an unpersisted (pending) run is
 *   guarded by an in-memory once-set so a crash loses the record AND the
 *   ability to re-signal together.
 * - Unpersisted ownership (persist failed after spawn, or identity capture
 *   incomplete) is a first-class pendingRecord: disk ENOENT never discards it,
 *   and stop/refresh keep managing it until exit is proven.
 * - refresh persists ONLY under the lock, re-reading and re-checking runId
 *   inside it, so a stale observation cannot overwrite a newer run's record.
 * - start captures the lifecycle generation AT CALL TIME and re-checks it
 *   before executing, after the lock, and before spawn; stop awaits the
 *   settlement of any start it invalidated before taking the lock.
 * - loadRecord maps only ENOENT to "no record"; every other error is corrupt
 *   (fail closed).
 * - The profile reader is EXHAUSTIVE over the canonical grammar documented in
 *   docs/tunnel.example.yaml (single mcp command, canonical indentation):
 *   every non-blank, non-comment line must match a known key at its exact
 *   indent; unknown keys, nesting, quoting styles, or sections refuse.
 * - Adopted runs (not spawned by this session) are supervised with an
 *   unbounded startup window — an observation lapse is DEGRADED, never a
 *   permanent terminal Error; the baseline is captured BEFORE the async probe
 *   so a completed health measurement can never predate it.
 *
 * Review amendments applied (Lane S S1–S10, Lane C C1–C8 over v1):
 * - S1  Real start is GATED: it requires the exact opt-in
 *   `CE_TUNNEL_BACKGROUND_ALLOW === "1"` (defense in depth at the manager,
 *   not just the command). status/stop remain gate-free: they cannot create
 *   cost, and stop only ever reduces it.
 * - S2  Profile parsing is a STRICT SUBSET reader, not regex-over-YAML: exact
 *   section tracking, double-quoted values without backslashes, unique keys,
 *   no block scalars, no tabs. Anything outside the canonical subset that
 *   `profile.ts buildTunnelProfile` emits refuses CE_TUNNEL_PROFILE_INVALID,
 *   so the value we gate on is byte-identical to what a YAML parser decodes.
 * - S3/C5  Process inspection is THREE-STATE: present / proven-absent /
 *   unknown. `ps` is invoked as /bin/ps with a fixed minimal environment and
 *   LC_ALL=C (S9); only exit 0 + parseable row is present, only exit 1 + empty
 *   stdout is absent, everything else is unknown. Unknown RETAINS ownership,
 *   blocks start, and makes stop unconfirmed — never a false exit proof.
 * - S4/C2  Cross-process mutual exclusion: an O_EXCL lock file whose holder is
 *   itself identity-verified (pid + start key). Every start/stop re-reads the
 *   record INSIDE the lock; refresh re-reads the record from disk each call.
 *   A contended or unverifiable lock refuses CE_TUNNEL_MANAGER_BUSY.
 * - S5/C8  ONE termination path: identity is re-verified immediately before
 *   any signal, and the persisted termRequestedAt is honored by every path
 *   (including startup-timeout cleanup), so a run is signalled at most once
 *   across all sessions.
 * - S6/C4  Start is a transaction: directory writability is proven BEFORE
 *   spawn; a post-spawn failure performs identity-verified single-signal
 *   cleanup with a bounded wait, and an unpersistable run stays owned
 *   in-memory (runId visible, stop() can retry) instead of being orphaned.
 * - S7  File hygiene: state directory must be an owned, non-symlink 0700 dir;
 *   record temp files are random-named O_EXCL creations; the log is opened
 *   O_NOFOLLOW and tightened to 0600; existing symlinks refuse.
 * - S8  Record loading distinguishes none / ok / corrupt: only ENOENT means
 *   "no record"; anything else is CE_TUNNEL_STATE_CORRUPT and blocks mutation.
 *   Size is checked via lstat BEFORE reading; every used field is validated.
 * - S10 A timed-out or killed health probe DISCARDS its stdout and becomes
 *   "unverifiable"; only cleanly exited probes feed the frozen parser.
 * - C1  A record adopted from a previous session is re-baselined: its state
 *   machine run starts at this manager's first observation, so the original
 *   startup deadline cannot fence a long-lived daemon. The recorded startedAt
 *   is still the one displayed.
 * - C3  start/stop are serialized per manager through one lifecycle queue and
 *   fenced after every await: a stop during a pending start aborts the start
 *   into the standard cleanup path, and a superseded start never reports
 *   success.
 * - C6  Start success requires the shared state machine to ACCEPT Connected;
 *   a healthy probe completing after the startup deadline takes the timeout
 *   path instead of being announced.
 *
 * Persistent invariants (unchanged from v1): no credential is ever read,
 * printed, copied, or forwarded — the client reads the operator's own key via
 * the profile's file: reference; the daemon environment is the profile.ts
 * allowlist; no autostart/reconnect/respawn; the MCP child is never signalled
 * by this manager; transport state is never delivery/ACK/completion evidence.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync,
  readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { TunnelRefusal } from "./codes.js";
import { resolveTunnelClient } from "../runtime/executables.js";
import { createHealthCompletionRecorder, type HealthProbeInput } from "./health.js";
import { checkKeyFileRequirements, childEnvironment } from "./profile.js";
import {
  DEFAULT_TUNNEL_TIMING, initialTunnelState, nextTunnelState,
  type TunnelState, type TunnelStateName, type TunnelTiming,
} from "./state.js";

/** Verified identity of one OS process; `startedKey` is the ps lstart string. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly command: string;
  readonly startedKey: string;
}

/** Three-state process presence: only proven absence may close ownership. */
export type ProcessPresence =
  | { readonly kind: "present"; readonly identity: ProcessIdentity }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

export type ProcessListResult =
  | { readonly kind: "ok"; readonly processes: readonly ProcessIdentity[] }
  | { readonly kind: "unknown" };

export interface DaemonChildHandle {
  readonly pid?: number | undefined;
  unref(): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export type BackgroundSpawnSeam = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; detached: true; logPath: string },
) => DaemonChildHandle;

export type InspectProcessSeam = (pid: number) => Promise<ProcessPresence>;
export type ListProcessesSeam = () => Promise<ProcessListResult>;
export type ProbeHealthSeam = (urlFile: string, pid: number) => Promise<HealthProbeInput>;
export type SignalSeam = (pid: number, signal: "SIGTERM") => void;

export interface BackgroundManagerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly profilePath?: string;
  readonly stateFilePath?: string;
  readonly clientPath?: string;
  readonly timing?: TunnelTiming;
  readonly spawn?: BackgroundSpawnSeam;
  readonly inspectProcess?: InspectProcessSeam;
  readonly listProcesses?: ListProcessesSeam;
  readonly probeHealth?: ProbeHealthSeam;
  readonly signal?: SignalSeam;
  /** TEST-ONLY seam: invoked between the reclaim judgement and the rename so
   *  tests can inject the exact interleavings the grave verification defends
   *  against. Production callers must leave it unset. */
  readonly reclaimProbe?: () => void;
}

export type BackgroundStatusName = "STOPPED" | "STARTING" | "CONNECTED" | "DEGRADED" | "UNKNOWN";

export interface BackgroundStartResult {
  readonly runId: string;
  readonly pid: number;
  /** Masked `tunnel_xxxxxxxx…`; the full id stays in the operator's own profile. */
  readonly tunnelId: string;
  readonly health: "connected" | "unknown";
  readonly startedAt: string;
  readonly alreadyRunning: boolean;
}

/** Spawn+persist acknowledgement, resolved BEFORE the readiness poll runs.
 *  Lets the caller show STARTING immediately without holding its command
 *  handler for the full readiness budget. */
export interface BackgroundStartAck {
  readonly runId: string;
  readonly pid: number;
  /** Masked `tunnel_xxxxxxxx…`. */
  readonly tunnelId: string;
  readonly startedAt: string;
}

/** A supervised, non-blocking start: `ack` resolves once the daemon is
 *  spawned and its ownership record persisted (state STARTING); `settled`
 *  resolves/rejects when readiness converges (connected) or times out — the
 *  same terminal contract as `start()`. Both are joined by stop/dispose. */
export interface BackgroundStartDeferred {
  readonly ack: Promise<BackgroundStartAck>;
  readonly settled: Promise<BackgroundStartResult>;
}

export interface BackgroundManagerStatus {
  readonly mode: "real-background";
  readonly state: BackgroundStatusName;
  readonly label: string;
  readonly evidence: "health-probe" | "process-absent" | "none";
  readonly running: boolean;
  readonly runId: string | undefined;
  readonly pid: number | undefined;
  readonly startedAt: string | undefined;
  readonly tunnelId: string | undefined;
  readonly note: string | undefined;
}

export interface ProfileConfigurationGuard {
  readonly profilePath: string;
  /** Must be checked immediately before the synchronous profile commit. */
  assertIntact(): void;
}

export interface BackgroundTunnelManager {
  readonly kind: "real-background";
  start(): Promise<BackgroundStartResult>;
  /** REAL-START-FIX-01: non-blocking supervised start (see BackgroundStartDeferred). */
  startDeferred(): BackgroundStartDeferred;
  /** Setup only: holds the SAME lifecycle/ownership lock as start/stop. The
   * callback must be synchronous and must not invoke lifecycle methods. No
   * running, pending, corrupt or uncertain ownership may be reconfigured. */
  withProfileConfigurationLock<T>(operation: (guard: ProfileConfigurationGuard) => T): Promise<T>;
  stop(options?: { readonly graceMs?: number }): Promise<void>;
  /** One real measurement cycle: fresh record read + identity + health probe. */
  refresh(): Promise<BackgroundManagerStatus>;
  status(): BackgroundManagerStatus;
  /** Session teardown: NEVER stops the daemon; releases only this host's view. */
  dispose(): Promise<void>;
  runId(): string | undefined;
}

interface TunnelRecord {
  readonly version: 1;
  readonly runId: string;
  readonly pid: number;
  readonly profilePath: string;
  readonly profileSha256: string;
  readonly tunnelId: string;
  readonly keyFile: string;
  readonly urlFile: string;
  readonly mcpCommand: string | undefined;
  readonly logPath: string;
  readonly commandIdentity: string;
  /** Evidence-based post-exec identity for a wrapper client (LOCAL-BG-03 F2):
   *  `<wrapper exec target> run --profile-file <profilePath>`, captured at
   *  spawn time from the wrapper script's strict exec line. Absent for direct
   *  binaries and for records written before this field existed (fail closed:
   *  only commandIdentity is accepted then). */
  readonly commandIdentityExec?: string | undefined;
  readonly processStartedKey: string;
  readonly startedAt: number;
  readonly termRequestedAt: number | undefined;
  readonly state: "running" | "stop-unconfirmed" | "stopped";
  readonly stoppedAt: number | undefined;
  readonly note: string | undefined;
  /** True only in MEMORY for a spawned child whose identity is unconfirmed;
   *  such records are never persisted. */
  readonly identityPending?: boolean | undefined;
}

export interface TunnelProfileFacts {
  readonly tunnelId: string;
  readonly organizationId: string | undefined;
  readonly keyFile: string;
  readonly urlFile: string;
  readonly mcpCommand: string | undefined;
}

type RecordLoad =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly record: TunnelRecord }
  | { readonly kind: "corrupt" };

// Background-only budget for the external 0.0.16 client's defaults: initial
// long-poll 30s + deadline guardrail 5s + 10s startup/probe/scheduling margin.
// No authoritative client timing config is available here. Keep the shared
// offline timing and explicit caller overrides unchanged; retain required poll.
const DEFAULT_BACKGROUND_TUNNEL_TIMING: TunnelTiming = Object.freeze({
  ...DEFAULT_TUNNEL_TIMING, startupTimeoutMs: 45_000,
});

/** Derived from the invoking account rather than a hardcoded operator home. */
const defaultProfilePath = (): string => join(homedir(), ".config", "pi-chat-exchange", "tunnel", "tunnel.yaml");
const PS_PATH = "/bin/ps";
const PROBE_TIMEOUT_MS = 10_000;
const IDENTITY_APPEAR_MS = 2_000;
const EXIT_POLL_MS = 200;
const MAX_RECORD_BYTES = 16_384;
const BACKGROUND_OPT_IN = "CE_TUNNEL_BACKGROUND_ALLOW";
const LOCK_STALE_MS = 60_000;
/** Tokens of locks THIS PROCESS failed to release (e.g. the state dir went
 *  unwritable mid-operation). Process-wide so a rebuilt manager in the same
 *  host can still reclaim them; never consulted for foreign holders. */
const leakedLockTokens = new Set<string>();

const maskTunnelId = (id: string): string => `${id.slice(0, 13)}…`;

// ---------------------------------------------------------------------------
// Strict-subset profile reader (S2). Accepts EXACTLY the canonical shape that
// profile.ts buildTunnelProfile emits: section-tracked, double-quoted values
// without backslashes, unique keys, no block scalars, no tabs. In this subset
// the line text and the YAML-decoded value are byte-identical, so the gate
// checks the same value the client will read. Anything else refuses.
// ---------------------------------------------------------------------------

export function parseTunnelProfile(text: string): TunnelProfileFacts {
  // Exhaustive grammar over the canonical profile shape (R8). Every non-blank,
  // non-comment line MUST match one production below; anything else refuses.
  if (/[\t\u0000\r\u0085\u2028\u2029]/.test(text)) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile");
  }
  type Section = "control_plane" | "health" | "admin_ui" | "harpoon" | "log" | "mcp";
  const SECTION_KEYS: Record<Section, ReadonlySet<string>> = {
    control_plane: new Set(["base_url", "tunnel_id", "api_key", "organization_id"]),
    health: new Set(["listen_addr", "url_file"]),
    admin_ui: new Set(["open_browser"]),
    harpoon: new Set(["capture_payloads"]),
    log: new Set(["level", "format", "http_raw_unsafe"]),
    mcp: new Set(["commands"]),
  };
  /** Gate-relevant values must be double-quoted, escape-free scalars so the
   *  line text and the YAML-decoded value are byte-identical. */
  const quoted = (raw: string, tag: string): string => {
    // S3-5: printable ASCII only — no C0/C1 controls or Unicode line
    // separators that a YAML reader could fold into a DIFFERENT scalar.
    if (!/^"[\x20\x21\x23-\x5B\x5D-\x7E]*"$/.test(raw)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", tag);
    return raw.slice(1, -1);
  };
  const bare = (raw: string, tag: string, pattern: RegExp): string => {
    if (!pattern.test(raw)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", tag);
    return raw;
  };
  let section: Section | undefined;
  let inCommands = false;
  let itemOpen = false;
  const seen = new Set<string>();
  const found: { tunnelId?: string; organizationId?: string; apiKey?: string; urlFile?: string; mcpCommand?: string } = {};
  for (const rawLine of text.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trimStart().startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (indent === 0) {
      itemOpen = false;
      inCommands = false;
      if (line === "config_version: 1") { section = undefined; continue; }
      const m = /^(\w+):$/.exec(line);
      if (m === null || !(m[1]! in SECTION_KEYS)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile");
      section = m[1] as Section;
      if (seen.has(section)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", section);
      seen.add(section);
      continue;
    }
    if (section === undefined) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile");
    if (section === "mcp") {
      if (!inCommands) {
        if (indent !== 2 || line !== "commands:") throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp");
        inCommands = true;
        continue;
      }
      if (line.startsWith("- ")) {
        if (indent !== 4) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp.commands");
        itemOpen = true;
        const first = line.slice(2);
        const kv = /^(\w+):\s*(\S+)$/.exec(first);
        if (kv === null || kv[1] !== "channel") throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp.commands");
        bare(kv[2]!, "mcp.commands.channel", /^[A-Za-z0-9_-]{1,32}$/);
        continue;
      }
      if (!itemOpen || indent !== 6) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp.commands");
      const kv = /^(\w+):\s*(.+)$/.exec(line);
      if (kv === null || kv[1] !== "command") throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp.commands");
      if (found.mcpCommand !== undefined) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "mcp.commands.command");
      found.mcpCommand = quoted(kv[2]!, "mcp.commands.command");
      continue;
    }
    if (indent !== 2) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", section);
    const kv = /^(\w+):\s*(\S.*)$/.exec(line);
    if (kv === null) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", section);
    const [, key, rawValue] = kv;
    if (!SECTION_KEYS[section].has(key!)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", `${section}.${key}`);
    const tag = `${section}.${key}`;
    if (seen.has(tag)) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", tag);
    seen.add(tag);
    switch (tag) {
      case "control_plane.base_url":
        bare(quoted(rawValue!, tag), tag, /^https:\/\/[A-Za-z0-9._:-]+(\/[A-Za-z0-9._~/-]*)?$/);
        break;
      case "control_plane.tunnel_id": found.tunnelId = quoted(rawValue!, tag); break;
      case "control_plane.api_key": found.apiKey = quoted(rawValue!, tag); break;
      case "control_plane.organization_id":
        // BG05: optional, profile-only organization context. The client reads
        // this same file; no argv/header injection or parent-env override.
        // This is a bounded local grammar, not remote binding validation.
        found.organizationId = bare(quoted(rawValue!, tag), tag, /^org-[A-Za-z0-9]{1,128}$/);
        break;
      case "health.listen_addr":
        bare(quoted(rawValue!, tag), tag, /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}$/);
        break;
      case "health.url_file": found.urlFile = quoted(rawValue!, tag); break;
      case "admin_ui.open_browser":
      case "harpoon.capture_payloads":
      case "log.http_raw_unsafe": bare(rawValue!, tag, /^(true|false)$/); break;
      case "log.level": bare(rawValue!, tag, /^(debug|info|warn|error)$/); break;
      case "log.format": bare(rawValue!, tag, /^(json|text)$/); break;
      default: throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", tag);
    }
  }
  if (found.tunnelId === undefined || !/^tunnel_[A-Za-z0-9]{8,}$/.test(found.tunnelId)) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "control_plane.tunnel_id");
  }
  if (found.apiKey === undefined) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "control_plane.api_key");
  }
  if (!found.apiKey.startsWith("file:")) {
    // env: references and inline values are both refused: this manager only
    // ever allows the pre-existing operator key FILE reference.
    throw new TunnelRefusal("CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED", "control_plane.api_key");
  }
  const keyFile = found.apiKey.slice("file:".length);
  if (!isAbsolute(keyFile) || normalize(keyFile) !== keyFile) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "control_plane.api_key");
  }
  if (found.urlFile === undefined || !isAbsolute(found.urlFile) || normalize(found.urlFile) !== found.urlFile) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "health.url_file");
  }
  return { tunnelId: found.tunnelId, organizationId: found.organizationId, keyFile, urlFile: found.urlFile, mcpCommand: found.mcpCommand };
}

export function checkKeyFileMetadata(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING", "control_plane.api_key");
  }
  const euid = process.geteuid?.();
  if (euid === undefined) throw new TunnelRefusal("CE_TUNNEL_KEY_PERMS_INVALID", "control_plane.api_key");
  const verdict = checkKeyFileRequirements({
    mode: stat.mode, uid: stat.uid, ownerUid: euid,
    isSymbolicLink: stat.isSymbolicLink(), size: stat.size,
  });
  if (!verdict.ok) throw new TunnelRefusal("CE_TUNNEL_KEY_PERMS_INVALID", "control_plane.api_key");
}

// ---------------------------------------------------------------------------
// Production process adapters (S3/C5/S9): /bin/ps, fixed minimal env, LC_ALL=C.
// ---------------------------------------------------------------------------

const PS_ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C" });

function parsePsIdentity(pid: number, stdout: string): ProcessPresence {
  const trimmed = stdout.trim();
  if (trimmed === "") return { kind: "unknown" }; // exit 0 without a row is NOT absence proof
  const match = /^(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(trimmed);
  if (match === null) return { kind: "unknown" };
  return { kind: "present", identity: { pid, startedKey: match[1]!, command: match[2]! } };
}

const defaultInspectProcess: InspectProcessSeam = (pid) => new Promise((resolve) => {
  nodeExecFile(PS_PATH, ["-p", String(pid), "-o", "lstart=,command="], { timeout: 5_000, env: { ...PS_ENV } }, (error, stdout) => {
    if (error === null) { resolve(parsePsIdentity(pid, stdout)); return; }
    // SAFETY: execFile errors carry the numeric exit `code` when the child ran
    // and exited; ps exits 1 with empty stdout exactly when the pid is gone.
    const code = (error as { code?: unknown }).code;
    if (code === 1 && (stdout ?? "").trim() === "") { resolve({ kind: "absent" }); return; }
    resolve({ kind: "unknown" });
  });
});

const defaultListProcesses: ListProcessesSeam = () => new Promise((resolve) => {
  nodeExecFile(PS_PATH, ["-ax", "-o", "pid=,lstart=,command="], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024, env: { ...PS_ENV } }, (error, stdout) => {
    if (error !== null) { resolve({ kind: "unknown" }); return; }
    const out: ProcessIdentity[] = [];
    for (const line of stdout.split("\n")) {
      const pidMatch = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (pidMatch === null) continue;
      const pidText = pidMatch[1];
      if (pidText === undefined) continue;
      const row = parsePsIdentity(Number.parseInt(pidText, 10), pidMatch[2] ?? "");
      if (row.kind !== "present") continue;
      // Refusal-only discovery must not depend on a configurable client's basename.
      if (!row.identity.command.includes("--profile-file ") && !row.identity.command.includes("mcp-stdio.js")) continue;
      out.push(row.identity);
    }
    resolve({ kind: "ok", processes: out });
  });
});

function defaultProbeHealth(clientPath: string | undefined): ProbeHealthSeam {
  return (urlFile, pid) => new Promise((resolve) => {
    if (clientPath === undefined) { resolve({ stdout: "", exitCode: 2 }); return; }
    nodeExecFile(
      clientPath,
      ["health", "--url-file", urlFile, "--pid", String(pid), "--require-control-plane-poll", "--json"],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...PS_ENV, HOME: process.env.HOME ?? "" } },
      (error, stdout) => {
        if (error === null) { resolve({ stdout: stdout ?? "", exitCode: 0 }); return; }
        // SAFETY: same execFile error shape as above.
        const err = error as { code?: unknown; killed?: unknown; signal?: unknown };
        if (typeof err.code === "number") {
          // A cleanly exited probe keeps its stdout for the frozen parser
          // (measured fail shapes); exit code itself never decides health.
          resolve({ stdout: stdout ?? "", exitCode: err.code });
          return;
        }
        // S10: timeout/kill/spawn failure — stdout is untrusted partial output.
        resolve({ stdout: "", exitCode: 2 });
      },
    );
  });
}

function defaultSpawnDaemon(logPath: string): BackgroundSpawnSeam {
  return (executable, args, options) => {
    const fd = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW, 0o600);
    try {
      // An inherited log with loose permissions is tightened, never trusted.
      const stat = fstatSync(fd);
      if ((stat.mode & 0o777) !== 0o600) chmodSync(logPath, 0o600);
      return nodeSpawn(executable, [...args], {
        env: { ...options.env },
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      closeSync(fd);
    }
  };
}

// ---------------------------------------------------------------------------
// Wrapper identity evidence (LOCAL-BACKGROUND-03 F2). Homebrew installs the
// client as a two-line shim (`#!/bin/bash` + `exec "<Cellar libexec>" "$@"`);
// ps therefore shows `/bin/bash <shim> run …` before the exec and `<cellar>
// run …` after it — same pid, same lstart. The exact-argv matcher must accept
// ONLY the forms backed by explicit evidence gathered here; anything unknown
// or ambiguous yields no form (fail closed). Basename equality is never
// evidence, and neither is a pidfile or a process name.
// ---------------------------------------------------------------------------
export interface WrapperIdentityEvidence {
  /** Interpreter of a no-argument `#!/abs/path` shebang (e.g. /bin/bash).
   *  A shebang carrying arguments (`#!/usr/bin/env bash`) is ambiguous about
   *  the final argv0 and yields NO shell-prefix form. */
  readonly shellPrefix?: string | undefined;
  /** Literal target of a single strict `exec "<abs>" "$@"` line. The target
   *  must be absolute, normalized, printable, and an existing regular file;
   *  anything else (relative, unquoted, extra args, multiple exec lines,
   *  missing target) yields NO exec form. */
  readonly execTarget?: string | undefined;
}

const MAX_WRAPPER_BYTES = 4096;
const SHEBANG_RE = /^#!(\/[^\s\u0000]+)$/;
const WRAPPER_EXEC_RE = /^exec "(\/[^"\\\r\n\u0000]+)" "\$@"$/;

export function resolveWrapperIdentityEvidence(clientPath: string): WrapperIdentityEvidence | undefined {
  let text: string;
  try {
    const stat = statSync(clientPath); // follows the brew bin symlink
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_WRAPPER_BYTES) return undefined;
    text = readFileSync(clientPath, "utf8");
  } catch {
    return undefined;
  }
  if (!text.startsWith("#!")) return {}; // direct binary: no wrapper forms
  const lines = text.split("\n");
  const shebang = SHEBANG_RE.exec((lines[0] ?? "").replace(/\r$/, ""));
  const shellPrefix = shebang !== null && /^[ -~]+$/.test(shebang[1]!) && normalize(shebang[1]!) === shebang[1]!
    ? shebang[1]!
    : undefined;
  const evidence: { shellPrefix?: string | undefined; execTarget?: string | undefined } =
    shellPrefix === undefined ? {} : { shellPrefix };
  // C-1 (Lane C): the exec form is accepted only when the ENTIRE file is the
  // canonical shim shape — shebang, then exactly ONE strict exec line, with
  // every other line blank or a comment. Anything else (heredocs, indented or
  // argument-carrying exec, conditionals, extra statements) means the file's
  // execution semantics are not fully understood here, so NO exec evidence is
  // produced (fail closed). The shell-prefix form rests on the shebang alone,
  // which the kernel honors regardless of the script body.
  const meaningful = lines.slice(1).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("#");
  });
  if (meaningful.length !== 1) return evidence;
  const execMatch = WRAPPER_EXEC_RE.exec(meaningful[0]!); // column-0, strict
  if (execMatch === null) return evidence;
  const target = execMatch[1]!;
  if (!/^[ -~]+$/.test(target) || normalize(target) !== target) return evidence;
  try {
    if (!statSync(target).isFile()) return evidence;
  } catch {
    return evidence;
  }
  evidence.execTarget = target;
  return evidence;
}

// ---------------------------------------------------------------------------
// Ownership record (S7/S8): strict load, random-name O_EXCL temp, 0700 dir.
// ---------------------------------------------------------------------------

function ensureStateDir(dir: string): void {
  const euid = process.geteuid?.();
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "state-dir");
    if (euid !== undefined && stat.uid !== euid) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "state-dir");
    // An existing directory is verified, never re-permissioned (S7).
    if ((stat.mode & 0o777) !== 0o700) throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "state-dir");
  } catch (error) {
    if (error instanceof TunnelRefusal) throw error;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
    } catch {
      throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "state-dir");
    }
  }
}

function loadRecord(file: string): RecordLoad {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    // R6/C-v2-6: ONLY ENOENT means "no record"; EACCES/EIO/… fail closed.
    if ((error as { code?: unknown }).code === "ENOENT") return { kind: "none" };
    return { kind: "corrupt" };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) return { kind: "corrupt" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { kind: "corrupt" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "corrupt" };
  const r = parsed as Record<string, unknown>;
  const valid = r.version === 1 &&
    typeof r.runId === "string" && r.runId.length > 0 &&
    typeof r.pid === "number" && Number.isSafeInteger(r.pid) && r.pid > 0 &&
    typeof r.commandIdentity === "string" && typeof r.processStartedKey === "string" &&
    (r.commandIdentityExec === undefined || r.commandIdentityExec === null ||
      (typeof r.commandIdentityExec === "string" && r.commandIdentityExec.length > 0 && r.commandIdentityExec.length <= 4096)) &&
    typeof r.profilePath === "string" && typeof r.tunnelId === "string" &&
    typeof r.urlFile === "string" && typeof r.keyFile === "string" &&
    typeof r.logPath === "string" &&
    typeof r.startedAt === "number" && Number.isFinite(r.startedAt) && r.startedAt > 0 && r.startedAt < 4.1e12 &&
    (r.termRequestedAt === undefined || r.termRequestedAt === null || (typeof r.termRequestedAt === "number" && Number.isFinite(r.termRequestedAt))) &&
    (r.state === "running" || r.state === "stop-unconfirmed" || r.state === "stopped") &&
    r.identityPending === undefined; // an identity-pending record must never come from disk
  if (!valid) return { kind: "corrupt" };
  // C-v2-3: a serialized null normalizes to absent, so a loaded record always
  // matches the declared `string | undefined` (JSON.stringify drops undefined,
  // so a first-party writer never emits null; a foreign null is inert anyway
  // because exact command equality against null is impossible).
  if (r.commandIdentityExec === null) delete (parsed as Record<string, unknown>).commandIdentityExec;
  // F2 (Lane C v3): same normalization for the ledger field — a foreign null
  // must not read as "SIGTERM already requested" (every consumer uses
  // !== undefined), which would suppress termination and lie in stop notes.
  if (r.termRequestedAt === null) delete (parsed as Record<string, unknown>).termRequestedAt;
  // SAFETY: every consumed field is individually validated above; the
  // assertion only restores the readonly narrowings TypeScript cannot infer.
  return { kind: "ok", record: parsed as unknown as TunnelRecord };
}

function mapStateName(name: TunnelStateName): BackgroundStatusName {
  switch (name) {
    case "Connected": return "CONNECTED";
    case "Starting":
    case "Connecting": return "STARTING";
    case "Disconnected":
    case "Stopping":
    case "Error": return "DEGRADED";
    case "Unknown": return "UNKNOWN";
    case "Stopped": default: return "STOPPED";
  }
}

/** Single path-selection authority for manager, setup and configuration status.
 * Reject control bytes before a path can reach any visible TUI/status surface. */
export function resolveTunnelProfilePath(options: Pick<BackgroundManagerOptions, "env" | "profilePath">): string {
  const path = options.profilePath ??
    (typeof options.env.CE_TUNNEL_PROFILE === "string" && options.env.CE_TUNNEL_PROFILE.length > 0
      ? options.env.CE_TUNNEL_PROFILE : defaultProfilePath());
  if (!isAbsolute(path) || normalize(path) !== path || !/^[\x20\x21\x23-\x5B\x5D-\x7E]+$/.test(path)) {
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile.path");
  }
  return path;
}

export function createBackgroundTunnelManager(options: BackgroundManagerOptions): BackgroundTunnelManager {
  const env = options.env ?? {};
  const now = options.now ?? Date.now;
  const timing = options.timing ?? DEFAULT_BACKGROUND_TUNNEL_TIMING;
  // Constructor overrides remain domain-test dependencies. Operator settings
  // and discovered production executables always cross the trust boundary.
  const clientPath = options.clientPath ?? (() => {
    try { return resolveTunnelClient({ env }); } catch { return undefined; }
  })();
  const profilePath = resolveTunnelProfilePath(options);
  const stateFilePath = options.stateFilePath ?? `${dirname(profilePath)}/background-state.json`;
  const logPath = `${dirname(stateFilePath)}/background-tunnel.log`;
  const spawnSeam = options.spawn ?? defaultSpawnDaemon(logPath);
  /** Exact command lines this manager's own spawn may show in ps (F2): the
   *  direct argv, plus wrapper-evidence forms (shell prefix / exec target).
   *  Recomputed at every start; used only for the never-persisted pending
   *  re-acquisition path, which belongs to this process's own spawn. */
  let pendingSpawnIdentities: readonly string[] = [`${clientPath} run --profile-file ${profilePath}`];
  /** S-1 (Lane S) + F1 (Lane C v3): spawn-linked exit proof, archived PER RUN.
   *  A child handle's exit event is FIRST-CLASS evidence that OUR spawn is
   *  dead; once fired, any process at that pid is foreign (PID reuse) and the
   *  run must never adopt or signal it. Evidence is keyed by runId (UUIDs,
   *  never reused), so a later start can never sever or inherit another run's
   *  binding — single-slot state provably cannot serve the dual-run stop path
   *  (S5-7). The listener is armed BEFORE the identity-capture loop (the
   *  dominant pending path is a child dying INSIDE that window). Handles are
   *  strongly held defensively (S-2/F4: a listener does not retain its
   *  emitter; no runtime-observable behavior depends on this in tests).
   *  Entries are deleted when their run closes; consulted only for
   *  identityPending records (same session). */
  const exitedPendingRuns = new Set<string>();
  const pendingChildren = new Map<string, DaemonChildHandle>();
  const inspect = options.inspectProcess ?? defaultInspectProcess;
  const listProcesses = options.listProcesses ?? defaultListProcesses;
  const probeHealth = options.probeHealth ?? defaultProbeHealth(clientPath);
  const signal = options.signal ?? ((pid: number, sig: "SIGTERM") => process.kill(pid, sig));

  let state: TunnelState = initialTunnelState(now());
  /** In-memory view; refresh/stop/start always re-read the record from disk. */
  let record: TunnelRecord | undefined;
  let recordCorrupt = false;
  {
    const loaded = loadRecord(stateFilePath);
    if (loaded.kind === "ok") record = loaded.record;
    if (loaded.kind === "corrupt") recordCorrupt = true;
  }
  let recorder: { readonly runId: string; readonly record: (input: HealthProbeInput) => ReturnType<ReturnType<typeof createHealthCompletionRecorder>> } | undefined;
  /** State-machine start baseline per run: spawn time for own runs, first
   *  observation time for adopted ones (C1). */
  const machineStart = new Map<string, number>();
  /** PID reuse/foreign identity observed: status is UNKNOWN until re-verified. */
  let identityMismatch = false;
  let note: string | undefined = record?.state === "stop-unconfirmed" ? "previous stop unconfirmed; ownership retained" : undefined;
  let disposed = false;
  /** C3: one serialized lifecycle queue per manager (cross-process exclusion is
   *  the lock; this queue fences THIS manager's async interleavings). */
  let lifecycle: Promise<unknown> = Promise.resolve();
  /** A stop (here or in another session) invalidates a pending start. */
  let startFence = 0;
  let stopping: Promise<void> | undefined;
  /** A start submitted but not settled; stop awaits it before taking the lock. */
  let activeStart: Promise<unknown> | undefined;
  /** R3/C-v2-1: spawned but UNPERSISTED ownership. Disk ENOENT never discards
   *  it; stop/refresh keep managing it until exit is proven. */
  let pendingRecord: TunnelRecord | undefined;
  /** R2: in-memory single-signal guard for runs that could not be persisted.
   *  A crash loses this set AND the record together, so the global at-most-once
   *  signal invariant still holds. */
  const termIntentSent = new Set<string>();
  /** Runs spawned by THIS session: their startup deadline is real. Adopted
   *  runs are supervised with an unbounded startup window instead (C-v2-5). */
  const spawnedRuns = new Set<string>();

  const recorderFor = (runId: string, pid: number) => {
    if (recorder === undefined || recorder.runId !== runId) {
      recorder = { runId, record: createHealthCompletionRecorder(runId, pid, now) };
    }
    return recorder.record;
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(op, op);
    lifecycle = run.then(() => undefined, () => undefined);
    return run;
  };

  // --- cross-process lock (S4/C2, v3 R1/R7/C-v2-4) -----------------------------
  // A mkdir DIRECTORY lock: creation is atomic; stale reclaim claims the right
  // to delete by renaming the old dir to a unique grave first (exactly one
  // reclaimer wins), so no contender can ever delete a live successor's lock.

  const lockDir = `${stateFilePath}.lock.d`;
  const holderPath = `${lockDir}/holder.json`;
  const LOCK_RETRIES = 3;
  /** The lock token this manager currently holds (critical-section guard). */
  let heldLockToken: string | undefined;

  interface LockJudgement {
    readonly stale: boolean;
    /** Inode+mtime of the judged directory, re-verified on the grave (F2). */
    readonly ino: number;
    readonly mtimeMs: number;
  }
  /** Judge the existing lock; the caller re-verifies identity after rename. */
  const judgeLock = async (): Promise<LockJudgement | undefined> => {
    let stat;
    try {
      stat = lstatSync(lockDir);
    } catch {
      return undefined; // vanished or unreadable: retry mkdir, never delete blind
    }
    if (!stat.isDirectory()) return { stale: false, ino: stat.ino, mtimeMs: stat.mtimeMs };
    const base = { ino: stat.ino, mtimeMs: stat.mtimeMs };
    let holder: { pid?: unknown; startedKey?: unknown; leaked?: unknown } | undefined;
    try {
      holder = JSON.parse(readFileSync(holderPath, "utf8")) as { pid?: unknown; startedKey?: unknown; leaked?: unknown };
    } catch {
      holder = undefined;
    }
    if (holder !== undefined && typeof holder.pid === "number" && holder.pid > 0) {
      const presence = await inspect(holder.pid);
      const pidStale = presence.kind === "absent" ||
        (presence.kind === "present" && typeof holder.startedKey === "string" &&
          presence.identity.startedKey !== holder.startedKey);
      // S5-4: `leaked` is an ADDITIONAL age-based reclaim reason; the pid
      // judgement still applies to every holder.
      const ageStale = holder.leaked === true && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      return { ...base, stale: pidStale || ageStale };
    }
    // Crash between mkdir and holder write (or partial write/removal), or a
    // leaked holder (F5): recoverable by age only. A live creator writes its
    // holder immediately, refreshing the dir mtime; an old holderless dir
    // belongs to a crashed or failed acquirer (R7). Wall-clock age is a REAL
    // cross-process fact, so it deliberately uses Date.now, not the
    // injectable clock.
    return { ...base, stale: Date.now() - stat.mtimeMs > LOCK_STALE_MS };
  };

  const acquireLock = async (): Promise<() => void> => {
    ensureStateDir(dirname(stateFilePath));
    const token = randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        mkdirSync(lockDir); // atomic: exactly one acquirer wins
      } catch {
        // A lock WE leaked (release failed while we still live) is reclaimable
        // by us alone; a live foreign holder is always respected.
        let existingToken: unknown;
        try {
          existingToken = (JSON.parse(readFileSync(holderPath, "utf8")) as { token?: unknown }).token;
        } catch {
          existingToken = undefined;
        }
        const leaked = typeof existingToken === "string" && leakedLockTokens.has(existingToken);
        const judgement = leaked ? undefined : await judgeLock();
        if (leaked || judgement?.stale === true) {
          options.reclaimProbe?.(); // test seam: inject the judge→rename window
          // Claim the sole right to remove by renaming FIRST (R1/C-v2-4).
          const grave = `${lockDir}.reclaim-${token}`;
          let renamed = false;
          try {
            renameSync(lockDir, grave);
            renamed = true;
          } catch { /* another reclaimer won; loop and retry mkdir */ }
          if (renamed) {
            // C-v3-2/S3-1/F2: judgement and rename are NOT atomic (a real ps
            // call sits between them). Verify the grave IS the directory we
            // judged — same inode+mtime AND same holder token (holderless
            // branch: still holderless). A live successor created meanwhile
            // fails this check: roll back and refuse, never delete it.
            let graveToken: unknown;
            let graveStat;
            try {
              graveStat = lstatSync(grave);
              graveToken = (JSON.parse(readFileSync(`${grave}/holder.json`, "utf8")) as { token?: unknown }).token;
            } catch {
              graveToken = undefined;
            }
            const sameLock = graveStat !== undefined &&
              (judgement === undefined ||
                (graveStat.ino === judgement.ino && graveStat.mtimeMs === judgement.mtimeMs)) &&
              (existingToken === undefined ? graveToken === undefined : graveToken === existingToken);
            if (!sameLock) {
              try {
                renameSync(grave, lockDir);
              } catch { /* best effort rollback */ }
              throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
            }
            try {
              rmSync(grave, { recursive: true, force: true });
            } catch { /* harmless residue; swept on a later acquire */ }
            if (typeof existingToken === "string") leakedLockTokens.delete(existingToken);
          }
          continue;
        }
        if (attempt + 1 >= LOCK_RETRIES) throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
        await sleep(100);
        continue;
      }
      // C-v3-7/C-v4-6: best-effort sweep of AGED reclaim graves belonging to
      // THIS lock only — a concurrent reclaimer's fresh grave is untouched.
      try {
        const dir = dirname(stateFilePath);
        const prefix = `${lockDir.slice(dir.length + 1)}.reclaim-`;
        for (const entry of readdirSync(dir)) {
          if (!entry.startsWith(prefix)) continue;
          try {
            if (Date.now() - lstatSync(`${dir}/${entry}`).mtimeMs <= LOCK_STALE_MS) continue;
            rmSync(`${dir}/${entry}`, { recursive: true, force: true });
          } catch { /* ignore */ }
        }
      } catch { /* sweep is best effort */ }
      let selfStartedKey: string | undefined;
      try {
        const self = await inspect(process.pid);
        selfStartedKey = self.kind === "present" ? self.identity.startedKey : undefined;
        writeFileSync(holderPath, JSON.stringify({
          token, pid: process.pid, acquiredAt: now(), startedKey: selfStartedKey,
        }), { mode: 0o600 });
      } catch (error) {
        // R7+F4: never leave a holderless lock behind on our own failure, and
        // never delete a directory that is no longer OURS (a successor may
        // already hold the path).
        let foreign = false;
        try {
          const current = JSON.parse(readFileSync(holderPath, "utf8")) as { token?: unknown };
          foreign = current.token !== undefined && current.token !== token;
        } catch { /* holder missing/unparseable: still our fresh dir */ }
        if (!foreign) {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch { /* best effort */ }
        }
        throw error instanceof TunnelRefusal ? error : new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
      }
      heldLockToken = token;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (heldLockToken === token) heldLockToken = undefined;
        try {
          const current = JSON.parse(readFileSync(holderPath, "utf8")) as { token?: unknown };
          if (current.token === token) {
            rmSync(lockDir, { recursive: true, force: true });
          }
          return; // success, or the lock is no longer ours — never delete
        } catch { /* fall through to leaked tracking */ }
        // S3-4/F5/S5-4: keep the token evidence readable (with startedKey, so
        // the pid/startedKey stale judgement still applies, and `leaked: true`
        // additionally allows age reclaim) so THIS process can reclaim its own
        // leaked lock deterministically.
        try {
          writeFileSync(holderPath, JSON.stringify({
            token, pid: process.pid, leaked: true,
            startedKey: selfStartedKey,
          }), { mode: 0o600 });
        } catch { /* dir unwritable; the age protocol remains */ }
        leakedLockTokens.add(token);
      };
    }
  };

  /** S3-1(b): inside a critical section, prove the lock is still ours before
   *  any persist/signal. If a reclaim ever stole it, fail closed. */
  const assertLockIntact = (): void => {
    const mine = heldLockToken;
    if (mine === undefined) return; // not inside a critical section
    try {
      const current = JSON.parse(readFileSync(holderPath, "utf8")) as { token?: unknown };
      if (current.token === mine) return;
    } catch { /* unreadable holder while we hold it: fail closed */ }
    throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
  };

  const reloadRecord = (): void => {
    const loaded = loadRecord(stateFilePath);
    recordCorrupt = loaded.kind === "corrupt";
    if (loaded.kind === "ok") {
      // C-v3-1 + C-v4-2: pending (unpersisted) ownership outranks only a
      // STOPPED disk record of a different run — a stopped record must never
      // hide a live pending daemon, but another session's LIVE record always
      // wins the in-memory view (persist() independently refuses to overwrite
      // it).
      record = pendingRecord !== undefined && loaded.record.runId !== pendingRecord.runId &&
          loaded.record.state === "stopped"
        ? pendingRecord
        : loaded.record;
    } else if (loaded.kind === "none") {
      record = pendingRecord; // R3: ENOENT never discards pending ownership
    }
    // corrupt: keep the previous in-memory view; mutations refuse elsewhere
  };

  const persist = (next: TunnelRecord): void => {
    // An identity-pending record is memory-only by design: persisting it would
    // both corrupt the on-disk schema and invent an unverified identity.
    if (next.identityPending === true) throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
    // F3/C-v5-4: EVERY ledger write happens under this manager's held lock —
    // machine-enforced, not advisory.
    if (heldLockToken === undefined) throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
    assertLockIntact();
    // F1/C-v4-2/S5-5: never overwrite a DIFFERENT run's live record — that
    // would roll back another session's ownership and termination ledger —
    // and never overwrite a CORRUPT record we cannot even read (S8).
    const onDisk = loadRecord(stateFilePath);
    if (onDisk.kind === "corrupt") throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
    if (onDisk.kind === "ok" && onDisk.record.runId !== next.runId && onDisk.record.state !== "stopped") {
      throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
    }
    ensureStateDir(dirname(stateFilePath));
    const tmp = `${stateFilePath}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(next, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, stateFilePath);
    chmodSync(stateFilePath, 0o600);
    record = next;
    if (pendingRecord?.runId === next.runId) {
      exitedPendingRuns.delete(next.runId);
      pendingChildren.delete(next.runId);
      pendingRecord = undefined;
    }
  };

  // F2: the startedKey anchor is unchanged; the command must equal EITHER the
  // identity captured at start OR the spawn-time wrapper exec evidence. Both
  // are exact full-string matches — substring/basename matches never pass.
  const identityMatches = (current: TunnelRecord, actual: ProcessIdentity): boolean =>
    actual.startedKey === current.processStartedKey &&
    (actual.command === current.commandIdentity ||
      (current.commandIdentityExec !== undefined && actual.command === current.commandIdentityExec));

  const machineStartedAt = (current: TunnelRecord): number => {
    let baseline = machineStart.get(current.runId);
    if (baseline === undefined) {
      // C1: an adopted run's supervision window starts at first observation.
      // Callers capture this BEFORE any async probe so a health completion can
      // never predate the baseline (C-v2-5).
      baseline = now();
      machineStart.set(current.runId, baseline);
    }
    return baseline;
  };

  /** Own spawns keep the real startup deadline; adopted runs get an unbounded
   *  startup window so an observation lapse is DEGRADED, never terminal. */
  const timingFor = (runId: string): TunnelTiming =>
    spawnedRuns.has(runId) ? timing : { ...timing, startupTimeoutMs: Number.MAX_SAFE_INTEGER / 4 };

  const observeAbsence = (current: TunnelRecord, runTiming?: TunnelTiming, baseline?: number): void => {
    state = nextTunnelState(state, {
      now: now(), runId: current.runId, managedPid: current.pid, processAlive: false,
      userStopped: current.termRequestedAt !== undefined, startedAt: baseline ?? machineStartedAt(current),
      exit: { code: null, signal: current.termRequestedAt !== undefined ? "SIGTERM" : null },
      probe: undefined, startupLogSeen: false, externalInstance: false,
    }, runTiming ?? timingFor(current.runId));
  };

  const markStopped = (current: TunnelRecord, stopNote: string | undefined): TunnelRecord => ({
    ...current, state: "stopped", stoppedAt: now(), note: stopNote,
  });

  /** The ONE termination path (S5/C8, v3 R2/R3): identity re-verified, signal
   *  at most once. The ledger is authoritative: a record-backed run is
   *  signalled only after termRequestedAt PERSISTS; an unpersisted pending run
   *  falls back to the in-memory once-set (a crash loses both together). */
  const terminateOwned = async (input: TunnelRecord, graceMs: number): Promise<"stopped" | "unconfirmed" | "unknown"> => {
    let current = input;
    const presence = await inspect(current.pid);
    if (presence.kind === "absent") return "stopped";
    if (presence.kind === "unknown") return "unknown";
    if (current.identityPending === true) {
      // Spawned child whose identity was never confirmed: re-acquire now.
      // S-1 FIRST: if the spawn-linked child already exited, OUR process is
      // provably dead and any process at this pid is a foreign reuser — never
      // adopt its startedKey, never signal it. The run's exit is proven.
      if (exitedPendingRuns.has(current.runId)) return "stopped";
      // S3-2 + F2: we spawned it, so the argv is KNOWN — require membership in
      // the exact, evidence-derived spawn-identity set (direct argv plus any
      // wrapper shell/exec forms). Substring matching is refused (forged argv
      // must never match). A live child link (no exit event) pins the pid to
      // our spawn, so the observed startedKey IS our child's start time.
      if (!pendingSpawnIdentities.includes(presence.identity.command)) {
        identityMismatch = true;
        note = "spawned child identity unconfirmed; retained ownership, no signal sent";
        return "unknown";
      }
      current = {
        ...current, commandIdentity: presence.identity.command,
        processStartedKey: presence.identity.startedKey, identityPending: undefined,
      };
      try {
        persist(current);
      } catch { /* stays pending; in-memory guard below still applies */ }
    } else if (!identityMatches(current, presence.identity)) {
      identityMismatch = true;
      note = "process identity mismatch; retained record, no signal sent";
      return "unknown";
    }
    identityMismatch = false;
    if (current.termRequestedAt === undefined) {
      const requested = { ...current, termRequestedAt: now() };
      // Snapshot BEFORE any bookkeeping: at-most-once spans the persisted
      // ledger and the in-memory guard across BOTH mechanisms.
      const alreadySent = termIntentSent.has(current.runId);
      let maySignal = false;
      try {
        assertLockIntact(); // S3-1(b): ledger writes happen under OUR lock
        persist(requested);
        current = requested;
        maySignal = !alreadySent;
      } catch {
        // R2: a record-backed run may NOT be signalled without its ledger.
        // A pending (never persisted) run uses the in-memory once-set instead.
        // The once-set is NOT burned here: it is burned below, only once the
        // lock is proven held, so a lost lock never burns the guard (F1).
        if (pendingRecord?.runId === current.runId && !alreadySent) maySignal = true;
      }
      if (maySignal) {
        // S6-4/F1: symmetric with persist — a signal (including the pending-run
        // in-memory once-set branch) is machine-enforced to a held lock. A
        // lost lock returns "unknown" (ownership retained) rather than
        // throwing, preserving the three-state termination contract.
        if (heldLockToken === undefined) {
          note = "lock lost before signal; ownership retained, no signal sent";
          return "unknown";
        }
        try {
          assertLockIntact(); // S3-1(b): never signal after losing the lock
        } catch {
          note = "lock lost before signal; ownership retained, no signal sent";
          return "unknown";
        }
        if (!alreadySent) termIntentSent.add(current.runId);
        try {
          signal(current.pid, "SIGTERM");
        } catch { /* delivery failure is not exit proof; record retains ownership */ }
      } else if (!alreadySent) {
        note = "termination intent could not be persisted; ownership retained, no signal sent";
        return "unknown";
      }
      // alreadySent && !maySignal: the single signal went out earlier; wait.
    }
    const deadline = now() + graceMs;
    for (;;) {
      const probe = await inspect(current.pid);
      if (probe.kind === "absent") return "stopped";
      if (probe.kind === "unknown") return "unknown";
      if (now() >= deadline) return "unconfirmed";
      await sleep(EXIT_POLL_MS);
    }
  };

  const refresh = async (): Promise<BackgroundManagerStatus> => {
    reloadRecord();
    if (recordCorrupt) {
      note = "ownership record unreadable; refusing to guess";
      return status();
    }
    let current = record;
    if (current === undefined || current.state === "stopped") return status();
    // C-v2-5: establish the run baseline BEFORE any async measurement so a
    // health completion can never predate it.
    const baseline = machineStartedAt(current);
    const runTiming = timingFor(current.runId);
    const presence = await inspect(current.pid);
    // Exit proof: verified ps absence (the only cross-session proof), OR — for
    // a never-persisted identity-pending run, same-session only — the spawn
    // link's exit event (S-1: after it, the pid may be a foreign reuser and
    // must never be adopted or signalled).
    if (presence.kind === "absent" || (current.identityPending === true && exitedPendingRuns.has(current.runId))) {
      observeAbsence(current, runTiming, baseline);
      // R4/C-v2-3: persist ONLY under the lock, re-checking the run inside.
      let release: (() => void) | undefined;
      try {
        release = await acquireLock();
      } catch {
        note = "exit observed but not persisted (lock busy); ownership view retained";
        return status();
      }
      try {
        reloadRecord();
        if (recordCorrupt) return status();
        if (record?.runId !== current.runId || record.state === "stopped") return status();
        // S3-7: persist the record re-read INSIDE the lock, so a concurrent
        // session's ledger fields (termRequestedAt, note) are not rolled back.
        const fresh = { ...record, identityPending: undefined };
        try {
          persist(markStopped(fresh, fresh.termRequestedAt !== undefined ? "exit observed after SIGTERM"
            : current.identityPending === true && exitedPendingRuns.has(current.runId) ? "spawn exit observed via child link; no respawn"
            : "process absent (unexpected; no respawn)"));
        } catch { /* a persistence failure never fabricates a stop either */ }
      } finally {
        release();
      }
      return status();
    }
    if (presence.kind === "unknown") {
      note = "process inspection unavailable; ownership retained";
      return status();
    }
    if (current.identityPending === true) {
      // Same re-acquisition rule as terminateOwned (S3-2 + F2: exact membership
      // in the evidence-derived spawn-identity set, never substring).
      if (pendingSpawnIdentities.includes(presence.identity.command)) {
        const upgraded = {
          commandIdentity: presence.identity.command,
          processStartedKey: presence.identity.startedKey,
          commandIdentityExec: current.commandIdentityExec,
        };
        // F1/S8-1: the upgrade persist happens under the lock, MERGED onto the
        // record re-read INSIDE the lock — a concurrent stop may have persisted
        // a newer termRequestedAt/state that must NOT be rolled back, and a run
        // another session already stopped is never resurrected.
        let release: (() => void) | undefined;
        try {
          release = await acquireLock();
          reloadRecord();
          if (recordCorrupt) return status();
          const fresh = record;
          if (fresh !== undefined && fresh.runId === current.runId && fresh.state !== "stopped") {
            const merged = { ...fresh, ...upgraded, identityPending: undefined };
            persist(merged);
            current = merged;
          } else if (fresh !== undefined && fresh.runId === current.runId && fresh.state === "stopped") {
            // Already terminated by a concurrent session: do not resurrect.
            current = { ...fresh, identityPending: undefined };
            return status();
          } else {
            // Still purely pending (no on-disk record): memory-only upgrade.
            current = { ...current, ...upgraded, identityPending: undefined };
          }
        } catch { /* remains pending; the in-memory identity still applies below */ }
        finally {
          release?.();
        }
      } else {
        identityMismatch = true;
        note = "spawned child identity unconfirmed; retained ownership";
        return status();
      }
    } else if (!identityMatches(current, presence.identity)) {
      identityMismatch = true;
      note = "process identity mismatch; retained record, no signal sent";
      return status();
    }
    identityMismatch = false;
    const probe = recorderFor(current.runId, current.pid)(await probeHealth(current.urlFile, current.pid));
    // C3 fencing: discard the measurement if the run stopped meanwhile.
    const latest = loadRecord(stateFilePath);
    if (latest.kind !== "ok" || latest.record.runId !== current.runId || latest.record.state === "stopped") {
      return status();
    }
    state = nextTunnelState(state, {
      now: now(), runId: current.runId, managedPid: current.pid, processAlive: true,
      userStopped: current.termRequestedAt !== undefined, startedAt: baseline,
      exit: undefined, probe, startupLogSeen: false, externalInstance: false,
    }, runTiming);
    return status();
  };

  const start = (): Promise<BackgroundStartResult> => {
    // R5/C-v2-2: the lifecycle generation is captured AT CALL TIME, so a stop
    // submitted before this start executes still invalidates it.
    const fenceAtCall = startFence;
    const op = enqueue(() => startImpl(fenceAtCall));
    activeStart = op;
    const settled = op.then(
      (result) => { if (activeStart === op) activeStart = undefined; return result; },
      (error: unknown) => { if (activeStart === op) activeStart = undefined; throw error; },
    );
    return settled;
  };

  /** REAL-START-FIX-01: spawn + persist (ack) separately from readiness
   *  (settled). Both stay joined by activeStart so stop/dispose settle the
   *  full start before proceeding; nothing becomes an unsupervised promise. */
  const startDeferred = (): BackgroundStartDeferred => {
    const fenceAtCall = startFence;
    let resolveAck: ((ack: BackgroundStartAck) => void) | undefined;
    let rejectAck: ((error: unknown) => void) | undefined;
    const ack = new Promise<BackgroundStartAck>((resolve, reject) => { resolveAck = resolve; rejectAck = reject; });
    const op = enqueue(() => startImpl(fenceAtCall, (spawned) => resolveAck?.(spawned)));
    activeStart = op;
    const settled = op.then(
      (result) => { if (activeStart === op) activeStart = undefined; return result; },
      (error: unknown) => { if (activeStart === op) activeStart = undefined; rejectAck?.(error); throw error; },
    );
    return { ack, settled };
  };
  const startImpl = async (fenceAtCall: number, onSpawned?: (ack: BackgroundStartAck) => void): Promise<BackgroundStartResult> => {
    if (fenceAtCall !== startFence) throw new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT");
    if (disposed) throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
    // S1: the real start gate is exact and independent of the offline flag.
    if (env[BACKGROUND_OPT_IN] !== "1") throw new TunnelRefusal("CE_TUNNEL_BACKGROUND_UNAUTHORIZED");
    if (!isAbsolute(profilePath) || normalize(profilePath) !== profilePath) {
      throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile");
    }
    let profileText: string;
    try {
      profileText = readFileSync(profilePath, "utf8");
    } catch {
      throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile");
    }
    const facts = parseTunnelProfile(profileText);
    checkKeyFileMetadata(facts.keyFile);
    const profileSha256 = createHash("sha256").update(profileText, "utf8").digest("hex");
    // S6/C4: prove the record location is writable BEFORE spawning.
    ensureStateDir(dirname(stateFilePath));
    const writabilityProbe = `${stateFilePath}.${randomUUID()}.probe`;
    try {
      writeFileSync(writabilityProbe, "", { mode: 0o600, flag: "wx" });
      unlinkSync(writabilityProbe);
    } catch {
      throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
    }

    const release = await acquireLock();
    if (fenceAtCall !== startFence) { release(); throw new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT"); }
    let child: DaemonChildHandle | undefined;
    try {
      reloadRecord();
      if (recordCorrupt) throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
      const existing = record;
      if (existing !== undefined && existing.state !== "stopped") {
        const presence = await inspect(existing.pid);
        if (presence.kind === "present" && identityMatches(existing, presence.identity)) {
          // Identity verified but health NOT re-measured here: report unknown.
          onSpawned?.({ runId: existing.runId, pid: existing.pid, tunnelId: maskTunnelId(existing.tunnelId), startedAt: new Date(existing.startedAt).toISOString() });
          return {
            runId: existing.runId, pid: existing.pid, tunnelId: maskTunnelId(existing.tunnelId),
            health: "unknown" as const, startedAt: new Date(existing.startedAt).toISOString(), alreadyRunning: true,
          };
        }
        if (presence.kind === "present") throw new TunnelRefusal("CE_TUNNEL_EXTERNAL_INSTANCE");
        if (presence.kind === "unknown") throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
        observeAbsence(existing);
        // C-v4-1: strip identityPending before persisting — a never-confirmed
        // run whose process is gone IS superseded (its exit is proven by ps
        // absence), so persist must not reject it as STATE_CORRUPT.
        persist(markStopped({ ...existing, identityPending: undefined }, "superseded: previous process absent"));
      }
      const listed = await listProcesses();
      if (listed.kind !== "ok") throw new TunnelRefusal("CE_TUNNEL_HEALTH_UNAVAILABLE");
      for (const proc of listed.processes) {
        if (proc.command.includes(`--profile-file ${profilePath}`)) {
          throw new TunnelRefusal("CE_TUNNEL_EXTERNAL_INSTANCE");
        }
      }

      if (fenceAtCall !== startFence) throw new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT");
      assertLockIntact(); // S3-1(b): the lock must still be ours before spawn
      // Setup commits under this same lock. Recheck after ALL asynchronous
      // identity/list operations: never spawn against a different generation
      // than the facts and credential metadata validated above.
      let currentProfileText: string;
      try { currentProfileText = readFileSync(profilePath, "utf8"); }
      catch { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "profile"); }
      if (currentProfileText !== profileText) throw new TunnelRefusal("CE_TUNNEL_CONFIG_CONFLICT", "profile");
      checkKeyFileMetadata(facts.keyFile);
      if (clientPath === undefined) throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED", "client");
      const runId = `bg-${randomUUID()}`;
      const startedAt = now();
      state = initialTunnelState(startedAt);
      machineStart.set(runId, startedAt);
      spawnedRuns.add(runId);
      identityMismatch = false;
      // S-1/F1: exit evidence is per-run and runIds are fresh UUIDs, so a new
      // start must NOT reset it — doing so would sever a surviving pending
      // run's binding (dual-run stop path, S5-7).
      note = undefined;
      // F2: establish the spawn's stable identity set BEFORE spawning. The
      // direct argv is always acceptable (it is what we pass); the wrapper
      // shell/exec forms are added only when the client file provides strict
      // evidence (resolveWrapperIdentityEvidence). The exec form is also
      // persisted on the record so LATER sessions recognize the post-exec argv.
      const wrapperEvidence = resolveWrapperIdentityEvidence(clientPath);
      const spawnArgs = ["run", "--profile-file", profilePath] as const;
      const commandIdentityExec = wrapperEvidence?.execTarget !== undefined
        ? [wrapperEvidence.execTarget, ...spawnArgs].join(" ")
        : undefined;
      pendingSpawnIdentities = [
        [clientPath, ...spawnArgs].join(" "),
        ...(wrapperEvidence?.shellPrefix !== undefined
          ? [`${wrapperEvidence.shellPrefix} ${[clientPath, ...spawnArgs].join(" ")}`]
          : []),
        ...(commandIdentityExec !== undefined ? [commandIdentityExec] : []),
      ];

      try {
        child = spawnSeam(clientPath, spawnArgs, {
          env: childEnvironment(env), detached: true, logPath,
        });
      } catch {
        throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }
      child.on("error", () => undefined);
      const pid = child.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        child = undefined;
        throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }
      child.unref();
      // S-1: arm the spawn-linked exit proof BEFORE the capture loop. The
      // dominant pending path is a child dying INSIDE the capture window — its
      // exit event fires there, once, before any pending record exists. The
      // entry is keyed by THIS run's id, so neither an early exit nor a later
      // start can lose or misattribute it.
      child.on("exit", () => {
        exitedPendingRuns.add(runId);
      });
      // Capture the process identity BEFORE persisting ownership.
      let identity: ProcessIdentity | undefined;
      const appearDeadline = now() + IDENTITY_APPEAR_MS;
      while (now() <= appearDeadline) {
        const presence = await inspect(pid);
        if (presence.kind === "present") { identity = presence.identity; break; }
        if (presence.kind === "absent") break;
        await sleep(50);
      }
      // S3-2 + F2: capture accepts ONLY the exact evidence-derived spawn
      // identities (direct argv / wrapper shell prefix / wrapper exec target);
      // a merely substring-similar command is never attributed to this spawn.
      if (identity === undefined || !pendingSpawnIdentities.includes(identity.command)) {
        // Never signal a process we cannot attribute to THIS spawn — but do
        // NOT abandon it either: keep a pending, never-persisted record so
        // stop/refresh can re-acquire identity and terminate it later (R3).
        pendingRecord = {
          version: 1, runId, pid, profilePath, profileSha256,
          tunnelId: facts.tunnelId, keyFile: facts.keyFile, urlFile: facts.urlFile,
          mcpCommand: facts.mcpCommand, logPath,
          commandIdentity: "", processStartedKey: "", commandIdentityExec,
          startedAt, termRequestedAt: undefined, state: "running",
          stoppedAt: undefined, note: "spawned child identity unconfirmed",
          identityPending: true,
        };
        record = pendingRecord;
        note = "spawned child identity unconfirmed; ownership retained in memory";
        // S-1/S-2: the exit listener is already armed (above) and archives by
        // runId; keep the handle strongly (defensive — a listener does not
        // retain its emitter) until this pending run closes or dispose().
        pendingChildren.set(runId, child);
        child = undefined;
        throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }

      const base: TunnelRecord = {
        version: 1, runId, pid, profilePath, profileSha256,
        tunnelId: facts.tunnelId, keyFile: facts.keyFile, urlFile: facts.urlFile,
        mcpCommand: facts.mcpCommand, logPath,
        commandIdentity: identity.command, processStartedKey: identity.startedKey, commandIdentityExec,
        startedAt, termRequestedAt: undefined, state: "running",
        stoppedAt: undefined, note: undefined,
      };
      try {
        persist(base);
        onSpawned?.({ runId, pid, tunnelId: maskTunnelId(facts.tunnelId), startedAt: new Date(startedAt).toISOString() });
      } catch (error) {
        // S6/C4 + R3: the daemon exists but the record does not. Ownership
        // becomes PENDING: disk ENOENT must never discard it, and a later
        // stop() retries the ledger + termination through the same path.
        pendingRecord = base;
        record = base;
        note = "ownership record persistence failed; in-memory ownership retained";
        const outcome = await terminateOwned(base, timing.stopGraceMs);
        if (outcome === "stopped") {
          pendingRecord = undefined;
          record = undefined;
          note = "startup aborted; record persistence failed and the child was stopped";
        }
        throw error instanceof TunnelRefusal ? error : new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }
    } finally {
      release();
    }

    const current = record!;
    // Wait for REAL transport readiness, never mere PID liveness. Success
    // requires the shared state machine to ACCEPT Connected (C6).
    const recordCompletion = recorderFor(current.runId, current.pid);
    const deadline = current.startedAt + timing.startupTimeoutMs;
    let accepted = false;
    for (;;) {
      const probe = recordCompletion(await probeHealth(facts.urlFile, current.pid));
      // C3 fencing: a stop here or in another session aborts this start.
      const latest = loadRecord(stateFilePath);
      const fenced = fenceAtCall !== startFence || latest.kind !== "ok" ||
        latest.record.runId !== current.runId || latest.record.state !== "running" ||
        latest.record.termRequestedAt !== undefined;
      state = nextTunnelState(state, {
        now: now(), runId: current.runId, managedPid: current.pid, processAlive: true,
        userStopped: false, startedAt: current.startedAt,
        exit: undefined, probe, startupLogSeen: false, externalInstance: false,
      }, timing);
      if (!fenced && state.name === "Connected") { accepted = true; break; }
      if (fenced || now() >= deadline) break;
      await sleep(250);
    }
    if (accepted) {
      return {
        runId: current.runId, pid: current.pid, tunnelId: maskTunnelId(facts.tunnelId),
        health: "connected" as const, startedAt: new Date(current.startedAt).toISOString(), alreadyRunning: false,
      };
    }
    // Startup failure/timeout/superseded: unified verified cleanup (S5/C8).
    // A concurrent stop may hold the lock; its termination already applies to
    // this run, so a busy lock here is not a second failure path.
    let cleanupRelease: (() => void) | undefined;
    try {
      cleanupRelease = await acquireLock();
    } catch {
      note = "startup not confirmed; cleanup lock busy (a concurrent stop owns this run)";
      throw new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT");
    }
    try {
      reloadRecord();
      if (recordCorrupt) throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
      if (record?.runId === current.runId && record.state !== "stopped") {
        const outcome = await terminateOwned(record, timing.stopGraceMs);
        if (outcome === "stopped") {
          observeAbsence(record);
          persist(markStopped({ ...record, identityPending: undefined }, "startup not confirmed; verified stop"));
        } else {
          try {
            persist({ ...record, state: "stop-unconfirmed", note: `startup not confirmed; cleanup ${outcome}` });
          } catch { /* ownership retained in memory */ }
          note = "startup not confirmed; cleanup unconfirmed; ownership retained";
        }
      }
    } finally {
      cleanupRelease();
    }
    throw new TunnelRefusal("CE_TUNNEL_READY_TIMEOUT");
  };

  // Stop is deliberately NOT queued behind a pending start: it preempts via
  // startFence + the lock (C3). v3: it first AWAITS the settlement of any
  // start it invalidated — bounded by one probe timeout + identity capture +
  // stopGraceMs — so it never returns while a cancelled start still owns work.
  const stop = (stopOptions: { graceMs?: number } = {}): Promise<void> => {
    if (stopping !== undefined) return stopping;
    const attempt = stopOnce(stopOptions);
    stopping = attempt;
    return attempt.then(
      () => { stopping = undefined; },
      (error: unknown) => { stopping = undefined; throw error; },
    ) as Promise<void>;
  };
  const stopOnce = async (stopOptions: { graceMs?: number }): Promise<void> => {
    startFence += 1; // invalidate any pending start in THIS manager (C3)
    // R5/C-v2-2: an invalidated start must SETTLE (cleanup included) before we
    // proceed, so stop never returns while a start it cancelled still owns work.
    const inflight = activeStart;
    if (inflight !== undefined) await inflight.catch(() => undefined);
    const graceMs = stopOptions.graceMs ?? timing.stopGraceMs;
    // Fast path without taking the lock or touching the filesystem: nothing
    // owned on disk AND no pending in-memory ownership means nothing to stop.
    {
      const pre = loadRecord(stateFilePath);
      if (pre.kind === "corrupt") { recordCorrupt = true; throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT"); }
      if (pre.kind === "none" || pre.record.state === "stopped") {
        if (pendingRecord === undefined) { record = pre.kind === "ok" ? pre.record : undefined; return; }
        record = pendingRecord; // R3: pending ownership must still be stoppable
      }
    }
    const release = await acquireLock();
    try {
      reloadRecord();
      if (recordCorrupt) throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
      const current = record;
      // S5-7: an unpersisted pending daemon that is NOT the disk record's run
      // still belongs to this session — terminate it alongside (the in-memory
      // once-set keeps this at-most-once). Exit proof clears the pending view.
      let pendingUnresolved = false;
      if (pendingRecord !== undefined && pendingRecord.runId !== current?.runId) {
        const pOutcome = await terminateOwned(pendingRecord, graceMs);
        if (pOutcome === "stopped") {
          try {
            persist(markStopped({ ...pendingRecord, identityPending: undefined }, "pending run exit confirmed"));
          } catch { /* exit is proven; the record is informational only */ }
          exitedPendingRuns.delete(pendingRecord.runId);
          pendingChildren.delete(pendingRecord.runId);
          pendingRecord = undefined;
          if (record?.runId !== current?.runId) record = current;
        } else {
          pendingUnresolved = true;
          note = "pending run stop unconfirmed; ownership retained";
        }
      }
      if (current === undefined || current.state === "stopped") {
        if (pendingUnresolved) throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
        return;
      }
      const outcome = await terminateOwned(current, graceMs);
      if (outcome === "stopped") {
        // Verify the profile-declared MCP child is gone too; the child belongs
        // to the client, so we NEVER signal it — only report. The note must be
        // honest about whether THIS run was ever signalled (S-1 child-link and
        // ps-absence exits deliver no signal): the ledger or the once-set tells.
        const signalled = current.termRequestedAt !== undefined || termIntentSent.has(current.runId);
        let stopNote = signalled
          ? "exit observed after SIGTERM"
          : "exit observed (process already gone); no signal sent";
        if (current.mcpCommand !== undefined) {
          const listed = await listProcesses();
          if (listed.kind === "ok" && listed.processes.some((proc) => proc.command === current.mcpCommand)) {
            stopNote = `${signalled ? "exit observed after SIGTERM" : "exit observed (process already gone); no signal sent"}; MCP child still running (not signalled by this manager)`;
            note = stopNote;
          }
        }
        observeAbsence(record!);
        persist(markStopped({ ...record!, identityPending: undefined }, stopNote));
        if (pendingUnresolved || pendingRecord !== undefined) {
          note = "stopped the recorded run; ANOTHER unpersisted pending run is still alive — run stop again";
        }
        if (pendingUnresolved) throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
        return;
      }
      try {
        persist({ ...record!, state: "stop-unconfirmed", note: `stop ${outcome}; ownership retained` });
      } catch { /* ownership retained in memory; the refusal below still applies */ }
      note = "stop unconfirmed; ownership retained";
      throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
    } finally {
      release();
    }
  };

  const status = (): BackgroundManagerStatus => {
    const current = record;
    // Pure projection: this observation is never committed, but lets a stale
    // Connected lapse to Unknown exactly like the offline manager's reads.
    const view: TunnelState = current === undefined || current.state === "stopped" || identityMismatch
      ? state
      : nextTunnelState(state, {
          now: now(), runId: current.runId, managedPid: current.pid, processAlive: true,
          userStopped: current.termRequestedAt !== undefined, startedAt: machineStartedAt(current),
          exit: undefined, probe: undefined, startupLogSeen: false, externalInstance: false,
        }, timingFor(current.runId));
    const mapped = recordCorrupt || identityMismatch
      ? "UNKNOWN" as const
      : mapStateName(current === undefined || current.state === "stopped" ? "Stopped" : view.name);
    const evidence = current === undefined
      ? "none" as const
      : current.state === "stopped"
        ? "process-absent" as const
        : !identityMismatch && view.lastHealthyAt !== undefined && now() - view.lastHealthyAt <= timing.freshnessMs
          ? "health-probe" as const
          : "none" as const;
    return Object.freeze({
      mode: "real-background" as const,
      state: mapped,
      label: `Tunnel ${mapped} (real background)`,
      evidence,
      running: current !== undefined && current.state !== "stopped" && !identityMismatch && !recordCorrupt && mapped !== "STOPPED",
      runId: current?.runId,
      pid: current !== undefined && current.state !== "stopped" ? current.pid : undefined,
      startedAt: current !== undefined && current.state !== "stopped" ? new Date(current.startedAt).toISOString() : undefined,
      tunnelId: current !== undefined ? maskTunnelId(current.tunnelId) : undefined,
      note: note ?? (current?.note),
    });
  };

  return {
    kind: "real-background" as const,
    start,
    startDeferred,
    withProfileConfigurationLock: <T>(operation: (guard: ProfileConfigurationGuard) => T): Promise<T> => enqueue(async () => {
      if (disposed) throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
      const release = await acquireLock();
      try {
        reloadRecord();
        if (recordCorrupt) throw new TunnelRefusal("CE_TUNNEL_STATE_CORRUPT");
        // Do not turn a setup action into recovery, a stop or an adoption.
        // Even a stale running ledger requires explicit lifecycle resolution.
        if (record !== undefined && record.state !== "stopped") throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
        const listed = await listProcesses();
        if (listed.kind !== "ok") throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
        if (listed.processes.some((proc) => proc.command.includes(`--profile-file ${profilePath}`))) {
          throw new TunnelRefusal("CE_TUNNEL_EXTERNAL_INSTANCE");
        }
        assertLockIntact();
        const token = heldLockToken;
        return operation({ profilePath, assertIntact: () => {
          if (token === undefined || heldLockToken !== token) throw new TunnelRefusal("CE_TUNNEL_MANAGER_BUSY");
          assertLockIntact();
        } });
      } finally { release(); }
    }),
    stop,
    refresh,
    status,
    runId: () => (record !== undefined && record.state !== "stopped" ? record.runId : undefined),
    async dispose(): Promise<void> {
      // The daemon is deliberately NOT stopped: it is owned by the record and
      // survives this Pi session. Session-locals are released only.
      // C-v5-1: settle an in-flight start first — its pending record and exit
      // proof must be materialized before we decide whether to release the
      // archives, so a start racing with dispose cannot lose its exit proof.
      const inflight = activeStart;
      if (inflight !== undefined) await inflight.catch(() => undefined);
      // S-1/F1 (S4-1): dispose must NOT sever a surviving pending run's exit
      // proof — stop/refresh remain callable after dispose and must still be
      // able to distinguish our dead child from a pid reuser. Only release the
      // archives when no pending ownership survives; otherwise the handle is
      // kept strongly so its exit event can still be archived.
      if (pendingRecord === undefined) {
        exitedPendingRuns.clear();
        pendingChildren.clear();
      }
      disposed = true;
    },
  };
}
