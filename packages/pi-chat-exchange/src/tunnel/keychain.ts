/**
 * HANDOFF-CE-HOST-09 B1.1 Task 2 — scoped macOS Keychain credential adapter.
 *
 * Two layers, deliberately separated so the policy layer is testable without a
 * Keychain and the transport layer is testable without a secret:
 *
 * 1. `createKeychainCredentialStore` — the only credential CRUD policy. It
 *    validates the scope, derives ONE deterministic account, issues exactly one
 *    operation from a fixed allowlist per call, and translates every outcome
 *    into the closed `CE_TUNNEL_*` vocabulary. Raw helper output never escapes.
 * 2. `createNativeKeychainRunner` — process transport for the Swift helper in
 *    `native/tunnel-keychain.swift`. The secret is written only to framed
 *    stdin; argv, the environment, the compiler invocation, and any temporary
 *    file are secret-free.
 *
 * Boundaries that are NOT crossed here:
 * - no credential ever reaches the official tunnel client (R11 stays blocked);
 *   this module stores and retrieves, it does not hand off.
 * - no enumeration, no prefix or service-wide match, no search-list fallback,
 *   no ACL repair, no partition-list change, no prompt automation.
 * - native `errSecItemNotFound` (-25300) is the ONLY accepted "missing" signal.
 *   The `security(1)` CLI's exit 44 convention is explicitly not honoured; a
 *   response that merely carries `exitCode: 44` is an unavailability, not a
 *   missing item.
 * - an ambiguous timeout is never retried: the mutation may already have
 *   committed, so the caller must reconcile the exact item first.
 *
 * NOT VERIFIED by the implementing worker: helper compilation, real Keychain
 * CRUD, and real ACL behaviour. Those need the authorized fake-item probe.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TunnelRefusal } from "./codes.js";
import { TUNNEL_ID_PATTERN } from "./tunnel-id.js";

/** Fixed service for every B1.1 item. Never derived from input. */
export const TUNNEL_KEYCHAIN_SERVICE = "pi-chat-exchange-tunnel";

/** Native `errSecItemNotFound`. Documented here to contrast with CLI exit 44. */
export const NATIVE_ITEM_NOT_FOUND = -25300;

export const KEYCHAIN_OPERATIONS = ["exists", "read", "create", "update", "delete"] as const;
export type KeychainOperation = (typeof KEYCHAIN_OPERATIONS)[number];

export interface KeychainRequest {
  readonly op: KeychainOperation;
  readonly service: string;
  readonly account: string;
  /**
   * B1.1-INTEGRATION: request the NATIVE macOS authorization prompt for this
   * one read. Only `read` accepts it; the runner refuses it for every other
   * op. It is set exclusively by the user-triggered authorize path — never by
   * an ordinary read, and never silently.
   */
  readonly interactive?: boolean;
}

/** Returns the helper's single raw response line; parsing stays in the store. */
export interface KeychainHelperRunner {
  run(request: KeychainRequest, secret?: string): Promise<string>;
}

export interface KeychainScope {
  /** Canonical control-plane origin, e.g. `https://api.example.test`. */
  readonly origin: string;
  readonly tunnelId: string;
}

/**
 * B1.1 commands operate exclusively on this synthetic offline scope: no
 * existing production profile, config, or key is inspected or retrieved.
 */
export const OFFLINE_SYNTHETIC_SCOPE: KeychainScope = Object.freeze({
  origin: "https://offline-b11.invalid",
  tunnelId: "tunnel_b11offline",
});

const ORIGIN_PATTERN = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
const ACCOUNT_PATTERN = /^v1:[0-9a-f]{64}$/;
const SECRET_PATTERN = /^[\x21-\x7e]{1,4096}$/;

function invalid(field: string): TunnelRefusal {
  return new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", field);
}

function unavailable(): TunnelRefusal {
  return new TunnelRefusal("CE_TUNNEL_KEYCHAIN_UNAVAILABLE");
}

