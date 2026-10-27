/**
 * HANDOFF-CE-HOST-09 B1 — tunnel profile construction and credential gating.
 *
 * Pins the mandatory client-side exposure switches (design S1–S4), the
 * `file:`-only credential reference rule, the ALLOWLIST child environment
 * (r2: Lane A finding 5 / Lane B NOTE 2 — inheritance is opt-in, not
 * denylisted), command-argument credential screening (Lane A finding 4),
 * key-file metadata checks (T14), dual-source drift detection (T17), and the
 * fact that the plaintext temp-file credential path (R11) is NOT authorized
 * by default: it must fail closed unless the exact boolean `true` opts in
 * (r2: Lane B NOTE 1 — truthy strings like "false" must not enable it).
 */
import { describe, expect, it } from "vitest";
import {
  buildTunnelProfile,
  checkKeyFileRequirements,
  detectConfigDrift,
  childEnvironment,
  resolveCredentialPlan,
  serializeTunnelProfile,
  migrateTunnelProfileText,
  needsTunnelProfileMigration,
  replaceTunnelMcpNodePath,
  resolveMcpNodePath,
  REQUIRED_MCP_NODE_VERSION,
  buildTunnelMcpCommand,
  parseTunnelMcpCommand,
  TunnelConfigError,
} from "../../src/tunnel/profile.js";

const base = {
  tunnelId: "tunnel_6ad49f0123456789abcdef0123456789",
  keyFile: "/Users/someone/.config/pi-chat-exchange/tunnel/secrets/runtime-key",
  mcpCommand: "/abs/node /abs/mcp-stdio.js --config /abs/binding.json",
  healthUrlFile: "/abs/runtime/health.url",
} as const;

describe("buildTunnelProfile", () => {
  it("pins loopback health and disables every known local exposure surface", () => {
    const profile = buildTunnelProfile(base);
    expect(profile.health.listen_addr.startsWith("127.0.0.1")).toBe(true);
    expect(profile.admin_ui.open_browser).toBe(false);
    expect("allow_remote_ui" in profile.admin_ui).toBe(false);
    expect("log_buffer_events" in profile.admin_ui).toBe(false);
    expect(profile.harpoon.capture_payloads).toBe(false);
    expect(profile.log.http_raw_unsafe).toBe(false);
  });

  it("emits a file: credential reference and never an inline secret", () => {
    const profile = buildTunnelProfile(base);
    expect(profile.control_plane.api_key).toBe(`file:${base.keyFile}`);
    expect(JSON.stringify(profile)).not.toMatch(/sk-|cap_|BEGIN [A-Z ]*PRIVATE KEY/);
  });

  it("refuses an inline (non file:) credential", () => {
    expect(() => buildTunnelProfile({ ...base, keyFile: "sk-proj-inline-secret-value" })).toThrow(TunnelConfigError);
  });

  it("refuses a relative key path or relative mcp command", () => {
    expect(() => buildTunnelProfile({ ...base, keyFile: "relative/runtime-key" })).toThrow(TunnelConfigError);
    expect(() => buildTunnelProfile({ ...base, mcpCommand: "node mcp-stdio.js" })).toThrow(TunnelConfigError);
  });

  it("refuses a malformed tunnel id", () => {
    expect(() => buildTunnelProfile({ ...base, tunnelId: "not-a-tunnel" })).toThrow(TunnelConfigError);
  });

  it("refuses credential-shaped command arguments (r2, Lane A finding 4)", () => {
    expect(() => buildTunnelProfile({ ...base, mcpCommand: "/abs/node /abs/mcp-stdio.js --token=short-secret" })).toThrow(
      TunnelConfigError,
    );
    expect(() => buildTunnelProfile({ ...base, mcpCommand: "/abs/node /abs/mcp-stdio.js --api-key sk-abcdefgh1234" })).toThrow(
      TunnelConfigError,
    );
  });

  it("refuses URLs with userinfo or query strings in commands and base URLs", () => {
    expect(() =>
      buildTunnelProfile({ ...base, mcpCommand: "/abs/node /abs/mcp-stdio.js --url https://user:secret@example.test/mcp" }),
    ).toThrow(TunnelConfigError);
    expect(() => buildTunnelProfile({ ...base, mcpCommand: "/abs/node /abs/mcp-stdio.js --url https://example.test/mcp?token=abc" })).toThrow(
      TunnelConfigError,
    );
    expect(() => buildTunnelProfile({ ...base, controlPlaneBaseUrl: "https://user:secret@api.example.com" })).toThrow(TunnelConfigError);
  });

  it("accepts ordinary flag arguments and plain https URLs without credentials", () => {
    const profile = buildTunnelProfile({ ...base, mcpCommand: "/abs/node /abs/mcp-stdio.js --config /abs/binding.json --channel main" });
    expect(profile.mcp.commands[0]?.command).toContain("--channel main");
  });

  it("documents that disabling switches does not prove the local /ui is unreachable", () => {
    const profile = buildTunnelProfile(base);
    expect(profile.localUiExposureAcknowledged).toBe(true);
  });
});

