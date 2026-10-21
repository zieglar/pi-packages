/**
 * Pure, transport-only ordered state machine. No spawn/restart, CE authority,
 * delivery, ACK, or completion semantics. Connected requires one fresh,
 * same-run health COMPLETION, not a cached parse result or observation tick.
 */
import type { HealthProbe } from "./health.js";

export type TunnelStateName = "Stopped" | "Starting" | "Connecting" | "Connected" | "Disconnected" | "Stopping" | "Unknown" | "Error";

interface TunnelRun {
  readonly id: string;
  readonly managedPid: number;
  readonly startedAt: number | undefined;
  readonly sequence: number;
  readonly completedAt: number | undefined;
  /** Exit and startup timeout fence this run until an explicit newer run. */
  readonly terminal: boolean;
}

export interface TunnelState {
  readonly name: TunnelStateName;
  readonly since: number;
  readonly consecutiveFailures: number;
  readonly consecutiveHealthy: number;
  readonly lastHealthyAt: number | undefined;
  /** Persists across Unknown; only M distinct completions clear recovery. */
  readonly recovering: boolean;
  readonly run?: TunnelRun;
  readonly observedAt?: number;
}

export interface TunnelObservation {
  readonly now: number;
  /** Fresh identity allocated by explicit start/restart, never by a tick. */
  readonly runId: string | undefined;
  readonly managedPid: number | undefined;
  readonly processAlive: boolean;
  readonly userStopped: boolean;
  readonly startedAt: number | undefined;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | undefined;
  readonly probe: HealthProbe | undefined;
  readonly startupLogSeen: boolean;
  readonly externalInstance: boolean;
}

export interface TunnelTiming {
  readonly startupTimeoutMs: number;
  readonly pollIntervalMs: number;
  readonly freshnessMs: number;
  readonly failThresholdN: number;
  readonly recoverThresholdM: number;
  readonly stopGraceMs: number;
}
export const DEFAULT_TUNNEL_TIMING: TunnelTiming = Object.freeze({
  startupTimeoutMs: 30_000, pollIntervalMs: 5_000, freshnessMs: 15_000,
  failThresholdN: 3, recoverThresholdM: 2, stopGraceMs: 10_000,
});
export function initialTunnelState(now: number): TunnelState {
  return Object.freeze({ name: "Stopped", since: now, consecutiveFailures: 0, consecutiveHealthy: 0, lastHealthyAt: undefined, recovering: false });
}

