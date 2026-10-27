/**
 * HANDOFF-CE-HOST-09 B1 — transport state machine (ordered decision table).
 *
 * Invariants pinned here:
 * - Connected requires CURRENT health evidence inside the freshness window;
 *   a PID/liveness fact or a startup log line can never produce Connected.
 * - Stale Connected evidence degrades to Unknown, never stays Connected.
 * - Expected SIGTERM exits are Stopped; unexpected exits (including exit 0)
 *   are Error.
 * - Disconnected recovers to Connected only after M consecutive healthy
 *   probes, which is NOT an automatic restart.
 * - Tunnel state is transport-only; it carries no delivery/ACK meaning.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_TUNNEL_TIMING, nextTunnelState, type TunnelObservation, type TunnelState } from "../../src/tunnel/state.js";

const T0 = 1_000_000;
const healthy = { kind: "healthy", connectedEligible: true, controlPlanePollObserved: true, exitCode: 0, uiExposureLoopbackOnly: false } as const;
const unhealthy = { kind: "unhealthy", connectedEligible: false, controlPlanePollObserved: false, exitCode: 0, uiExposureLoopbackOnly: false } as const;
const unreachable = { kind: "unreachable", connectedEligible: false, controlPlanePollObserved: false, exitCode: 2, uiExposureLoopbackOnly: false } as const;

let completionSequence = 0;
function observe(partial: Partial<TunnelObservation>): TunnelObservation {
  // These legacy cases describe independent completed probes, not replays.
  // Explicit replay coverage lives in b1-fix.test.ts and never uses this helper.
  const probe = partial.probe === undefined ? undefined : {
    ...partial.probe,
    completion: { runId: "legacy-run", managedPid: 4242, sequence: ++completionSequence, completedAt: partial.now ?? T0 },
  };
  return {
    now: T0,
    runId: "legacy-run",
    managedPid: 4242,
    processAlive: true,
    userStopped: false,
    startedAt: T0 - 1_000,
    exit: undefined,
    startupLogSeen: false,
    externalInstance: false,
    ...partial,
    probe,
  };
}

const initial: TunnelState = { name: "Stopped", since: T0, consecutiveFailures: 0, consecutiveHealthy: 0, lastHealthyAt: undefined, recovering: false };

describe("nextTunnelState — ordered decision table", () => {
  it("stays Stopped when no managed process exists", () => {
    const s = nextTunnelState(initial, observe({ managedPid: undefined, processAlive: false }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Stopped");
  });

  it("is Starting while alive and health is not yet reachable within the startup window", () => {
    const s = nextTunnelState(initial, observe({ probe: unreachable }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Starting");
  });

  it("NEVER reaches Connected on startup log + liveness alone (anti-sticky)", () => {
    const s = nextTunnelState(initial, observe({ startupLogSeen: true, probe: undefined }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).not.toBe("Connected");
    expect(["Starting", "Connecting"]).toContain(s.name);
  });

  it("is Connecting when health is reachable but not eligible", () => {
    const s = nextTunnelState(initial, observe({ probe: unhealthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Connecting");
  });

  it("reaches Connected only with current eligible health evidence", () => {
    const s = nextTunnelState(initial, observe({ probe: healthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Connected");
    expect(s.lastHealthyAt).toBe(T0);
  });

  it("degrades stale Connected evidence to Unknown, never keeps Connected", () => {
    const connected = nextTunnelState(initial, observe({ probe: healthy }), DEFAULT_TUNNEL_TIMING);
    const later = nextTunnelState(
      connected,
      observe({ now: T0 + DEFAULT_TUNNEL_TIMING.freshnessMs + 1, probe: undefined }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(later.name).toBe("Unknown");
  });

  it("enters Disconnected only after N consecutive failures following Connected", () => {
    let s = nextTunnelState(initial, observe({ probe: healthy }), DEFAULT_TUNNEL_TIMING);
    for (let i = 1; i <= DEFAULT_TUNNEL_TIMING.failThresholdN; i += 1) {
      s = nextTunnelState(s, observe({ now: T0 + i, probe: unreachable }), DEFAULT_TUNNEL_TIMING);
    }
    expect(s.name).toBe("Disconnected");
  });

  it("recovers Disconnected -> Connected after M consecutive healthy probes without restarting", () => {
    let s: TunnelState = { name: "Disconnected", since: T0, consecutiveFailures: 3, consecutiveHealthy: 0, lastHealthyAt: T0 - 50_000, recovering: true };
    for (let i = 1; i < DEFAULT_TUNNEL_TIMING.recoverThresholdM; i += 1) {
      s = nextTunnelState(s, observe({ now: T0 + i, probe: healthy }), DEFAULT_TUNNEL_TIMING);
      expect(s.name).toBe("Disconnected");
    }
    s = nextTunnelState(s, observe({ now: T0 + 10, probe: healthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Connected");
  });

  it("classifies an expected SIGTERM exit as Stopped, not Error", () => {
    const s = nextTunnelState(
      { name: "Connected", since: T0, consecutiveFailures: 0, consecutiveHealthy: 1, lastHealthyAt: T0, recovering: false },
      observe({ processAlive: false, userStopped: true, exit: { code: null, signal: "SIGTERM" } }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(s.name).toBe("Stopped");
  });

  it("classifies an UNEXPECTED exit 0 as Error (attributed process)", () => {
    const s = nextTunnelState(
      { name: "Connected", since: T0, consecutiveFailures: 0, consecutiveHealthy: 1, lastHealthyAt: T0, recovering: false },
      observe({ managedPid: 4242, processAlive: false, userStopped: false, exit: { code: 0, signal: null } }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(s.name).toBe("Error");
  });

  it("classifies a startup that never became healthy as Error after the startup timeout", () => {
    const s = nextTunnelState(
      initial,
      observe({ now: T0 + DEFAULT_TUNNEL_TIMING.startupTimeoutMs + 1, startedAt: T0, probe: unreachable }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(s.name).toBe("Error");
  });

  it("reports Unknown when the probe itself is unverifiable", () => {
    const s = nextTunnelState(
      { name: "Connected", since: T0, consecutiveFailures: 0, consecutiveHealthy: 1, lastHealthyAt: T0, recovering: false },
      observe({ now: T0 + 1, probe: { kind: "unverifiable", connectedEligible: false, controlPlanePollObserved: false, exitCode: 0, uiExposureLoopbackOnly: false } }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(s.name).toBe("Unknown");
  });

  it("surfaces Stopping while a user stop is in flight", () => {
    const s = nextTunnelState(
      { name: "Connected", since: T0, consecutiveFailures: 0, consecutiveHealthy: 1, lastHealthyAt: T0, recovering: false },
      observe({ userStopped: true, processAlive: true, probe: healthy }),
      DEFAULT_TUNNEL_TIMING,
    );
    expect(s.name).toBe("Stopping");
  });

  // --- r2 regression cases (Lane C findings 1–3, Lane D finding 2) ---

  it("resets the failure streak on a healthy probe (interleaved sequences never reach N)", () => {
    let s = nextTunnelState(initial, observe({ probe: healthy }), DEFAULT_TUNNEL_TIMING);
    // fail, healthy, fail, fail -> failure streak is 2 (< N=3), still Connecting.
    s = nextTunnelState(s, observe({ now: T0 + 1, probe: unreachable }), DEFAULT_TUNNEL_TIMING);
    s = nextTunnelState(s, observe({ now: T0 + 2, probe: healthy }), DEFAULT_TUNNEL_TIMING);
    s = nextTunnelState(s, observe({ now: T0 + 3, probe: unreachable }), DEFAULT_TUNNEL_TIMING);
    s = nextTunnelState(s, observe({ now: T0 + 4, probe: unreachable }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Connecting");
    expect(s.consecutiveFailures).toBe(2);
  });

  it("cannot bypass the M recovery gate via an Unknown detour", () => {
    let s: TunnelState = { name: "Disconnected", since: T0, consecutiveFailures: DEFAULT_TUNNEL_TIMING.failThresholdN, consecutiveHealthy: 0, lastHealthyAt: T0 - 50_000, recovering: true };
    const unverifiableProbe = { kind: "unverifiable", connectedEligible: false, controlPlanePollObserved: false, exitCode: 0, uiExposureLoopbackOnly: false } as const;
    // Unknown detour must not clear the latch...
    s = nextTunnelState(s, observe({ now: T0 + 1, probe: unverifiableProbe }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Unknown");
    expect(s.recovering).toBe(true);
    // ...so a single healthy probe afterwards is still insufficient (M=2).
    s = nextTunnelState(s, observe({ now: T0 + 2, probe: healthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Disconnected");
    // Reset the streak with an unhealthy probe, then two healthy in a row reach Connected.
    s = nextTunnelState(s, observe({ now: T0 + 3, probe: unhealthy }), DEFAULT_TUNNEL_TIMING);
    s = nextTunnelState(s, observe({ now: T0 + 4, probe: healthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Disconnected");
    s = nextTunnelState(s, observe({ now: T0 + 5, probe: healthy }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Connected");
    expect(s.recovering).toBe(false);
  });

  it("keeps a startup with ONLY unverifiable probes in Starting so the startup timeout stays reachable", () => {
    const unverifiableProbe = { kind: "unverifiable", connectedEligible: false, controlPlanePollObserved: false, exitCode: 0, uiExposureLoopbackOnly: false } as const;
    let s = nextTunnelState(initial, observe({ now: T0 + 1, startedAt: T0, probe: unverifiableProbe }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Starting");
    s = nextTunnelState(s, observe({ now: T0 + DEFAULT_TUNNEL_TIMING.startupTimeoutMs + 1, startedAt: T0, probe: unverifiableProbe }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Error");
  });

  it("an unverifiable probe after an established Connected run is Unknown (never stays Connected)", () => {
    let s = nextTunnelState(initial, observe({ probe: healthy }), DEFAULT_TUNNEL_TIMING);
    const unverifiableProbe = { kind: "unverifiable", connectedEligible: false, controlPlanePollObserved: false, exitCode: 0, uiExposureLoopbackOnly: false } as const;
    s = nextTunnelState(s, observe({ now: T0 + 1, probe: unverifiableProbe }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Unknown");
  });

  it("an unattributed dead process (no managedPid) is Stopped by design — exit classification requires attribution (r3)", () => {
    const s = nextTunnelState(initial, observe({ managedPid: undefined, processAlive: false, userStopped: false, exit: { code: 0, signal: null } }), DEFAULT_TUNNEL_TIMING);
    expect(s.name).toBe("Stopped");
  });
});