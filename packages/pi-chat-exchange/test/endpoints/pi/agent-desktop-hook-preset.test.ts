import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverAgentDesktopHookPreset, discoverAgentDesktopHookPresetForPolicy } from "../../../pi-extension/agent-desktop-hook-preset.js";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function owner(name = "agent-desktop-hook-01") {
  const created = fs.mkdtempSync(join(os.tmpdir(), "ce-desktop-preset-")); roots.push(created); const root = fs.realpathSync(created);
  const directory = join(root, "ce-chat-exchange", name, "hook"); fs.mkdirSync(join(directory, "tools", "ce-chatgpt-wake"), { recursive: true, mode: 0o700 });
  const auto = { ownerDirectory: directory, python: "/opt/homebrew/bin/python3", conversationGuard: { targetSelection: "desktop-at-intake", captureAfterAuditSequence: 1 } };
  fs.writeFileSync(join(directory, "auto-wake.json"), JSON.stringify(auto), { mode: 0o600 }); fs.writeFileSync(join(directory, "config.json"), JSON.stringify({ autoWakeConfig: join(directory, "auto-wake.json") }), { mode: 0o600 });
  return { root, directory };
}
it("discovers one private installed owner without machine-specific constants", () => {
  const f = owner(); expect(discoverAgentDesktopHookPreset({ dataRoot: f.root, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } })).toMatchObject({
    id: "ce-agent-desktop-wake", command: "/opt/homebrew/bin/python3", recipient: { endpointId: "chatgpt/main" },
    status: { label: "Desktop", command: "/opt/homebrew/bin/python3", args: ["-B", join(f.directory, "tools", "ce-chatgpt-wake", "status_probe.py"), "--config", join(f.directory, "auto-wake.json")], timeoutMs: 2000 },
  });
});
it("uses the live policy ChatGPT endpoint schema, which contains only endpointId", () => {
  const f = owner();
  expect(discoverAgentDesktopHookPresetForPolicy({ dataRoot: f.root, chatgptEndpoint: { endpointId: "chatgpt/main" } })).toMatchObject({ recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } });
});
it("refuses absent and ambiguous owners", () => {
  const empty = fs.mkdtempSync(join(os.tmpdir(), "ce-desktop-empty-")); roots.push(empty); expect(discoverAgentDesktopHookPreset({ dataRoot: empty, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } })).toBeUndefined();
  const f = owner(); const second = join(f.root, "ce-chat-exchange", "agent-desktop-second", "hook"); fs.cpSync(f.directory, second, { recursive: true });
  const autoPath = join(second, "auto-wake.json"), configPath = join(second, "config.json"); fs.writeFileSync(autoPath, JSON.stringify({ ownerDirectory: second, python: "/opt/homebrew/bin/python3", conversationGuard: { targetSelection: "desktop-at-intake", captureAfterAuditSequence: 1 } }), { mode: 0o600 }); fs.writeFileSync(configPath, JSON.stringify({ autoWakeConfig: autoPath }), { mode: 0o600 });
  expect(discoverAgentDesktopHookPreset({ dataRoot: f.root, recipient: { adapter: "chatgpt", endpointId: "chatgpt/main" } })).toBeUndefined();
});
