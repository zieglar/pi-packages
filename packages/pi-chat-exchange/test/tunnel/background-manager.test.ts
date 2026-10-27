/**
 * HANDOFF-CE-LOCAL-BACKGROUND-01 v2 — real background tunnel manager tests.
 *
 * Fully offline: daemon spawn, ps identity, health probe, and signal are all
 * injected seams. No real network, Keychain, credential read, or foreign
 * process is touched; the only real filesystem objects live in a tmp dir
 * created by the test itself (profile, a 0600 dummy key file, state record,
 * lock file).
 *
 * v1 acceptance contract (retained) plus v2–v5 regression coverage for Lane S
 * S1–S10 + S2-R1…R8 + S3-1…7 + F1…F7 and Lane C C1–C8 + C-v2-1…6 + C-v3-1…7 +
 * C-v4-1…7; each test names its finding.
 */
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, symlinkSync, mkdirSync, readdirSync, rmSync, lstatSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createBackgroundTunnelManager,
  resolveWrapperIdentityEvidence,
  type BackgroundManagerOptions,
  type DaemonChildHandle,
  type ProcessIdentity,
} from "../../src/tunnel/background-manager.js";
import type { HealthProbeInput } from "../../src/tunnel/health.js";

const TUNNEL_ID = "tunnel_abcdef1234567890";
const SELF_KEY = "Mon Oct 12 00:00:00 2026";

interface Harness {
  readonly options: BackgroundManagerOptions;
  readonly procs: Map<number, ProcessIdentity>;
  readonly spawnCalls: { executable: string; args: readonly string[]; detached: boolean }[];
  readonly signals: { pid: number; signal: string }[];
  readonly dir: string;
  readonly profilePath: string;
  readonly statePath: string;
  readonly keyPath: string;
  /** Per-harness client path inside the tmp dir; never created by the default
   *  harness, so wrapper resolution finds nothing and records stay free of the
   *  exec alternative (LOCAL-BACKGROUND-03 hermeticity). */
  readonly client: string;
  probes: HealthProbeInput[];
  clock: number;
  unknownPids: Set<number>;
  onSpawn?: (() => void) | undefined;
  onProbe?: (() => void) | undefined;
  onInspect?: ((pid: number) => void) | undefined;
  /** S-1: child-handle exit listeners captured by the spawn seam, per pid. */
  readonly exitListeners: Map<number, { exit?: ((code: number | null, signal: string | null) => void) | undefined }>;
  /** S-1: deliver the spawned child's exit event (spawn-linked death proof). */
  fireExit(pid: number): void;
}

function healthyProbe(): HealthProbeInput {
  return {
    stdout: JSON.stringify({
      result: "ok",
      healthz: { ok: true, body: "live" },
      readyz: { ok: true },
      process: { running: true },
      control_plane_poll: { ok: true },
    }),
    exitCode: 0,
  };
}
const UNREACHABLE: HealthProbeInput = {
  stdout: JSON.stringify({ locator: { error: "url file missing" }, result: "fail", healthz: { ok: false } }),
  exitCode: 2,
};

function makeHarness(env: NodeJS.ProcessEnv = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "ce-bg-v2-"));
  const keyPath = join(dir, "runtime-key");
  writeFileSync(keyPath, "x".repeat(24), { mode: 0o600 });
  const profilePath = join(dir, "tunnel.yaml");
  const mcpCommand = `/usr/bin/node /tmp/mcp-stdio.js --config ${join(dir, "binding.json")}`;
  writeFileSync(profilePath, [
    "config_version: 1",
    "control_plane:",
    '  base_url: "https://api.openai.com"',
    `  tunnel_id: "${TUNNEL_ID}"`,
    `  api_key: "file:${keyPath}"`,
    "health:",
    '  listen_addr: "127.0.0.1:0"',
    `  url_file: "${join(dir, "health.url")}"`,
    "admin_ui:",
    "  open_browser: false",
    "log:",
    "  level: info",
    "mcp:",
    "  commands:",
    "    - channel: main",
    `      command: "${mcpCommand}"`,
    "",
  ].join("\n"), { mode: 0o600 });
  const statePath = join(dir, "background-state.json");
  const client = join(dir, "tunnel-client");
  const procs = new Map<number, ProcessIdentity>();
  const spawnCalls: Harness["spawnCalls"] = [];
  const signals: Harness["signals"] = [];
  const exitListeners: Harness["exitListeners"] = new Map();
  const harness: Harness = {
    dir, profilePath, statePath, keyPath, client, procs, spawnCalls, signals,
    probes: [],
    clock: 1_760_000_000_000,
    unknownPids: new Set(),
    exitListeners,
    fireExit: (pid) => { harness.exitListeners.get(pid)?.exit?.(0, null); },
    options: {
      env: { CE_TUNNEL_BACKGROUND_ALLOW: "1", ...env },
      get now() { return () => harness.clock; },
      profilePath,
      stateFilePath: statePath,
      clientPath: client,
      timing: { startupTimeoutMs: 5_000, pollIntervalMs: 5_000, freshnessMs: 15_000, failThresholdN: 3, recoverThresholdM: 2, stopGraceMs: 1_000 },
      spawn: (executable, args, opts) => {
        spawnCalls.push({ executable, args, detached: opts.detached });
        harness.onSpawn?.();
        const pid = 40_000 + spawnCalls.length;
        procs.set(pid, { pid, command: `${client} run --profile-file ${profilePath}`, startedKey: "Tue Oct 20 06:30:09 2026" });
        const listeners: { exit?: ((code: number | null, signal: string | null) => void) | undefined } = {};
        exitListeners.set(pid, listeners);
        const handle: DaemonChildHandle = {
          pid,
          unref: () => undefined,
          on(event: string, listener: unknown): void {
            if (event === "exit") listeners.exit = listener as (code: number | null, signal: string | null) => void;
          },
        };
        return handle;
      },
      inspectProcess: async (pid) => {
        harness.clock += 250;
        harness.onInspect?.(pid);
        if (pid === process.pid) return { kind: "present", identity: { pid, command: "test-runner", startedKey: SELF_KEY } };
        if (harness.unknownPids.has(pid)) return { kind: "unknown" };
        const found = procs.get(pid);
        return found === undefined ? { kind: "absent" } : { kind: "present", identity: found };
      },
      listProcesses: async () => ({ kind: "ok", processes: [...procs.values()] }),
      probeHealth: async () => { harness.clock += 600; harness.onProbe?.(); return harness.probes.length > 0 ? harness.probes.shift()! : UNREACHABLE; },
      signal: (pid, sig) => { signals.push({ pid, signal: sig }); },
    },
  };
  return harness;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((resolve) => setImmediate(resolve));
}

function recordStateOrAbsent(h: Harness): boolean {
  try {
    readFileSync(h.statePath, "utf8");
    return false;
  } catch {
    return true;
  }
}

function diskRecord(h: Harness, runId: string, pid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1, runId, pid, profilePath: h.profilePath,
    profileSha256: "f".repeat(64), tunnelId: TUNNEL_ID, keyFile: h.keyPath,
    urlFile: join(h.dir, "health.url"), logPath: join(h.dir, "background-tunnel.log"),
    commandIdentity: `${h.client} run --profile-file ${h.profilePath}`,
    processStartedKey: "Tue Oct 20 10:00:00 2026", startedAt: Date.now(),
    state: "running", ...extra,
  };
}

function recordState(h: Harness): Record<string, unknown> {
  return JSON.parse(readFileSync(h.statePath, "utf8")) as Record<string, unknown>;
}

describe("BACKGROUND-05 default background startup budget", () => {
  const noPoll: HealthProbeInput = {
    stdout: JSON.stringify({ result: "fail", healthz: { ok: true, body: "live" },
      readyz: { ok: true }, process: { running: true }, control_plane_poll: { ok: false } }),
    exitCode: 2,
  };

  function defaultOptions(h: Harness): BackgroundManagerOptions {
    const { timing, ...options } = h.options;
    void timing; // Exercise the production default, not the harness's 5s override.
    return { ...options, signal: (pid, signal) => {
      h.signals.push({ pid, signal });
      h.procs.delete(pid); // Simulate the same owned child's SIGTERM exit.
      rmSync(join(h.dir, "health.url"), { force: true });
    } };
  }

  it("accepts first successful-poll health at 35s, beyond the old 30s window", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      h.clock = Number(recordState(h).startedAt) + 35_001;
      return healthyProbe();
    } });
    const result = await m.start();
    expect(result.health).toBe("connected");
    expect(m.status().state).toBe("CONNECTED");
    expect(h.signals).toEqual([]);
    await m.stop();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(recordState(h).state).toBe("stopped");
  });

  it("does not accept local live/ready health while required poll is false at 31s", async () => {
    const h = makeHarness();
    let calls = 0;
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      calls += 1;
      h.clock = Number(recordState(h).startedAt) + (calls === 1 ? 31_000 : 36_000);
      return calls === 1 ? noPoll : healthyProbe();
    } });
    const result = await m.start();
    expect(calls).toBe(2);
    expect(result.health).toBe("connected");
    expect(m.status().state).toBe("CONNECTED");
    expect(h.signals).toEqual([]);
    await m.stop();
  });

  it("times out at the new 45s deadline if poll never succeeds, with verified cleanup", async () => {
    const h = makeHarness();
    let calls = 0;
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      const offsets = [31_000, 44_999, 45_000];
      h.clock = Number(recordState(h).startedAt) + offsets[calls++]!;
      return noPoll;
    } });
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(calls).toBe(3);
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(recordState(h).state).toBe("stopped");
    expect(recordState(h).termRequestedAt).toBeDefined();
    expect(recordState(h).note).toBe("startup not confirmed; verified stop");
    expect(h.procs.size).toBe(0);
    expect(readdirSync(h.dir).some((name) => name.includes("lock"))).toBe(false);
    await m.stop();
    expect(h.signals).toHaveLength(1);
  });

  it("still refuses a first healthy completion exactly at 45s and cleans up once", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      h.clock = Number(recordState(h).startedAt) + 45_000;
      return healthyProbe();
    } });
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(recordState(h).state).toBe("stopped");
  });
  it("REAL-START-FIX-01 startDeferred: ack resolves at spawn, settled converges to connected", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      h.clock = Number(recordState(h).startedAt) + 35_001;
      return healthyProbe();
    } });
    const deferred = m.startDeferred();
    const ack = await deferred.ack;
    expect(ack).toMatchObject({ runId: expect.stringMatching(/^bg-/), pid: 40_001, tunnelId: expect.stringMatching(/^tunnel_/) });
    const result = await deferred.settled;
    expect(result.health).toBe("connected");
    expect(m.status().state).toBe("CONNECTED");
    await m.stop();
  });

  it("REAL-START-FIX-01 startDeferred: reports STARTING after the ack, then times out with cleanup", async () => {
    const h = makeHarness();
    let calls = 0;
    const m = createBackgroundTunnelManager({ ...defaultOptions(h), probeHealth: async () => {
      const offsets = [31_000, 44_999, 45_000];
      h.clock = Number(recordState(h).startedAt) + offsets[calls++]!;
      return noPoll;
    } });
    const deferred = m.startDeferred();
    const ack = await deferred.ack;
    expect(ack.pid).toBe(40_001);
    expect(m.status().state).toBe("STARTING");
    await expect(deferred.settled).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(recordState(h).state).toBe("stopped");
    expect(recordState(h).note).toBe("startup not confirmed; verified stop");
    await m.stop();
  });
});

