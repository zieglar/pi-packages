import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { generateLaunchAgent, planLaunchAgent } from "../../src/tunnel/launchagent-generator.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const homeDir = fs.mkdtempSync(join(tmpdir(), "ce-launchagent-"));
  dirs.push(homeDir);
  return { homeDir, account: "Build_User", name: "work-2", profilePath: "/Users/example/.config/ce/tunnel.yaml",
    clientPath: "/opt/homebrew/bin/tunnel-client" };
}

it("derives a safe account-scoped label and fixed LaunchAgents path", () => {
  const plan = planLaunchAgent(fixture());
  expect(plan.label).toBe("com.build-user.pi-chat-exchange.tunnel.work-2");
  expect(plan.path).toBe(join(plan.homeDir, "Library/LaunchAgents", `${plan.label}.plist`));
  expect(plan.plist).toContain("<string>/opt/homebrew/bin/tunnel-client</string>");
  expect(plan.plist).toContain("<string>--profile-file</string>");
  expect(plan.plist).toContain("<string>/Users/example/.config/ce/tunnel.yaml</string>");
  expect(plan.plist).not.toContain("launchctl");
});

it("rejects unsafe names, identities and non-absolute launch inputs", () => {
  const valid = fixture();
  for (const name of ["", "Work", "two words", "../escape", "a_thing", "-bad", "bad-", "a".repeat(65)]) {
    expect(() => planLaunchAgent({ ...valid, name })).toThrow("CE_LAUNCHAGENT_INVALID");
  }
  for (const account of ["", "../root", "two words"]) {
    expect(() => planLaunchAgent({ ...valid, account })).toThrow("CE_LAUNCHAGENT_INVALID");
  }
  expect(() => planLaunchAgent({ ...valid, profilePath: "relative.yaml" })).toThrow("CE_LAUNCHAGENT_INVALID");
  expect(() => planLaunchAgent({ ...valid, clientPath: "tunnel-client" })).toThrow("CE_LAUNCHAGENT_INVALID");
});

it("atomically creates one plist and never overwrites an existing target", () => {
  const options = fixture();
  const first = generateLaunchAgent(options);
  expect(fs.readFileSync(first.path, "utf8")).toBe(first.plist);
  expect(fs.statSync(first.path).mode & 0o777).toBe(0o644);
  expect(fs.readdirSync(join(options.homeDir, "Library/LaunchAgents"))).toEqual([`${first.label}.plist`]);
  expect(() => generateLaunchAgent(options)).toThrow("CE_LAUNCHAGENT_EXISTS");
  expect(fs.readFileSync(first.path, "utf8")).toBe(first.plist);
});

it("reports a created target as successful when temporary-link cleanup fails", () => {
  const options = fixture();
  const unlink = fs.unlinkSync;
  const spy = vi.spyOn(fs, "unlinkSync").mockImplementation(path => {
    if (String(path).endsWith(".tmp")) throw Object.assign(new Error("synthetic cleanup failure"), { code: "EACCES" });
    return unlink(path);
  });
  try {
    const generated = generateLaunchAgent(options);
    expect(fs.readFileSync(generated.path, "utf8")).toBe(generated.plist);
  } finally {
    spy.mockRestore();
  }
});
