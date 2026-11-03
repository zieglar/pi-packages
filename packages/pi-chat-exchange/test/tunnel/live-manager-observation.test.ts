import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBackgroundTunnelManager, type ProcessPresence } from "../../src/tunnel/background-manager.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ce-live-observe-"));
  dirs.push(dir);
  const profilePath = join(dir, "profile.yaml"); // Intentionally absent: observation must not read it or credentials.
  const stateFilePath = join(dir, "state.json");
  const command = `${join(dir, "client")} run --profile-file ${profilePath}`;
  const record = { version: 1, runId: "bg-test", pid: 41000, profilePath,
    commandIdentity: command, processStartedKey: "start-key", startedAt: 1760000000000,
    tunnelId: "tunnel_abcdef1234567890", keyFile: join(dir, "absent-key"),
    urlFile: join(dir, "health.url"), logPath: join(dir, "log"), state: "running" };
  const save = () => writeFileSync(stateFilePath, JSON.stringify(record), { mode: 0o600 });
  save();
  let presence: ProcessPresence = { kind: "present", identity: { pid: record.pid, command, startedKey: record.processStartedKey } };
  let health: Record<string, unknown> = { result: "ok", healthz: { ok: true, body: "live" },
    readyz: { ok: true }, process: { running: true }, control_plane_poll: { ok: true } };
  const inspectProcess = vi.fn(async () => presence);
  const probeHealth = vi.fn(async () => ({ stdout: JSON.stringify(health), exitCode: 0 }));
  const forbidden = vi.fn(() => { throw new Error("forbidden lifecycle operation"); });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, stateFilePath,
    clientPath: join(dir, "client"), authorizationDirectory: join(dir, "authorization"),
    now: () => 1760000001000, inspectProcess, probeHealth,
    spawn: forbidden, signal: forbidden, listProcesses: forbidden });
  return { manager, record, save, inspectProcess, probeHealth,
    setPresence: (value: ProcessPresence) => { presence = value; },
    setHealth: (value: Record<string, unknown>) => { health = value; },
    assertReadOnly: (before: string) => {
      expect(readFileSync(stateFilePath, "utf8")).toBe(before);
      expect(readdirSync(dir)).toEqual(["state.json"]);
      expect(forbidden).not.toHaveBeenCalled();
    }, snapshot: () => readFileSync(stateFilePath, "utf8") };
}

describe("read-only live transport observation", () => {
  it("returns only the freshly verified remote transport identity", async () => {
    const f = fixture();
    const before = f.snapshot();
    await expect(f.manager.observeLiveTransport()).resolves.toEqual({ kind: "CONNECTED", runId: "bg-test", managedPid: 41000, identityConfirmed: true });
    expect(f.inspectProcess).toHaveBeenCalledWith(41000);
    expect(f.probeHealth).toHaveBeenCalledOnce();
    f.assertReadOnly(before);
  });

  it.each(["unknown", "absent", "pid", "startedKey", "command"])("refuses %s process identity without changing the ledger", async (variant) => {
    const f = fixture();
    if (variant === "unknown" || variant === "absent") f.setPresence({ kind: variant });
    else f.setPresence({ kind: "present", identity: { pid: variant === "pid" ? 41001 : 41000,
      command: variant === "command" ? "foreign run" : f.record.commandIdentity,
      startedKey: variant === "startedKey" ? "reused" : "start-key" } });
    const before = f.snapshot();
    await expect(f.manager.observeLiveTransport()).resolves.toEqual({ kind: "UNAVAILABLE" });
    expect(f.probeHealth).not.toHaveBeenCalled();
    f.assertReadOnly(before);
  });

  it.each(["unhealthy", "missing-poll", "failed-poll", "local"])("refuses %s current health even after a successful observation", async (variant) => {
    const f = fixture();
    await f.manager.observeLiveTransport();
    f.setHealth({ result: variant === "unhealthy" ? "fail" : "ok", healthz: { ok: true, body: "live" }, readyz: { ok: true },
      ...(variant === "local" ? { mode: "local" } : {}),
      ...(variant === "failed-poll" ? { control_plane_poll: { ok: false } } : {}) });
    const before = f.snapshot();
    await expect(f.manager.observeLiveTransport()).resolves.toEqual({ kind: "UNAVAILABLE" });
    f.assertReadOnly(before);
  });

  it.each(["stopped", "stop-unconfirmed", "empty-run", "invalid-pid"])("refuses %s ledger without leaking identity", async (variant) => {
    const f = fixture();
    if (variant === "empty-run") f.record.runId = "";
    else if (variant === "invalid-pid") f.record.pid = 0;
    else f.record.state = variant;
    f.save();
    const before = f.snapshot();
    await expect(f.manager.observeLiveTransport()).resolves.toEqual({ kind: "UNAVAILABLE" });
    f.assertReadOnly(before);
  });
});