describe("background manager v2 — baseline acceptance", () => {
  it("first start spawns ONE detached client and persists a 0600 record", async () => {
    const h = makeHarness();
    h.probes.push(UNREACHABLE, healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    const r = await m.start();
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.spawnCalls[0]!.detached).toBe(true);
    expect(h.spawnCalls[0]!.args).toEqual(["run", "--profile-file", h.profilePath]);
    expect(r.alreadyRunning).toBe(false);
    expect(r.health).toBe("connected");
    expect(r.tunnelId).toBe("tunnel_abcdef…");
    const rec = recordState(h);
    expect(rec.state).toBe("running");
    expect(rec.commandIdentity).toContain("--profile-file");
    expect((await import("node:fs")).statSync(h.statePath).mode & 0o777).toBe(0o600);
    expect(m.status().state).toBe("CONNECTED");
    expect(m.status().evidence).toBe("health-probe");
  });

  it("repeated start never spawns a second instance", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    const first = await m.start();
    const second = await m.start();
    expect(second.runId).toBe(first.runId);
    expect(second.alreadyRunning).toBe(true);
    expect(second.health).toBe("unknown"); // identity verified, health not re-measured
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("REAL-START-FIX-01 startDeferred: alreadyRunning also resolves the ack", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    const first = await m.start();
    const deferred = m.startDeferred();
    const ack = await deferred.ack; // must resolve (not hang) on the alreadyRunning path
    expect(ack.runId).toBe(first.runId);
    expect(ack.pid).toBe(40_001);
    const second = await deferred.settled;
    expect(second.alreadyRunning).toBe(true);
    expect(second.health).toBe("unknown");
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("status vocabulary and stale-evidence lapse", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager(h.options);
    expect(m.status().state).toBe("STOPPED");
    h.probes.push(healthyProbe());
    await m.start();
    expect(m.status().state).toBe("CONNECTED");
    h.probes.push(UNREACHABLE, UNREACHABLE, UNREACHABLE);
    await m.refresh(); await m.refresh(); await m.refresh();
    expect(m.status().state).toBe("DEGRADED");
    h.clock += 20_000;
    const stale = m.status();
    expect(stale.state).not.toBe("CONNECTED");
    expect(stale.evidence).toBe("none");
  });

  it("a later session stops the owned instance with exactly one SIGTERM", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    const m2 = createBackgroundTunnelManager(h.options);
    const stop = m2.stop();
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
    expect(recordState(h).note).toContain("exit observed");
    expect(m2.status().state).toBe("STOPPED");
    expect(m2.status().evidence).toBe("process-absent");
  });

  it("stop timeout refuses and RETAINS ownership; a retry never re-signals", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    await expect(m.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(1);
    expect(recordState(h).state).toBe("stop-unconfirmed");
    const retry = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toHaveLength(1);
    h.procs.delete(40_001);
    await retry;
    expect(recordState(h).state).toBe("stopped");
  });

  it("PID reuse blocks adoption and signalling (UNKNOWN / EXTERNAL_INSTANCE)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    const m2 = createBackgroundTunnelManager(h.options);
    await m2.refresh();
    expect(m2.status().state).toBe("UNKNOWN");
    await expect(m2.stop()).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0);
  });

  it("refuses to race a foreign client on the same profile", async () => {
    const h = makeHarness();
    h.procs.set(55_555, { pid: 55_555, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Tue Oct 20 05:00:00 2026" });
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_EXTERNAL_INSTANCE" });
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("credential gating and key metadata gates are unchanged", async () => {
    const h = makeHarness();
    writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8").replace(/api_key: "file:[^"]+"/, 'api_key: "env:CONTROL_PLANE_API_KEY"'));
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED" });

    const h2 = makeHarness();
    chmodSync(h2.keyPath, 0o644);
    await expect(createBackgroundTunnelManager(h2.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_PERMS_INVALID" });

    const h3 = makeHarness();
    const linkPath = join(h3.dir, "key-link");
    symlinkSync(h3.keyPath, linkPath);
    writeFileSync(h3.profilePath, readFileSync(h3.profilePath, "utf8").replace(`file:${h3.keyPath}`, `file:${linkPath}`));
    await expect(createBackgroundTunnelManager(h3.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_PERMS_INVALID" });
  });

  it("mcp child still alive after tunnel exit is reported, never signalled", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    const stop = m.stop();
    await flush();
    h.procs.delete(40_001);
    h.procs.set(40_002, { pid: 40_002, command: `/usr/bin/node /tmp/mcp-stdio.js --config ${join(h.dir, "binding.json")}`, startedKey: "Tue Oct 20 06:30:10 2026" });
    await stop;
    expect(h.signals.filter((s) => s.pid !== 40_001)).toHaveLength(0);
    expect(recordState(h).note).toContain("MCP child still running");
  });
});

describe("background manager v2 — review regression coverage", () => {
  it("S1: real start requires the exact CE_TUNNEL_BACKGROUND_ALLOW=1 opt-in", async () => {
    for (const bad of [undefined, "true", "0", " 1", "yes"]) {
      const h = makeHarness();
      const env = bad === undefined ? {} : { CE_TUNNEL_BACKGROUND_ALLOW: bad };
      await expect(createBackgroundTunnelManager({ ...h.options, env }).start())
        .rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
      expect(h.spawnCalls).toHaveLength(0);
    }
    // status/stop stay gate-free: they create no cost and only reduce it.
    const h = makeHarness({});
    await expect(createBackgroundTunnelManager({ ...h.options, env: {} }).stop()).resolves.toBeUndefined();
  });

  it("S2: YAML escapes, block scalars and duplicate keys refuse", async () => {
    const h = makeHarness();
    const original = readFileSync(h.profilePath, "utf8");
    writeFileSync(h.profilePath, original.replace(`file:${h.keyPath}`, String.raw`file:/tmp/safe\x2fkey`));
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });

    const h2 = makeHarness();
    writeFileSync(h2.profilePath, `control_plane:\n  api_key: |\n    file:/etc/passwd\n` + readFileSync(h2.profilePath, "utf8"));
    await expect(createBackgroundTunnelManager(h2.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });

    const h3 = makeHarness();
    writeFileSync(h3.profilePath, readFileSync(h3.profilePath, "utf8") + `control_plane_extra: false\n` +
      `health:\n  url_file: "/tmp/decoy.url"\n`);
    await expect(createBackgroundTunnelManager(h3.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
  });

  it("REAL-START-FIX-01: rejects the admin_ui keys the real 0.0.16 client rejects", async () => {
    // `allow_remote_ui` is a top-level client flag, not an admin_ui member;
    // `log_buffer_events: 0` is below the client's minimum of 1. Both must
    // refuse BEFORE spawn so the manager never hands the client a profile it
    // will parse-fail on and then time out for 45s.
    const h = makeHarness();
    writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8").replace("admin_ui:\n  open_browser: false", "admin_ui:\n  open_browser: false\n  allow_remote_ui: false"));
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(h.spawnCalls).toHaveLength(0);

    const h2 = makeHarness();
    writeFileSync(h2.profilePath, readFileSync(h2.profilePath, "utf8").replace("admin_ui:\n  open_browser: false", "admin_ui:\n  open_browser: false\n  log_buffer_events: 0"));
    await expect(createBackgroundTunnelManager(h2.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(h2.spawnCalls).toHaveLength(0);
  });

  it("S3/C5: inspection UNKNOWN retains ownership everywhere", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    h.unknownPids.add(40_001);
    await m.refresh();
    expect(m.status().state).not.toBe("STOPPED");
    expect(recordState(h).state).toBe("running"); // never marked stopped on unknown
    await expect(m.stop({ graceMs: 200 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0); // unknown presence: no signal
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("S4/C2: a second manager cannot double-stop (single SIGTERM across sessions)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    await m1.start();
    // m1 stops and times out (process stays alive); m2 must not re-signal.
    await expect(m1.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(1);
    const m2 = createBackgroundTunnelManager(h.options);
    const stop2 = m2.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toHaveLength(1); // termRequestedAt was persisted
    h.procs.delete(40_001);
    await stop2;
    expect(recordState(h).state).toBe("stopped");
  });

  it("S4/C2 + R1/R7: live lock refuses; stale and crashed locks reclaim atomically", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    // Live holder: this test process with matching start key.
    mkdirSync(`${h.statePath}.lock.d`);
    writeFileSync(`${h.statePath}.lock.d/holder.json`, JSON.stringify({ token: "foreign", pid: process.pid, startedKey: SELF_KEY }));
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    expect(h.spawnCalls).toHaveLength(0);

    // Stale holder (pid absent) → reclaimed; start proceeds (times out on health).
    const h2 = makeHarness();
    mkdirSync(`${h2.statePath}.lock.d`);
    writeFileSync(`${h2.statePath}.lock.d/holder.json`, JSON.stringify({ token: "stale", pid: 999_999, startedKey: "n/a" }));
    const m2 = createBackgroundTunnelManager(h2.options);
    await expect(m2.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h2.spawnCalls).toHaveLength(1);

    // R7: crashed acquirer (holderless dir). Young → BUSY; aged past the stale
    // threshold → reclaimed.
    const h3 = makeHarness();
    mkdirSync(`${h3.statePath}.lock.d`);
    await expect(createBackgroundTunnelManager(h3.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    const past = new Date(Date.now() - 120_000);
    utimesSync(`${h3.statePath}.lock.d`, past, past);
    const m3 = createBackgroundTunnelManager(h3.options);
    await expect(m3.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h3.spawnCalls).toHaveLength(1);
  });

  it("C3: a stop during a pending start aborts the start without a second signal", async () => {
    const h = makeHarness(); // probes stay unreachable
    const m = createBackgroundTunnelManager(h.options);
    const start = m.start();
    await flush(); // spawn + record persisted, probe loop running
    expect(h.spawnCalls).toHaveLength(1);
    const stop = m.stop({ graceMs: 300 });
    // v3: stop AWAITS the invalidated start; the fenced start's own cleanup
    // issues the single SIGTERM. Wait for it, then let the daemon exit.
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(1); // cleanup's signal; stop adds none
    h.procs.delete(40_001); // client exits from that SIGTERM
    await stop;
    await expect(start).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.signals).toHaveLength(1);
    expect(recordState(h).state).toBe("stopped");
  });

  it("C6/S5: a healthy probe COMPLETING after the deadline takes the timeout path", async () => {
    const h = makeHarness();
    // The probe starts before the deadline but completes 60s later (clock jump
    // inside the await): the frozen state machine must NOT accept Connected.
    h.onProbe = () => { h.clock += 60_000; };
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
  });

  it("C8: startup-timeout cleanup re-verifies identity and never signals a reused pid", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager(h.options);
    const start = m.start();
    await flush();
    // The original child died and the PID was reused by a foreign process.
    h.procs.set(40_001, { pid: 40_001, command: "/usr/bin/yes", startedKey: "Fri Oct 24 00:00:00 2026" });
    await expect(start).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.signals).toHaveLength(0);
    expect(recordState(h).state).toBe("stop-unconfirmed");
    expect(String(recordState(h).note)).toContain("unknown");
  });

  it("S6/C4: persist failure after spawn cleans up verified and keeps no false record", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    // Spawn succeeds; make the state directory unwritable during spawn.
    h.onSpawn = () => chmodSync(h.dir, 0o500);
    const m = createBackgroundTunnelManager(h.options);
    // Persist is impossible after chmod 0500: start refuses, performs ONE
    // verified cleanup signal (in-memory once-guard), keeps the run owned.
    await expect(m.start()).rejects.toBeInstanceOf(Error);
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    expect(m.runId()).toBeDefined(); // in-memory ownership retained, not orphaned
    expect(m.status().note).toContain("persistence failed");
    // R3/C-v2-1: refresh and stop must NOT discard the unpersisted ownership,
    // and a later stop must NOT signal a second time.
    await m.refresh();
    expect(m.runId()).toBeDefined();
    chmodSync(h.dir, 0o700);
    // The failed start leaked its lock while the dir was unwritable; the
    // documented recovery is the stale-age protocol (holder partially removed).
    const leakedLock = `${h.statePath}.lock.d`;
    const aged = new Date(Date.now() - 120_000);
    try { utimesSync(leakedLock, aged, aged); } catch { /* already gone */ }
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toHaveLength(1); // no second signal
    h.procs.delete(40_001); // the daemon finally exits
    await stop;
    expect(m.runId()).toBeUndefined();
    expect(recordState(h).state).toBe("stopped");
  });

  it("C1: a daemon adopted by a new session after >startup window still reaches CONNECTED", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    h.clock += 60_000; // long past the startup deadline
    const m2 = createBackgroundTunnelManager(h.options);
    h.probes.push(healthyProbe());
    const view = await m2.refresh();
    expect(view.state).toBe("CONNECTED");
    expect(view.runId).toBeDefined();
  });

  it("S8: a corrupt record fails closed (UNKNOWN, start/stop refuse)", async () => {
    const h = makeHarness();
    writeFileSync(h.statePath, "{not json", { mode: 0o600 });
    const m = createBackgroundTunnelManager(h.options);
    expect(m.status().state).toBe("UNKNOWN");
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    await expect(m.stop()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.signals).toHaveLength(0);
  });

  it("S7: a symlinked state directory refuses before any mutation", async () => {
    const h = makeHarness();
    const realDir = join(h.dir, "real-state");
    mkdirSync(realDir, { mode: 0o700 });
    const linkDir = join(h.dir, "link-state");
    symlinkSync(realDir, linkDir);
    const m = createBackgroundTunnelManager({ ...h.options, stateFilePath: join(linkDir, "background-state.json") });
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(readdirSync(realDir)).toHaveLength(0);
  });
  it("R2: a record-backed run is NOT signalled when the ledger cannot persist", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start(); // record persisted, dir healthy
    chmodSync(h.dir, 0o500); // ledger can no longer persist
    await expect(m.stop({ graceMs: 300 })).rejects.toBeInstanceOf(Error);
    expect(h.signals).toHaveLength(0); // no ledger, no signal — ownership kept
    expect(m.runId()).toBeDefined();
    chmodSync(h.dir, 0o700);
    const stop = m.stop({ graceMs: 300 });
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(1); // ledger restored → exactly one signal
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });

  it("R4/C-v2-3: refresh never overwrites a newer run's record with a stale absence", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    const started = await m1.start();
    // While m1's refresh inspects the OLD pid, another session confirms the
    // exit and persists a NEW run B record.
    const runB = {
      version: 1, runId: "bg-run-b", pid: 40_002, profilePath: h.profilePath,
      profileSha256: "b".repeat(64), tunnelId: TUNNEL_ID, keyFile: h.keyPath,
      urlFile: join(h.dir, "health.url"), logPath: join(h.dir, "background-tunnel.log"),
      commandIdentity: `${h.client} run --profile-file ${h.profilePath}`,
      processStartedKey: "Tue Oct 20 07:00:00 2026", startedAt: Date.now(),
      state: "running",
    };
    let swapped = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !swapped) {
        swapped = true;
        writeFileSync(h.statePath, JSON.stringify(runB), { mode: 0o600 });
      }
    };
    const m2 = createBackgroundTunnelManager(h.options); // adopts run A from disk
    h.procs.delete(40_001); // run A is gone
    const view = await m2.refresh();
    void view;
    // The stale absence observation must NOT have overwritten run B.
    expect((recordState(h) as { runId: string }).runId).toBe("bg-run-b");
    expect((recordState(h) as { state: string }).state).toBe("running");
    void started;
  });

  it("R5/C-v2-2: a stop submitted immediately after start prevents any spawn", async () => {
    const h = makeHarness();
    const m = createBackgroundTunnelManager(h.options);
    const start = m.start();
    const stop = m.stop(); // same tick: stop invalidates the queued start
    await stop;
    await expect(start).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.spawnCalls).toHaveLength(0);
    expect(m.status().state).toBe("STOPPED");
  });

  it("R6/C-v2-6: an unreadable (EACCES) record fails closed, never 'no record'", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    chmodSync(h.statePath, 0o000); // lstat works, read fails with EACCES
    const m2 = createBackgroundTunnelManager(h.options);
    expect(m2.status().state).toBe("UNKNOWN");
    await expect(m2.start()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    await expect(m2.stop()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    expect(h.signals).toHaveLength(0);
    chmodSync(h.statePath, 0o600);
  });

  it("C-v2-5: an adopted run survives a long observation lapse and recovers", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    // New session adopts the run; first observations are unreachable and the
    // original startup window lapses — this must be DEGRADED, not terminal.
    const m2 = createBackgroundTunnelManager(h.options);
    h.clock += 60_000;
    await m2.refresh(); // unreachable
    expect(m2.status().state).not.toBe("CONNECTED");
    h.clock += 60_000;
    await m2.refresh(); // still unreachable, far past any startup window
    h.probes.push(healthyProbe());
    const view = await m2.refresh();
    expect(view.state).toBe("CONNECTED"); // late recovery works for adopted runs
  });

  it("R8: nested or unknown structure cannot smuggle a second api_key", async () => {
    const h = makeHarness();
    writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8") +
      `extra:\n  control_plane:\n    api_key: "file:/etc/passwd"\n`);
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    const h2 = makeHarness();
    writeFileSync(h2.profilePath, readFileSync(h2.profilePath, "utf8") +
      `log:\n  level: info\n  api_key: "file:/etc/passwd"\n`);
    await expect(createBackgroundTunnelManager(h2.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    // Quoted keys are not part of the canonical grammar either.
    const h3 = makeHarness();
    writeFileSync(h3.profilePath, readFileSync(h3.profilePath, "utf8").replace('api_key: "file:', '"api_key": "file:'));
    await expect(createBackgroundTunnelManager(h3.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
  });
  it("C-v3-1: a stopped record on disk never hides a live pending daemon", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    const firstStop = m.stop();
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    h.procs.delete(40_001);
    await firstStop;
    expect(recordState(h).state).toBe("stopped"); // run A stopped on disk

    // Second start: spawn succeeds, record persistence fails → run P pending.
    h.onSpawn = () => chmodSync(h.dir, 0o500);
    await expect(m.start()).rejects.toBeInstanceOf(Error);
    expect(h.signals).toHaveLength(2); // A's stop + P's in-memory-guard cleanup
    // refresh must NOT report STOPPED while P's daemon is alive and pending.
    const view = await m.refresh();
    expect(view.state).not.toBe("STOPPED");
    expect(view.runId).toBeDefined();

    chmodSync(h.dir, 0o700);
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toHaveLength(2); // no second signal for P (alreadySent)
    h.procs.delete(40_002);
    await stop;
    const final = recordState(h);
    expect(final.state).toBe("stopped");
    expect(final.runId).toBe(view.runId); // the stopped record is P's, not A's
  });

  it("S3-2: identity re-acquisition refuses a forged argv containing the substrings", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001); // identity capture window expires → pending
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined();
    // PID reused by a forged command that CONTAINS both substrings.
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, {
      pid: 40_001,
      command: `bash -c 'exec -a "x --profile-file ${h.profilePath}" sleep 1000'`,
      startedKey: "Wed Oct 21 00:00:00 2026",
    });
    await expect(m.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0); // forged argv never signalled
    // The exact expected command line IS adopted and stoppable.
    h.procs.set(40_001, {
      pid: 40_001,
      command: `${h.client} run --profile-file ${h.profilePath}`,
      startedKey: "Wed Oct 21 00:00:01 2026",
    });
    const stop = m.stop({ graceMs: 300 });
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(1);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });

  it("C-v3-2/S3-1: a reclaim that grabbed a live successor rolls back and refuses", async () => {
    const h = makeHarness();
    mkdirSync(`${h.statePath}.lock.d`);
    writeFileSync(`${h.statePath}.lock.d/holder.json`, JSON.stringify({ token: "stale-tok", pid: 999_999, startedKey: "n/a" }));
    // Between the staleness judgement (a slow ps call) and the rename, a live
    // successor takes the lock.
    let swapped = false;
    h.onInspect = (pid) => {
      if (pid === 999_999 && !swapped) {
        swapped = true;
        const d = `${h.statePath}.lock.d`;
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d);
        writeFileSync(`${d}/holder.json`, JSON.stringify({ token: "winner", pid: process.pid, startedKey: SELF_KEY }));
      }
    };
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    // The successor's lock was rolled back intact, never deleted.
    const holder = JSON.parse(readFileSync(`${h.statePath}.lock.d/holder.json`, "utf8")) as { token: string };
    expect(holder.token).toBe("winner");
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("C-v3-3: a leaked lock is reclaimable by a NEW manager in the same process", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    // Release fails while keeping holder.json readable: lock dir not writable,
    // parent not writable → token lands in the process-wide leaked set.
    h.onSpawn = () => {
      chmodSync(`${h.statePath}.lock.d`, 0o555);
      chmodSync(h.dir, 0o500);
    };
    const m1 = createBackgroundTunnelManager(h.options);
    await expect(m1.start()).rejects.toBeInstanceOf(Error);
    h.onSpawn = undefined; // the sabotage applies to m1's start only
    chmodSync(h.dir, 0o700);
    chmodSync(`${h.statePath}.lock.d`, 0o755);
    h.procs.delete(40_001); // m1's failed-start daemon is gone
    // A rebuilt manager (fresh manager scope, same process) reclaims it.
    const m2 = createBackgroundTunnelManager(h.options);
    await expect(m2.start()).rejects.toMatchObject({ code: "CE_TUNNEL_READY_TIMEOUT" });
    expect(h.spawnCalls).toHaveLength(2); // reclaim worked; start proceeded
  });

  it("C-v3-6: a health completion older than the baseline is never credited", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    const m2 = createBackgroundTunnelManager(h.options); // adopted run
    let regressed = false;
    h.onProbe = () => { if (!regressed) { regressed = true; h.clock -= 1_000; } };
    h.probes.push(healthyProbe(), healthyProbe(), healthyProbe());
    // The completion predates the run baseline: the frozen machine must never
    // credit it. (Baseline AFTER the probe — the v2 defect — would instead
    // accept this probe and report CONNECTED, failing this assertion.)
    const first = await m2.refresh();
    expect(first.state).not.toBe("CONNECTED");
    // A startedAt > now observation terminally fences the run in the frozen
    // machine, so it stays fenced rather than recovering from bad evidence.
    expect((await m2.refresh()).state).not.toBe("CONNECTED");
    expect((await m2.refresh()).state).not.toBe("CONNECTED");
  });

  it("S3-5: quoted scalars reject control characters and line separators", async () => {
    for (const bad of ["\u2028", "\x07", "\u0085"]) {
      const h = makeHarness();
      writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8").replace(
        `file:${h.keyPath}`, `file:${h.keyPath}${bad}x`));
      await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    }
  });
  it("C-v4-2: a live foreign run's record is never overwritten by pending state", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    const firstStop = m.stop();
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    h.procs.delete(40_001);
    await firstStop; // run A stopped on disk

    // Start run P: spawn ok, persist fails → pending.
    h.onSpawn = () => chmodSync(h.dir, 0o500);
    await expect(m.start()).rejects.toBeInstanceOf(Error);
    expect(h.signals).toHaveLength(2); // P was signalled once (in-memory guard)
    h.onSpawn = undefined;
    chmodSync(h.dir, 0o700);
    // Age the leaked lock from the failed start so the foreign session can act.
    const leaked = `${h.statePath}.lock.d`;
    try { const aged = new Date(Date.now() - 120_000); utimesSync(leaked, aged, aged); } catch { /* gone */ }

    // A foreign session persists its own LIVE run B (different runId).
    const runB = {
      version: 1, runId: "bg-run-b", pid: 40_010, profilePath: h.profilePath,
      profileSha256: "c".repeat(64), tunnelId: TUNNEL_ID, keyFile: h.keyPath,
      urlFile: join(h.dir, "health.url"), logPath: join(h.dir, "background-tunnel.log"),
      commandIdentity: `${h.client} run --profile-file ${h.profilePath}`,
      processStartedKey: "Tue Oct 20 08:00:00 2026", startedAt: Date.now(),
      state: "running",
    };
    const runBBytes = JSON.stringify(runB);
    writeFileSync(h.statePath, runBBytes, { mode: 0o600 });
    h.procs.set(40_010, { pid: 40_010, command: runB.commandIdentity, startedKey: runB.processStartedKey });

    // P's daemon has exited. This test pins the reloadRecord NARROWING: if
    // pending wrongly outranked a LIVE foreign record, the in-memory view would
    // become P (not B) — the runId assertion below fails directly, independent
    // of the persist-level guard. The byte assertion adds that B's record is
    // also untouched on disk. (The persist cross-run guard itself — the third
    // defence — is pinned separately by S5-1.)
    h.procs.delete(40_002);
    h.probes.push(UNREACHABLE);
    await m.refresh();
    expect(m.runId()).toBe(runB.runId); // narrowing: live B outranks pending P
    expect(readFileSync(h.statePath, "utf8")).toBe(runBBytes);
  });

  it("C-v4-3: an identity-pending run whose process exited stops cleanly", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001); // identity capture expires → identityPending
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined();
    // The spawned child is gone for good; stop must terminate cleanly instead
    // of wedging on CE_TUNNEL_STATE_CORRUPT.
    h.unknownPids.delete(40_001);
    h.procs.delete(40_001);
    await m.stop({ graceMs: 300 });
    expect(m.runId()).toBeUndefined();
    expect(h.signals).toHaveLength(0);
    expect(recordState(h).state).toBe("stopped"); // final persist stripped the flag
    // And a second stop is a clean no-op.
    await m.stop();
  });

  it("F3/S3-1: losing the lock mid-critical-section fails closed (BUSY, no record write)", async () => {
    const h = makeHarness();
    // A reclaimer steals the lock during identity capture: the next persist
    // must refuse, and no record may be written.
    let stolen = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !stolen) {
        stolen = true;
        const d = `${h.statePath}.lock.d`;
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d);
        writeFileSync(`${d}/holder.json`, JSON.stringify({ token: "thief", pid: process.pid, startedKey: SELF_KEY }));
      }
    };
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    expect(recordStateOrAbsent(h)).toBe(true);
  });

  it("S3-7: refresh absence persists the lock-fresh record (ledger fields kept)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    // Another session records its termination intent while our refresh waits.
    let stamped = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !stamped) {
        stamped = true;
        const rec = JSON.parse(readFileSync(h.statePath, "utf8")) as Record<string, unknown>;
        rec.termRequestedAt = Date.now();
        writeFileSync(h.statePath, JSON.stringify(rec), { mode: 0o600 });
        h.procs.delete(40_001); // the daemon exits after the foreign SIGTERM
      }
    };
    await m.refresh();
    const final = recordState(h);
    expect(final.state).toBe("stopped");
    expect(final.termRequestedAt).toBeDefined(); // the foreign ledger survived
    expect(String(final.note)).toContain("SIGTERM"); // attribution is correct
  });
  it("S5-1: persist refuses to overwrite a foreign LIVE record (byte-identical after)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    // During stop's exit wait, a foreign session installs its own LIVE run B.
    let swapped = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && h.signals.length === 1 && !swapped) {
        swapped = true;
        h.procs.delete(40_001); // A exits from the signal
        const runB = {
          version: 1, runId: "bg-run-b", pid: 40_010, profilePath: h.profilePath,
          profileSha256: "d".repeat(64), tunnelId: TUNNEL_ID, keyFile: h.keyPath,
          urlFile: join(h.dir, "health.url"), logPath: join(h.dir, "background-tunnel.log"),
          commandIdentity: `${h.client} run --profile-file ${h.profilePath}`,
          processStartedKey: "Tue Oct 20 09:00:00 2026", startedAt: Date.now(),
          state: "running",
        };
        writeFileSync(h.statePath, JSON.stringify(runB), { mode: 0o600 });
        h.procs.set(40_010, { pid: 40_010, command: runB.commandIdentity, startedKey: runB.processStartedKey });
      }
    };
    await expect(m.stop()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    const after = recordState(h) as { runId: string; state: string };
    expect(after.runId).toBe("bg-run-b"); // B's record is byte-equivalent, not rolled back
    expect(after.state).toBe("running");
  });

  it("S5-2/F2: a still-holderless successor created in the judge window is rolled back", async () => {
    const h = makeHarness();
    // Aged holderless lock (crashed acquirer).
    mkdirSync(`${h.statePath}.lock.d`);
    const past = new Date(Date.now() - 120_000);
    utimesSync(`${h.statePath}.lock.d`, past, past);
    // In the judge→rename window a successor creates a NEW, still-holderless lock.
    const probe = () => {
      const d = `${h.statePath}.lock.d`;
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d); // successor has not written its holder yet
    };
    const m = createBackgroundTunnelManager({ ...h.options, reclaimProbe: probe });
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    // The successor's directory survives (rollback), and we never spawned.
    const successor = lstatSync(`${h.statePath}.lock.d`);
    expect(successor.isDirectory()).toBe(true);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it("C-v5-2/S5-7: stop handles a foreign live run AND the surviving pending run", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    const firstStop = m.stop();
    for (let i = 0; i < 200 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    h.procs.delete(40_001);
    await firstStop; // run A stopped

    // Run P: spawn ok, persist fails → pending (signalled once by cleanup guard).
    h.onSpawn = () => chmodSync(h.dir, 0o500);
    await expect(m.start()).rejects.toBeInstanceOf(Error);
    h.onSpawn = undefined;
    const pendingRunId = m.runId(); // P's id while it is still owned in memory
    expect(pendingRunId).toBeDefined();
    expect(h.signals).toHaveLength(2);
    chmodSync(h.dir, 0o700);
    try { const aged = new Date(Date.now() - 120_000); utimesSync(`${h.statePath}.lock.d`, aged, aged); } catch { /* gone */ }

    // Foreign session's live run B takes the record.
    const runB = {
      version: 1, runId: "bg-run-b", pid: 40_010, profilePath: h.profilePath,
      profileSha256: "e".repeat(64), tunnelId: TUNNEL_ID, keyFile: h.keyPath,
      urlFile: join(h.dir, "health.url"), logPath: join(h.dir, "background-tunnel.log"),
      commandIdentity: `${h.client} run --profile-file ${h.profilePath}`,
      processStartedKey: "Tue Oct 20 09:30:00 2026", startedAt: Date.now(),
      state: "running",
    };
    writeFileSync(h.statePath, JSON.stringify(runB), { mode: 0o600 });
    h.procs.set(40_010, { pid: 40_010, command: runB.commandIdentity, startedKey: runB.processStartedKey });

    // S6-1: P is STILL ALIVE (its cleanup SIGTERM was delivered but it has not
    // exited). A single stop must NOT silently succeed while P survives: it
    // stops B, refuses with STOP_UNCONFIRMED, and discloses the orphan.
    const stop1 = m.stop({ graceMs: 300 });
    for (let i = 0; i < 300 && h.signals.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(3); // A + P(cleanup) + B; P was NOT signalled again
    h.procs.delete(40_010); // B exits
    await expect(stop1).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(m.status().note).toContain("run stop again");
    const rec1 = recordState(h) as { runId: string; state: string };
    expect(rec1.runId).toBe("bg-run-b");
    expect(rec1.state).toBe("stopped");
    // P remains owned and stoppable via a second stop once it exits.
    expect(m.runId()).toBeUndefined(); // disk view resolved
    const pRunId = pendingRunId; // captured when P's start failed
    h.procs.delete(40_002);
    await m.stop();
    const rec2 = recordState(h) as { runId: string; state: string };
    expect(rec2.state).toBe("stopped");
    expect(rec2.runId).toBe(pRunId); // P's closure actually persisted (F4)
    expect(h.signals).toHaveLength(3); // still no second signal for P
  });

  it("C-v5-3: refresh resolves an identity-pending run under the lock and persists it", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    // Identity becomes knowable: exact argv appears.
    h.unknownPids.delete(40_001);
    h.probes.push(UNREACHABLE);
    await m.refresh();
    const rec = recordState(h) as Record<string, unknown>;
    expect(rec.identityPending).toBeUndefined(); // stripped on persist
    expect(rec.commandIdentity).toBe(`${h.client} run --profile-file ${h.profilePath}`);
    expect(rec.state).toBe("running");
    expect(m.runId()).toBeDefined();
  });
  it("S6-3/F6: grave sweep removes only AGED graves of THIS lock", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    // Three siblings: aged grave of THIS lock, young grave of THIS lock,
    // aged grave of a DIFFERENT lock.
    const thisLock = `${h.statePath}.lock.d`;
    const agedMine = `${thisLock}.reclaim-aaa`;
    const youngMine = `${thisLock}.reclaim-bbb`;
    const other = `${h.statePath}.OTHER.lock.d.reclaim-ccc`;
    mkdirSync(agedMine);
    mkdirSync(youngMine);
    mkdirSync(other);
    const past = new Date(Date.now() - 120_000);
    utimesSync(agedMine, past, past);
    utimesSync(other, past, past);
    // The sweep runs during the start's first acquireLock; the start itself
    // succeeds on the injected healthy probe.
    await m.start();
    expect(() => lstatSync(agedMine)).toThrow(); // aged + this lock → swept
    expect(lstatSync(youngMine).isDirectory()).toBe(true); // young → kept
    expect(lstatSync(other).isDirectory()).toBe(true); // foreign → kept
  });
  it("F1: a lost lock during the signal phase never burns the once-set (later stop still signals once)", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    // spawn succeeds, then the state dir goes unwritable → persist fails → P pending.
    h.onSpawn = () => chmodSync(h.dir, 0o500);
    const m = createBackgroundTunnelManager(h.options);
    // During the failed start's CLEANUP termination, steal the lock: the
    // second inspect of P (first is identity capture, second is cleanup) swaps
    // the holder for a foreign token, so the signal phase loses the lock.
    let inspectCount = 0;
    h.onInspect = (pid) => {
      if (pid === 40_001 && ++inspectCount === 2) {
        writeFileSync(`${h.statePath}.lock.d/holder.json`, JSON.stringify({ token: "thief", pid: process.pid, startedKey: SELF_KEY }));
      }
    };
    await expect(m.start()).rejects.toBeInstanceOf(Error);
    // The lock was lost during cleanup: P must NOT have been signalled, and the
    // once-set must NOT have been burned (ownership retained).
    expect(h.signals).toHaveLength(0);
    expect(m.runId()).toBeDefined();

    // Restore a usable lock and dir; a later stop must deliver P's ONLY signal.
    chmodSync(h.dir, 0o700);
    rmSync(`${h.statePath}.lock.d`, { recursive: true, force: true });
    const stop = m.stop({ graceMs: 300 });
    for (let i = 0; i < 300 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(1); // P signalled exactly once, by THIS stop
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });
  it("S8-2/S9-1: losing the lock at the SIGNAL phase yields STOP_UNCONFIRMED, zero signal, ownership kept", { timeout: 20_000 }, async () => {
    const h = makeHarness();
    // An UNPERSISTED identity-pending run (identity capture failed) has never
    // been signalled. Its stop takes the pending fallback, which sets
    // maySignal, so the signal-phase lock re-check is genuinely reached.
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(h.signals).toHaveLength(0);
    expect(m.runId()).toBeDefined();

    // Identity becomes knowable (exact argv is already in the process table).
    h.unknownPids.delete(40_001);
    // Steal the lock during stop's re-inspection: the pending fallback sets
    // maySignal, then the signal-phase re-check loses the lock → "unknown".
    h.onInspect = (pid) => {
      if (pid === 40_001) {
        writeFileSync(`${h.statePath}.lock.d/holder.json`, JSON.stringify({ token: "thief", pid: process.pid, startedKey: SELF_KEY }));
      }
    };
    await expect(m.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0); // lock lost at signal → no signal, once-set unburned
    expect(m.runId()).toBeDefined(); // ownership retained

    // Restore the lock; a later stop delivers the ONE signal and closes out.
    h.onInspect = undefined;
    rmSync(`${h.statePath}.lock.d`, { recursive: true, force: true });
    const stop2 = m.stop({ graceMs: 300 });
    for (let i = 0; i < 300 && h.signals.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(h.signals).toHaveLength(1);
    h.procs.delete(40_001);
    await stop2;
    expect(recordState(h).state).toBe("stopped");
  });
  it("S8-1/C9-2: identity resolution preserves a concurrent stop's ledger", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    const pRunId = m.runId()!;
    h.unknownPids.delete(40_001);
    // During refresh's inspect, a concurrent session persists P's identity +
    // termRequestedAt (stop-unconfirmed) to disk.
    let injected = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !injected) {
        injected = true;
        const rec = diskRecord(h, pRunId, 40_001, { termRequestedAt: Date.now(), state: "stop-unconfirmed" });
        writeFileSync(h.statePath, JSON.stringify(rec), { mode: 0o600 });
      }
    };
    h.probes.push(UNREACHABLE);
    await m.refresh();
    const rec = recordState(h) as Record<string, unknown>;
    expect(rec.termRequestedAt).toBeDefined(); // ledger preserved, not rolled back
    expect(rec.state).toBe("stop-unconfirmed");
  });

  it("S8-1/C9-2: identity resolution never resurrects a stopped record", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    const pRunId = m.runId()!;
    h.unknownPids.delete(40_001);
    let injected = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !injected) {
        injected = true;
        const rec = diskRecord(h, pRunId, 40_001, { termRequestedAt: Date.now(), stoppedAt: Date.now(), state: "stopped" });
        writeFileSync(h.statePath, JSON.stringify(rec), { mode: 0o600 });
      }
    };
    h.probes.push(UNREACHABLE);
    const status = await m.refresh();
    expect(status.state).toBe("STOPPED");
    const rec = recordState(h) as Record<string, unknown>;
    expect(rec.state).toBe("stopped"); // never resurrected
  });
});