/**
 * Versioned deterministic account: `v1:sha256(origin + NUL + tunnelId)`. The
 * NUL separator makes the two fields unambiguous, so no pair of distinct
 * scopes can collide by shifting bytes across the boundary.
 */
export function keychainAccountFor(scope: KeychainScope): string {
  const origin = scope?.origin;
  const tunnelId = scope?.tunnelId;
  if (typeof origin !== "string" || !ORIGIN_PATTERN.test(origin)) throw invalid("credential.scope.origin");
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || parsed.username !== "" || parsed.password !== "") {
      throw invalid("credential.scope.origin");
    }
  } catch (error) {
    throw error instanceof TunnelRefusal ? error : invalid("credential.scope.origin");
  }
  if (typeof tunnelId !== "string" || !TUNNEL_ID_PATTERN.test(tunnelId)) throw invalid("credential.scope.tunnelId");
  const digest = createHash("sha256").update(`${origin}\u0000${tunnelId}`, "utf8").digest("hex");
  return `v1:${digest}`;
}

/**
 * B1.1-INTEGRATION: the helper's closed error-reason vocabulary, mirrored from
 * `native/tunnel-keychain.swift`. `authorization_required` is the native
 * -25293 class (no user decision available for THIS code identity);
 * `user_canceled` is the -128 class (the user dismissed the native prompt).
 * Anything else on the error path is plain unavailability.
 */
const HELPER_ERROR_REASONS = [
  "bad_request",
  "unavailable",
  "acl_too_broad",
  "already_exists",
  "authorization_required",
  "user_canceled",
] as const;

type HelperErrorReason = (typeof HELPER_ERROR_REASONS)[number];

type HelperResponse =
  | { readonly status: "ok"; readonly secret?: string }
  | { readonly status: "not_found" }
  | {
      readonly status: "error";
      /**
       * B1.1-INTEGRATION: closed helper reason token, when the helper supplied
       * one from its fixed list. Absent/unknown tokens stay undefined and fail
       * closed to unavailability at the store.
       */
      readonly reason?: HelperErrorReason | undefined;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict parse of the helper's single response line. Anything unexpected is
 * unavailability — never an optimistic success and never a "missing" verdict.
 */
function parseResponse(raw: unknown): HelperResponse {
  if (typeof raw !== "string" || raw.length > 65_536) throw unavailable();
  const firstLine = raw.split("\n", 1)[0] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw unavailable();
  }
  if (!isRecord(parsed)) throw unavailable();
  const status = parsed.status;
  if (status === "not_found") return { status: "not_found" };
  // `exitCode: 44` (the security(1) CLI convention) lands here deliberately:
  // an error response is unavailability, never a native missing item.
  if (status === "error") {
    const reason = parsed.reason;
    return {
      status: "error",
      reason:
        typeof reason === "string" && (HELPER_ERROR_REASONS as readonly string[]).includes(reason)
          ? (reason as HelperErrorReason)
          : undefined,
    };
  }
  if (status !== "ok") throw unavailable();
  const encoded = parsed.secretBase64;
  if (encoded === undefined) return { status: "ok" };
  if (typeof encoded !== "string") throw unavailable();
  let secret: string;
  try {
    secret = Buffer.from(encoded, "base64").toString("utf8");
  } catch {
    throw unavailable();
  }
  if (!SECRET_PATTERN.test(secret)) throw unavailable();
  return { status: "ok", secret };
}

export interface KeychainCredentialStore {
  /** The exact account every operation of this store targets. */
  readonly account: string;
  /** Existence check that never retrieves the value. */
  exists(): Promise<boolean>;
  /** Create when absent, update the exact item when present. */
  store(secret: string): Promise<void>;
  /** Retrieve the secret. Sole consumer: the credential adapter caller. */
  read(): Promise<string>;
  /**
   * B1.1-INTEGRATION: one user-triggered read that allows the native macOS
   * authorization prompt. The caller must discard the returned value.
   */
  requestAuthorization(): Promise<string>;
  /** Delete the exact item. */
  remove(): Promise<void>;
}

