/**
 * HANDOFF-CE-HOST-09 B1.1 Task 3 — owned OFFLINE lifecycle manager.
 *
 * What this manager can start: exactly one process, the bundled offline
 * simulator `offline-client.js`, launched with the approved Node executable and
 * a fixed argv the manager builds itself. It accepts no executable, argv, PID,
 * or profile-supplied command from a command, the model, or the environment.
 *
 * What it can NEVER start: the real tunnel client. There is no code path that
 * reads a credential, materialises a plaintext temp file, or hands a secret to
 * a child — R11 and real start stay hard BLOCKED regardless of
 * `resolveCredentialPlan`, `allowPlaintextTempFile`, or an existing key file.
 * Even the offline simulator requires the explicit opt-in
 * `CE_TUNNEL_OFFLINE_TEST === "1"` (exact string), and the refusal is raised
 * BEFORE any credential interaction.
 *
 * Ownership: the retained `ChildProcess` handle plus a monotonic generation.
 * Stop/kill act only on that handle; no PID is ever adopted from disk, a lock
 * file, or an external process list, and no foreign process is signalled.
 *
 * Evidence: health comes only from the simulator's correlated stdout records
 * (current run id AND current PID), is stamped once at actual completion by the
 * shared recorder, and is evaluated by the shared pure state machine. Raw child
 * output is never parsed loosely, forwarded, logged, or surfaced. There is NO
 * auto-respawn and no business retry: an unexpected exit — including exit 0 —
 * is an Error that requires an explicit operator start.
 *
 * Every status this manager produces is explicitly offline/simulated and is
 * never evidence of delivery, ACK, reconciliation, or completion.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TunnelRefusal } from "./codes.js";
import { createHealthCompletionRecorder, type HealthProbe } from "./health.js";
import {
  DEFAULT_TUNNEL_TIMING,
  initialTunnelState,
  nextTunnelState,
  tunnelStatusLabel,
  type TunnelState,
  type TunnelStateName,
  type TunnelTiming,
} from "./state.js";

/** Narrow structural view of the child handle this manager retains. */
export interface ManagedChildView {
  /** Optional like `ChildProcess.pid`; a missing pid fails the start closed. */
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** Optional second exit proof; `close` is accepted idempotently with `exit`. */
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  readonly stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  readonly stderr?: { resume?(): void; on?(event: string, listener: (chunk: Buffer) => void): void } | null;
}

export type ManagedSpawnSeam = (
  executable: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: readonly ("ignore" | "pipe")[] },
) => ManagedChildView;

export interface TunnelManagerOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly spawn?: ManagedSpawnSeam;
  readonly nodeExecPath?: string;
  readonly clientScript?: string;
  readonly timing?: TunnelTiming;
  /** Opt-in request for explicitly simulated client-activity records. */
  readonly simulateActivity?: boolean;
}

export interface TunnelClientActivity {
  /** True only for an ACTUAL attributed record from the current run. */
  readonly observed: boolean;
  /** Always true in B1.1: there is no real client to observe. */
  readonly simulated: true;
  readonly at: number | undefined;
}

export interface TunnelManagerStatus {
  /** Fixed: this manager has no real-transport mode at all. */
  readonly mode: "offline-simulated";
  readonly state: TunnelStateName;
  readonly label: string;
  readonly evidence: "health-probe" | "process-absent" | "none";
  readonly running: boolean;
  readonly runId: string | undefined;
  readonly clientActivity: TunnelClientActivity;
}

export interface TunnelStopOptions {
  readonly graceMs?: number;
  /** Legacy option retained for callers; no escalation or second signal. */
  readonly killTimeoutMs?: number;
}

export interface TunnelManager {
  start(): Promise<{ readonly runId: string }>;
  stop(options?: TunnelStopOptions): Promise<void>;
  status(): TunnelManagerStatus;
  dispose(): Promise<void>;
  runId(): string | undefined;
}

/** Exact opt-in. Anything else (including "true"/"0"/" 1") stays blocked. */
const OFFLINE_OPT_IN = "CE_TUNNEL_OFFLINE_TEST";
const MAX_LINE_CHARS = 8_192;
const MAX_BUFFER_CHARS = 32_768;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultClientScript(): string {
  return fileURLToPath(new URL("./offline-client.js", import.meta.url));
}

/**
 * Minimal child environment. Built from scratch, never inherited: the only
 * variables present are the ones the simulator itself needs. No `*_KEY`,
 * `*_TOKEN`, or loader-injection variable can reach the child because nothing
 * is copied from the caller's environment.
 */
function simulatorEnvironment(): NodeJS.ProcessEnv {
  return { [OFFLINE_OPT_IN]: "1", PATH: "/usr/bin:/bin" };
}

