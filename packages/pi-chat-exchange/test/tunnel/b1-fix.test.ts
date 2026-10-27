import { describe, expect, it } from "vitest";
import { redactChildOutput as redact } from "../../src/tunnel/redact.js";
import { buildTunnelProfile, checkKeyFileRequirements } from "../../src/tunnel/profile.js";
import * as health from "../../src/tunnel/health.js";
import { initialTunnelState, nextTunnelState, type TunnelObservation, type TunnelState } from "../../src/tunnel/state.js";

const placeholder = "[child output suppressed]";
describe("FG-S1 fixed suppression contract", () => {
  it.each([
    "https://x.test/?%74oken=Sentinel1234", "https://x.test/?api-key=Sentinel1234",
    "https://Sentinel1234@example.test/mcp", "https://x.test/?token=" + "a.".repeat(101) + "Sentinel1234",
    "Authorization: " + "x ".repeat(101) + "Sentinel1234", "ordinary diagnostic text",
    "tunnel_1234567890 connected", "x ".repeat(999) + "Sentinel1234", "x ".repeat(1000) + "Sentinel1234",
  ])("suppresses entire nonempty record %#", (input) => {
    expect(redact(input).text).toBe(placeholder);
    expect(redact(input).appliedRules).toEqual(["raw-output-suppressed"]);
  });
});
describe("FG-S2 no normalization, chunk or overlapping-secret bypass", () => {
  it.each([
    "rejected sk-AbCd\u034fEfGh1234", "rejected sk-AbCd\tEfGh1234", "SK-AbCdEfGh1234",
    "Authorization: Bearer AbCdEfGh\n  IjKlMnOp invalid", "sk-\0AbCdEfGh1234",
    "Authorization: Bearer sk-authorizationabcdefgh?token=cap_0123456789abcdef",
    "\n", "\t", "\u034f", "Authorization: Bearer Sen", "tinel1234 failed",
  ])("suppresses independently supplied chunk %#", (input) => {
    expect(redact(input).text).toBe(placeholder);
    expect(redact(redact(input).text).text).toBe(placeholder);
  });
  it("keeps empty input empty and bounds all output without raw truncation", () => {
    expect(redact("").text).toBe("");
    expect(redact("x".repeat(100000)).text).toBe(placeholder);
  });
});
const profile = { tunnelId: "tunnel_12345678", keyFile: "/synthetic/key", healthUrlFile: "/synthetic/health", mcpCommand: "/abs/node /abs/mcp-stdio.js --config /abs/binding.json" };
describe("FG-S3 strict CE stdio command grammar", () => {
  it.each([
    "--token Sentinel1234", "--token=Sentinel1234", "--api-key SK-Sentinel1234", "--authorization Sentinel1234",
    "--unknown value", "--url https://Sentinel1234@example.test/mcp", "--url https://x.test/?%74oken=Sentinel1234",
    "--config /abs/binding.json;echo", "--config '/abs/binding.json'", "--config /abs/$(echo)",
    "--config /abs/binding.json --channel other", "--config /abs/binding.json --token Sentinel1234",
  ])("rejects unsupported/sensitive argv %s", (args) => {
    expect(() => buildTunnelProfile({ ...profile, mcpCommand: `/abs/node /abs/mcp-stdio.js ${args}` })).toThrow();
  });
  it.each(["/bin/sh /abs/mcp-stdio.js --config /abs/binding.json", "/abs/node /abs/other.js --config /abs/binding.json", "/abs/node  /abs/mcp-stdio.js --config /abs/binding.json", "/abs/node\t/abs/mcp-stdio.js --config /abs/binding.json"])("rejects ambiguous executable/grammar %s", (mcpCommand) => {
    expect(() => buildTunnelProfile({ ...profile, mcpCommand })).toThrow();
  });
  it("accepts only required CE stdio syntax, with optional main channel", () => {
    for (const suffix of ["", " --channel main"]) expect(buildTunnelProfile({ ...profile, mcpCommand: profile.mcpCommand + suffix }).mcp.commands[0]?.command).toBe(profile.mcpCommand + suffix);
  });
});
describe("FG-S4/C4 exact regular 0600 metadata gate (not runtime read evidence)", () => {
  it.each([0o40600, 0o10600, 0o100700, 0o104600, 0o100400, 0o102600, 0o101600, 0o100644, 0o600])("rejects mode %i", (mode) => {
    expect(checkKeyFileRequirements({ mode, uid: 501, ownerUid: 501, isSymbolicLink: false, size: 96 }).ok).toBe(false);
  });
  it("accepts regular exact0600; refuses symlink, foreign owner and empty", () => {
    const stat = { mode: 0o100600, uid: 501, ownerUid: 501, isSymbolicLink: false, size: 96 };
    expect(checkKeyFileRequirements(stat).ok).toBe(true);
    for (const patch of [{ isSymbolicLink: true }, { uid: 502 }, { size: 0 }]) expect(checkKeyFileRequirements({ ...stat, ...patch }).ok).toBe(false);
  });
});