export function createKeychainCredentialStore(options: {
  readonly runner: KeychainHelperRunner;
  readonly scope: KeychainScope;
}): KeychainCredentialStore {
  const account = keychainAccountFor(options.scope);
  const runner = options.runner;

/**
 * B1.1-INTEGRATION: translate a closed helper error reason into the closed
 * refusal vocabulary. `authorization_required`/-25293-class and
 * `user_canceled`/-128-class carry their own codes so an authorization
 * outcome is never misreported as a missing item or generic unavailability.
 * Every other reason (and an absent token) fails closed to unavailability.
 */
function authorizationRefusal(reason: HelperErrorReason | undefined): TunnelRefusal {
  if (reason === "authorization_required") return new TunnelRefusal("CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED");
  if (reason === "user_canceled") return new TunnelRefusal("CE_TUNNEL_KEYCHAIN_USER_CANCELED");
  return unavailable();
}

const call = async (op: KeychainOperation, secret?: string, interactive?: boolean): Promise<HelperResponse> => {
    let raw: string;
    try {
      // Exactly one invocation per operation: an ambiguous failure (timeout,
      // cancellation) is NEVER retried here.
      raw = await runner.run(
        { op, service: TUNNEL_KEYCHAIN_SERVICE, account, ...(interactive === true ? { interactive: true } : {}) },
        secret,
      );
    } catch (error) {
      throw error instanceof TunnelRefusal ? error : unavailable();
    }
    return parseResponse(raw);
  };

  const exists = async (): Promise<boolean> => {
    const response = await call("exists");
    if (response.status === "error") throw unavailable();
    return response.status === "ok";
  };

  return Object.freeze({
    account,
    exists,
    async store(secret: string): Promise<void> {
      if (typeof secret !== "string" || !SECRET_PATTERN.test(secret)) throw invalid("credential.secret");
      const present = await exists();
      const response = await call(present ? "update" : "create", secret);
      if (response.status !== "ok") throw unavailable();
    },
    async read(): Promise<string> {
      const response = await call("read");
      if (response.status === "not_found") throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING");
      if (response.status === "error") throw authorizationRefusal(response.reason);
      if (response.secret === undefined) throw unavailable();
      return response.secret;
    },
    /**
     * B1.1-INTEGRATION: the ONE user-triggered native authorization path.
     * Semantically a read whose helper run allows the macOS authorization
     * prompt; the returned value exists only because authorization is obtained
     * BY reading — the caller must discard it and never display or persist it.
     * Never retried, never automatic: an ordinary `read()` stays the
     * noninteractive path and reports CE_TUNNEL_KEYCHAIN_AUTH_REQUIRED when
     * this code identity has no user decision yet.
     */
    async requestAuthorization(): Promise<string> {
      const response = await call("read", undefined, true);
      if (response.status === "not_found") throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING");
      if (response.status === "error") throw authorizationRefusal(response.reason);
      if (response.secret === undefined) throw unavailable();
      return response.secret;
    },
    async remove(): Promise<void> {
      const response = await call("delete");
      if (response.status === "not_found") throw new TunnelRefusal("CE_TUNNEL_KEY_MISSING");
      if (response.status !== "ok") throw unavailable();
    },
  });
}

// ---------------------------------------------------------------------------
// Native helper transport.
// ---------------------------------------------------------------------------

