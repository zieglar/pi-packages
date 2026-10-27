import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const seam = vi.hoisted(() => ({
  child: vi.fn(() => "/synthetic/qualified-node" as string | undefined),
  client: vi.fn(() => "CE_TUNNEL_CLIENT_MISSING"),
  store: vi.fn(() => { throw Error("private-store-access"); }),
  manager: vi.fn(() => { throw Error("private-manager-created"); }),
  defaultExec: vi.fn(() => { throw Error("FORBIDDEN default process inspection"); }),
  defaultSpawn: vi.fn(() => { throw Error("FORBIDDEN process spawn"); }),
  signal: vi.fn(() => { throw Error("FORBIDDEN process signal"); }),
}));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFile: seam.defaultExec, spawn: seam.defaultSpawn }));
vi.mock("../../dist/runtime/executables.js", async original => {
  const actual = await original<typeof import("../../src/runtime/executables.js")>();
  return { ...actual, resolveApprovedNode: seam.child, diagnoseTunnelClient: seam.client };
});
vi.mock("../../dist/storage/store.js", () => ({ initializeStore: seam.store, openStore: seam.store }));
vi.mock("../../dist/tunnel/background-manager.js", async original => {
  const actual = await original<typeof import("../../src/tunnel/background-manager.js")>();
  return { ...actual, createBackgroundTunnelManager: seam.manager };
});
const dirs: string[] = [];
beforeEach(() => { for (const key of Object.keys(process.env)) if (key.startsWith("CE_")) vi.stubEnv(key, undefined); vi.spyOn(process, "kill").mockImplementation(seam.signal); });
afterEach(() => { expect(seam.defaultExec).not.toHaveBeenCalled(); expect(seam.defaultSpawn).not.toHaveBeenCalled(); expect(seam.signal).not.toHaveBeenCalled(); vi.unstubAllEnvs(); vi.restoreAllMocks(); seam.child.mockReset().mockReturnValue("/synthetic/qualified-node"); seam.client.mockReset().mockReturnValue("CE_TUNNEL_CLIENT_MISSING"); seam.store.mockClear(); seam.manager.mockClear(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it.each(["CE_TUNNEL_CLIENT_MISSING", "CE_EXECUTABLE_UNTRUSTED", "TRUSTED_METADATA_ONLY"])("unbound doctor reports %s with zero runtime effects", async outcome => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ce-doctor-command-"))); dirs.push(dir);
  const allowlist = join(dir, "allowlist.json"); fs.writeFileSync(allowlist, JSON.stringify({ sessions: {} }), { mode: 0o600 });
  vi.stubEnv("CE_ALLOWLIST", allowlist); vi.stubEnv("CE_TUNNEL_PROFILE", join(dir, "NEVER-READ-PROFILE"));
  vi.stubEnv("CE_NODE_PATH", "/private/override-secret"); vi.stubEnv("CE_TUNNEL_CLIENT_PATH", "/private/client-secret");
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions(prefix: string): Array<{ value: string }> }>();
  const append = vi.fn(); const notify = vi.fn();
  const { default: factory } = await import(new URL("../../pi-extension/index.ts", import.meta.url).href);
  factory({ on: vi.fn(), registerTool: vi.fn(), appendEntry: append, registerCommand: (name: string, command: never) => commands.set(name, command) } as never);
  seam.client.mockReturnValue(outcome); seam.child.mockImplementation(() => { throw Error("private-subprocess-output"); });
  const ctx = { mode: "tui", hasUI: true, cwd: dir, sessionManager: { getSessionId: () => "unbound", getBranch: () => [] }, ui: { notify } };
  const before = fs.readdirSync(dir);
  await commands.get("ce-tunnel")!.handler("doctor", ctx);
  const message = notify.mock.calls.map(([text]) => text).join("\n");
  expect(message).toContain(`client=${outcome}`); expect(message).toContain("Pi host=QUALIFIED"); expect(message).toContain("MCP child=CE_NODE_INELIGIBLE");
  expect(message).not.toContain("private-"); expect(message).not.toContain(dir);
  expect(seam.store).not.toHaveBeenCalled(); expect(seam.manager).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled(); expect(fs.readdirSync(dir)).toEqual(before);
  expect(commands.get("ce-tunnel")!.getArgumentCompletions("doc").map(item => item.value)).toContain("doctor");
  expect(commands.get("ce-tunnel")!.getArgumentCompletions("dea").map(item => item.value)).toContain("deactivate");
});