const parsed = health.parseHealthProbe({ stdout: '{"result":"ok","readyz":{"ok":true},"healthz":{"ok":true,"body":"live"}}', exitCode: 0 });
// Extra completion fields deliberately work against the old implementation too:
// baseline must fail assertions, not fail module linking.
const H = (sequence = 1, completedAt = 1, runId = "run-1", managedPid = 42) => ({ ...parsed, completion: { sequence, completedAt, runId, managedPid } });
const F = (sequence: number, completedAt: number) => ({ ...H(sequence, completedAt), kind: "unhealthy" as const, connectedEligible: false });
function obs(now: number, probe: TunnelObservation["probe"] = undefined, extra = {}): TunnelObservation {
  return { now, managedPid: 42, runId: "run-1", startedAt: 0, processAlive: true, userStopped: false, exit: undefined, probe, startupLogSeen: false, externalInstance: false, ...extra } as TunnelObservation;
}
const init = () => initialTunnelState(0);
const connected = () => nextTunnelState(init(), obs(1, H()));
function disconnected(): TunnelState {
  let s = connected();
  for (let i = 2; i <= 4; i++) s = nextTunnelState(s, obs(i, F(i, i)));
  expect(s.name).toBe("Disconnected");
  return s;
}
describe("FG-C1 completion identity, freshness and run fence", () => {
  it("does not refresh lastHealthyAt or count a replay (healthy -> replay -> replay)", () => {
    let s = connected();
    s = nextTunnelState(s, obs(2, H()));
    s = nextTunnelState(s, obs(3, H()));
    expect(s.lastHealthyAt).toBe(1);
    expect(s.consecutiveHealthy).toBe(1);
  });
  it("never resurrects expired evidence (healthy -> timeout -> stale)", () => {
    const expired = nextTunnelState(connected(), obs(15002));
    expect(expired.name).toBe("Unknown");
    expect(nextTunnelState(expired, obs(15003, H())).name).toBe("Unknown");
  });
  it("requires M different probes and undefined tick resets recovery streak", () => {
    let s = nextTunnelState(disconnected(), obs(5, H(5, 5)));
    expect(s.name).toBe("Disconnected");
    s = nextTunnelState(s, obs(6, H(5, 5)));
    expect(s.name).not.toBe("Connected");
    s = nextTunnelState(s, obs(7));
    expect(s.consecutiveHealthy).toBe(0);
    s = nextTunnelState(s, obs(8, H(6, 8)));
    expect(s.name).toBe("Disconnected");
    expect(nextTunnelState(s, obs(9, H(7, 9))).name).toBe("Connected");
  });
  it.each([
    H(2, 2, "other"), H(2, 2, "run-1", 99), H(2, 4), H(0, 2), H(1.5, 2), H(2, NaN), H(2, -1),
    { ...parsed }, { ...H(2, 2), kind: "unhealthy" as const },
  ])("rejects mismatched/invalid/future evidence %#", (probe) => {
    expect(nextTunnelState(init(), obs(3, probe)).name).not.toBe("Connected");
  });
  it("rejects out-of-order completion time and sequence", () => {
    let s = nextTunnelState(connected(), obs(4, F(3, 4)));
    expect(nextTunnelState(s, obs(5, H(2, 5))).name).not.toBe("Connected");
    expect(nextTunnelState(s, obs(5, H(4, 3))).name).not.toBe("Connected");
    expect(nextTunnelState(init(), obs(15002, H())).name).not.toBe("Connected");
  });
  it("healthy -> Unknown -> stale cannot return to Connected", () => {
    const unknown = { ...H(2, 2), kind: "unverifiable" as const, connectedEligible: false };
    const s = nextTunnelState(connected(), obs(2, unknown));
    expect(s.name).toBe("Unknown");
    expect(nextTunnelState(s, obs(3, H())).name).toBe("Unknown");
  });
  it("fail -> healthy -> fail clears consecutive failures", () => {
    let s = nextTunnelState(connected(), obs(2, F(2, 2)));
    s = nextTunnelState(s, obs(3, H(3, 3)));
    s = nextTunnelState(s, obs(4, F(4, 4)));
    expect(s.consecutiveFailures).toBe(1);
  });
  it("exit fences stale healthy and old-run observations, new explicit run may recover", () => {
    const exited = nextTunnelState(connected(), obs(2, undefined, { processAlive: false, exit: { code: 0, signal: null } }));
    expect(exited.name).toBe("Error");
    expect(nextTunnelState(exited, obs(3, H(2, 3))).name).toBe("Error");
    const fresh = nextTunnelState(exited, obs(4, H(1, 4, "run-2", 43), { runId: "run-2", managedPid: 43, startedAt: 3 }));
    expect(fresh.name).toBe("Connected");
    expect(nextTunnelState(fresh, obs(5, H(3, 5))).name).not.toBe("Connected");
  });
  it("uses completion time, not delivery tick, with inclusive freshness boundary", () => {
    const s = nextTunnelState(init(), obs(10, H(1, 7)));
    expect(s.lastHealthyAt).toBe(7);
    expect(nextTunnelState(s, obs(15007, H(1, 7))).name).toBe("Connected");
    expect(nextTunnelState(s, obs(15008, H(1, 7))).name).toBe("Unknown");
  });
  it("expected exit is fenced even across an unattributed stopped tick", () => {
    const stopped = nextTunnelState(connected(), obs(2, undefined, { processAlive: false, userStopped: true, exit: { code: null, signal: "SIGTERM" } }));
    expect(stopped.name).toBe("Stopped");
    const absent = nextTunnelState(stopped, obs(3, undefined, { managedPid: undefined, processAlive: false }));
    expect(nextTunnelState(absent, obs(4, H(2, 4))).name).toBe("Stopped");
  });
  it("old-run exit cannot fence a newer run", () => {
    const s = nextTunnelState(connected(), obs(4, H(1, 4, "run-2", 43), { runId: "run-2", managedPid: 43, startedAt: 3 }));
    const staleExit = nextTunnelState(s, obs(5, undefined, { processAlive: false, exit: { code: 0, signal: null } }));
    expect(nextTunnelState(staleExit, obs(6, H(2, 6, "run-2", 43), { runId: "run-2", managedPid: 43, startedAt: 3 })).name).toBe("Connected");
  });
  it("completion recorder stamps actual completion seam, not parse/tick time", () => {
    const module = health as unknown as Record<string, unknown>;
    expect(typeof module.createHealthCompletionRecorder).toBe("function");
    const create = module.createHealthCompletionRecorder as (runId: string, pid: number, now: () => number) => (input: health.HealthProbeInput) => ReturnType<typeof H>;
    let now = 7;
    const complete = create("run-1", 42, () => now);
    const input = { stdout: '{"result":"fail"}', exitCode: 0 };
    const one = complete(input);
    now = 9;
    const two = complete(input);
    expect(one.completion).toEqual({ sequence: 1, completedAt: 7, runId: "run-1", managedPid: 42 });
    expect(two.completion).toEqual({ sequence: 2, completedAt: 9, runId: "run-1", managedPid: 42 });
  });
});
describe("FG-C2 startup deadline is exclusive and timeout terminal per run", () => {
  it.each([29999, 30000, 30001])("first healthy at %i obeys now < deadline", (now) => {
    expect(nextTunnelState(init(), obs(now, H(1, now))).name).toBe(now < 30000 ? "Connected" : "Error");
  });
  it("missing startedAt fails closed", () => {
    expect(nextTunnelState(init(), obs(1, undefined, { startedAt: undefined })).name).toBe("Error");
  });
  it("timeout Error remains terminal even when supervision is cleared", () => {
    const timeout = nextTunnelState(init(), obs(30000));
    const absent = nextTunnelState(timeout, obs(30001, undefined, { managedPid: undefined, processAlive: false }));
    expect(absent.name).toBe("Error");
    expect(nextTunnelState(absent, obs(30002, H(1, 30002))).name).toBe("Error");
  });
  it("timeout cannot be overwritten by late healthy; explicit new run can start", () => {
    const timeout = nextTunnelState(init(), obs(30000));
    expect(timeout.name).toBe("Error");
    expect(nextTunnelState(timeout, obs(30001, H(1, 30001))).name).toBe("Error");
    expect(nextTunnelState(timeout, obs(30002, H(1, 30002, "run-2"), { runId: "run-2", startedAt: 30001 })).name).toBe("Connected");
  });
});