describe("LOCAL-BACKGROUND-03 — F2 Homebrew wrapper exec identity", () => {
  // BACKGROUND-02 real-run evidence: /opt/homebrew/bin/tunnel-client is a
  // two-line brew shim (`#!/bin/bash` + `exec "<Cellar libexec>" "$@"`).
  // ps first shows `/bin/bash <shim> run …`, then after exec `<cellar> run …`
  // — same pid, same lstart. The exact-argv matcher misjudged the exec'd form
  // as EXTERNAL_INSTANCE / STOP_UNCONFIRMED (fail-closed but unmanageable).
  const WRAP_KEY = "Tue Oct 20 06:30:09 2026"; // exec preserves pid + lstart
  const bashForm = (h: Harness): string => `/bin/bash ${h.client} run --profile-file ${h.profilePath}`;
  const execForm = (h: Harness, cellar: string): string => `${cellar} run --profile-file ${h.profilePath}`;

  /** Turn h.client into a brew-style wrapper script exec'ing `cellar`. */
  const writeWrapper = (h: Harness, cellar: string): void => {
    mkdirSync(dirname(cellar), { recursive: true });
    writeFileSync(cellar, "client-binary", { mode: 0o755 });
    writeFileSync(h.client, `#!/bin/bash\nexec "${cellar}" "$@"\n`, { mode: 0o755 });
  };

  /** First inspection of pid sees the pre-exec bash form (kernel shebang). */
  const capturePreExec = (h: Harness): void => {
    let armed = true;
    h.onInspect = (pid) => {
      if (armed && pid === 40_001) {
        armed = false;
        h.procs.set(pid, { pid, command: bashForm(h), startedKey: WRAP_KEY });
      }
    };
  };

  it("F2 core: a session-B manager recognizes and stops the exec'd wrapper instance", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    await m1.start();
    // Identity was captured in the pre-exec bash form (as in the real run).
    expect(recordState(h).commandIdentity).toBe(bashForm(h));
    // bash now execs the real binary: same pid, same startedKey, new argv0.
    h.onInspect = undefined;
    h.procs.set(40_001, { pid: 40_001, command: execForm(h, cellar), startedKey: WRAP_KEY });
    // A fresh Pi session must recognize THIS instance, not misread it as foreign.
    const m2 = createBackgroundTunnelManager(h.options);
    h.probes.push(healthyProbe());
    await m2.refresh();
    expect(m2.status().note ?? "").not.toContain("identity mismatch");
    const stop = m2.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
    expect(m2.status().state).toBe("STOPPED");
  });

  it("F2: duplicate start after wrapper exec reports alreadyRunning, not EXTERNAL_INSTANCE", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    const started = await m1.start();
    h.onInspect = undefined;
    h.procs.set(40_001, { pid: 40_001, command: execForm(h, cellar), startedKey: WRAP_KEY });
    const m2 = createBackgroundTunnelManager(h.options);
    const again = await m2.start();
    expect(again.alreadyRunning).toBe(true);
    expect(again.runId).toBe(started.runId);
    expect(h.spawnCalls).toHaveLength(1); // never a second instance
  });

  it("F2: identity captured AFTER the exec (post-exec form) stays manageable", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    // The exec lands before the first ps sample: capture sees the cellar form.
    h.onInspect = (pid) => {
      if (pid === 40_001) h.procs.set(pid, { pid, command: execForm(h, cellar), startedKey: WRAP_KEY });
    };
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    await m1.start();
    expect(recordState(h).commandIdentity).toBe(execForm(h, cellar));
    h.onInspect = undefined;
    const m2 = createBackgroundTunnelManager(h.options);
    const stop = m2.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });

  it("F2: a direct (non-script) client gains NO exec alternative and keeps exact matching", async () => {
    const h = makeHarness();
    writeFileSync(h.client, "not-a-script-binary", { mode: 0o755 });
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    await m1.start();
    const rec = recordState(h);
    expect("commandIdentityExec" in rec).toBe(false);
    // Exact form still manages; a rewritten argv0 still refuses.
    h.procs.set(40_001, { pid: 40_001, command: `/usr/local/bin/${basename(h.client)} run --profile-file ${h.profilePath}`, startedKey: WRAP_KEY });
    const m2 = createBackgroundTunnelManager(h.options);
    await m2.refresh();
    expect(m2.status().state).toBe("UNKNOWN");
    await expect(m2.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0);
  });

  it("F2: a missing client binary gains NO exec alternative (default harness)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    const m1 = createBackgroundTunnelManager(h.options);
    await m1.start();
    expect("commandIdentityExec" in recordState(h)).toBe(false);
  });

  it("F2: PID reuse with the exec'd argv (same argv, different lstart) refuses", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    h.onInspect = undefined;
    // The daemon died and the pid was recycled by a same-argv process.
    h.procs.set(40_001, { pid: 40_001, command: execForm(h, cellar), startedKey: "Wed Oct 21 00:00:00 2026" });
    const m2 = createBackgroundTunnelManager(h.options);
    await m2.refresh();
    expect(m2.status().state).toBe("UNKNOWN");
    await expect(m2.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    await expect(m2.start()).rejects.toMatchObject({ code: "CE_TUNNEL_EXTERNAL_INSTANCE" });
    expect(h.signals).toHaveLength(0);
    expect(h.spawnCalls).toHaveLength(1);
  });

  it("F2: a DIFFERENT cellar build (argv mismatch) is never adopted or signalled", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    h.onInspect = undefined;
    h.procs.set(40_001, {
      pid: 40_001,
      command: execForm(h, join(h.dir, "libexec-9.9.9", "tunnel-client")),
      startedKey: WRAP_KEY,
    });
    const m2 = createBackgroundTunnelManager(h.options);
    await m2.refresh();
    expect(m2.status().state).toBe("UNKNOWN");
    await expect(m2.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0);
  });

  it("F2: a forged argv merely CONTAINING the exec form refuses (exact match only)", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    h.onInspect = undefined;
    h.procs.set(40_001, {
      pid: 40_001,
      command: `bash -c 'exec -a "${execForm(h, cellar)}" sleep 1000'`,
      startedKey: WRAP_KEY,
    });
    const m2 = createBackgroundTunnelManager(h.options);
    await expect(m2.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0);
  });

  it("F2: a corrupt commandIdentityExec field fails closed as STATE_CORRUPT", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    const rec = recordState(h);
    writeFileSync(h.statePath, JSON.stringify({ ...rec, commandIdentityExec: 42 }), { mode: 0o600 });
    const m2 = createBackgroundTunnelManager(h.options);
    await expect(m2.start()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    expect(h.spawnCalls).toHaveLength(1);
    writeFileSync(h.statePath, JSON.stringify({ ...rec, commandIdentityExec: "" }), { mode: 0o600 });
    const m3 = createBackgroundTunnelManager(h.options);
    await expect(m3.start()).rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
  });

  it("F2: pending (never-captured) ownership re-acquires the exec'd identity before signalling", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    h.unknownPids.add(40_001); // identity capture window expires → pending
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined(); // ownership retained in memory
    // The child exec's into the cellar form before any later inspection.
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, { pid: 40_001, command: execForm(h, cellar), startedKey: WRAP_KEY });
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(m.runId()).toBeUndefined();
  });

  it("F2: pending re-acquisition also accepts the pre-exec bash form", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, { pid: 40_001, command: bashForm(h), startedKey: WRAP_KEY });
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
  });

  it("F2: pending re-acquisition still refuses a forged/unknown argv", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, { pid: 40_001, command: `/usr/bin/curl --profile-file ${h.profilePath}`, startedKey: WRAP_KEY });
    await expect(m.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(0);
    expect(m.runId()).toBeDefined(); // ownership retained
  });

  it("F2: wrapper stop timeout stays UNKNOWN, retains ownership, and never re-signals", async () => {
    const h = makeHarness();
    const cellar = join(h.dir, "libexec", "tunnel-client");
    writeWrapper(h, cellar);
    capturePreExec(h);
    h.probes.push(healthyProbe());
    const m = createBackgroundTunnelManager(h.options);
    await m.start();
    h.onInspect = undefined;
    h.procs.set(40_001, { pid: 40_001, command: execForm(h, cellar), startedKey: WRAP_KEY });
    await expect(m.stop({ graceMs: 300 })).rejects.toMatchObject({ code: "CE_TUNNEL_STOP_UNCONFIRMED" });
    expect(h.signals).toHaveLength(1);
    expect(recordState(h).state).toBe("stop-unconfirmed");
    const retry = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toHaveLength(1); // ledger: at most one signal
    h.procs.delete(40_001);
    await retry;
    expect(recordState(h).state).toBe("stopped");
  });
});

