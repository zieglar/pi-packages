import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTunnelProfileSetup } from "../../dist/tunnel/setup.js";
import { createBackgroundTunnelManager, parseTunnelProfile } from "../../dist/tunnel/background-manager.js";
import { parseTunnelMcpCommand } from "../../dist/tunnel/profile.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function harness(env: NodeJS.ProcessEnv) {
  const root = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "ce-portability-")); roots.push(root);
  fs.chmodSync(root, 0o700);
  const profilePath = join(root, "tunnel.yaml");
  const bindingPath = join(root, "binding.json");
  fs.writeFileSync(bindingPath, JSON.stringify({ version: 1, store: { directory: join(root, "UNOPENED-STORE") },
    exchange: { namespace: "portability-test", idempotencyKey: "exchange-1" },
    endpoint: { adapter: "local", endpointId: "test" }, recipients: [] }), { mode: 0o600 });
  let spawns = 0;
  const manager = createBackgroundTunnelManager({ env, profilePath,
    listProcesses: async () => ({ kind: "ok", processes: [] }),
    inspectProcess: async () => ({ kind: "absent" }),
    spawn: () => { spawns++; throw new Error("NO_REAL_CLIENT"); },
    signal: () => { throw new Error("NO_SIGNALS"); },
  });
  const setup = createTunnelProfileSetup({ env, profilePath, manager, mcpScriptPath: "/approved/mcp-stdio.js" });
  const save = () => setup.save({ expectedRevision: setup.inspect().revision, tunnelId: "tunnel_abcdefgh123456",
    credential: { kind: "replace", secret: "synthetic-portability-test-only" }, binding: { kind: "path", path: bindingPath } });
  return { root, profilePath, manager, save, spawns: () => spawns };
}
it("writes a profile using explicitly qualified Node outside mise, including spaces", async () => {
  const h = harness({}); const dir = join(h.root, "portable node"); fs.mkdirSync(dir);
  const node = join(dir, "node"); fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o700);
  const configured = createTunnelProfileSetup({ env: { CE_NODE_PATH: node, PATH: "/usr/bin:/bin" },
    profilePath: h.profilePath, manager: h.manager, mcpScriptPath: "/approved/mcp-stdio.js" });
  await configured.save({ expectedRevision: null, tunnelId: "tunnel_abcdefgh123456",
    credential: { kind: "replace", secret: "synthetic-portability-test-only" }, binding: { kind: "path", path: join(h.root, "binding.json") } });
  expect(parseTunnelMcpCommand(parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).mcpCommand!).nodePath).toBe(node);
  expect(fs.existsSync(join(h.root, "UNOPENED-STORE"))).toBe(false);
  expect(h.spawns()).toBe(0);
});
it("invalid explicit Node refuses setup without publishing a profile", async () => {
  const h = harness({ CE_NODE_PATH: "node" });
  await expect(h.save()).rejects.toMatchObject({ field: "mcp.commands.0.command" });
  expect(fs.existsSync(h.profilePath)).toBe(false);
  expect(fs.existsSync(join(h.root, "UNOPENED-STORE"))).toBe(false);
  expect(h.spawns()).toBe(0);
});
it("missing explicitly selected client refuses spawn while preserving inspection", async () => {
  const env = { CE_TUNNEL_CLIENT_PATH: "/missing/ce-tunnel-client", CE_TUNNEL_BACKGROUND_ALLOW: "1", CE_NODE_PATH: "" };
  const h = harness(env);
  const node = join(h.root, "node"); fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o700);
  env.CE_NODE_PATH = node;
  await h.save();
  const saved = fs.readFileSync(h.profilePath, "utf8");
  await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_SPAWN_FAILED" });
  expect(h.spawns()).toBe(0);
  expect(fs.readFileSync(h.profilePath, "utf8")).toBe(saved);
  expect(parseTunnelProfile(saved).mcpCommand).toBeDefined();
  expect(fs.existsSync(join(h.root, "UNOPENED-STORE"))).toBe(false);
});