interface Run {
  readonly id: string;
  readonly generation: number;
  readonly child: ManagedChildView;
  readonly pid: number;
  readonly startedAt: number;
  readonly record: (input: { stdout: string; exitCode: number }) => HealthProbe;
  stdoutBuffer: string;
  lastProbe: HealthProbe | undefined;
  lastProbeAt: number | undefined;
  /** Highest simulator-assigned health sequence actually consumed. */
  lastSequence: number;
  activityAt: number | undefined;
  userStopped: boolean;
  /** At most one termination request per owned run, including failed delivery. */
  termRequested: boolean;
  /**
   * A ChildProcess `error` was observed. This is NOT exit proof: the same event
   * fires when signal delivery fails while the process stays alive, so the pid
   * stays owned and an actual exit/close is still required.
   */
  errored: boolean;
  exited: boolean;
  exit: { code: number | null; signal: string | null } | undefined;
}

export function createTunnelManager(options: TunnelManagerOptions): TunnelManager {
  const env = options.env ?? {};
  const now = options.now ?? Date.now;
  const spawnSeam: ManagedSpawnSeam = options.spawn ?? ((executable, args, spawnOptions) =>
    nodeSpawn(executable, [...args], {
      env: { ...spawnOptions.env },
      stdio: ["ignore", "pipe", "pipe"],
    }));
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const clientScript = options.clientScript ?? defaultClientScript();
  const timing = options.timing ?? DEFAULT_TUNNEL_TIMING;

  let state: TunnelState = initialTunnelState(now());
  let run: Run | undefined;
  let generation = 0;
  let starting: Promise<{ runId: string }> | undefined;
  let stopping: Promise<void> | undefined;
  let disposed = false;
  let exitWaiters: (() => void)[] = [];

  /** Pure projection; reads must never commit counters or run evidence. */
  const project = (probe: HealthProbe | undefined): TunnelState => {
    const at = now();
    if (run === undefined) {
      return nextTunnelState(state, {
        now: at,
        runId: undefined,
        managedPid: undefined,
        processAlive: false,
        userStopped: true,
        startedAt: undefined,
        exit: undefined,
        probe: undefined,
        startupLogSeen: false,
        externalInstance: false,
      }, timing);
    }
    return nextTunnelState(state, {
      now: at,
      runId: run.id,
      managedPid: run.pid,
      processAlive: !run.exited,
      userStopped: run.userStopped,
      startedAt: run.startedAt,
      exit: run.exit,
      probe,
      startupLogSeen: false,
      externalInstance: false,
    }, timing);
  };

  /** Only lifecycle events and distinct completions commit observations. */
  const observe = (probe: HealthProbe | undefined): void => { state = project(probe); };

  /**
   * Consume one correlated simulator record. Anything that is not an exact,
   * current-run, current-PID record of a known event type is discarded without
   * being surfaced anywhere.
   */
  const consumeLine = (current: Run, line: string): void => {
    if (line.length === 0 || line.length > MAX_LINE_CHARS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.runId !== current.id || parsed.pid !== current.pid) return;
    // Every consumed record must be EXPLICITLY labelled simulated, and must
    // belong to the live owned run: a record that arrives after the owned child
    // exited, or for a superseded generation, is stale and mutates nothing.
    if (parsed.simulated !== true) return;
    if (run !== current || current.exited) return;
    if (parsed.event === "activity") {
      if (parsed.kind !== "simulated-request") return;
      current.activityAt = now();
      return;
    }
    if (parsed.event !== "health" || !isRecord(parsed.payload)) return;
    // The simulator assigns an explicit, strictly increasing sequence per run
    // (offline-client.ts protocol). It is validated BEFORE any completion is
    // stamped, so a duplicate, replayed, missing, or non-integer sequence can
    // never mint a fresh completion timestamp and refresh an expired state.
    const sequence = parsed.sequence;
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) return;
    if (sequence <= current.lastSequence) return;
    current.lastSequence = sequence;
    // Stamped ONCE here, at actual completion of this accepted record.
    const probe = current.record({ stdout: JSON.stringify(parsed.payload), exitCode: 0 });
    current.lastProbe = probe;
    current.lastProbeAt = now();
    observe(probe);
  };

  const attach = (current: Run): void => {
    current.child.stdout?.on("data", (chunk: Buffer) => {
      if (run !== current) return; // stale child: discard without parsing
      current.stdoutBuffer += chunk.toString("utf8");
      if (current.stdoutBuffer.length > MAX_BUFFER_CHARS) {
        // Bounded: drop the oversized backlog rather than growing or echoing it.
        current.stdoutBuffer = "";
        return;
      }
      let index = current.stdoutBuffer.indexOf("\n");
      while (index !== -1) {
        const line = current.stdoutBuffer.slice(0, index);
        current.stdoutBuffer = current.stdoutBuffer.slice(index + 1);
        consumeLine(current, line);
        index = current.stdoutBuffer.indexOf("\n");
      }
    });
    // Child stderr is drained and never captured: it can echo credentials.
    current.child.stderr?.resume?.();
    // `exit` and `close` are both ACTUAL exit proofs and are folded into one
    // idempotent settlement, so a handle that emits both does not double-fence.
    const settleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (current.exited) return;
      current.exited = true;
      current.exit = { code, signal: signal ?? null };
      if (run !== current) return; // a previous run cannot fence the live one
      observe(undefined);
      const waiters = exitWaiters;
      exitWaiters = [];
      for (const waiter of waiters) waiter();
    };
    current.child.on("exit", settleExit);
    try {
      current.child.on("close", settleExit);
    } catch {
      // A handle without `close` is fine: `exit` remains the required proof.
    }
  };

  const waitForExit = (current: Run, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (current.exited) {
        resolve(true);
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(current.exited);
      }, Math.max(0, timeoutMs));
      timer.unref?.();
      exitWaiters.push(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      });
    });

  const start = async (): Promise<{ runId: string }> => {
    if (starting !== undefined) return starting;
    if (run !== undefined && !run.exited) return { runId: run.id };
    if (disposed) throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
    // The gate is evaluated FIRST: no credential interaction precedes it, and
    // no other configuration can satisfy it.
    if (env[OFFLINE_OPT_IN] !== "1") throw new TunnelRefusal("CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED");

    const attempt = (async () => {
      const id = `offline-${randomUUID()}`;
      const startedAt = now();
      const args = [
        clientScript,
        "--run-id",
        id,
        ...(options.simulateActivity === true ? ["--simulate-activity"] : []),
      ];
      let child: ManagedChildView;
      try {
        child = spawnSeam(nodeExecPath, args, { env: simulatorEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }
      // Attach before PID validation or any other failure path. Keep this
      // listener for the handle's lifetime, including no-PID failures and late
      // duplicate errors: removing it on rejection/close opens a crash window.
      let acquired: Run | undefined;
      let errored = false;
      child.on("error", () => {
        errored = true;
        // Error is NOT exit proof (signal delivery can fail on a live child).
        if (acquired !== undefined) acquired.errored = true;
      });
      const pid = child.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        // A missing/invalid PID is not an owned run; never signal or adopt it.
        throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      }
      generation += 1;
      const current: Run = {
        id,
        generation,
        child,
        pid,
        startedAt,
        record: createHealthCompletionRecorder(id, pid, now),
        stdoutBuffer: "",
        lastProbe: undefined,
        lastProbeAt: undefined,
        lastSequence: 0,
        activityAt: undefined,
        userStopped: false,
        termRequested: false,
        errored,
        exited: false,
        exit: undefined,
      };
      acquired = current;
      run = current;
      state = initialTunnelState(startedAt);
      attach(current);
      observe(undefined);
      if (current.errored) throw new TunnelRefusal("CE_TUNNEL_SPAWN_FAILED");
      return { runId: id };
    })();
    starting = attempt;
    try {
      return await attempt;
    } finally {
      starting = undefined;
    }
  };

  const stop = async (stopOptions: TunnelStopOptions = {}): Promise<void> => {
    if (stopping !== undefined) return stopping;
    const current = run;
    if (current === undefined || current.exited) return;
    const graceMs = stopOptions.graceMs ?? timing.stopGraceMs;
    const attempt = (async () => {
      current.userStopped = true;
      observe(undefined);
      if (!current.termRequested) {
        // Mark BEFORE delivery: a throw/error must not trigger blind re-signal.
        current.termRequested = true;
        try {
          current.child.kill("SIGTERM");
        } catch {
          // Delivery failure is not exit proof. Retain this exact handle.
        }
      }
      if (await waitForExit(current, graceMs)) return;
      // No exit proof: never claim a stop that was not observed.
      throw new TunnelRefusal("CE_TUNNEL_STOP_UNCONFIRMED");
    })();
    stopping = attempt;
    try {
      await attempt;
    } finally {
      stopping = undefined;
    }
  };

  const status = (): TunnelManagerStatus => {
    // Derive freshness without committing the projection: undefined probes in
    // the shared machine reset recovery counters, which a read must not do.
    const view = project(undefined);
    const current = run;
    // A signal/spawn error on a still-owned, not-yet-exited child is reported as
    // Error (never Connected, never Stopped): the exit is unconfirmed, so the
    // handle is still live and `stop()` must still be able to signal it.
    const unconfirmedError = current !== undefined && current.errored && !current.exited;
    const effective: TunnelState = unconfirmedError ? { ...view, name: "Error" } : view;
    const fresh = !unconfirmedError && current?.lastProbeAt !== undefined && now() - current.lastProbeAt <= timing.freshnessMs;
    const evidence = fresh ? "health-probe" : current !== undefined && current.exited ? "process-absent" : "none";
    const observedActivity = current?.activityAt !== undefined;
    return Object.freeze({
      mode: "offline-simulated" as const,
      state: effective.name,
      label: `${tunnelStatusLabel(effective)} (offline simulated)`,
      evidence,
      running: current !== undefined && !current.exited,
      runId: current?.id,
      clientActivity: Object.freeze({
        observed: observedActivity,
        simulated: true as const,
        at: current?.activityAt,
      }),
    });
  };

  return {
    start,
    stop,
    status,
    runId: () => run?.id,
    async dispose(): Promise<void> {
      disposed = true;
      // Failure MUST propagate so the extension retains this manager. A later
      // dispose/stop can still await the same child, but never signal it again.
      await stop();
      exitWaiters = [];
    },
  };
}