describe("LOCAL-BACKGROUND-03 — wrapper evidence parser (resolveWrapperIdentityEvidence)", () => {
  const mk = (name: string, text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-wrap-"));
    const p = join(dir, name);
    writeFileSync(p, text, { mode: 0o755 });
    return p;
  };

  it("parses the canonical brew shim (shebang + quoted exec \"$@\")", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-brew-"));
    const cellar = join(dir, "Cellar", "tunnel-client", "0.0.16", "libexec", "tunnel-client");
    mkdirSync(dirname(cellar), { recursive: true });
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const shim = join(dir, "bin", "tunnel-client");
    mkdirSync(dirname(shim), { recursive: true });
    writeFileSync(shim, `#!/bin/bash\nexec "${cellar}" "$@"\n`, { mode: 0o755 });
    const link = join(dir, "linked-tunnel-client");
    symlinkSync(shim, link);
    for (const p of [shim, link]) {
      const ev = resolveWrapperIdentityEvidence(p);
      expect(ev?.shellPrefix).toBe("/bin/bash");
      expect(ev?.execTarget).toBe(cellar);
    }
  });

  it("missing file → undefined (no evidence, fail closed)", () => {
    expect(resolveWrapperIdentityEvidence(join(tmpdir(), "ce-bg03-definitely-missing", "x"))).toBeUndefined();
  });

  it("non-script binary → no forms", () => {
    const p = mk("client", "\x7fELF fake binary");
    expect(resolveWrapperIdentityEvidence(p)).toEqual({});
  });

  it("shebang WITH interpreter args is not accepted as shell-prefix evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-env-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const p = mk("client", `#!/usr/bin/env bash\nexec "${cellar}" "$@"\n`);
    const ev = resolveWrapperIdentityEvidence(p);
    expect(ev?.shellPrefix).toBeUndefined(); // ambiguous interpreter form
    expect(ev?.execTarget).toBe(cellar); // exec evidence still valid
  });

  it("a relative exec target is not evidence", () => {
    const p = mk("client", '#!/bin/bash\nexec "../libexec/tunnel-client" "$@"\n');
    expect(resolveWrapperIdentityEvidence(p)?.execTarget).toBeUndefined();
  });

  it("two exec lines are ambiguous → no exec evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-two-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const p = mk("client", `#!/bin/bash\nexec "${cellar}" "$@"\nexec "${cellar}" "$@"\n`);
    expect(resolveWrapperIdentityEvidence(p)?.execTarget).toBeUndefined();
  });

  it("unquoted or argument-carrying exec lines are not evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-unq-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    expect(resolveWrapperIdentityEvidence(mk("c1", `#!/bin/bash\nexec ${cellar} "$@"\n`))?.execTarget).toBeUndefined();
    expect(resolveWrapperIdentityEvidence(mk("c2", `#!/bin/bash\nexec "${cellar}" --json "$@"\n`))?.execTarget).toBeUndefined();
    expect(resolveWrapperIdentityEvidence(mk("c3", `#!/bin/bash\nexec env FOO=1 "${cellar}" "$@"\n`))?.execTarget).toBeUndefined();
  });

  it("an exec target that does not exist on disk is not evidence", () => {
    const p = mk("client", '#!/bin/bash\nexec "/no/such/cellar/tunnel-client" "$@"\n');
    expect(resolveWrapperIdentityEvidence(p)?.execTarget).toBeUndefined();
  });

  it("a non-normalized exec target is not evidence", () => {
    const p = mk("client", '#!/bin/bash\nexec "/opt/homebrew/../homebrew/Cellar/x" "$@"\n');
    expect(resolveWrapperIdentityEvidence(p)?.execTarget).toBeUndefined();
  });
});

