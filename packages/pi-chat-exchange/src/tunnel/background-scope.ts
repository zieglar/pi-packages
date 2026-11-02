import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from "node:fs";
import { fileURLToPath } from "node:url";
import { admitExecutable, qualifyNodeExecutable } from "../runtime/executables.js";
import { resolveWrapperIdentityEvidence } from "../runtime/wrapper-identity.js";
import { parseMcpBindingConfig } from "../host/mcp-binding-config.js";
import { parseTunnelMcpCommand } from "./profile.js";
import { TunnelRefusal } from "./codes.js";

export interface BackgroundAuthorizationScope {
  readonly digest: string;
  readonly profileSha256: string;
  readonly clientPath: string;
  readonly credentialPath: string;
}
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const identity = (stat: Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode, stat.uid];
function safeDocument(path: string, key: Stats): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    // Exclude credential aliases before reading even a single byte.
    if (!stat.isFile() || (stat.uid !== process.geteuid?.() && stat.uid !== 0) ||
        (stat.mode & 0o022) !== 0 || stat.size > 1_048_576 || (stat.dev === key.dev && stat.ino === key.ino)) throw new Error("unsafe");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > 1_048_576) throw new Error("oversized");
    return text;
  } catch { throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "authorization.scope"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
/** Exact launch scope, never credential contents or messaging authority. The caller
 * admits the selected client; grant validation rechecks these file identities before spawn. */
export function captureBackgroundAuthorizationScope(input: {
  readonly profilePath: string; readonly profileText: string; readonly credentialPath: string;
  readonly mcpCommand: string | undefined; readonly clientPath: string | undefined;
}): BackgroundAuthorizationScope {
  try {
    if (input.clientPath === undefined || input.mcpCommand === undefined) throw new Error("missing");
    const key = lstatSync(input.credentialPath);
    if (safeDocument(input.profilePath, key) !== input.profileText) throw new Error("drift");
    const client = lstatSync(input.clientPath);
    if (!client.isFile() || (client.uid !== process.geteuid?.() && client.uid !== 0) || (client.mode & 0o022) !== 0) throw new Error("client");
    const wrapper = resolveWrapperIdentityEvidence(input.clientPath);
    const parsed = parseTunnelMcpCommand(input.mcpCommand);
    const scriptPath = fileURLToPath(new URL("../../dist/bin/mcp-stdio.js", import.meta.url));
    // Persistent permission never authorizes an arbitrary script with a familiar basename.
    if (parsed.scriptPath !== scriptPath) throw new Error("script");
    admitExecutable(parsed.nodePath);
    qualifyNodeExecutable(parsed.nodePath);
    const binding = safeDocument(parsed.bindingPath, key);
    parseMcpBindingConfig(JSON.parse(binding));
    const profileSha256 = sha(input.profileText);
    const scope = { version: 1, profilePath: input.profilePath, profileSha256,
      credential: [input.credentialPath, ...identity(key)], client: [input.clientPath, ...identity(client)],
      wrapper: wrapper?.execTarget === undefined ? null : [wrapper.execTarget, ...identity(lstatSync(wrapper.execTarget))],
      node: [parsed.nodePath, ...identity(lstatSync(parsed.nodePath))],
      script: [scriptPath, sha(safeDocument(scriptPath, key))], binding: [parsed.bindingPath, sha(binding)] };
    return { digest: sha(JSON.stringify(scope)), profileSha256, clientPath: input.clientPath, credentialPath: input.credentialPath };
  } catch (error) {
    if (error instanceof TunnelRefusal) throw error;
    throw new TunnelRefusal("CE_TUNNEL_PROFILE_INVALID", "authorization.scope");
  }
}
