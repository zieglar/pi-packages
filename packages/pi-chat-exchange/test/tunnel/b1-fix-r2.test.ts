import { describe, expect, it } from "vitest";
import { buildTunnelProfile, TunnelConfigError } from "../../src/tunnel/profile.js";
import { createHealthCompletionRecorder } from "../../src/tunnel/health.js";
import { initialTunnelState, nextTunnelState, type TunnelObservation } from "../../src/tunnel/state.js";

const base = { tunnelId: "tunnel_12345678", keyFile: "/synthetic/key", healthUrlFile: "/synthetic/health", mcpCommand: "/abs/node /abs/mcp-stdio.js --config /abs/binding.json" };
describe("R2 URL credential boundary", () => {
  it.each([
    "https://operator@api.example.test", "https://:Sentinel1234@api.example.test",
    "https://operator:Sentinel1234@api.example.test", "https://%6fperator:%53entinel1234@api.example.test",
    "https:///operator:Sentinel1234@api.example.test", "https:////%6fperator:%53entinel1234@api.example.test",
    "https:///operator@api.example.test", "https:///:Sentinel1234@api.example.test",
    "https://\\operator:Sentinel1234@api.example.test", "https://api.example.test\t@evil.example.test",
    "https://api.example.test?token=Sentinel1234", "https://api.example.test?%74oken=Sentinel1234",
    "https://api.example.test#Sentinel1234", "https:///operator:Sentinel1234@api.example.test?token=Sentinel1234#secret",
    "https:///api.example.test", "https://api.example.test/../secret", "https://api.example.test?", "https://api.example.test#",
    "https://", "https://%zz", "http://api.example.test", " https://api.example.test",
  ])("refuses unverified/credential-bearing syntax %#", (controlPlaneBaseUrl) => {
    expect(() => buildTunnelProfile({ ...base, controlPlaneBaseUrl })).toThrow(TunnelConfigError);
  });
  it.each(["https://api.example.test", "https://api.example.test/", "https://api.example.test/v1", "https://api.example.test:8443/v1"]) ("preserves validated safe URL %s", (controlPlaneBaseUrl) => {
    expect(buildTunnelProfile({ ...base, controlPlaneBaseUrl }).control_plane.base_url).toBe(controlPlaneBaseUrl);
  });
  it.each(["--token Sentinel1234", "--token=Sentinel1234", "--api-key Sentinel1234", "--api-key=Sentinel1234", "--url https:///operator:Sentinel1234@api.example.test"]) ("still refuses split/combined credential argv %s", (args) => {
    expect(() => buildTunnelProfile({ ...base, mcpCommand: `/abs/node /abs/mcp-stdio.js ${args}` })).toThrow(TunnelConfigError);
  });
});

const raw = { stdout: '{"result":"ok","healthz":{"ok":true,"body":"live"},"readyz":{"ok":true}}', exitCode: 0 };
function fixture() {
  let now = 1;
  const a = createHealthCompletionRecorder("A", 42, () => now), b = createHealthCompletionRecorder("B", 43, () => now);
  const observation = (id: string, pid: number, start: number, probe?: TunnelObservation["probe"]): TunnelObservation => ({ now, runId: id, managedPid: pid, startedAt: start, probe, processAlive: true, userStopped: false, exit: undefined, startupLogSeen: false, externalInstance: false });
  const first = nextTunnelState(initialTunnelState(0), observation("A", 42, 0, a(raw)));
  now = 4;
  const active = nextTunnelState(first, observation("B", 43, 3));
  const healthy = nextTunnelState(first, observation("B", 43, 3, b(raw)));
  return { active, healthy, absence: (patch: Partial<TunnelObservation> = {}): TunnelObservation => ({ ...observation("A", 42, 0), now: 5, managedPid: undefined, processAlive: false, ...patch }), healthyB: (time: number) => { now = time; return observation("B", 43, 3, b(raw)); } };
}
describe("R2 run-attributed absence", () => {
  it.each(["active", "healthy"] as const)("old A absence cannot mutate B %s", (kind) => {
    const f = fixture(), before = f[kind];
    expect(nextTunnelState(before, f.absence())).toBe(before);
    expect(nextTunnelState(before, f.healthyB(6)).name).toBe("Connected");
  });
  it.each([
    { runId: undefined }, { runId: "" }, { runId: "A" },
    { runId: "B", startedAt: 0 }, { runId: "B", startedAt: 3, now: 2 },
    { runId: "B", startedAt: 3, now: NaN },
  ])("unattributed/stale absence cannot change any B field %#", (patch) => {
    const f = fixture();
    expect(nextTunnelState(f.healthy, f.absence(patch))).toBe(f.healthy);
  });
  it.each([
    { runId: "A", managedPid: 42, startedAt: 0 },
    { runId: undefined, managedPid: 43, startedAt: 3 },
    { runId: "B", managedPid: 42, startedAt: 3 },
    { runId: "B", managedPid: 43, startedAt: 3, now: 2 },
  ])("retained-PID absence also requires matching run and time %#", (patch) => {
    const f = fixture();
    expect(nextTunnelState(f.healthy, f.absence(patch))).toBe(f.healthy);
  });
  it("A/B interleaving cannot fence B or consume its completions", () => {
    const f = fixture();
    let s = nextTunnelState(f.healthy, f.absence());
    s = nextTunnelState(s, f.healthyB(6));
    expect(s.name).toBe("Connected");
    const before = s;
    s = nextTunnelState(s, f.absence({ now: 7 }));
    expect(s).toBe(before);
    s = nextTunnelState(s, f.healthyB(8));
    expect(s.name).toBe("Connected");
    expect(s.run?.id).toBe("B");
  });
  it("lawful same-run absence fences B and cannot be revived by B health", () => {
    const f = fixture();
    const stopped = nextTunnelState(f.healthy, f.absence({ runId: "B", startedAt: 3 }));
    expect(stopped.name).toBe("Stopped");
    expect(stopped.run?.terminal).toBe(true);
    expect(nextTunnelState(stopped, f.healthyB(6)).name).toBe("Stopped");
  });
  it("missing-identity absence cannot erase terminal timeout", () => {
    const f = fixture();
    const timeout = nextTunnelState(initialTunnelState(0), { ...f.absence(), now: 30000, runId: "A", managedPid: 42, processAlive: true, startedAt: 0 });
    expect(timeout.name).toBe("Error");
    expect(nextTunnelState(timeout, f.absence({ now: 30001, runId: undefined }))).toBe(timeout);
  });
});