describe("LOCAL-BACKGROUND-03 — C-1 parser strictness (Lane C)", () => {
  const mk2 = (name: string, text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-c1-"));
    const p = join(dir, name);
    writeFileSync(p, text, { mode: 0o755 });
    return p;
  };

  it("C-1: a heredoc body is never exec evidence (Lane C's example)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-c1hd-"));
    const cat = join(dir, "cat-bin");
    writeFileSync(cat, "bin", { mode: 0o755 });
    // Lane C's counterexample: the column-0 exec line sits INSIDE a heredoc
    // (never executed); the REAL exec is the indented line below it.
    const p = mk2("client", '#!/bin/bash\n: <<\'IGNORED\'\nexec "/bin/sleep" "$@"\nIGNORED\n  exec "' + cat + '" "$@"\n');
    const ev = resolveWrapperIdentityEvidence(p);
    expect(ev?.execTarget).toBeUndefined(); // neither the heredoc line nor the indented one
    expect(ev?.shellPrefix).toBe("/bin/bash"); // shebang evidence stands on its own
  });

  it("C-1: extra statements (set -e / exports) forfeit exec evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-c1ex-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const withSet = mk2("c1", '#!/bin/bash\nset -e\nexec "' + cellar + '" "$@"\n');
    expect(resolveWrapperIdentityEvidence(withSet)?.execTarget).toBeUndefined();
    const withExport = mk2("c2", '#!/bin/bash\nexport HOMEBREW_PREFIX=/opt/homebrew\nexec "' + cellar + '" "$@"\n');
    expect(resolveWrapperIdentityEvidence(withExport)?.execTarget).toBeUndefined();
  });

  it("C-1: comments and blanks around one strict exec line keep evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-c1ok-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const p = mk2("client", '#!/bin/bash\n# Homebrew shim\n\nexec "' + cellar + '" "$@"\n');
    const ev = resolveWrapperIdentityEvidence(p);
    expect(ev?.shellPrefix).toBe("/bin/bash");
    expect(ev?.execTarget).toBe(cellar);
  });

  it("C-1: an indented exec line alone is not evidence (column-0 only)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-bg03-c1in-"));
    const cellar = join(dir, "cellar-bin");
    writeFileSync(cellar, "bin", { mode: 0o755 });
    const p = mk2("client", '#!/bin/bash\n  exec "' + cellar + '" "$@"\n');
    expect(resolveWrapperIdentityEvidence(p)?.execTarget).toBeUndefined();
  });
});

