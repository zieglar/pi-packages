import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { admitExecutable, admitInstallationDirectory, qualifyNodeExecutable } from "./executables.js";

const SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const invalid = (): never => { throw new Error("CE_DESKTOP_CONFIG_INVALID"); };

/** Explicit preparation of an unpacked, operator-owned LOCAL copy. This never
 * installs/registers/launches the plugin, resolves binding credentials or opens Store. */
export function configureDesktopManifest(pluginRoot: string, nodePath: string): void {
  let fd: number | undefined;
  let temporary: string | undefined;
  try {
    if (!isAbsolute(pluginRoot) || normalize(pluginRoot) !== pluginRoot || realpathSync(pluginRoot) !== pluginRoot) invalid();
    admitInstallationDirectory(pluginRoot);
    const root = lstatSync(pluginRoot);
    if (!root.isDirectory() || root.uid !== process.geteuid?.() || (root.mode & 0o777) !== 0o700) invalid();
    const server = lstatSync(join(pluginRoot, "server"));
    const launcher = lstatSync(join(pluginRoot, "server/launch.mjs"));
    if (!server.isDirectory() || server.isSymbolicLink() || !launcher.isFile() || launcher.isSymbolicLink()) invalid();
    const manifestPath = join(pluginRoot, "mcp.json");
    fd = openSync(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const original = fstatSync(fd);
    if (!original.isFile() || original.uid !== process.geteuid?.() || original.nlink !== 1 || original.size > 16_384 || (original.mode & 0o022) !== 0) invalid();
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > 16_384) invalid();
    const template = JSON.parse(text) as Record<string, unknown>;
    if (template.$schema !== SCHEMA || Object.keys(template).sort().join(",") !== "$schema,mcpServers" ||
        template.mcpServers === null || typeof template.mcpServers !== "object" || Array.isArray(template.mcpServers) ||
        Object.keys(template.mcpServers).length !== 0) invalid();
    closeSync(fd); fd = undefined;
    const command = admitExecutable(nodePath);
    qualifyNodeExecutable(command);
    const manifest = { $schema: SCHEMA, mcpServers: { "pi-chat-exchange": {
      type: "stdio", command, args: ["${PLUGIN_ROOT}/server/launch.mjs"], cwd: "${PLUGIN_ROOT}",
    } } };
    temporary = join(pluginRoot, `.mcp-${randomUUID()}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, undefined, 2)}\n`);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    const current = lstatSync(manifestPath);
    if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size || current.mtimeMs !== original.mtimeMs) invalid();
    renameSync(temporary, manifestPath); temporary = undefined;
  } catch { invalid(); }
  finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) rmSync(temporary, { force: true });
  }
}
