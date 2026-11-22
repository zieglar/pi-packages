import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

it("distributes a discoverable pi-chat-exchange skill with routed references", async () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  expect(manifest.pi.skills).toEqual(["./skills"]);
  const paths = [
    "skills/pi-chat-exchange/SKILL.md",
    "skills/pi-chat-exchange/references/chatgpt-work.md",
    "skills/pi-chat-exchange/references/pi.md",
    "skills/pi-chat-exchange/references/e2e-smoke.md",
  ];
  for (const path of paths) {
    expect(existsSync(resolve(root, path)), path).toBe(true);
    expect(manifest.files).toContain(path);
  }
  const skill = readFileSync(resolve(root, paths[0]!), "utf8");
  expect(skill).toMatch(/^---\nname: pi-chat-exchange\ndescription:/);
  for (const reference of paths.slice(1)) expect(skill).toContain(reference.replace("skills/pi-chat-exchange/", ""));
  const { loadSkills } = await import("@earendil-works/pi-coding-agent");
  const discovered = loadSkills({ cwd: root, agentDir: resolve(root, ".test-agent-missing"), includeDefaults: false, skillPaths: [resolve(root, "skills")] });
  expect(discovered.diagnostics).toEqual([]);
  expect(discovered.skills.map(item => item.name).sort()).toEqual(["ce-hook-script", "pi-chat-exchange"]);
});
