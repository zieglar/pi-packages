/**
 * HANDOFF-CE-SESSION-ONBOARDING-01 — explicit OFFLINE migration of a legacy
 * multi-session profile into the live policy chain.
 *
 * Fully offline and hermetic: no CE, no Store, no Owner, no credential read,
 * no network and no transport lifecycle. The real manager's STOPPED-only
 * profile lock is exercised with injected process seams.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHookRules } from "../../src/hooks/config.js";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { TunnelRefusal } from "../../src/tunnel/codes.js";
import { createLiveSessionMigration } from "../../src/tunnel/live-session-migration.js";
import { readLivePolicy } from "../../src/tunnel/live-session-policy.js";
import { publishMessagingGeneration, readMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

interface Legacy {
  readonly dir: string;
  readonly profilePath: string;
  readonly bindingsDir: string;
  readonly keyFile: string;
  readonly oldBindingPath: string;
  readonly manifest: Record<string, unknown>;
  readonly manager: ReturnType<typeof createBackgroundTunnelManager>;
}

function legacySetup(payloadRead = true, ack = true): Legacy {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-live-migration-"));
  dirs.push(dir);
  const bindingsDir = join(dir, ".ce-bindings");
  fs.mkdirSync(bindingsDir, { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml");
  const keyFile = join(dir, "NEVER-READ-CREDENTIAL");
  const store = { directory: bindingsDir, file: "ce-store.sqlite" };
  const exchange = { namespace: "ns-1", idempotencyKey: "idem-1" };
  const endpoint = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const hooks = [{ id: "hook-a", event: CE_MESSAGE_COMMITTED_EVENT,
    recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: join(dir, "hook.sh"), enabled: true }];
  const manifest = {
    kind: "ce-multi-session-v1", version: 1,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store, exchange, chatgptEndpoint: endpoint,
    mcp: { payloadRead, ack },
    registrations: [
      { endpointId: "pi/A", runtimeSessionId: "session-A", epoch: 3, status: "active", payloadRead: true, ack: true, hooks },
      { endpointId: "pi/B", runtimeSessionId: "session-B", epoch: 1, status: "revoked", payloadRead: false, ack: false },
    ],
  };
  const config = parseMcpBindingConfig({ version: 1, store, exchange, endpoint,
    recipients: [{ adapter: "pi", endpointId: "pi/A" }],
    lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
    payloadRead: { enabled: payloadRead }, ack: { enabled: ack }, debugExecutionGuard: { enabled: false },
    admissionPolicy: { kind: "ce-multi-session-v1", profilePath } });
  const pair = publishMessagingGeneration(profilePath, config, manifest);
  fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdefgh123456",
    keyFile, healthUrlFile: join(dir, "health.url"),
    mcpCommand: buildTunnelMcpCommand({ nodePath: process.execPath, scriptPath: join(dir, "mcp-stdio.js"), bindingPath: pair.bindingPath }) })), { mode: 0o600 });
  const forbidden = vi.fn(() => { throw new Error("no transport lifecycle"); });
  const manager = createBackgroundTunnelManager({ env: {}, profilePath, stateFilePath: join(dir, "state.json"),
    authorizationDirectory: join(dir, "authorization"), clientPath: join(dir, "client"),
    listProcesses: async () => ({ kind: "ok", processes: [] }), inspectProcess: async () => ({ kind: "absent" }),
    spawn: forbidden as never, signal: forbidden as never });
  return { dir, profilePath, bindingsDir, keyFile, oldBindingPath: pair.bindingPath, manifest, manager };
}

function markRunning(legacy: Legacy): void {
  fs.writeFileSync(join(legacy.dir, "state.json"), JSON.stringify({ version: 1, runId: "bg-run", pid: 4242,
    profilePath: legacy.profilePath, commandIdentity: "client run --profile-file x", processStartedKey: "key",
    startedAt: 1760000000000, tunnelId: "tunnel_abcdefgh123456", keyFile: legacy.keyFile,
    urlFile: join(legacy.dir, "health.url"), logPath: join(legacy.dir, "log"), state: "running" }), { mode: 0o600 });
}

describe("offline live-session migration", () => {
  it.each([[false, true], [true, false], [false, false]])("refuses global ceiling %s/%s before publishing", async (payloadRead, ack) => {
    const legacy = legacySetup(payloadRead, ack);
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    const before = fs.readFileSync(legacy.profilePath);
    const entries = fs.readdirSync(legacy.bindingsDir);
    await expect(api.migrate({ expectedRevision: api.revision(), confirm: true })).rejects.toMatchObject({
      code: "CE_TUNNEL_PROFILE_INVALID", field: "messaging.liveMigration.globalCeiling",
    });
    expect(fs.readFileSync(legacy.profilePath)).toEqual(before);
    expect(fs.readdirSync(legacy.bindingsDir)).toEqual(entries);
  });
  it("migrates a legacy v1 profile to a live policy reference", async () => {
    const legacy = legacySetup();
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    const result = await api.migrate({ expectedRevision: api.revision(), confirm: true });
    expect(result.kind).toBe("saved");
    expect(result.ref.kind).toBe("ce-live-session-v1");
    expect(result.bindingPath).not.toBe(legacy.oldBindingPath);
    expect(result.durability).toBe("synced");
    const command = parseTunnelProfile(fs.readFileSync(legacy.profilePath, "utf8")).mcpCommand!;
    expect(command).toContain(result.bindingPath);
  });

  it("publishes a launch document that references the policy without copying the manifest", async () => {
    const legacy = legacySetup();
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    const result = await api.migrate({ expectedRevision: api.revision(), confirm: true });
    const pair = readMessagingGeneration(legacy.profilePath, result.bindingPath, legacy.keyFile)!;
    expect(Object.keys(pair.document).sort()).toEqual(["kind", "ref", "version"]);
    expect(pair.document.kind).toBe("ce-live-launch-v1");
    expect((pair.document.ref as { kind: string }).kind).toBe("ce-live-session-v1");
    expect(JSON.stringify(pair.document)).not.toContain("registrations");
    expect(pair.config.admissionPolicy).toEqual(result.ref);
    // Fixed MCP fields, grants and hooks survive the repoint.
    expect(pair.config.payloadRead).toEqual({ enabled: true });
    expect(pair.config.ack).toEqual({ enabled: true });
    expect(pair.config.recipients).toEqual([{ adapter: "pi", endpointId: "pi/A" }]);
    expect(pair.config.hooks).toBeUndefined();
    expect(pair.config.managed).toBeUndefined();
  });

  it("preserves identity, hooks and the revoked tombstone in the live chain", async () => {
    const legacy = legacySetup();
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    const result = await api.migrate({ expectedRevision: api.revision(), confirm: true });
    const snapshot = readLivePolicy(result.ref);
    expect(snapshot.manifest.identity).toEqual({ tunnelId: "tunnel_abcdefgh123456", organizationId: null });
    expect(snapshot.manifest.store).toEqual(legacy.manifest.store);
    expect(snapshot.manifest.exchange).toEqual(legacy.manifest.exchange);
    const active = snapshot.manifest.registrations.find((r) => r.endpointId === "pi/A")!;
    expect(active.status).toBe("active");
    expect(active.epoch).toBe(3);
    expect(active.hooks).toEqual(parseHookRules((legacy.manifest.registrations as { hooks?: unknown }[])[0]!.hooks));
    const tombstone = snapshot.manifest.registrations.find((r) => r.endpointId === "pi/B")!;
    expect(tombstone.status).toBe("revoked");
  });

  it("keeps one writable live chain and retains the previous generation", async () => {
    const legacy = legacySetup();
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    const result = await api.migrate({ expectedRevision: api.revision(), confirm: true });
    const root = result.ref.root;
    expect(root.startsWith(`${legacy.bindingsDir}/live-policy-`)).toBe(true);
    const entries = fs.readdirSync(root);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).toMatch(/^(\d{6}\.json|\.live-stage-[0-9a-f-]+|\.live-intent-[0-9a-f]+-[0-9a-f]+\.json)$/);
    }
    // The previous generation is retained, never replaced or removed.
    expect(fs.existsSync(legacy.oldBindingPath)).toBe(true);
    expect(fs.readFileSync(legacy.oldBindingPath, "utf8")).toContain("ce-multi-session-v1");
  });

  it("refuses a running transport with zero writes", async () => {
    const legacy = legacySetup();
    markRunning(legacy);
    const before = fs.readFileSync(legacy.profilePath, "utf8");
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    await expect(api.migrate({ expectedRevision: api.revision(), confirm: true })).rejects.toBeInstanceOf(TunnelRefusal);
    expect(fs.readFileSync(legacy.profilePath, "utf8")).toBe(before);
    expect(fs.readdirSync(legacy.bindingsDir).filter((n) => n.startsWith("live-policy-"))).toEqual([]);
  });

  it("refuses a stale revision or a missing confirmation with zero writes", async () => {
    const legacy = legacySetup();
    const before = fs.readFileSync(legacy.profilePath, "utf8");
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager });
    await expect(api.migrate({ expectedRevision: "0".repeat(64), confirm: true })).rejects.toBeInstanceOf(TunnelRefusal);
    await expect(api.migrate({ expectedRevision: api.revision(), confirm: false as never })).rejects.toBeInstanceOf(TunnelRefusal);
    expect(fs.readFileSync(legacy.profilePath, "utf8")).toBe(before);
    expect(fs.readdirSync(legacy.bindingsDir).filter((n) => n.startsWith("live-policy-"))).toEqual([]);
  });

  it("never retries an uncertain commit", async () => {
    const legacy = legacySetup();
    const renameSync = vi.fn(() => { throw new Error("rename failed"); });
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager, io: { renameSync } as never });
    const before = fs.readFileSync(legacy.profilePath, "utf8");
    await expect(api.migrate({ expectedRevision: api.revision(), confirm: true })).rejects.toBeInstanceOf(TunnelRefusal);
    expect(renameSync).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(legacy.profilePath, "utf8")).toBe(before);
  });

  it("reports uncertain durability without rolling back a committed rename", async () => {
    const legacy = legacySetup();
    let renamed = false;
    const renameSync = vi.fn((from: string, to: string) => { renamed = true; fs.renameSync(from, to); });
    const fsyncSync = vi.fn((fd: number) => {
      // Only the directory fsync AFTER the commit may fail: the pre-commit
      // fsync must stay successful, otherwise nothing was committed at all.
      if (renamed && fs.fstatSync(fd).isDirectory()) throw new Error("dir fsync failed");
      fs.fsyncSync(fd);
    });
    const api = createLiveSessionMigration({ profilePath: legacy.profilePath, manager: legacy.manager, io: { fsyncSync, renameSync } as never });
    const result = await api.migrate({ expectedRevision: api.revision(), confirm: true });
    expect(result.kind).toBe("saved");
    expect(result.durability).toBe("uncertain");
    expect(parseTunnelProfile(fs.readFileSync(legacy.profilePath, "utf8")).mcpCommand).toContain(result.bindingPath);
  });
});
