import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureDesktopManifest } from "../../src/runtime/desktop-manifest.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-desktop-config-")); roots.push(root); chmodSync(root, 0o700);
  const plugin = join(root, "local-plugin"); mkdirSync(plugin, { mode: 0o700 }); mkdirSync(join(plugin, "server"));
  writeFileSync(join(plugin, "server/launch.mjs"), "// fixture: not executed\n");
  const manifest = join(plugin, "mcp.json"); writeFileSync(manifest, JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} }));
  const runtime = join(root, "approved runtime"); mkdirSync(runtime); const node = join(runtime, "node");
  copyFileSync(process.execPath, node); chmodSync(node, 0o700);
  return { root, plugin, manifest, node };
}
it("generates only a local absolute-command manifest after actual qualification", () => {
  const h = fixture(); configureDesktopManifest(h.plugin, h.node);
  expect(JSON.parse(readFileSync(h.manifest, "utf8"))).toMatchObject({ mcpServers: { "pi-chat-exchange": {
    type: "stdio", command: h.node, args: ["${PLUGIN_ROOT}/server/launch.mjs"], cwd: "${PLUGIN_ROOT}" } } });
  expect(existsSync(join(h.root, "store"))).toBe(false);
});
it("refuses an invalid Node without changing the template", () => {
  const h = fixture(); const before = readFileSync(h.manifest, "utf8");
  expect(() => configureDesktopManifest(h.plugin, "node")).toThrow();
  expect(readFileSync(h.manifest, "utf8")).toBe(before);
});
it("refuses symlink manifest targets without modifying their destinations", () => {
  const h = fixture(); const outside = join(h.root, "outside.json"); writeFileSync(outside, "untouched");
  rmSync(h.manifest); symlinkSync(outside, h.manifest);
  expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
  expect(readFileSync(outside, "utf8")).toBe("untouched");
});
it("does not silently overwrite an already configured local manifest", () => {
  const h = fixture(); configureDesktopManifest(h.plugin, h.node);
  const before = readFileSync(h.manifest, "utf8");
  expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
  expect(readFileSync(h.manifest, "utf8")).toBe(before);
});
it("refuses a private local copy beneath an unsafe writable ancestor", () => {
  const h = fixture(); const parent = join(h.root, "unsafe-parent"); mkdirSync(parent); chmodSync(parent, 0o777);
  const moved = join(parent, "local-plugin"); renameSync(h.plugin, moved);
  expect(() => configureDesktopManifest(moved, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
});
it("refuses writable plugin roots", () => {
  const h = fixture(); chmodSync(h.plugin, 0o777);
  expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
});
it.each(["server", "server/launch.mjs"])("refuses traversable plugin roots with writable %s", (relative) => {
  const h = fixture(); chmodSync(h.plugin, 0o755);
  chmodSync(join(h.plugin, relative), relative === "server" ? 0o777 : 0o666);
  const before = readFileSync(h.manifest, "utf8");
  expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
  expect(readFileSync(h.manifest, "utf8")).toBe(before);
});
it("refuses hardlinked manifest templates without modifying either link", () => {
  const h = fixture(); const other = join(h.root, "linked.json");
  linkSync(h.manifest, other); const before = readFileSync(other, "utf8");
  expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
  expect(readFileSync(h.manifest, "utf8")).toBe(before);
  expect(readFileSync(other, "utf8")).toBe(before);
});
it.skipIf(process.platform !== "darwin")("refuses an allow ACL on a POSIX-private Desktop root", () => {
  const h = fixture(); const before = readFileSync(h.manifest, "utf8");
  execFileSync("/bin/chmod", ["+a", "everyone allow write,add_file,add_subdirectory", h.plugin]);
  try {
    expect(() => configureDesktopManifest(h.plugin, h.node)).toThrow("CE_DESKTOP_CONFIG_INVALID");
    expect(readFileSync(h.manifest, "utf8")).toBe(before);
  } finally { execFileSync("/bin/chmod", ["-N", h.plugin]); }
});
