import { describe, expect, it, vi } from "vitest";
import { observeLiveConnection } from "../../src/tunnel/live-connection-status.js";

describe("live connection status", () => {
  it("sanitizes a missing profile while retaining independently observed transport", async () => {
    const manager = { observeLiveTransport: async () => ({ kind: "CONNECTED" as const, runId: "test", managedPid: 42, identityConfirmed: true as const }) };
    await expect(observeLiveConnection({ profilePath: "/absent/ce-profile.yaml", manager, targetEndpointId: "pi/A", readOwner: () => undefined })).resolves.toEqual({ policy: "UNVERIFIED", transport: "CONNECTED" });
  });
  it("sanitizes manager failure", async () => {
    await expect(observeLiveConnection({ profilePath: "/absent/ce-profile.yaml", manager: { observeLiveTransport: async () => { throw Error("private details"); } }, targetEndpointId: "pi/A", readOwner: () => undefined })).resolves.toEqual({ policy: "UNVERIFIED", transport: "UNAVAILABLE" });
  });
});

import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach } from "vitest";
import { multiSessionFixture } from "./support/multi-session-fixture.js";
import { createLiveSessionMigration } from "../../src/tunnel/live-session-migration.js";
import { createBackgroundTunnelManager } from "../../src/tunnel/background-manager.js";
import { parseTunnelProfile } from "../../src/tunnel/background-manager.js";
import { parseTunnelMcpCommand } from "../../src/tunnel/profile.js";
import { createLivePolicyRegistration, readLivePolicy, prepareLivePolicyUpgrade } from "../../src/tunnel/live-session-policy.js";
import { readMessagingGeneration, publishMessagingGeneration } from "../../src/tunnel/messaging-config.js";
import { replaceTunnelMcpBindingPath } from "../../src/tunnel/profile.js";
import { createLiveAdoptionRecorder } from "../../src/tunnel/live-adoption-observation.js";
const probe = vi.hoisted(() => vi.fn());
vi.mock("../../src/tunnel/live-adoption-probe.js", () => ({ queryLiveAdoptionProbe: probe }));
const cleanups: (() => void)[] = [];
afterEach(() => { probe.mockReset(); for (const cleanup of cleanups.splice(0)) cleanup(); });
it.each(["active", "active-v2", "renewal", "expiry-regression", "blocked", "missing", "owner-release", "child-exit", "disconnect", "revoke", "profile-change"])("revalidates %s during a delayed challenge", async (variant) => {
  const f = await multiSessionFixture(); cleanups.push(f.cleanup);
  const migrationManager = createBackgroundTunnelManager({ env: {}, profilePath: f.profilePath, clientPath: join(f.dir, "client"), authorizationDirectory: join(f.dir, "authorization"), inspectProcess: async () => ({ kind: "absent" }), listProcesses: async () => ({ kind: "ok", processes: [] }) });
  const migration = createLiveSessionMigration({ profilePath: f.profilePath, manager: migrationManager });
  let migrated = await migration.migrate({ expectedRevision: migration.revision(), confirm: true });
  if (variant === "active-v2") {
    const text = fs.readFileSync(f.profilePath, "utf8"); const oldFacts = parseTunnelProfile(text);
    const oldPath = parseTunnelMcpCommand(oldFacts.mcpCommand!).bindingPath;
    const oldPair = readMessagingGeneration(f.profilePath, oldPath, oldFacts.keyFile)!;
    const ref = prepareLivePolicyUpgrade(migrated.ref, f.profilePath);
    const pair = publishMessagingGeneration(f.profilePath, { ...oldPair.config, admissionPolicy: ref }, { kind: "ce-live-launch-v2", version: 1, ref }, { credentialFile: oldFacts.keyFile });
    createLivePolicyRegistration({ ref }).upgrade({ expectedDigest: readLivePolicy(migrated.ref).digest, actorRuntimeSessionId: "operator", profileRevision: migrated.revision, bindingGeneration: "d".repeat(64) });
    fs.writeFileSync(f.profilePath, text.replace(`"${oldFacts.mcpCommand!}"`, `"${replaceTunnelMcpBindingPath(oldFacts.mcpCommand!, pair.bindingPath)}"`), { mode: 0o600 });
    migrated = { ...migrated, ref, bindingPath: pair.bindingPath };
  }
  const current = readLivePolicy(migrated.ref);
  const facts = parseTunnelProfile(fs.readFileSync(f.profilePath, "utf8"));
  const command = parseTunnelMcpCommand(facts.mcpCommand!);
  const now = () => "2026-11-03T00:00:00.000Z";
  const owner = { endpointId: current.manifest.chatgptEndpoint.endpointId, registered: true, participantId: "p", sessionId: "s", exchangeId: "e", fencingToken: 1, lease: "ACTIVE", leaseExpiresAt: "2026-11-03T00:01:00.000Z" };
  if (variant !== "missing") createLiveAdoptionRecorder({ ref: migrated.ref, launchDigest: createHash("sha256").update(fs.readFileSync(migrated.bindingPath)).digest("hex"), identity: { pid: 101, startedKey: "child-start" }, now }).record(current, owner, { state: variant === "blocked" ? "WRITE_BLOCKED" : "ACTIVE", renewal: "RUNNING" });
  let changed = false;
  probe.mockImplementation(async () => {
    await Promise.resolve();
    changed = true;
    if (variant === "profile-change") fs.appendFileSync(f.profilePath, "# changed\n");
    if (variant === "revoke") {
      const registration = createLivePolicyRegistration({ ref: migrated.ref });
      registration.revoke({ expectedDigest: readLivePolicy(migrated.ref).digest, endpointId: "pi/A" });
    }
    return { kind: variant === "missing" ? "UNVERIFIED" : variant === "blocked" ? "BLOCKED" : "OBSERVED" };
  });
  const result = await observeLiveConnection({ profilePath: f.profilePath, targetEndpointId: "pi/A", now,
    manager: { observeLiveTransport: async () => changed && variant === "disconnect" ? ({ kind: "UNAVAILABLE" }) : ({ kind: "CONNECTED", runId: "run", managedPid: 100, identityConfirmed: true }) },
    readOwner: () => ({ ...owner, ...(changed && variant === "owner-release" ? { lease: "RELEASED" } : {}),
      ...(changed && variant === "renewal" ? { leaseExpiresAt: "2026-11-03T00:02:00.000Z" } : {}),
      ...(changed && variant === "expiry-regression" ? { leaseExpiresAt: "2026-11-03T00:00:30.000Z" } : {}) }),
    inspect: async () => changed && variant === "child-exit" ? undefined : [
      { pid: 100, ppid: 1, uid: process.geteuid!(), startedKey: "manager-start", command: "managed client" },
      { pid: 101, ppid: 100, uid: process.geteuid!(), startedKey: "child-start", command: `${command.nodePath} ${command.scriptPath} --config ${command.bindingPath}` },
    ] });
  expect(result).toEqual({ policy: variant === "active" || variant === "active-v2" || variant === "renewal" ? "OBSERVED" : variant === "blocked" ? "BLOCKED" : "UNVERIFIED", transport: variant === "disconnect" ? "UNAVAILABLE" : "CONNECTED" });
});
