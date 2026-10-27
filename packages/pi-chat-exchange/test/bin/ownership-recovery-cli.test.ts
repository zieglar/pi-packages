import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireOwnership, bindSession, readCurrentOwnership } from "../../src/storage/ownership.js";
import { openStore } from "../../src/storage/store.js";
import {
  capabilityFor,
  cleanupFixtures,
  fixture,
  NOW,
  participant,
} from "../storage/support/participant-fixture.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const recoveryEntry = resolve(packageRoot, "scripts", "recover-stale-ownership.mjs");
const OLD_SESSION = "ses_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const at = (seconds: number): string => new Date(Date.parse(NOW) + seconds * 1_000).toISOString();

afterEach(cleanupFixtures);

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [recoveryEntry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

function staleWorld(label: string, leaseStartedAt = at(-60)) {
  const active = fixture(label);
  const participantId = participant(active, "chatgpt-desktop", "create-chatgpt", "mcp").participant.participantId;
  const attach = capabilityFor(active, participantId, "attach");
  bindSession(active.store, { participantId, sessionId: OLD_SESSION, capability: attach }, { now: () => leaseStartedAt });
  acquireOwnership(
    active.store,
    { participantId, sessionId: OLD_SESSION, capability: attach, leaseTtlSeconds: 30 },
    { now: () => leaseStartedAt },
  );
  active.store.close();
  const configPath = resolve(active.root, "binding.json");
  writeFileSync(configPath, `${JSON.stringify({
    version: 1,
    store: { directory: active.directory, file: active.filename },
    exchange: { namespace: "cli-recovery", idempotencyKey: "exchange" },
    endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
    recipients: [{ adapter: "pi", endpointId: "pi-main" }],
    lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
    payloadRead: { enabled: true },
  })}\n`);
  return { active, participantId, configPath };
}

describe("operator stale-ownership recovery CLI", () => {
  it("requires the built artifact", () => {
    if (!existsSync(resolve(packageRoot, "dist", "host", "ownership-recovery.js"))) {
      throw new Error("built recovery module missing \u2014 run \"pnpm run build\" first");
    }
  });

  it("refuses a wrong confirmation label and an unreadable config without recovering", async () => {
    const world = staleWorld("ce-recovery-confirm-");
    const base = [
      "--expect-owner-session", OLD_SESSION,
      "--expect-fencing-token", "1",
      "--expect-lease-started-at", at(-60),
      "--expect-expires-at", at(-30),
    ];

    const wrongLabel = await run(["--config", world.configPath, "--confirm-endpoint", "mcp/wrong-endpoint", ...base]);
    expect(wrongLabel.code).toBe(1);
    expect(wrongLabel.stdout).toBe("");
    expect(wrongLabel.stderr).toBe("CE_RECOVERY_LAUNCH_INVALID\n");

    const badConfigPath = resolve(world.active.root, "malformed.json");
    writeFileSync(badConfigPath, "{not json");
    const badConfig = await run(["--config", badConfigPath, "--confirm-endpoint", "mcp/chatgpt-desktop", ...base]);
    expect(badConfig.code).toBe(1);
    expect(badConfig.stdout).toBe("");
    expect(["CE_RECOVERY_CONFIG_INVALID\n", "CE_RECOVERY_LAUNCH_INVALID\n"]).toContain(badConfig.stderr);

    const store = openStore({ directory: world.active.directory, filename: world.active.filename });
    expect(readCurrentOwnership(store, world.participantId)).toMatchObject({ sessionId: OLD_SESSION, fencingToken: 1 });
    store.close();
  });

  it("requires exact operator confirmation and prints a capability-free receipt", async () => {
    const active = fixture("ce-recovery-cli-");
    const participantId = participant(active, "chatgpt-desktop", "create-chatgpt", "mcp").participant.participantId;
    const attach = capabilityFor(active, participantId, "attach");
    bindSession(active.store, { participantId, sessionId: OLD_SESSION, capability: attach }, { now: () => at(-60) });
    acquireOwnership(
      active.store,
      { participantId, sessionId: OLD_SESSION, capability: attach, leaseTtlSeconds: 30 },
      { now: () => at(-60) },
    );
    active.store.close();

    const configPath = resolve(active.root, "binding.json");
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      store: { directory: active.directory, file: active.filename },
      exchange: { namespace: "cli-recovery", idempotencyKey: "exchange" },
      endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
      recipients: [{ adapter: "pi", endpointId: "pi-main" }],
      lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
      payloadRead: { enabled: true },
    })}\n`);

    const result = await run([
      "--config", configPath,
      "--confirm-endpoint", "mcp/chatgpt-desktop",
      "--expect-owner-session", OLD_SESSION,
      "--expect-fencing-token", "1",
      "--expect-lease-started-at", at(-60),
      "--expect-expires-at", at(-30),
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({ disposition: "RECOVERED", participantId });
    expect(result.stdout).not.toContain("cap_");
    expect(result.stdout).not.toContain(active.databasePath);
  });

  it("admits only one winner across concurrent recovery processes", async () => {
    const active = fixture("ce-recovery-concurrent-");
    const participantId = participant(active, "chatgpt-desktop", "create-chatgpt", "mcp").participant.participantId;
    const attach = capabilityFor(active, participantId, "attach");
    bindSession(active.store, { participantId, sessionId: OLD_SESSION, capability: attach }, { now: () => at(-60) });
    acquireOwnership(
      active.store,
      { participantId, sessionId: OLD_SESSION, capability: attach, leaseTtlSeconds: 30 },
      { now: () => at(-60) },
    );
    active.store.close();

    const configPath = resolve(active.root, "binding.json");
    writeFileSync(configPath, `${JSON.stringify({
      version: 1,
      store: { directory: active.directory, file: active.filename },
      exchange: { namespace: "cli-recovery", idempotencyKey: "exchange" },
      endpoint: { adapter: "mcp", endpointId: "chatgpt-desktop" },
      recipients: [{ adapter: "pi", endpointId: "pi-main" }],
      lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
      payloadRead: { enabled: true },
    })}\n`);
    const args = [
      "--config", configPath,
      "--confirm-endpoint", "mcp/chatgpt-desktop",
      "--expect-owner-session", OLD_SESSION,
      "--expect-fencing-token", "1",
      "--expect-lease-started-at", at(-60),
      "--expect-expires-at", at(-30),
    ];

    const results = await Promise.all([run(args), run(args)]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const loser = results.find((result) => result.code === 1)!;
    expect(["CE_RECOVERY_OWNER_ABSENT\n", "CE_RECOVERY_RACE_LOST\n"]).toContain(loser.stderr);
    expect(results.map((result) => result.stdout + result.stderr).join("\n")).not.toContain("cap_");
  });

  it("rejects missing or mismatched confirmation without echoing arguments", async () => {
    const marker = "DO_NOT_ECHO_THIS_PATH";
    const result = await run(["--config", `/${marker}`]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("CE_RECOVERY_LAUNCH_INVALID\n");
    expect(result.stderr).not.toContain(marker);
  });
});