describe("LOCAL-BACKGROUND-03 — S-1 pending run vs PID reuse (Lane S)", () => {
  // A pending (never-identity-captured) run has NO startedKey anchor. Before
  // the fix, re-acquisition trusted argv membership alone: if our spawn died
  // and a foreign process with an allowed argv recycled the pid, stop() would
  // adopt the foreign process's startedKey and SIGTERM it. The child handle's
  // exit event is spawn-linked death proof that bars adoption and signalling.

  it("S-1: pending run + exited spawn + same-argv pid reuser → no adoption, no signal", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001); // capture window expires → identityPending
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined(); // pending ownership retained in memory
    // Our spawn dies; a foreign process with an allowed argv recycles the pid.
    h.fireExit(40_001);
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    await m.stop({ graceMs: 300 });
    expect(h.signals).toHaveLength(0); // foreign process never signalled
    expect(m.runId()).toBeUndefined(); // pending run closed via spawn-link exit proof
    const rec = recordState(h);
    expect(rec.state).toBe("stopped");
    expect(rec.processStartedKey ?? "").not.toBe("Wed Oct 21 00:00:00 2026"); // foreign anchor never adopted
    expect(rec.note).toBe("exit observed (process already gone); no signal sent"); // C-v2-1: exact honest wording
  });

  it("S-1: refresh treats an exited pending spawn as proven exit, never adopts the reuser", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.fireExit(40_001);
    h.unknownPids.delete(40_001);
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    h.probes.push(UNREACHABLE);
    await m.refresh();
    expect(m.status().state).not.toBe("CONNECTED");
    expect(m.status().state).not.toBe("DEGRADED");
    // The refresh persists the exit with the child-link wording (C-v2-1 exact).
    const rec = recordState(h);
    expect(rec.state).toBe("stopped");
    expect(rec.note).toBe("spawn exit observed via child link; no respawn");
    // A later stop is a no-op; the foreign reuser is never signalled.
    await m.stop({ graceMs: 300 });
    expect(h.signals).toHaveLength(0);
  });

  it("S-1: exit INSIDE the capture window (before the pending record) still bars adoption and signal", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001); // the capture loop keeps seeing "unknown"…
    let fired = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !fired) {
        fired = true;
        h.fireExit(40_001); // …while the child dies mid-window, pre-record
      }
    };
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined(); // pending ownership, exit evidence inherited
    h.onInspect = undefined;
    h.unknownPids.delete(40_001);
    // A foreign same-argv process recycles the pid.
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    await m.stop({ graceMs: 300 });
    expect(h.signals).toHaveLength(0);
    const rec = recordState(h);
    expect(rec.state).toBe("stopped");
    expect(rec.note).toBe("exit observed (process already gone); no signal sent");
    expect(rec.processStartedKey ?? "").not.toBe("Wed Oct 21 00:00:00 2026");
  });

  it("S-1: a LIVE pending spawn still re-acquires and stops normally (guard is precise)", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    // No exit event: the pid still belongs to our spawn; argv match adopts it.
    h.unknownPids.delete(40_001);
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(m.runId()).toBeUndefined();
  });

  it("S-1: exit AFTER adoption keeps the adopted anchors (normal termination path)", async () => {
    const h = makeHarness();
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.unknownPids.delete(40_001);
    // Adopt while alive (argv match + live child link), then the child exits.
    const stop = m.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.fireExit(40_001);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
    expect(recordState(h).note).toContain("SIGTERM"); // signalled run keeps honest wording
  });
});