export interface HelperSpawnOptions {
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  /**
   * B1.1-INTEGRATION rework (Lane C C1): cancellation for a possibly
   * user-paced helper run. On abort the child is SIGKILLed and the run
   * settles as an unavailability; nothing is retried.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface HelperSpawnResult {
  readonly stdout: string;
  readonly code: number | null;
  readonly timedOut: boolean;
}

export type HelperSpawnSeam = (executable: string, options: HelperSpawnOptions) => Promise<HelperSpawnResult>;
export type HelperCompileSeam = () => Promise<{ executable: string; dispose(): Promise<void> }>;

export interface NativeKeychainRunner extends KeychainHelperRunner {
  dispose(): Promise<void>;
}

type CompiledHelper = { executable: string; dispose(): Promise<void> };

/**
 * Explicit probe-keychain policy. The helper targets exactly ONE keychain. By
 * default that is the production default keychain, resolved inside the helper.
 *
 * A caller may instead name a single keychain file, which the helper opens with
 * `SecKeychainOpen`. This exists solely for the authorized probe against an
 * exclusively owned temporary keychain, so that the probe never has to mutate
 * the default keychain or any search list. The path is accepted ONLY as an
 * explicit construction option of this runner: it is never read from the
 * environment, from a CE command, from a profile, or from a `KeychainRequest`.
 */
const MAX_KEYCHAIN_PATH_BYTES = 1_024;

function validateKeychainPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    !path.startsWith("/") ||
    path.includes("\u0000") ||
    path.includes("\n") ||
    path.includes("\r") ||
    path.includes(" ") ||
    Buffer.byteLength(path, "utf8") > MAX_KEYCHAIN_PATH_BYTES
  ) {
    throw unavailable();
  }
  return path;
}

const DEFAULT_HELPER_TIMEOUT_MS = 20_000;
/**
 * B1.1-INTEGRATION: the native macOS authorization prompt is USER-paced; a
 * 20s bound would kill the helper while the operator is still reading the
 * dialog and misreport the outcome as unavailability. Only the interactive
 * read gets this budget; every unattended operation keeps the tight bound.
 */
const INTERACTIVE_HELPER_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_STDOUT_BYTES = 65_536;
const DEFAULT_SWIFTC = "/usr/bin/swiftc";

/** Minimal child environment: no credential, no loader injection, no inherit. */
function helperEnvironment(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin" };
}

function helperSourcePath(): string {
  return fileURLToPath(new URL("../../native/tunnel-keychain.swift", import.meta.url));
}

/**
 * Default compile: absolute compiler, owner-only fresh directory, no cache.
 * Round 3 (Lane C R2-C3): the runner's cancellation signal is passed into
 * the compiler run, so an abort during compilation kills swiftc instead of
 * letting it finish and hand the task a stale executable.
 */
function defaultCompile(swiftcPath: string, spawnSeam: HelperSpawnSeam, signal?: AbortSignal): HelperCompileSeam {
  return async () => {
    // mkdtemp creates with mode 0700 and a non-predictable name; the binary is
    // never written to a shared or predictable location.
    const directory = await mkdtemp(join(tmpdir(), "ce-tunnel-keychain-"));
    const executable = join(directory, "tunnel-keychain");
    try {
      if (signal?.aborted) throw unavailable();
      const result = await spawnSeam(swiftcPath, {
        // Compiler arguments and source carry no secret whatsoever.
        args: ["-O", "-framework", "Security", "-framework", "Foundation", "-o", executable, helperSourcePath()],
        env: helperEnvironment(),
        stdin: "",
        timeoutMs: 120_000,
        maxStdoutBytes: DEFAULT_MAX_STDOUT_BYTES,
        signal,
      });
      if (signal?.aborted || result.timedOut || result.code !== 0) throw unavailable();
      return {
        executable,
        dispose: async () => {
          await rm(directory, { recursive: true, force: true });
        },
      };
    } catch {
      // Includes thrown transport errors and partial output after cancellation.
      await rm(directory, { recursive: true, force: true });
      throw unavailable();
    }
  };
}

