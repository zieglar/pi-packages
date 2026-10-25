/**
 * HANDOFF-CE-HOST-09 B1 — offline end-to-end against `tunnel-client dev proxy`.
 *
 * No real credential, no real control plane, no paid connection. The dev proxy
 * provides an in-memory control plane and an in-process client runtime with a
 * genuine health/admin surface, which is exactly the evidence contract the
 * state machine consumes.
 *
 * Covered lifecycle moments (handoff §6):
 * - start success (Starting -> Connected via current health evidence)
 * - PID cross-check refusal (result=fail; exit code is NON-zero in the r2
 *   re-capture — Phase A V7's "exit 0" was a `| tail` pipeline measurement
 *   artifact. Both exit 0 and non-zero shapes are refused identically in unit
 *   tests; exit codes are never trusted as health.)
 * - health evidence expiry (freshness window)
 * - user stop (SIGTERM -> Stopped) and stop cleanup (url-file removed)
 * - probing a stopped manager (missing url-file) is a refusal, not a crash
 * - state bar labels derive from state, not from history
 *
 * REWORK-01 B0: this file is EXCLUDED from the default `pnpm test` lane (see
 * package.json); it runs only via the opt-in `pnpm run test:installed-client`
 * lane and REQUIRES the installed tunnel-client binary. A missing binary is a
 * setup error and fails loudly below — never a silent skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHealthCompletionRecorder, parseHealthProbe } from "../../src/tunnel/health.js";
import { DEFAULT_TUNNEL_TIMING, nextTunnelState, tunnelStatusLabel, type TunnelState } from "../../src/tunnel/state.js";

const CLIENT = process.env.CE_TUNNEL_CLIENT_BIN ?? "/opt/homebrew/bin/tunnel-client";
const clientAvailable = existsSync(CLIENT);

if (!clientAvailable) {
  throw new Error(
    `offline dev-proxy lifecycle tests require the installed tunnel-client binary (${CLIENT}); ` +
      "this file is the opt-in `pnpm run test:installed-client` lane, not the default `pnpm test`. " +
      "A missing client is a setup error, not a silent skip.",
  );
}

function probe(urlFile: string, pid?: number): { stdout: string; exitCode: number } | undefined {
  const args = ["health", "--url-file", urlFile, "--json"];
  if (pid !== undefined) args.push("--pid", String(pid));
  const res = spawnSync(CLIENT, args, { encoding: "utf8", timeout: 15_000 });
  if (res.error) return undefined;
  return { stdout: res.stdout ?? "", exitCode: res.status ?? -1 };
}

describe("offline dev-proxy lifecycle (no credentials, no network)", () => {
  let workDir: string;
  let proxy: ReturnType<typeof spawn> | undefined;
  let healthUrlFile: string;

  let stubProcess: ReturnType<typeof spawn> | undefined;

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "ce-tunnel-b1-"));
    healthUrlFile = join(workDir, "health.url");
    // The stub is a long-lived process: spawn it in the background and read
    // its startup banner from stdout instead of blocking on exit.
    stubProcess = spawn(CLIENT, ["dev", "mcp-stub", "--listen-addr", "127.0.0.1:0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const banner: string[] = [];
    stubProcess.stdout?.on("data", (chunk: Buffer) => banner.push(chunk.toString("utf8")));
    const STUB_BANNER_DEADLINE_MS = 10_000;
    const startedWaiting = Date.now();
    let stubUrl: string | undefined;
    while (Date.now() - startedWaiting < STUB_BANNER_DEADLINE_MS) {
      stubUrl = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(banner.join(""))?.[0];
      if (stubUrl !== undefined) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (stubUrl === undefined) throw new Error("mcp-stub url not found before the banner deadline");
    proxy = spawn(CLIENT, ["dev", "proxy", "--mcp-server-url", stubUrl, "--health-url-file", healthUrlFile, "--duration", "60s"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  afterAll(() => {
    proxy?.kill("SIGTERM");
    stubProcess?.kill("SIGTERM");
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
  });

  it("reaches Connected only through current health evidence", async () => {
    // Starting: the health surface appears only after the client is ready.
    // Poll to a NAMED deadline instead of asserting an instant race.
    const URL_FILE_DEADLINE_MS = 15_000;
    const urlFileWaitStart = Date.now();
    while (!existsSync(healthUrlFile) && Date.now() - urlFileWaitStart < URL_FILE_DEADLINE_MS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(existsSync(healthUrlFile)).toBe(true);
    let state: TunnelState = { name: "Stopped", since: Date.now(), consecutiveFailures: 0, consecutiveHealthy: 0, lastHealthyAt: undefined, recovering: false };
    const startedAt = Date.now();
    let becameConnectedAt: number | undefined;
    const complete = createHealthCompletionRecorder("offline-proxy-run", proxy?.pid ?? -1, Date.now);

    for (let i = 0; i < 40 && becameConnectedAt === undefined; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const raw = probe(healthUrlFile);
      const parsed = raw === undefined ? undefined : complete(raw);
      state = nextTunnelState(
        state,
        {
          now: Date.now(),
          runId: "offline-proxy-run",
          managedPid: proxy?.pid,
          processAlive: proxy?.exitCode === null,
          userStopped: false,
          startedAt,
          exit: proxy?.exitCode === null ? undefined : { code: proxy?.exitCode ?? null, signal: proxy?.signalCode ?? null },
          probe: parsed,
          startupLogSeen: false,
          externalInstance: false,
        },
        { ...DEFAULT_TUNNEL_TIMING, startupTimeoutMs: 45_000 },
      );
      if (state.name === "Connected") becameConnectedAt = Date.now();
    }

    expect(becameConnectedAt).toBeDefined();
    expect(state.name).toBe("Connected");
    expect(tunnelStatusLabel(state)).toBe("Tunnel ● transport up");
  }, 60_000);

  it("refuses Connected on a failed PID cross-check even with exit code 0", async () => {
    // Wait for the health file, then probe with a wrong PID.
    for (let i = 0; i < 30 && !existsSync(healthUrlFile); i += 1) await new Promise((r) => setTimeout(r, 500));
    const raw = probe(healthUrlFile, 999_999);
    expect(raw).toBeDefined();
    const parsed = parseHealthProbe(raw as { stdout: string; exitCode: number });
    // Fresh capture (this run): wrong-PID probe exits 2 with result "fail"
    // while healthz/readyz still look good. The exit code and the
    // healthy-looking triple must both NOT produce Connected evidence.
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.connectedEligible).toBe(false);
    const state = nextTunnelState(
      { name: "Connected", since: Date.now(), consecutiveFailures: 0, consecutiveHealthy: 3, lastHealthyAt: Date.now(), recovering: false },
      {
        now: Date.now(),
        runId: "offline-pid-refusal",
        managedPid: 123,
        processAlive: true,
        userStopped: false,
        startedAt: Date.now() - 5_000,
        exit: undefined,
        probe: parsed,
        startupLogSeen: false,
        externalInstance: false,
      },
    );
    expect(state.name).not.toBe("Connected");
  });

  it("degrades stale evidence past the freshness window instead of staying Connected", () => {
    const stale = Date.now() - DEFAULT_TUNNEL_TIMING.freshnessMs - 1;
    const state = nextTunnelState(
      { name: "Connected", since: stale, consecutiveFailures: 0, consecutiveHealthy: 2, lastHealthyAt: stale, recovering: false },
      {
        now: Date.now(),
        runId: "offline-expiry",
        managedPid: 4242,
        processAlive: true,
        userStopped: false,
        startedAt: stale - 1_000,
        exit: undefined,
        probe: undefined,
        startupLogSeen: true,
        externalInstance: false,
      },
    );
    expect(state.name).toBe("Unknown");
    expect(tunnelStatusLabel(state)).toBe("Tunnel ? unverified");
  });

  it("classifies user SIGTERM as Stopped and observes the client remove the url-file", async () => {
    for (let i = 0; i < 30 && !existsSync(healthUrlFile); i += 1) await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(healthUrlFile)).toBe(true);
    proxy?.kill("SIGTERM");
    const exited = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => resolve(-1), 10_000);
      proxy?.on("exit", (code) => { clearTimeout(t); resolve(code); });
    });
    expect(exited).not.toBe(-1);
    // The client deletes the url-file on shutdown (captured behavior).
    // Poll to a NAMED deadline: a fixed sleep is a scheduling race (r2, Lane D finding 4).
    const URL_FILE_REMOVAL_DEADLINE_MS = 10_000;
    const removalWaitStart = Date.now();
    while (existsSync(healthUrlFile) && Date.now() - removalWaitStart < URL_FILE_REMOVAL_DEADLINE_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(healthUrlFile)).toBe(false);

    const state = nextTunnelState(
      { name: "Connected", since: Date.now(), consecutiveFailures: 0, consecutiveHealthy: 2, lastHealthyAt: Date.now(), recovering: false },
      {
        now: Date.now(),
        runId: "offline-stop",
        managedPid: 4242,
        processAlive: false,
        userStopped: true,
        startedAt: Date.now() - 10_000,
        exit: { code: null, signal: "SIGTERM" },
        probe: undefined,
        startupLogSeen: false,
        externalInstance: false,
      },
    );
    expect(state.name).toBe("Stopped");
    expect(tunnelStatusLabel(state)).toBe("Tunnel ○ stopped");
  });

  it("probing a stopped manager is a refusal, not a crash", () => {
    const raw = probe(join(tmpdir(), "ce-tunnel-b1-definitely-absent.url"));
    expect(raw).toBeDefined();
    const parsed = parseHealthProbe(raw as { stdout: string; exitCode: number });
    expect(parsed.kind).toBe("unreachable");
    expect(parsed.connectedEligible).toBe(false);
  });
});