describe("LOCAL-BACKGROUND-03 — C-v2-3 record hygiene", () => {
  it("a null commandIdentityExec on disk normalizes to absent (declared type preserved)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    const rec = recordState(h);
    writeFileSync(h.statePath, JSON.stringify({ ...rec, commandIdentityExec: null }), { mode: 0o600 });
    const m2 = createBackgroundTunnelManager(h.options);
    h.probes.push(healthyProbe());
    await m2.refresh(); // loads fine; null behaves exactly as absent
    expect(m2.status().state).toBe("CONNECTED");
    const stop = m2.stop({ graceMs: 300 });
    await flush();
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });
});

describe("LOCAL-BACKGROUND-03 — v4 structural findings (Lane C F1/F2)", () => {
  it("F1: a second start must NOT sever a surviving pending run's exit binding (no signal to the reuser)", async () => {
    const h = makeHarness();
    // start#1: the child dies INSIDE the capture window (the dominant pending
    // path) — pending run#1 carries spawn-linked exit evidence for pid 40001.
    h.unknownPids.add(40_001);
    let fired = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !fired) {
        fired = true;
        h.fireExit(40_001);
        h.procs.delete(40_001); // a dead child disappears from ps
      }
    };
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined();
    h.onInspect = undefined;
    h.unknownPids.delete(40_001);
    // A foreign-session record whose pid is absent lets start#2 proceed (it is
    // markStopped first) — the S5-7 dual-run shape this regression guards.
    writeFileSync(h.statePath, JSON.stringify(diskRecord(h, "foreign-run", 50_001)), { mode: 0o600 });
    // start#2 succeeds (spawn seam pid 40002, identity captured, persisted).
    // v3 reset the single-slot evidence here, severing run#1's binding.
    h.probes.push(healthyProbe(), healthyProbe(), healthyProbe(), healthyProbe());
    await m.start();
    expect(m.status().state).toBe("CONNECTED");
    // The dead child's pid is recycled by a foreign same-argv process.
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    const stop = m.stop({ graceMs: 300 });
    await flush();
    // The foreign reuser at 40001 is never signalled; the live run#2 daemon is.
    expect(h.signals.filter((s) => s.pid === 40_001)).toHaveLength(0);
    expect(h.signals.filter((s) => s.pid === 40_002)).toEqual([{ pid: 40_002, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    h.procs.delete(40_002);
    await stop;
    expect(recordState(h).state).toBe("stopped");
  });

  it("F2: a null termRequestedAt on disk normalizes to absent (termination is not suppressed)", async () => {
    const h = makeHarness();
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    const rec = recordState(h);
    writeFileSync(h.statePath, JSON.stringify({ ...rec, termRequestedAt: null }), { mode: 0o600 });
    const m2 = createBackgroundTunnelManager(h.options);
    const stop = m2.stop({ graceMs: 300 });
    await flush();
    // A foreign null must NOT read as "SIGTERM already requested".
    expect(h.signals).toEqual([{ pid: 40_001, signal: "SIGTERM" }]);
    h.procs.delete(40_001);
    await stop;
    const after = recordState(h);
    expect(after.state).toBe("stopped");
    expect(after.note).toBe("exit observed after SIGTERM"); // honest: we DID signal
  });
});

describe("LOCAL-BACKGROUND-03 — v5 findings (Lane S S4-1 / Lane C C-v4-1)", () => {
  it("S4-1: dispose() must NOT sever a surviving pending run's exit proof (no signal to the reuser)", async () => {
    const h = makeHarness();
    // start: the child dies inside the capture window → pending run, exit proof
    // archived for pid 40001.
    h.unknownPids.add(40_001);
    let fired = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !fired) {
        fired = true;
        h.fireExit(40_001);
        h.procs.delete(40_001);
      }
    };
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    expect(m.runId()).toBeDefined();
    h.onInspect = undefined;
    h.unknownPids.delete(40_001);
    // Session teardown: dispose must NOT clear the archived exit proof.
    await m.dispose();
    // The dead child's pid is recycled by a foreign same-argv process.
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    await m.stop({ graceMs: 300 });
    expect(h.signals).toHaveLength(0); // foreign reuser never signalled
    const rec = recordState(h);
    expect(rec.state).toBe("stopped");
    expect(rec.note).toBe("exit observed (process already gone); no signal sent");
    expect(rec.processStartedKey ?? "").not.toBe("Wed Oct 21 00:00:00 2026");
  });

  it("C-v4-1: a pending run whose process is gone is superseded (start succeeds, no misleading STATE_CORRUPT)", async () => {
    const h = makeHarness();
    // start#1: child dies in the capture window → pending run, no disk record.
    h.unknownPids.add(40_001);
    let fired = false;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !fired) {
        fired = true;
        h.fireExit(40_001);
        h.procs.delete(40_001);
      }
    };
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.onInspect = undefined;
    h.unknownPids.delete(40_001);
    // start#2 must supersede the absent pending run (spawn #2) rather than
    // throw CE_TUNNEL_STATE_CORRUPT.
    h.probes.push(healthyProbe(), healthyProbe(), healthyProbe(), healthyProbe());
    await m.start();
    expect(m.status().state).toBe("CONNECTED");
    expect(h.spawnCalls).toHaveLength(2);
  });
});