/** now < startedAt + timeout is the ONLY startup window; equality is timeout. */
export function nextTunnelState(previous: TunnelState, observation: TunnelObservation, timing: TunnelTiming = DEFAULT_TUNNEL_TIMING): TunnelState {
  const { now, managedPid, runId, startedAt, probe } = observation;
  let base = previous;
  let run = previous.run;
  const finish = (name: TunnelStateName, patch: Partial<TunnelState> = {}): TunnelState => Object.freeze({
    ...base, ...patch, name, since: previous.name === name ? previous.since : now,
    ...(run === undefined ? {} : { run: Object.freeze(run) }),
    observedAt: Number.isFinite(now) ? Math.max(previous.observedAt ?? now, now) : previous.observedAt ?? previous.since,
  });
  const clear = { consecutiveFailures: 0, consecutiveHealthy: 0, lastHealthyAt: undefined, recovering: false };

  // A retained PID does not make an old/misattributed absence current either.
  if (!observation.processAlive && run !== undefined &&
    (runId !== run.id || startedAt !== run.startedAt ||
      (managedPid !== undefined && managedPid !== run.managedPid) ||
      !Number.isFinite(now) || (previous.observedAt !== undefined && now < previous.observedAt))) return previous;
  // Absence has no PID to cross-check. It may fence an existing run only
  // when the run identity/start and observation order still match. Delayed
  // or unattributed absence is not evidence about the current process.
  if (managedPid === undefined && !observation.processAlive) {
    if (!Number.isFinite(now) || (previous.observedAt !== undefined && now < previous.observedAt)) return previous;
    if (run !== undefined) {
      if (runId !== run.id || startedAt !== run.startedAt || run.terminal) return previous;
      run = { ...run, terminal: true };
    }
    return finish("Stopped", clear);
  }
  if (!Number.isFinite(now) || (previous.observedAt !== undefined && now < previous.observedAt)) {
    return finish(run?.terminal ? previous.name : "Unknown", { consecutiveHealthy: 0 });
  }
  const identityValid = typeof runId === "string" && runId.length > 0 && Number.isSafeInteger(managedPid) && managedPid! > 0;
  if (!identityValid) return finish(run?.terminal ? previous.name : "Error", { consecutiveHealthy: 0 });

  // Explicit new-run attribution must advance the start clock; delayed old-run
  // observations (even exits) cannot replace the currently supervised run.
  if (run !== undefined && run.id !== runId) {
    if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt <= (run.startedAt ?? -Infinity) || startedAt > now) {
      return finish(run.terminal ? previous.name : "Unknown", { consecutiveHealthy: 0 });
    }
    base = initialTunnelState(now);
    run = undefined;
  }
  if (run === undefined) {
    run = { id: runId!, managedPid: managedPid!, startedAt, sequence: 0, completedAt: undefined, terminal: false };
  } else if (run.managedPid !== managedPid || (startedAt !== undefined && run.startedAt !== startedAt)) {
    return finish(run.terminal ? previous.name : "Unknown", { consecutiveHealthy: 0 });
  }
  if (run.terminal) return finish(previous.name);

  // Exit wins over all health evidence, including a contradictory alive flag.
  if (!observation.processAlive || observation.exit !== undefined) {
    const exit = observation.exit;
    const expected = observation.userStopped && (exit === undefined || exit.signal === "SIGTERM" || exit.signal === "SIGINT" || exit.code === 0);
    run = { ...run, terminal: true };
    return finish(expected ? "Stopped" : "Error", clear);
  }
  if (observation.userStopped) return finish("Stopping", { consecutiveHealthy: 0 });
  if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt > now) {
    run = { ...run, terminal: true };
    return finish("Error", { consecutiveHealthy: 0 });
  }
  // Evaluate startup against PREVIOUS evidence; late first health cannot erase
  // the deadline. An established run instead expires by completion freshness.
  const startup = base.lastHealthyAt === undefined && !base.recovering;
  if (startup && now >= startedAt + timing.startupTimeoutMs) {
    run = { ...run, terminal: true };
    return finish("Error", { consecutiveHealthy: 0, consecutiveFailures: Math.max(base.consecutiveFailures, 1) });
  }

  const completion = probe?.completion;
  const attributed = completion !== undefined && completion.runId === run.id && completion.managedPid === run.managedPid &&
    Number.isSafeInteger(completion.sequence) && completion.sequence > 0 && Number.isFinite(completion.completedAt) &&
    completion.completedAt >= startedAt && completion.completedAt <= now && now - completion.completedAt <= timing.freshnessMs;
  const distinct = attributed && completion.sequence > run.sequence && (run.completedAt === undefined || completion.completedAt >= run.completedAt);
  // Replaying the last accepted healthy completion may KEEP an already fresh
  // Connected, but can never create one, refresh a timestamp, or advance M.
  const duplicate = attributed && completion.sequence === run.sequence && completion.completedAt === run.completedAt;
  if (!distinct || probe === undefined) {
    const fresh = base.lastHealthyAt !== undefined && now - base.lastHealthyAt <= timing.freshnessMs;
    const keepConnected = base.name === "Connected" && fresh && (probe === undefined || (duplicate && probe.kind === "healthy" && probe.connectedEligible));
    const name = keepConnected ? "Connected" : startup ? "Starting" : base.recovering && fresh ? "Disconnected" : "Unknown";
    return finish(name, { consecutiveHealthy: duplicate ? base.consecutiveHealthy : 0 });
  }

  run = { ...run, sequence: completion.sequence, completedAt: completion.completedAt };
  const healthyNow = probe.kind === "healthy" && probe.connectedEligible === true;
  const failures = healthyNow ? 0 : base.consecutiveFailures + 1;
  const healthy = healthyNow ? base.consecutiveHealthy + 1 : 0;
  const counters = { consecutiveFailures: failures, consecutiveHealthy: healthy, lastHealthyAt: healthyNow ? completion.completedAt : base.lastHealthyAt };
  if (healthyNow) {
    if (base.recovering && healthy < timing.recoverThresholdM) return finish("Disconnected", counters);
    return finish("Connected", { ...counters, recovering: false });
  }
  if (startup) return finish(probe.kind === "unhealthy" ? "Connecting" : "Starting", counters);
  if (probe.kind === "unverifiable") return finish("Unknown", counters);
  if (failures >= timing.failThresholdN || base.recovering) return finish("Disconnected", { ...counters, recovering: true });
  return finish("Connecting", counters);
}

/** Human-facing transport label. Never implies delivery, ACK, or completion. */
export function tunnelStatusLabel(state: TunnelState): string {
  switch (state.name) {
    case "Connected": return "Tunnel ● transport up";
    case "Connecting": return "Tunnel ◐ connecting";
    case "Starting": return "Tunnel ◐ starting";
    case "Disconnected": return "Tunnel ○ transport down";
    case "Stopping": return "Tunnel ◌ stopping";
    case "Unknown": return "Tunnel ? unverified";
    case "Error": return "Tunnel ✗ error";
    case "Stopped": default: return "Tunnel ○ stopped";
  }
}
