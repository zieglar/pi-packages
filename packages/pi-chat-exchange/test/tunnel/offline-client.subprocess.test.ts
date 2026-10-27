/**
 * HANDOFF-CE-HOST-09 B1.1 Task 3 — ACTUAL subprocess exercise of the bundled
 * offline simulator through the production manager code path.
 *
 * This test starts a REAL child process: the bundled `offline-client.js` from
 * `dist/`, launched by the real `node:child_process` spawn seam. It never
 * starts the official tunnel client, never reads a credential, never contacts
 * a control plane, and needs no network: the simulator only prints correlated
 * JSON records to its own stdout.
 *
 * It therefore proves the manager's ownership/lifecycle wiring against a real
 * OS process (spawn, stdout framing, SIGTERM exit proof), which a fake seam
 * cannot prove. It proves nothing about a real transport.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createTunnelManager, type TunnelManager } from "../../src/tunnel/manager.js";

const CLIENT_SCRIPT = fileURLToPath(new URL("../../dist/tunnel/offline-client.js", import.meta.url));

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

let managers: TunnelManager[] = [];

afterEach(async () => {
  for (const manager of managers) await manager.dispose().catch(() => undefined);
  managers = [];
});

function manager(options: { optIn?: boolean; simulateActivity?: boolean } = {}): TunnelManager {
  const created = createTunnelManager({
    env: options.optIn === false ? {} : { CE_TUNNEL_OFFLINE_TEST: "1" },
    nodeExecPath: process.execPath,
    clientScript: CLIENT_SCRIPT,
    ...(options.simulateActivity === undefined ? {} : { simulateActivity: options.simulateActivity }),
  });
  managers.push(created);
  return created;
}

describe("B1.1 bundled offline simulator — real subprocess", () => {
  it("is built and available as a bundled script", () => {
    expect(existsSync(CLIENT_SCRIPT), `${CLIENT_SCRIPT} must be built (tsc -p tsconfig.build.json)`).toBe(true);
  });

  it("refuses to start without the explicit offline opt-in", async () => {
    await expect(manager({ optIn: false }).start()).rejects.toMatchObject({
      code: "CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED",
    });
  });

  it("reaches Connected from real simulated health records, then stops with exit proof", async () => {
    const subject = manager();
    const started = await subject.start();
    expect(started.runId).toMatch(/^offline-/);
    expect(subject.status().running).toBe(true);

    const connected = await waitFor(() => subject.status().state === "Connected", 20_000);
    const status = subject.status();
    expect(connected, `state was ${status.state}`).toBe(true);
    expect(status.mode).toBe("offline-simulated");
    expect(status.evidence).toBe("health-probe");
    expect(status.label).toMatch(/offline simulated/);
    // No activity record was requested, so none may be claimed.
    expect(status.clientActivity.observed).toBe(false);

    await subject.stop();
    const stopped = subject.status();
    expect(stopped.state).toBe("Stopped");
    expect(stopped.running).toBe(false);
  }, 40_000);

  it("reports observed activity only when the simulator actually emits it", async () => {
    const subject = manager({ simulateActivity: true });
    await subject.start();
    const observed = await waitFor(() => subject.status().clientActivity.observed, 20_000);
    expect(observed).toBe(true);
    expect(subject.status().clientActivity.simulated).toBe(true);
    await subject.stop();
  }, 40_000);

  it("treats an out-of-band killed simulator as an Error and never respawns it", async () => {
    // The manager deliberately exposes no PID, adopt, or attach API, so this
    // probe observes the owned child through the spawn seam instead of asking
    // the manager for a PID. The seam is the REAL node spawn.
    let observedPid: number | undefined;
    const subject = createTunnelManager({
      env: { CE_TUNNEL_OFFLINE_TEST: "1" },
      nodeExecPath: process.execPath,
      clientScript: CLIENT_SCRIPT,
      spawn: (executable, args, spawnOptions) => {
        const child = spawn(executable, [...args], { env: { ...spawnOptions.env }, stdio: ["ignore", "pipe", "pipe"] });
        observedPid = child.pid;
        return child;
      },
    });
    managers.push(subject);
    await subject.start();
    await waitFor(() => subject.status().state === "Connected", 20_000);
    expect(observedPid).toBeGreaterThan(0);
    // Not through stop(): an unexpected exit must not look like a clean stop
    // and must not trigger a respawn.
    process.kill(observedPid as number, "SIGKILL");
    const errored = await waitFor(() => subject.status().state === "Error", 10_000);
    expect(errored).toBe(true);
    expect(subject.status().running).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subject.status().state).toBe("Error");
  }, 40_000);
});