/** Bounded pipe transport. stderr is read and discarded, never forwarded. */
const defaultSpawnHelper: HelperSpawnSeam = (executable, options) =>
  new Promise<HelperSpawnResult>((resolve) => {
    // Round 3 (Lane C R2-C3): refuse BEFORE the child exists. Spawning first
    // and killing after violates "already-aborted never spawns": the
    // aborted request resolves as an unavailability without creating any
    // process, stdin write, or kill event.
    if (options.signal?.aborted) {
      resolve({ stdout: "", code: null, timedOut: false });
      return;
    }
    const child = spawn(executable, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...options.env },
    });
    let stdout = "";
    let overflow = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout: "", code: null, timedOut: true });
    }, options.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ stdout: "", code: null, timedOut: false });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > options.maxStdoutBytes) {
        overflow = true;
        stdout = stdout.slice(0, options.maxStdoutBytes + 1);
      }
    });
    // Drained but never captured or forwarded: stderr may echo credentials.
    child.stderr?.resume();
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, code, timedOut: false });
    };
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.stdin);
  });

/**
 * Build the native helper runner. Compilation happens lazily, at most once per
 * runner, and the owned executable/directory is removed by `dispose()`.
 */
export function createNativeKeychainRunner(options: {
  readonly compile?: HelperCompileSeam;
  readonly spawnHelper?: HelperSpawnSeam;
  readonly swiftcPath?: string;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
  /**
   * Test/probe only: target this ONE keychain file instead of the default
   * keychain. Production callers leave it unset. Never sourced from env, a CE
   * command, a profile, or a request.
   */
  readonly probeKeychainPath?: string;
  /**
   * B1.1-INTEGRATION rework (Lane C C1): abort every helper run of this
   * runner. Used by the extension so a session teardown can end a
   * user-paced authorization instead of orphaning it.
   *
   * Round 3 (Lane C R2-C3): the signal is honored across the WHOLE run —
   * the default compile passes it to swiftc (an abort kills the compiler
   * and cleans the partial directory), a run re-checks it after the compile
   * await, and the default spawn transport refuses an already-aborted
   * request BEFORE creating the child.
   */
  readonly signal?: AbortSignal | undefined;
} = {}): NativeKeychainRunner {
  const spawnHelper = options.spawnHelper ?? defaultSpawnHelper;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const probeKeychainPath = options.probeKeychainPath;
  // Round 3 (Lane C R2-C3): validated BEFORE the default compile closure so
  // the same signal object is handed to swiftc and every helper spawn.
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw unavailable();
  const compile = options.compile ?? defaultCompile(options.swiftcPath ?? DEFAULT_SWIFTC, spawnHelper, signal);
  let compiled: CompiledHelper | undefined;
  let compiling: Promise<CompiledHelper> | undefined;
  let disposed = false;
  /** Artifacts already released, so no temporary directory is disposed twice. */
  const released = new WeakSet<object>();

  const release = async (artifact: CompiledHelper): Promise<void> => {
    if (released.has(artifact)) return;
    released.add(artifact);
    try {
      await artifact.dispose();
    } catch {
      // Best effort: a cleanup failure must not surface helper internals.
    }
  };

  /**
   * Compilation is serialized: concurrent operations share ONE compile, so no
   * second temporary directory is ever created behind the first. A failed
   * compile is not memoized (a later call may retry), but it is never retried
   * inside a single operation.
   */
  const compileOnce = (): Promise<CompiledHelper> => {
    if (compiling === undefined) {
      const attempt = (async () => {
        try {
          return await compile();
        } catch (error) {
          // Compiler diagnostics can be arbitrary text; only a closed code escapes.
          throw error instanceof TunnelRefusal ? error : unavailable();
        }
      })();
      compiling = attempt;
      void attempt.catch(() => {
        if (compiling === attempt) compiling = undefined;
      });
    }
    return compiling;
  };

  const ensureCompiled = async (): Promise<string> => {
    if (disposed) throw unavailable();
    if (compiled !== undefined) return compiled.executable;
    const artifact = await compileOnce();
    if (disposed || signal?.aborted) {
      // A compile seam may settle after cancellation; release its late artifact.
      await release(artifact);
      throw unavailable();
    }
    if (compiled === undefined) compiled = artifact;
    else if (compiled !== artifact) await release(artifact);
    return compiled.executable;
  };

  return {
    async run(request: KeychainRequest, secret?: string): Promise<string> {
      if (disposed || signal?.aborted) throw unavailable();
      if (!(KEYCHAIN_OPERATIONS as readonly string[]).includes(request?.op)) throw unavailable();
      if (request.service !== TUNNEL_KEYCHAIN_SERVICE) throw unavailable();
      const account = request.account;
      if (typeof account !== "string" || !ACCOUNT_PATTERN.test(account)) {
        throw unavailable();
      }
      if (secret !== undefined && !SECRET_PATTERN.test(secret)) throw unavailable();
      const needsSecret = request.op === "create" || request.op === "update";
      if (needsSecret !== (secret !== undefined)) throw unavailable();
      // B1.1-INTEGRATION: the native-authorization flag is legal ONLY on a
      // read, and only as the exact boolean `true`. Refused before any spawn.
      const interactive = (request as { interactive?: unknown }).interactive;
      if (interactive !== undefined && typeof interactive !== "boolean") throw unavailable();
      if (interactive === true && request.op !== "read") throw unavailable();
      const allowInteraction = interactive === true;

      const accountBytes = Buffer.byteLength(account, "utf8");
      const secretBytes = secret === undefined ? 0 : Buffer.byteLength(secret, "utf8");
      // The keychain target comes ONLY from this runner's construction option.
      // Any `keychainPath` on the request is structurally ignored here.
      const keychain = probeKeychainPath === undefined ? undefined : validateKeychainPath(probeKeychainPath);
      const keychainBytes = keychain === undefined ? 0 : Buffer.byteLength(keychain, "utf8");
      // Framed stdin is the ONLY channel that ever carries the secret. The
      // optional probe-keychain length and the B1.1-INTEGRATION authorization
      // flag are the only extra header fields; the flag is always LAST.
      const header = keychain === undefined
        ? `v1 ${request.op} ${accountBytes} ${secretBytes}${allowInteraction ? " interactive" : ""}`
        : `v1 ${request.op} ${accountBytes} ${secretBytes} ${keychainBytes}${allowInteraction ? " interactive" : ""}`;
      const stdin = `${header}\n${account}${secret ?? ""}${keychain ?? ""}`;

      const executable = await ensureCompiled();
      // Round 3 (Lane C R2-C3): re-check cancellation AFTER the compile await.
      // A run that started before the abort but returns from ensureCompiled
      // afterwards must still refuse here — before any helper spawn or stdin
      // write — instead of launching and killing the child.
      if (disposed || signal?.aborted) throw unavailable();
      const result = await spawnHelper(executable, {
        args: [],
        env: helperEnvironment(),
        stdin,
        timeoutMs: allowInteraction ? Math.max(timeoutMs, INTERACTIVE_HELPER_TIMEOUT_MS) : timeoutMs,
        maxStdoutBytes,
        signal,
      });
      if (result.timedOut || result.code !== 0) throw unavailable();
      if (typeof result.stdout !== "string" || result.stdout.length > maxStdoutBytes) throw unavailable();
      return result.stdout;
    },
    async dispose(): Promise<void> {
      disposed = true;
      const owned = compiled;
      const inFlight = compiling;
      compiled = undefined;
      compiling = undefined;
      if (owned !== undefined) await release(owned);
      if (inFlight !== undefined) {
        // An in-flight compile is awaited, not abandoned: its temporary
        // directory would otherwise outlive this runner.
        const artifact = await inFlight.catch(() => undefined);
        if (artifact !== undefined) await release(artifact);
      }
    },
  };
}
