import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundAuthorizationStore } from "../../src/tunnel/background-authorization.js";
import { createBackgroundTunnelManager, type BackgroundManagerOptions } from "../../src/tunnel/background-manager.js";
import { serializeTunnelProfile, buildTunnelProfile, buildTunnelMcpCommand } from "../../src/tunnel/profile.js";
import { parseMcpBindingConfig } from "../../src/host/mcp-binding-config.js";
import type { ProcessIdentity } from "../../src/tunnel/background-manager.js";
import { vi } from "vitest";
import { linkSync } from "node:fs";
// Executable/Native admission is tested separately; no test executes these synthetic files.
vi.mock("../../src/runtime/executables.js", () => ({ resolveTunnelClient: () => undefined, admitExecutable: (path: string) => path, qualifyNodeExecutable: () => ({}) }));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const root = join(new URL("../..", import.meta.url).pathname);
function fixture(env: NodeJS.ProcessEnv = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ce-persistent-auth-"))); dirs.push(dir);
  const key = join(dir, "credential"); writeFileSync(key, "synthetic-only", { mode: 0o600 });
  const client = join(dir, "tunnel-client"); writeFileSync(client, "synthetic-only", { mode: 0o700 });
  const node = join(dir, "node"); writeFileSync(node, "synthetic-only", { mode: 0o700 });
  const bindingPath = join(dir, "binding.json");
  const binding = { version: 1, store: { directory: dir, file: "store.sqlite" },
    exchange: { namespace: "test", idempotencyKey: "test" }, endpoint: { adapter: "chatgpt", endpointId: "chatgpt/main" },
    recipients: [], lease: { ttlSeconds: 120, renewIntervalSeconds: 30 }, payloadRead: { enabled: false }, ack: { enabled: false } };
  writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600 }); parseMcpBindingConfig(JSON.parse(readFileSync(bindingPath, "utf8")));
  const profilePath = join(dir, "tunnel.yaml");
  writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: "tunnel_abcdef123456", keyFile: key,
    healthUrlFile: join(dir, "health.url"), mcpCommand: buildTunnelMcpCommand({ nodePath: node,
      scriptPath: join(root, "dist/bin/mcp-stdio.js"), bindingPath }) })), { mode: 0o600 });
  const authorizationDirectory = join(dir, "authorization"); mkdirSync(authorizationDirectory, { mode: 0o700 });
  const store = createBackgroundAuthorizationStore({ directory: authorizationDirectory });
  const procs = new Map<number, ProcessIdentity>(); const spawned: number[] = [];
  const options: BackgroundManagerOptions = { env, profilePath, clientPath: client, authorizationDirectory,
    stateFilePath: join(dir, "state.json"), timing: { startupTimeoutMs: 1, pollIntervalMs: 1, freshnessMs: 1, failThresholdN: 1, recoverThresholdM: 1, stopGraceMs: 1 },
    inspectProcess: async pid => { const identity = procs.get(pid); return identity === undefined ? { kind: "absent" } : { kind: "present", identity }; },
    listProcesses: async () => ({ kind: "ok", processes: [...procs.values()] }),
    probeHealth: async () => ({ stdout: JSON.stringify({ result: "ok", healthz: { ok: true, body: "live" }, readyz: { ok: true }, process: { running: true }, control_plane_poll: { ok: true } }), exitCode: 0 }),
    spawn: (executable, args) => { const pid = 41000 + spawned.length; spawned.push(pid); procs.set(pid, { pid, command: `${executable} ${args.join(" ")}`, startedKey: "synthetic" }); return { pid, unref() {}, on() {} }; } };
  return { dir, profilePath, store, options, spawned };
}
describe("persistent background authorization scope", () => {
  it("requires permission without env, honors only a fresh grant, and reloads it in a new manager", async () => {
    const f = fixture();
    await expect(createBackgroundTunnelManager(f.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    expect(f.spawned).toHaveLength(0);
    const scope = createBackgroundTunnelManager(f.options).authorizationScope();
    f.store.write(f.profilePath, "granted", scope.digest);
    await createBackgroundTunnelManager(f.options).start().catch(error => { expect(error.code).not.toBe("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"); });
    expect(f.spawned).toHaveLength(1);
  });
  it("revocation survives restart and overrides an inherited environment opt-in", async () => {
    const f = fixture({ CE_TUNNEL_BACKGROUND_ALLOW: "1" });
    f.store.write(f.profilePath, "revoked", createBackgroundTunnelManager(f.options).authorizationScope().digest);
    await expect(createBackgroundTunnelManager(f.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    expect(f.spawned).toHaveLength(0);
  });
  it("profile and binding changes cannot inherit a grant even with env compatibility", async () => {
    const f = fixture({ CE_TUNNEL_BACKGROUND_ALLOW: "1" });
    f.store.write(f.profilePath, "granted", createBackgroundTunnelManager(f.options).authorizationScope().digest);
    writeFileSync(f.profilePath, readFileSync(f.profilePath, "utf8").replace("abcdef123456", "fedcba654321"), { mode: 0o600 });
    await expect(createBackgroundTunnelManager(f.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    expect(f.spawned).toHaveLength(0);
  });
  it.each([false, true])("revocation during asynchronous process enumeration prevents spawn (deferred=%s)", async deferred => {
    const f = fixture(); const manager = createBackgroundTunnelManager(f.options);
    manager.grantAuthorization(manager.authorizationScope().digest);
    let entered!: () => void; const opened = new Promise<void>(resolve => { entered = resolve; });
    let resume!: () => void; const paused = new Promise<void>(resolve => { resume = resolve; });
    const waiting = createBackgroundTunnelManager({ ...f.options, listProcesses: async () => { entered(); await paused; return { kind: "ok", processes: [] }; } });
    const attempt = deferred ? (() => { const task = waiting.startDeferred(); void task.ack.catch(() => undefined); return task.settled; })() : waiting.start();
    const rejected = expect(attempt).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    await opened; manager.revokeAuthorization(); resume(); await rejected;
    expect(f.spawned).toHaveLength(0);
  });
  it.each(["binding", "client", "profile"])("changed %s input cannot inherit permission", async target => {
    const f = fixture({ CE_TUNNEL_BACKGROUND_ALLOW: "1" }); const manager = createBackgroundTunnelManager(f.options);
    manager.grantAuthorization(manager.authorizationScope().digest);
    const path = target === "binding" ? join(f.dir, "binding.json") : target === "client" ? f.options.clientPath! : f.profilePath;
    writeFileSync(path, readFileSync(path, "utf8") + "\n ");
    await expect(createBackgroundTunnelManager(f.options).start()).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    expect(f.spawned).toHaveLength(0);
  });
  it("caller expected profile rejects queued generation change before spawn", async () => {
    const f = fixture({ CE_TUNNEL_BACKGROUND_ALLOW: "1" }); const manager = createBackgroundTunnelManager(f.options);
    const expected = manager.authorizationScope().profileSha256;
    writeFileSync(f.profilePath, readFileSync(f.profilePath, "utf8") + "\n");
    await expect(manager.start(expected)).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(f.spawned).toHaveLength(0);
  });
  it("rejects a hard-linked profile before scope parsing", () => {
    const f = fixture(); linkSync(f.profilePath, join(f.dir, "profile-alias"));
    expect(() => createBackgroundTunnelManager(f.options).authorizationScope()).toThrow();
    expect(f.spawned).toHaveLength(0);
  });
});
