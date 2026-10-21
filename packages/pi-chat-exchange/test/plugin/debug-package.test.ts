import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("packages a distinct debug identity with contained launcher and same-process guard, refuses overwrite", () => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ce-debug-build-"));
  try {
    mkdirSync(join(dir, "deps")); mkdirSync(join(dir, "mcp-config"));
    writeFileSync(join(dir, "mcp-config/binding.json"), JSON.stringify({ store: { directory: join(dir, "store") } }));
    // A minimal dependency fixture suffices: builder copies, never installs or executes it.
    writeFileSync(join(dir, "deps/marker"), "isolated");
    const args = [join(root, "scripts/package-debug-plugin.mjs"), "--root", dir, "--dependencies", join(dir, "deps")];
    const built = spawnSync(process.execPath, args, { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
    const output = join(dir, "marketplace/plugins/pi-chat-exchange-gate-b1-debug");
    const plugin = JSON.parse(readFileSync(join(output, "plugin.json"), "utf8"));
    expect(plugin.name).toBe("pi-chat-exchange-gate-b1-debug");
    const mcp = JSON.parse(readFileSync(join(output, "mcp.json"), "utf8"));
    expect(mcp.mcpServers[plugin.name].command).toBe("./bin/launch");
    expect(readFileSync(join(output, "server/launch.mjs"), "utf8")).toContain('["--require", join(pluginRoot, "bin/version-guard.cjs"), entrypoint');
    // DIAG-04: generated mcp.json must carry the same $schema as the valid frozen baseline,
    // preserving every other field and the contained launcher projection.
    const baselineMcp = JSON.parse(readFileSync(join(root, "plugin/pi-chat-exchange/mcp.json"), "utf8"));
    expect(mcp.$schema, "missing $schema reproduces the Desktop plugin/read parse failure").toBe(baselineMcp.$schema);
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(baselineMcp).sort());
    expect(spawnSync(process.execPath, args, { encoding: "utf8" }).status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("refuses a Store path with a symlink ancestor escaping isolation", () => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ce-debug-linked-"));
  const outside = mkdtempSync(join(realpathSync(tmpdir()), "ce-debug-outside-"));
  try {
    mkdirSync(join(dir, "deps")); mkdirSync(join(dir, "mcp-config"));
    symlinkSync(outside, join(dir, "store-link"));
    writeFileSync(join(dir, "mcp-config/binding.json"), JSON.stringify({ store: { directory: join(dir, "store-link/store") } }));
    const result = spawnSync(process.execPath, [join(root, "scripts/package-debug-plugin.mjs"), "--root", dir, "--dependencies", join(dir, "deps")], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
