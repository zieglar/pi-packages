import fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CeHookRule } from "../dist/hooks/config.js";
import { AGENT_DESKTOP_HOOK_ID, findDesktopTargetHook } from "./desktop-target.js";

const privateFile = (path: string): boolean => {
  try { const stat = fs.lstatSync(path); return stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.geteuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 16384 && fs.realpathSync(path) === path; }
  catch { return false; }
};

export function discoverAgentDesktopHookPreset(options: { readonly dataRoot?: string; readonly recipient: { readonly adapter: "chatgpt"; readonly endpointId: string } }): CeHookRule | undefined {
  try {
    const dataRoot = options.dataRoot ?? process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    if (!isAbsolute(dataRoot) || options.recipient.endpointId.length === 0) return undefined;
    const family = join(dataRoot, "ce-chat-exchange");
    const names = fs.readdirSync(family).filter(name => name.startsWith("agent-desktop-") && !name.includes("/") && !name.includes(".."));
    if (names.length > 64) return undefined;
    const candidates = names.flatMap(name => {
      const owner = join(family, name, "hook"), config = join(owner, "config.json"), autoPath = join(owner, "auto-wake.json");
      if (!privateFile(config) || !privateFile(autoPath)) return [];
      const outer: unknown = JSON.parse(fs.readFileSync(config, "utf8")); const auto: unknown = JSON.parse(fs.readFileSync(autoPath, "utf8"));
      if (!outer || typeof outer !== "object" || Array.isArray(outer) || Reflect.ownKeys(outer).length !== 1 || (outer as { autoWakeConfig?: unknown }).autoWakeConfig !== autoPath || !auto || typeof auto !== "object" || Array.isArray(auto)) return [];
      const python = (auto as { python?: unknown }).python; if (typeof python !== "string") return [];
      const rule: CeHookRule = { id: AGENT_DESKTOP_HOOK_ID, event: "ce.message.committed.v1", recipient: options.recipient, command: python,
        args: ["-B", join(owner, "tools", "ce-chatgpt-wake", "wake.py"), "--config", config, "--hook"], timeoutMs: 10000, enabled: true, scope: "workspace",
        status: { label: "Desktop", command: python, args: ["-B", join(owner, "tools", "ce-chatgpt-wake", "status_probe.py"), "--config", autoPath], timeoutMs: 2000 } };
      return findDesktopTargetHook([rule]) === undefined ? [] : [rule];
    });
    return candidates.length === 1 ? candidates[0] : undefined;
  } catch { return undefined; }
}

export function discoverAgentDesktopHookPresetForPolicy(options: { readonly dataRoot?: string; readonly chatgptEndpoint: { readonly endpointId: string } }): CeHookRule | undefined {
  return discoverAgentDesktopHookPreset({ ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }), recipient: { adapter: "chatgpt", endpointId: options.chatgptEndpoint.endpointId } });
}