describe("LOCAL-BACKGROUND-03 — v6 finding (Lane C C-v5-1)", () => {
  it("C-v5-1: dispose racing an in-flight start does not drop the exit proof (no signal to the reuser)", async () => {
    const h = makeHarness();
    // The child dies inside the capture window; dispose is invoked from the
    // inspect seam WHILE start is still in flight (pending record not yet set).
    h.unknownPids.add(40_001);
    const m = createBackgroundTunnelManager(h.options);
    let fired = false;
    let disposePromise: Promise<void> | undefined;
    h.onInspect = (pid) => {
      if (pid === 40_001 && !fired) {
        fired = true;
        h.fireExit(40_001); // exit proof archived for run#1 …
        h.procs.delete(40_001);
        disposePromise = m.dispose(); // … then dispose races the in-flight start
      }
    };
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
    h.onInspect = undefined;
    h.unknownPids.delete(40_001);
    await disposePromise; // dispose settles only after the start settles
    // The dead child's pid is recycled by a foreign same-argv process.
    h.procs.set(40_001, { pid: 40_001, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "Wed Oct 21 00:00:00 2026" });
    await m.stop({ graceMs: 300 });
    expect(h.signals).toHaveLength(0); // exit proof survived dispose
    const rec = recordState(h);
    expect(rec.state).toBe("stopped");
    expect(rec.processStartedKey ?? "").not.toBe("Wed Oct 21 00:00:00 2026");
  });
});

describe("LOCAL-BACKGROUND-05 — profile-only organization context", () => {
  const ORG = "org-TestOrganization123"; // synthetic, never an operator identifier
  function addControlFields(h: Harness, fields: string): string {
    const text = readFileSync(h.profilePath, "utf8").replace("control_plane:\n", `control_plane:\n${fields}\n`);
    writeFileSync(h.profilePath, text, { mode: 0o600 });
    return text;
  }

  it("accepts an organization in the exact profile passed to spawn, without argv or environment overrides", async () => {
    const h = makeHarness({
      CONTROL_PLANE_ORGANIZATION_ID: "org-ConflictingParent",
      CONTROL_PLANE_TUNNEL_ID: "tunnel_conflictingparent",
      CONTROL_PLANE_EXTRA_HEADERS: "OpenAI-Organization: org-ConflictingHeader",
      CONTROL_PLANE_API_KEY: "synthetic-parent-not-a-real-key",
      OPENAI_API_KEY: "synthetic-parent-not-a-real-key",
      TUNNEL_CLIENT_CONFIG: "/tmp/untrusted-config.yaml",
      TUNNEL_CLIENT_PROFILE_FILE: "/tmp/untrusted-profile.yaml",
    });
    const expectedProfile = addControlFields(h, `  organization_id: "${ORG}"`);
    let called = false;
    const spawn = h.options.spawn!;
    const m = createBackgroundTunnelManager({ ...h.options, spawn: (exe, args, opts) => {
      called = true;
      expect(args).toEqual(["run", "--profile-file", h.profilePath]);
      expect(readFileSync(args[2]!, "utf8")).toBe(expectedProfile);
      expect(expectedProfile).toContain(`  organization_id: "${ORG}"`);
      for (const name of Object.keys(h.options.env).filter((name) => /^(CONTROL_PLANE_|OPENAI_|TUNNEL_CLIENT_)/.test(name))) {
        expect(opts.env[name], name).toBeUndefined();
      }
      return spawn(exe, args, opts);
    } });
    h.probes.push(healthyProbe());
    await m.start();
    expect(called).toBe(true);
    expect(h.spawnCalls).toHaveLength(1);
    expect(readFileSync(h.profilePath, "utf8")).toBe(expectedProfile);
  });

  it("keeps missing organization backwards compatible and does not inherit one from the parent", async () => {
    const h = makeHarness({ CONTROL_PLANE_ORGANIZATION_ID: "org-ParentOnly" });
    const spawn = h.options.spawn!;
    const m = createBackgroundTunnelManager({ ...h.options, spawn: (exe, args, opts) => {
      expect(readFileSync(args[2]!, "utf8")).not.toContain("organization_id:");
      expect(opts.env.CONTROL_PLANE_ORGANIZATION_ID).toBeUndefined();
      return spawn(exe, args, opts);
    } });
    h.probes.push(healthyProbe());
    await m.start();
    expect(h.spawnCalls).toHaveLength(1); // seam health is not real authentication
  });

  it.each([
    ["empty", '  organization_id: ""'],
    ["bare prefix", '  organization_id: "org-"'],
    ["wrong prefix", '  organization_id: "team-Abc123"'],
    ["unquoted", '  organization_id: org-Abc123'],
    ["single quoted", "  organization_id: 'org-Abc123'"],
    ["leading whitespace", '  organization_id: " org-Abc123"'],
    ["trailing whitespace", '  organization_id: "org-Abc123 "'],
    ["escaped value", '  organization_id: "org-Abc\\n123"'],
    ["header injection", '  organization_id: "org-Abc\rOpenAI-Organization: other"'],
    ["non ASCII", '  organization_id: "org-Abcé123"'],
    ["overlong", `  organization_id: "org-${"a".repeat(129)}"`],
    ["duplicate same", `  organization_id: "${ORG}"\n  organization_id: "${ORG}"`],
    ["duplicate conflict", `  organization_id: "${ORG}"\n  organization_id: "org-Other"`],
    ["header conflict", `  organization_id: "${ORG}"\n  extra_headers: "OpenAI-Organization: org-Other"`],
  ])("rejects %s before spawn", async (_name, fields) => {
    const h = makeHarness();
    addControlFields(h, fields!);
    const m = createBackgroundTunnelManager(h.options);
    await expect(m.start()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(h.spawnCalls).toHaveLength(0);
    expect(h.signals).toHaveLength(0);
  });

  it("accepts the bounded upper limit of the local organization grammar", async () => {
    const h = makeHarness();
    addControlFields(h, `  organization_id: "org-${"a".repeat(128)}"`);
    h.probes.push(healthyProbe());
    await createBackgroundTunnelManager(h.options).start();
    expect(h.spawnCalls).toHaveLength(1);
  });
});

describe("real setup shares background coordination", () => {
  it("start refuses a profile changed while obtaining the shared lock", async () => {
    const h = makeHarness(); h.probes.push(healthyProbe());
    let changed = false;
    h.onInspect = (pid) => {
      if (pid === process.pid && !changed) {
        changed = true;
        writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8") + "# changed during lock acquisition\n");
      }
    };
    await expect(createBackgroundTunnelManager(h.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(h.spawnCalls).toHaveLength(0);
  });
  it("start rechecks after asynchronous process enumeration inside the lock", async () => {
    const h = makeHarness(); h.probes.push(healthyProbe());
    const manager = createBackgroundTunnelManager({ ...h.options, listProcesses: async () => {
      writeFileSync(h.profilePath, readFileSync(h.profilePath, "utf8") + "# changed during enumeration\n");
      return { kind: "ok", processes: [] };
    } });
    await expect(manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(h.spawnCalls).toHaveLength(0);
  });
  it("setup guard cannot be reused after release or during a successor lock", async () => {
    const h = makeHarness(); const manager = createBackgroundTunnelManager(h.options);
    let retained!: { assertIntact(): void };
    await manager.withProfileConfigurationLock((guard) => { retained = guard; });
    expect(() => retained.assertIntact()).toThrow();
    await manager.withProfileConfigurationLock(() => { expect(() => retained.assertIntact()).toThrow(); });
  });
  it("setup callback executes only with the actual ownership lock and no record writes", async () => {
    const h = makeHarness(); const manager = createBackgroundTunnelManager(h.options);
    const value = await manager.withProfileConfigurationLock((guard) => {
      guard.assertIntact(); expect(readFileSync(`${h.statePath}.lock.d/holder.json`, "utf8")).toContain("token");
      return "saved-fixture";
    });
    expect(value).toBe("saved-fixture"); expect(recordStateOrAbsent(h)).toBe(true);
    expect(readdirSync(h.dir)).not.toContain("background-state.json.lock.d"); expect(h.spawnCalls).toHaveLength(0);
  });
  it.each(["running", "stop-unconfirmed"])("setup refuses %s ownership even when no health is known", async (state) => {
    const h = makeHarness(); writeFileSync(h.statePath, JSON.stringify(diskRecord(h, "existing", 1234, { state })));
    let called = false;
    await expect(createBackgroundTunnelManager(h.options).withProfileConfigurationLock(() => { called = true; }))
      .rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    expect(called).toBe(false); expect(h.signals).toHaveLength(0); expect(h.spawnCalls).toHaveLength(0);
  });
  it("setup refuses corrupt ownership and uncertain process enumeration", async () => {
    const h = makeHarness(); writeFileSync(h.statePath, "corrupt");
    await expect(createBackgroundTunnelManager(h.options).withProfileConfigurationLock(() => undefined))
      .rejects.toMatchObject({ code: "CE_TUNNEL_STATE_CORRUPT" });
    rmSync(h.statePath);
    await expect(createBackgroundTunnelManager({ ...h.options, listProcesses: async () => ({ kind: "unknown" }) })
      .withProfileConfigurationLock(() => undefined)).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
  });
  it("setup refuses an external profile reader without stopping or adopting it", async () => {
    const h = makeHarness(); h.procs.set(555, { pid: 555, command: `${h.client} run --profile-file ${h.profilePath}`, startedKey: "external" });
    await expect(createBackgroundTunnelManager(h.options).withProfileConfigurationLock(() => undefined))
      .rejects.toMatchObject({ code: "CE_TUNNEL_EXTERNAL_INSTANCE" });
    expect(h.signals).toHaveLength(0); expect(recordStateOrAbsent(h)).toBe(true);
  });
});