describe("childEnvironment — ALLOWLIST (r2)", () => {
  it("passes through only allowlisted runtime variables", () => {
    const env = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/someone",
      TMPDIR: "/tmp",
      CONTROL_PLANE_API_KEY: "should-not-survive",
      OPENAI_API_KEY: "should-not-survive",
      GITHUB_TOKEN: "should-not-survive",
      AWS_SECRET_ACCESS_KEY: "should-not-survive",
      RANDOM_APP_CONFIG: "also-dropped",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/someone");
    expect(env.TMPDIR).toBe("/tmp");
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", "TMPDIR"]);
  });

  it("drops every variable an attacker might add — nothing is inherited by default (denylist trap closed)", () => {
    const env = childEnvironment({ PATH: "/usr/bin", SUPER_SECRET_LEAKED: "x", MY_TOKEN: "y" });
    expect(env.SUPER_SECRET_LEAKED).toBeUndefined();
    expect(env.MY_TOKEN).toBeUndefined();
  });

  it("never introduces a credential variable of its own", () => {
    const env = childEnvironment({ PATH: "/usr/bin" });
    expect(Object.keys(env).some((k) => /KEY|TOKEN|SECRET/i.test(k))).toBe(false);
  });
});

describe("checkKeyFileRequirements — T14 key-file metadata", () => {
  it("accepts a 0600 owner-owned regular file with content", () => {
    expect(
      checkKeyFileRequirements({ mode: 0o100600, uid: 501, ownerUid: 501, isSymbolicLink: false, size: 96 }),
    ).toEqual({ ok: true });
  });

  it("refuses group/other-readable permissions", () => {
    const bad = checkKeyFileRequirements({ mode: 0o644, uid: 501, ownerUid: 501, isSymbolicLink: false, size: 96 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("CE_TUNNEL_KEY_PERMS_INVALID");
  });

  it("refuses a file owned by another user", () => {
    const bad = checkKeyFileRequirements({ mode: 0o100600, uid: 0, ownerUid: 501, isSymbolicLink: false, size: 96 });
    expect(bad.ok).toBe(false);
  });

  it("refuses symbolic links and empty files", () => {
    const symlink = checkKeyFileRequirements({ mode: 0o100600, uid: 501, ownerUid: 501, isSymbolicLink: true, size: 96 });
    expect(symlink.ok).toBe(false);
    const empty = checkKeyFileRequirements({ mode: 0o100600, uid: 501, ownerUid: 501, isSymbolicLink: false, size: 0 });
    expect(empty.ok).toBe(false);
  });
});

describe("detectConfigDrift — T17 dual-source conflict", () => {
  it("is clean when the env override matches or is absent", () => {
    expect(detectConfigDrift({ profileTunnelId: "tunnel_a", envTunnelId: undefined }).ok).toBe(true);
    expect(detectConfigDrift({ profileTunnelId: "tunnel_a", envTunnelId: "tunnel_a" }).ok).toBe(true);
  });

  it("refuses when env and profile disagree (T17)", () => {
    const drift = detectConfigDrift({ profileTunnelId: "tunnel_a", envTunnelId: "tunnel_b" });
    expect(drift.ok).toBe(false);
    if (!drift.ok) expect(drift.code).toBe("CE_TUNNEL_CONFIG_CONFLICT");
  });
});

describe("resolveCredentialPlan", () => {
  it("prefers keychain and reports it as the default source", () => {
    const plan = resolveCredentialPlan({ keychainAvailable: true, keyFileExists: false, allowPlaintextTempFile: false });
    expect(plan.source).toBe("keychain");
  });

  it("BLOCKS the plaintext temp-file hand-off unless explicitly authorized (R11)", () => {
    const plan = resolveCredentialPlan({ keychainAvailable: true, keyFileExists: false, allowPlaintextTempFile: false });
    expect(plan.clientHandoff).toBe("blocked");
    expect(plan.blockedCode).toBe("CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED");
  });

  it("permits the temp-file hand-off only under the exact boolean true (r2, Lane B NOTE 1)", () => {
    const plan = resolveCredentialPlan({ keychainAvailable: true, keyFileExists: false, allowPlaintextTempFile: true });
    expect(plan.clientHandoff).toBe("temp-file");
  });

  it("BLOCKS the temp-file hand-off on truthy-but-not-true inputs (e.g. the string 'false')", () => {
    const malformed = resolveCredentialPlan({
      keychainAvailable: true,
      keyFileExists: false,
      allowPlaintextTempFile: "false" as unknown as boolean,
    });
    expect(malformed.clientHandoff).toBe("blocked");
    expect(malformed.blockedCode).toBe("CE_TUNNEL_CREDENTIAL_HANDOFF_BLOCKED");
  });

  it("uses an existing operator key file as an explicit downgrade, with a warning", () => {
    const plan = resolveCredentialPlan({ keychainAvailable: false, keyFileExists: true, allowPlaintextTempFile: false });
    expect(plan.source).toBe("file");
    expect(plan.warning).toContain("plaintext at rest");
  });

  it("reports keychain unavailability without inventing a plaintext fallback", () => {
    const plan = resolveCredentialPlan({ keychainAvailable: false, keyFileExists: false, allowPlaintextTempFile: false });
    expect(plan.source).toBe("none");
    expect(plan.blockedCode).toBe("CE_TUNNEL_KEY_MISSING");
  });
});

describe("REAL-START-FIX-01 — schema compatibility and migration", () => {
  it("serializes the canonical minimal admin_ui subset only", () => {
    const text = serializeTunnelProfile(buildTunnelProfile(base));
    expect(text).toContain("admin_ui:");
    expect(text).toContain("  open_browser: false");
    expect(text).not.toContain("allow_remote_ui");
    expect(text).not.toContain("log_buffer_events");
  });

  const stale = [
    "config_version: 1", "control_plane:",
    '  base_url: "https://api.openai.com"',
    '  tunnel_id: "tunnel_6ad49fce3df081919fa181980b494729"',
    '  organization_id: "org-J9Mg0ZApcakcou48jDZ9wjwc"',
    '  api_key: "file:/Users/x/.config/pi-chat-exchange/tunnel/.credentials/credential-abc"',
    "health:", '  listen_addr: "127.0.0.1:0"', '  url_file: "/Users/x/.config/pi-chat-exchange/tunnel/health.url"',
    "admin_ui:", "  open_browser: false", "  allow_remote_ui: false", "  log_buffer_events: 0",
    "harpoon:", "  capture_payloads: false",
    "log:", "  level: info", "  format: json", "  http_raw_unsafe: false",
    "mcp:", "  commands:", "    - channel: main",
    '      command: "/Users/old/node /abs/mcp-stdio.js --config /abs/binding.yaml"', "",
  ].join("\n");

  it("detects a saved profile that needs migration", () => {
    expect(needsTunnelProfileMigration(stale)).toBe(true);
    expect(needsTunnelProfileMigration(serializeTunnelProfile(buildTunnelProfile(base)))).toBe(false);
  });

  it("drops the rejected keys and preserves every other line", () => {
    const result = migrateTunnelProfileText(stale);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("allow_remote_ui");
    expect(result.text).not.toContain("log_buffer_events");
    expect(result.text).toContain("  open_browser: false");
    expect(result.text).toContain('tunnel_id: "tunnel_6ad49fce3df081919fa181980b494729"');
    expect(result.text).toContain('organization_id: "org-J9Mg0ZApcakcou48jDZ9wjwc"');
    expect(result.text).toContain('api_key: "file:/Users/x/.config/pi-chat-exchange/tunnel/.credentials/credential-abc"');
    expect(result.text).toContain("--config /abs/binding.yaml");
  });

  it("repoints the mcp node path while preserving script/binding/channel", () => {
    const result = migrateTunnelProfileText(stale, { nodePath: "/Users/new/node" });
    expect(result.changed).toBe(true);
    expect(result.text).toContain('command: "/Users/new/node /abs/mcp-stdio.js --config /abs/binding.yaml"');
    expect(result.text).not.toContain("/Users/old/node");
  });

  it("reports unchanged when a clean profile is migrated", () => {
    const clean = serializeTunnelProfile(buildTunnelProfile(base));
    expect(migrateTunnelProfileText(clean).changed).toBe(false);
  });
});

describe("replaceTunnelMcpNodePath", () => {
  it("swaps only the node executable token", () => {
    const cmd = "/old/node /abs/mcp-stdio.js --config /abs/binding.json";
    expect(replaceTunnelMcpNodePath(cmd, "/new/node")).toBe("/new/node /abs/mcp-stdio.js --config /abs/binding.json");
  });
  it("preserves --channel main", () => {
    const cmd = "/old/node /abs/mcp-stdio.js --config /abs/binding.json --channel main";
    expect(replaceTunnelMcpNodePath(cmd, "/new/node")).toBe("/new/node /abs/mcp-stdio.js --config /abs/binding.json --channel main");
  });
  it("round-trips through buildTunnelMcpCommand", () => {
    const built = buildTunnelMcpCommand({ nodePath: "/a/node", scriptPath: "/b/mcp-stdio.js", bindingPath: "/c/binding.yaml" });
    expect(replaceTunnelMcpNodePath(built, "/d/node")).toBe("/d/node /b/mcp-stdio.js --config /c/binding.yaml");
  });
});

describe("mcp command grammar — scoped npm installation paths", () => {
  const scopedScript = "/private/tmp/ce/consumer/node_modules/@zieglar/pi-chat-exchange/dist/bin/mcp-stdio.js";
  const scopedNode = "/private/tmp/ce/tools/node_modules/@scope/runtime/bin/node";
  const scopedBinding = "/private/tmp/ce/consumer/node_modules/@zieglar/pi-chat-exchange/.ce-bindings/messaging-abc.yaml";

  it("round-trips a scoped script path through the builder and parser", () => {
    const built = buildTunnelMcpCommand({ nodePath: "/private/tmp/ce/bin/node", scriptPath: scopedScript, bindingPath: "/private/tmp/ce/run/binding.yaml" });
    expect(built).toBe(`/private/tmp/ce/bin/node ${scopedScript} --config /private/tmp/ce/run/binding.yaml`);
    expect(parseTunnelMcpCommand(built)).toEqual({ nodePath: "/private/tmp/ce/bin/node", scriptPath: scopedScript, bindingPath: "/private/tmp/ce/run/binding.yaml" });
  });

  it("round-trips scoped node and binding paths where the grammar is shared", () => {
    const built = buildTunnelMcpCommand({ nodePath: scopedNode, scriptPath: "/private/tmp/ce/dist/bin/mcp-stdio.js", bindingPath: scopedBinding });
    expect(parseTunnelMcpCommand(built)).toEqual({ nodePath: scopedNode, scriptPath: "/private/tmp/ce/dist/bin/mcp-stdio.js", bindingPath: scopedBinding });
    expect(parseTunnelMcpCommand(`${built} --channel main`)).toEqual({ nodePath: scopedNode, scriptPath: "/private/tmp/ce/dist/bin/mcp-stdio.js", bindingPath: scopedBinding });
  });

  it("round-trips a space-bearing scoped path using single quotes only where required", () => {
    const scriptPath = "/private/tmp/My CE/consumer/node_modules/@zieglar/pi-chat-exchange/dist/bin/mcp-stdio.js";
    const built = buildTunnelMcpCommand({ nodePath: "/private/tmp/ce/bin/node", scriptPath, bindingPath: "/private/tmp/ce/run/binding.yaml" });
    expect(built).toBe(`/private/tmp/ce/bin/node '${scriptPath}' --config /private/tmp/ce/run/binding.yaml`);
    expect(parseTunnelMcpCommand(built)).toEqual({ nodePath: "/private/tmp/ce/bin/node", scriptPath, bindingPath: "/private/tmp/ce/run/binding.yaml" });
  });

  it("refuses shell metacharacters, escapes and expansions in scoped paths", () => {
    for (const poison of [";", "&", "|", "$", "`", "\\", '"', "'", "~", "*", "?", "[", "]", "(", ")", "\n", "\t", "!", "#"]) {
      const scriptPath = `/private/tmp/ce/node_modules/@zieglar/x${poison}/dist/bin/mcp-stdio.js`;
      expect(() => buildTunnelMcpCommand({ nodePath: "/private/tmp/ce/bin/node", scriptPath, bindingPath: "/private/tmp/ce/run/binding.yaml" }), poison).toThrow(TunnelConfigError);
      expect(() => parseTunnelMcpCommand(`/private/tmp/ce/bin/node ${scriptPath} --config /private/tmp/ce/run/binding.yaml`), poison).toThrow(TunnelConfigError);
    }
  });

  it("refuses option-forging space segments inside a scoped path", () => {
    const scriptPath = "/private/tmp/ce -config/node_modules/@zieglar/x/dist/bin/mcp-stdio.js";
    expect(() => buildTunnelMcpCommand({ nodePath: "/private/tmp/ce/bin/node", scriptPath, bindingPath: "/private/tmp/ce/run/binding.yaml" })).toThrow(TunnelConfigError);
  });

  it("refuses relative, non-normalized, truncated and credential-shaped scoped commands", () => {
    expect(() => parseTunnelMcpCommand("node_modules/@zieglar/pi-chat-exchange/dist/bin/mcp-stdio.js x --config y")).toThrow(TunnelConfigError);
    expect(() => parseTunnelMcpCommand("/private/tmp//node_modules/@x/dist//mcp-stdio.js --config /b.yaml")).toThrow(TunnelConfigError);
    expect(() => parseTunnelMcpCommand("/private/tmp/ce/node_modules/@x/sk-abcdefgh1234 --config /b.yaml")).toThrow(TunnelConfigError);
    expect(() => parseTunnelMcpCommand("/n/node /s/node_modules/@x/mcp-stdio.js --config /b.yaml extra --config /c.yaml")).toThrow(TunnelConfigError);
  });

  it("accepts @ only inside an absolute, normalized path — never as the leading character", () => {
    expect(() => parseTunnelMcpCommand("/n/node @scope/x/mcp-stdio.js --config /b.yaml")).toThrow(TunnelConfigError);
  });
});

describe("resolveMcpNodePath", () => {
  const opts = { requiredVersion: REQUIRED_MCP_NODE_VERSION, homeDir: "/Users/x" };
  it("reuses the running runtime when its version matches", () => {
    expect(resolveMcpNodePath({ ...opts, env: {}, execPath: "/usr/bin/node", execVersion: `v${REQUIRED_MCP_NODE_VERSION}`, exists: () => false }))
      .toBe("/usr/bin/node");
  });
  it("falls back to the mise install layout when the running runtime differs", () => {
    const resolved = resolveMcpNodePath({
      ...opts, env: { MISE_DATA_DIR: "/data/mise" }, execPath: "/usr/bin/node", execVersion: "v25.2.1",
      exists: (p) => p === `/data/mise/installs/node/${REQUIRED_MCP_NODE_VERSION}/bin/node`,
    });
    expect(resolved).toBe(`/data/mise/installs/node/${REQUIRED_MCP_NODE_VERSION}/bin/node`);
  });
  it("derives the mise dir from homedir when MISE_DATA_DIR is unset", () => {
    const resolved = resolveMcpNodePath({
      ...opts, env: {}, execPath: "/usr/bin/node", execVersion: "v25.2.1",
      exists: (p) => p === `/Users/x/.local/share/mise/installs/node/${REQUIRED_MCP_NODE_VERSION}/bin/node`,
    });
    expect(resolved).toBe(`/Users/x/.local/share/mise/installs/node/${REQUIRED_MCP_NODE_VERSION}/bin/node`);
  });
  it("returns undefined when no approved Node exists", () => {
    expect(resolveMcpNodePath({ ...opts, env: {}, execPath: "/usr/bin/node", execVersion: "v25.2.1", exists: () => false }))
      .toBeUndefined();
  });
});
