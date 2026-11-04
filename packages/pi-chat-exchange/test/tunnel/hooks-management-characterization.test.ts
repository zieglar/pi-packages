/**
 * HANDOFF-CE-HOOKS-MANAGEMENT-01 — characterization of the Hook management
 * boundaries that the management UX must respect.
 *
 * Fully offline and hermetic: no CE, no Store, no Owner, no credential read,
 * no network, no transport lifecycle and no Hook execution.
 *
 * These cases pin current behavior only. They are not a management feature and
 * do not claim any production activation API.
 */
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHookRules } from "../../src/hooks/config.js";
import { CE_MESSAGE_COMMITTED_EVENT } from "../../src/hooks/events.js";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import { createLiveSessionMigration } from "../../src/tunnel/live-session-migration.js";
import { createLivePolicyRegistration, readLivePolicy } from "../../src/tunnel/live-session-policy.js";
import { createLiveMcpComposition } from "../../src/tunnel/live-mcp-composition.js";
import { publishMessagingGeneration, readMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { buildTunnelMcpCommand, buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";
import { assertLiveRegistrationContinuity, effectiveLiveRegistration } from "../../pi-extension/multi-session-runtime.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

interface Live {
  readonly dir: string;
  readonly profilePath: string;
  readonly keyFile: string;
  readonly manager: ReturnType<typeof createBackgroundTunnelManager>;
}

/** Synthetic operator profile only. Never reads a credential or starts transport. */
function liveSetup(): Live {
  const dir = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-hooks-mgmt-"));
  dirs.push(dir);
  const bindingsDir = join(dir, ".ce-bindings");
  fs.mkdirSync(bindingsDir, { mode: 0o700 });
  const profilePath = join(dir, "tunnel.yaml");
  const keyFile = join(dir, "NEVER-READ-CREDENTIAL");
  const store = { directory: bindingsDir, file: "ce-store.sqlite" };
  const exchange = { namespace: "ns-1", idempotencyKey: "idem-1" };
  const endpoint = { adapter: "chatgpt", endpointId: "chatgpt/main" };
  const manifest = {
    kind: "ce-multi-session-v1", version: 1,
    identity: { tunnelId: "tunnel_abcdefgh123456", organizationId: null },
    store, exchange, chatgptEndpoint: endpoint,
    mcp: { payloadRead: true, ack: true },
    registrations: [
      { endpointId: "pi/A", runtimeSessionId: "session-A", epoch: 3, status: "active", payloadRead: true, ack: true },
      { endpointId: "pi/B", runtimeSessionId: "session-B", epoch: 1, status: "revoked", payloadRead: false, ack: false },
    ],
  };
  const config = parseMcpBindingConfig({ version: 1, store, exchange, endpoint,
    recipients: [{ adapter: "pi", endpointId: "pi/A" }],
    lease: { ttlSeconds: 120, renewIntervalSeconds: 30 },
    payloadRead: { enabled: true }, ack: { enabled: true }, debugExecutionGuard: { enabled: false },
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
  return { dir, profilePath, keyFile, manager };
}

describe("Hook management boundaries", () => {
  it.each(["after-final-recheck", "after-candidate-save"] as const)(
    "does not pin Hook adoption to the confirmed incarnation when registration changes %s", async phase => {
      const live = liveSetup();
      const migration = createLiveSessionMigration({ profilePath: live.profilePath, manager: live.manager });
      const selected = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
      const original = readMessagingGeneration(live.profilePath, selected.bindingPath, live.keyFile)!;
      const confirmed = readLivePolicy(selected.ref);
      const confirmedTarget = confirmed.manifest.registrations.find(r => r.endpointId === "pi/A")!;
      const hooks = parseHookRules([{ id: "notify-A", event: CE_MESSAGE_COMMITTED_EVENT,
        recipient: { adapter: "pi", endpointId: "pi/A" }, command: join(live.dir, "NEVER-EXECUTE"), enabled: true }]);
      const config = parseMcpBindingConfig({ version: 1, ...original.config, hooks });
      const oldProcess = createLiveMcpComposition(config);
      expect(oldProcess.hookAllowed(hooks[0]!)).toBe(true);
      const api = createLivePolicyRegistration({ ref: selected.ref });
      const reauthorize = () => {
        const revoked = api.revoke({ expectedDigest: readLivePolicy(selected.ref).digest, endpointId: "pi/A" }).snapshot;
        return api.reauthorize({ expectedDigest: revoked.digest, registration: {
          endpointId: "pi/A", runtimeSessionId: "session-A", payloadRead: true, ack: true, presenceDisclosure: false,
        } }).snapshot;
      };

      // The public live writer commits while the real STOPPED Profile lock is
      // held. These schedules model the two windows from the security review;
      // this stages a candidate only, not a management activation implementation.
      const candidate = await live.manager.withProfileConfigurationLock(guard => {
        expect(readLivePolicy(selected.ref)).toEqual(confirmed);
        guard.assertIntact();
        if (phase === "after-final-recheck") reauthorize();
        return publishMessagingGeneration(live.profilePath, config, original.document, { credentialFile: live.keyFile });
      });
      if (phase === "after-candidate-save") reauthorize();

      const changed = readLivePolicy(selected.ref);
      const adoptedTarget = changed.manifest.registrations.find(r => r.endpointId === "pi/A")!;
      expect(changed.digest).not.toBe(confirmed.digest);
      expect(adoptedTarget).toMatchObject({ runtimeSessionId: confirmedTarget.runtimeSessionId,
        endpointId: confirmedTarget.endpointId, status: "active", epoch: confirmedTarget.epoch + 1 });
      expect(oldProcess.hookAllowed(hooks[0]!)).toBe(false);
      const readBack = readMessagingGeneration(live.profilePath, candidate.bindingPath, live.keyFile)!;
      // A fresh composition captures the new incarnation; the existing rule
      // has no durable field carrying the incarnation confirmed by the operator.
      expect(createLiveMcpComposition(readBack.config).hookAllowed(hooks[0]!)).toBe(true);
      expect(parseTunnelProfile(fs.readFileSync(live.profilePath, "utf8")).mcpCommand).toContain(selected.bindingPath);
      expect(fs.existsSync(join(live.dir, "NEVER-EXECUTE"))).toBe(false);
    },
  );

  it("denies messaging continuity and reload transfer when the Session Hook array changes", async () => {
    const live = liveSetup();
    const migration = createLiveSessionMigration({ profilePath: live.profilePath, manager: live.manager });
    const selected = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
    const loaded = readLivePolicy(selected.ref);
    const hooks = parseHookRules([{ id: "notify-peer", event: CE_MESSAGE_COMMITTED_EVENT,
      recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" }, command: join(live.dir, "NEVER-EXECUTE"), enabled: true }]);
    // Exercise the real runtime guard with an otherwise unchanged typed snapshot.
    // This is not a claim that the current chain can publish the changed snapshot.
    const changed = { ...loaded, manifest: { ...loaded.manifest, registrations: loaded.manifest.registrations.map(r =>
      r.runtimeSessionId === "session-A" ? { ...r, hooks } : r) } };
    expect(assertLiveRegistrationContinuity(loaded, loaded, "session-A").endpointId).toBe("pi/A");
    expect(() => assertLiveRegistrationContinuity(loaded, changed, "session-A")).toThrow();
    expect(() => effectiveLiveRegistration(loaded, changed, "session-A")).toThrow();
    const unrelated = { ...loaded, manifest: { ...loaded.manifest, registrations: loaded.manifest.registrations.map(r =>
      r.runtimeSessionId === "session-B" ? { ...r, hooks } : r) } };
    expect(assertLiveRegistrationContinuity(loaded, unrelated, "session-A").endpointId).toBe("pi/A");
    expect(readLivePolicy(selected.ref)).toEqual(loaded);
  });
});
