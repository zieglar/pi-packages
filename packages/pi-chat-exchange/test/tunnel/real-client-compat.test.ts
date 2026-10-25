/**
 * REAL-START-FIX-01 — regression against the REAL installed tunnel-client
 * 0.0.16 schema, so the offline simulator can never again mask a
 * generator/decoder mismatch with the actual binary.
 *
 * These tests are skipped when `tunnel-client` is not installed (CI / other
 * machines). They never start a daemon, read a credential, or contact a control
 * plane: `tunnel-client doctor` only parses and validates the profile.
 * Intentional difference inside this opt-in lane: this file skips on a missing client, while offline.integration.test.ts throws loudly instead of skipping.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTunnelProfile, serializeTunnelProfile } from "../../src/tunnel/profile.js";

const CLIENT = "/opt/homebrew/bin/tunnel-client";
const available = existsSync(CLIENT);

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Write a realistic (key + stdio script present) generated profile and return
 *  its path. The key file is a non-secret placeholder; its contents are never
 *  read by the test or the client. */
function writeProfile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ce-real-client-")); dirs.push(dir);
  const path = join(dir, "tunnel.yaml");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

function generatedProfile(dir: string): string {
  const key = join(dir, "runtime-key");
  writeFileSync(key, "x".repeat(24), { mode: 0o600 });
  const script = join(dir, "mcp-stdio.js");
  writeFileSync(script, "#!/usr/bin/env node\n", { mode: 0o700 });
  return serializeTunnelProfile(buildTunnelProfile({
    tunnelId: "tunnel_6ad49fce3df081919fa181980b494729",
    organizationId: "org-J9Mg0ZApcakcou48jDZ9wjwc",
    keyFile: key,
    healthUrlFile: join(dir, "health.url"),
    mcpCommand: `${process.execPath} ${script} --config ${join(dir, "binding.yaml")}`,
  }));
}

/** Returns the doctor exit code: 0 = ok, 2 = failed checks. */
function doctor(profilePath: string): number {
  try {
    execFileSync(CLIENT, ["doctor", "--config", profilePath], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000 });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

describe.skipIf(!available)("real tunnel-client 0.0.16 profile compatibility", () => {
  it("accepts the generated canonical profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-real-client-")); dirs.push(dir);
    const path = writeProfile(generatedProfile(dir));
    expect(doctor(path)).toBe(0);
  });

  it("rejects a profile carrying admin_ui.allow_remote_ui (the original failure)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-real-client-")); dirs.push(dir);
    const stale = generatedProfile(dir).replace("admin_ui:\n  open_browser: false", "admin_ui:\n  open_browser: false\n  allow_remote_ui: false");
    const path = writeProfile(stale);
    expect(doctor(path)).toBe(2);
  });

  it("rejects a profile carrying admin_ui.log_buffer_events: 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "ce-real-client-")); dirs.push(dir);
    const stale = generatedProfile(dir).replace("admin_ui:\n  open_browser: false", "admin_ui:\n  open_browser: false\n  log_buffer_events: 0");
    const path = writeProfile(stale);
    expect(doctor(path)).toBe(2);
  });
});
