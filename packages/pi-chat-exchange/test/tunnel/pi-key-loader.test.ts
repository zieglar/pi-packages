import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const runner = fileURLToPath(new URL("../fixtures/pi-key-loader.mjs", import.meta.url));

it.each([
  ["host", "../../pi-extension/index.ts"],
  ["semantics", "../fixtures/pi-key-semantics.ts"],
])("Pi 1.3.0 public loader: %s (no session binding)", (mode, relativeEntry) => {
  const root = mkdtempSync(join(tmpdir(), "ce-pi-key-loader-"));
  try {
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    const agent = join(root, "agent");
    for (const directory of [home, cwd, agent]) mkdirSync(directory, { mode: 0o700 });
    // Allowlist, never inherit CE_*, provider credentials, NODE_OPTIONS, live
    // profiles, proxy config or extension settings. No CLI/session is created.
    const child = spawnSync(process.execPath, [runner, fileURLToPath(new URL(relativeEntry, import.meta.url)), mode], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        CE_TUNNEL_PROFILE: join(root, "unused-private-profile"),
        PI_OFFLINE: "1",
        DO_NOT_TRACK: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    const output = `${child.stdout}\n${child.stderr}`;
    expect(child.error, output).toBeUndefined();
    expect(child.status, output).toBe(0);
    expect(output).toContain(`loader-only ${mode} PASS`);
    if (mode === "semantics") expect(output).toContain("Printable semantics PASS");
    // Registration alone must not create profile/Store/session state.
    expect(readdirSync(root).sort()).toEqual(["agent", "cwd", "home"]);
    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(readdirSync(agent)).toEqual([]);
    console.log(output.trim());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
