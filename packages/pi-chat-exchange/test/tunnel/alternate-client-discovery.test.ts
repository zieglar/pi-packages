import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const ps = vi.hoisted(() => ({ output: "" }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  execFile: (_file: unknown, _args: unknown, _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, ps.output),
}));
import { createBackgroundTunnelManager } from "../../src/tunnel/background-manager.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-alternate-client-")); roots.push(root); chmodSync(root, 0o700);
  const profilePath = join(root, "tunnel.yaml"); const key = join(root, "key");
  writeFileSync(key, "synthetic-key-not-real".repeat(2), { mode: 0o600 });
  writeFileSync(profilePath, `config_version: 1\ncontrol_plane:\n  base_url: "https://api.openai.com"\n  tunnel_id: "tunnel_abcdef1234567890"\n  api_key: "file:${key}"\nhealth:\n  listen_addr: "127.0.0.1:0"\n  url_file: "${join(root, "health.url")}"\nadmin_ui:\n  open_browser: false\nlog:\n  level: info\nmcp:\n  commands:\n    - channel: main\n      command: "/usr/bin/node /tmp/mcp-stdio.js --config ${join(root, "binding.json")}"\n`, { mode: 0o600 });
  ps.output = `54321 Tue Oct 20 06:30:09 2026 /trusted/ce-client-real run --profile-file ${profilePath}\n`;
  const spawn = vi.fn(() => { throw new Error("NO_REAL_SPAWN"); }); const signal = vi.fn();
  const manager = createBackgroundTunnelManager({ env: { CE_TUNNEL_BACKGROUND_ALLOW: "1" }, profilePath,
    clientPath: "/trusted/ce-client-real", spawn, signal,
    inspectProcess: async () => ({ kind: "present", identity: { pid: process.pid, startedKey: "Mon Oct 12 00:00:00 2026", command: "test" } }),
  });
  return { manager, spawn, signal };
}
it("default process discovery refuses duplicate start for an alternate client basename", async () => {
  const h = fixture();
  await expect(h.manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_EXTERNAL_INSTANCE" });
  expect(h.spawn).not.toHaveBeenCalled(); expect(h.signal).not.toHaveBeenCalled(); await h.manager.dispose();
});
it("default process discovery blocks setup replacement for an alternate client basename", async () => {
  const h = fixture(); const write = vi.fn();
  await expect(h.manager.withProfileConfigurationLock(write)).rejects.toMatchObject({ code: "CE_TUNNEL_EXTERNAL_INSTANCE" });
  expect(write).not.toHaveBeenCalled(); expect(h.spawn).not.toHaveBeenCalled(); expect(h.signal).not.toHaveBeenCalled(); await h.manager.dispose();
});
