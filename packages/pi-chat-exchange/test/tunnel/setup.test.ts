import fs from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTunnelProfileSetup, validateTunnelBindingFile, type SetupFileOperations } from "../../dist/tunnel/setup.js";
import { buildTunnelMcpCommand, buildTunnelProfile, parseTunnelMcpCommand, serializeTunnelProfile } from "../../dist/tunnel/profile.js";
import { createBackgroundTunnelManager, parseTunnelProfile, resolveTunnelProfilePath, type BackgroundManagerOptions } from "../../dist/tunnel/background-manager.js";

const SECRET = "synthetic-key-ONLY-test-123456";
const ID = "tunnel_abcdefgh123456";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function harness(existing = true, io: Partial<SetupFileOperations> = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-setup-")); dirs.push(dir);
  const profilePath = join(dir, "tunnel.yaml");
  const key = join(dir, "old-key");
  const bindingPath = join(dir, "binding.json");
  const command = `/abs/node /abs/mcp-stdio.js --config ${bindingPath} --channel main`;
  fs.writeFileSync(bindingPath, JSON.stringify({ version: 1,
    store: { directory: join(dir, "NEVER-OPEN-STORE") },
    exchange: { namespace: "test", idempotencyKey: "binding-test" },
    endpoint: { adapter: "local", endpointId: "sender" }, recipients: [],
  }), { mode: 0o600 });
  if (existing) {
    fs.writeFileSync(key, "old-test-credential", { mode: 0o600 });
    fs.writeFileSync(profilePath, serializeTunnelProfile(buildTunnelProfile({ tunnelId: ID,
      organizationId: "org-old", keyFile: key, healthUrlFile: join(dir, "health.url"), mcpCommand: command,
    })), { mode: 0o600 });
  }
  const opts: BackgroundManagerOptions = {
    env: {}, profilePath, inspectProcess: async (pid) => ({ kind: "present", identity: { pid, command: "test", startedKey: "self" } }),
    listProcesses: async () => ({ kind: "ok", processes: [] }),
    spawn: () => { throw new Error("MUST NOT SPAWN"); },
    signal: () => { throw new Error("MUST NOT SIGNAL"); },
  };
  const manager = createBackgroundTunnelManager(opts);
  const setup = createTunnelProfileSetup({ env: {}, profilePath, manager, nodePath: "/abs/node", mcpScriptPath: "/abs/mcp-stdio.js", io });
  return { dir, key, profilePath, bindingPath, command, setup, manager, opts };
}
function proposal(h: ReturnType<typeof harness>) {
  return { expectedRevision: h.setup.inspect().revision, tunnelId: ID, organizationId: "org-new", credential: { kind: "replace" as const, secret: SECRET } };
}
function names(h: ReturnType<typeof harness>) { return fs.readdirSync(h.dir).sort(); }

describe("real profile setup domain", () => {
  it("uses the exact manager resolver precedence", () => {
    expect(resolveTunnelProfilePath({ env: { CE_TUNNEL_PROFILE: "/env/tunnel.yaml" } })).toBe("/env/tunnel.yaml");
    expect(resolveTunnelProfilePath({ env: { CE_TUNNEL_PROFILE: "/env/tunnel.yaml" }, profilePath: "/explicit/tunnel.yaml" })).toBe("/explicit/tunnel.yaml");
    expect(resolveTunnelProfilePath({ env: {} })).toBe(join(homedir(), ".config", "pi-chat-exchange", "tunnel", "tunnel.yaml"));
    expect(() => createTunnelProfileSetup({ env: { CE_TUNNEL_PROFILE: "relative.yaml" } })).toThrow();
    expect(() => resolveTunnelProfilePath({ env: { CE_TUNNEL_PROFILE: "/tmp/\u001b[2J.yaml" } })).toThrow();
  });
  it("inspect is read-only, prefill-ready, and never reads credential contents", () => {
    const h = harness(); const before = names(h);
    const opened = vi.spyOn(fs, "openSync");
    expect(h.setup.inspect()).toMatchObject({ exists: true, profilePath: h.profilePath,
      tunnelId: ID, organizationId: "org-old", mcpCommand: h.command, bindingPath: h.bindingPath, credentialConfigured: true });
    expect(opened.mock.calls.some(([path]) => path === h.key)).toBe(false);
    expect(names(h)).toEqual(before);
    expect(JSON.stringify(h.setup.inspect())).not.toContain("old-test-credential");
  });
  it.each(["same-path", "hardlink"])("Keep never opens a binding alias of the existing credential: %s", async (alias) => {
    const h = harness();
    if (alias === "same-path") {
      fs.writeFileSync(h.profilePath, fs.readFileSync(h.profilePath, "utf8").replace(h.bindingPath, () => h.key));
    } else {
      fs.unlinkSync(h.bindingPath); fs.linkSync(h.key, h.bindingPath);
    }
    const input = { ...proposal(h), credential: { kind: "keep" as const } };
    const opened = vi.spyOn(fs, "openSync");
    await expect(h.setup.save(input)).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(opened.mock.calls.some(([path]) => path === h.key || path === h.bindingPath)).toBe(false);
  });
  it("new inspection is side effect free", () => {
    const h = harness(false); const before = names(h);
    expect(h.setup.inspect()).toMatchObject({ exists: false, revision: null, credentialConfigured: false });
    expect(names(h)).toEqual(before);
  });
  it("statically validates the formal binding without opening Store or creating anything", () => {
    const h = harness(false); const before = names(h);
    expect(validateTunnelBindingFile(h.bindingPath)).toEqual({ path: h.bindingPath });
    expect(names(h)).toEqual(before);
    const bad = join(h.dir, "bad.json"); fs.writeFileSync(bad, '{"version":1,"store":{}}');
    expect(() => validateTunnelBindingFile(bad)).toThrow();
    expect(() => validateTunnelBindingFile("relative.json")).toThrow();
    const link = join(h.dir, "link.json"); fs.symlinkSync(h.bindingPath, link);
    expect(() => validateTunnelBindingFile(link)).toThrow();
    fs.writeFileSync(bad, "x".repeat(65_537)); expect(() => validateTunnelBindingFile(bad)).toThrow();
  });
  it("creates a complete profile and independent 0600 generation, only file: in YAML", async () => {
    const h = harness(false);
    const result = await h.setup.save({ ...proposal(h), binding: { kind: "path" as const, path: h.bindingPath } });
    expect(result).toMatchObject({ kind: "saved", profilePath: h.profilePath, durability: "synced" });
    const text = fs.readFileSync(h.profilePath, "utf8"); const facts = parseTunnelProfile(text);
    expect(facts).toMatchObject({ tunnelId: ID, organizationId: "org-new", mcpCommand: expect.stringContaining(h.bindingPath) });
    expect(fs.readFileSync(facts.keyFile, "utf8")).toBe(SECRET);
    expect(fs.lstatSync(facts.keyFile).mode & 0o777).toBe(0o600);
    expect(text).not.toContain(SECRET); expect(text).toContain("api_key: \"file:");
    expect(names(h).some((n) => n.endsWith(".tmp") || n.includes("lock.d"))).toBe(false);
  });
  it("Keep preserves the exact reference/MCP bytes and never reads or rewrites the key", async () => {
    const h = harness(); const before = fs.readFileSync(h.profilePath, "utf8"); const keyStat = fs.statSync(h.key);
    const opened = vi.spyOn(fs, "openSync");
    await h.setup.save({ ...proposal(h), credential: { kind: "keep" } });
    const after = fs.readFileSync(h.profilePath, "utf8");
    expect(after).toBe(before.replace('organization_id: "org-old"', 'organization_id: "org-new"'));
    expect(parseTunnelProfile(after).keyFile).toBe(h.key);
    expect(opened.mock.calls.some(([path]) => path === h.key)).toBe(false);
    expect(fs.statSync(h.key).ino).toBe(keyStat.ino); expect(fs.statSync(h.key).mtimeMs).toBe(keyStat.mtimeMs);
  });
  it("Keep preserves valid credential references containing replacement-string metacharacters", async () => {
    const h = harness(); const keyWithDollar = join(h.dir, "old-$&-key");
    fs.renameSync(h.key, keyWithDollar);
    fs.writeFileSync(h.profilePath, fs.readFileSync(h.profilePath, "utf8").replace(h.key, () => keyWithDollar));
    await h.setup.save({ ...proposal(h), credential: { kind: "keep" } });
    expect(parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).keyFile).toBe(keyWithDollar);
  });
  it("Replace retains old credential byte-identical and uses a different random generation each time", async () => {
    const h = harness(); const old = fs.readFileSync(h.key);
    await h.setup.save(proposal(h)); const first = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).keyFile;
    await h.setup.save(proposal(h)); const second = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).keyFile;
    expect(first).not.toBe(second); expect(first).not.toBe(h.key);
    expect(fs.readFileSync(h.key)).toEqual(old); expect(fs.readFileSync(first, "utf8")).toBe(SECRET);
  });
  it.each(["", "bad", "tunnel_abc", "tunnel_a\ninjected"])("invalid Tunnel refuses before writes: %s", async (tunnelId) => {
    const h = harness(); const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    await expect(h.setup.save({ ...proposal(h), tunnelId })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it.each(["org-", "org-bad_name", "org-" + "x".repeat(129)])("invalid organization refuses before writes: %s", async (organizationId) => {
    const h = harness(); const before = names(h);
    await expect(h.setup.save({ ...proposal(h), organizationId })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(names(h)).toEqual(before);
  });
  it("empty Organization removes the field; existing MCP sections are not regenerated", async () => {
    const h = harness(); const old = fs.readFileSync(h.profilePath, "utf8");
    fs.writeFileSync(h.profilePath, old.replace("mcp:", "# preserve operator comments\nmcp:"));
    await h.setup.save({ ...proposal(h), organizationId: "", credential: { kind: "keep" } });
    const text = fs.readFileSync(h.profilePath, "utf8");
    expect(text).not.toContain("organization_id"); expect(text).toContain("# preserve operator comments\nmcp:");
    expect(parseTunnelProfile(text).mcpCommand).toBe(h.command);
  });
  it("new profile derives the managed binding by default; Replace required; Keep requires valid metadata", async () => {
    const h = harness(false);
    // No binding input at all: a CE-managed minimal-permission binding is
    // generated beside the profile (never a typed path, recipients default []).
    const saved = await h.setup.save(proposal(h));
    expect(saved).toMatchObject({ kind: "saved" });
    const managedDir = join(h.dir, ".ce-bindings");
    const bindings = fs.readdirSync(managedDir);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toBe("ce-123456-rg-new.yaml"); // tunnel_…123456 tail + org-new tail
    const parsed = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8"));
    expect(parsed.mcpCommand).toContain(join(managedDir, bindings[0]!));
    const bindingDoc = JSON.parse(fs.readFileSync(join(managedDir, bindings[0]!), "utf8"));
    expect(bindingDoc.managed).toEqual({ tunnelId: ID, organizationId: "org-new", adapter: "pi" });
    expect(bindingDoc.recipients).toEqual([]);
    // Keep without an existing valid credential still refuses.
    const h2 = harness(false);
    const before2 = names(h2);
    await expect(h2.setup.save({ ...proposal(h2), credential: { kind: "keep" } })).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_MISSING" });
    expect(names(h2)).toEqual(before2); // refusal leaves zero residue
    const old = harness(); fs.chmodSync(old.key, 0o644);
    await expect(old.setup.save({ ...proposal(old), credential: { kind: "keep" } })).rejects.toMatchObject({ code: "CE_TUNNEL_KEY_PERMS_INVALID" });
  });
  it("stale inspection cannot overwrite a concurrent edit", async () => {
    const h = harness(); const input = proposal(h); const changed = fs.readFileSync(h.profilePath, "utf8") + "# concurrent edit\n";
    fs.writeFileSync(h.profilePath, changed); const before = names(h);
    await expect(h.setup.save(input)).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(changed); expect(names(h)).toEqual(before);
  });
  it("abort before save or during lock acquisition returns cancelled without residue", async () => {
    const h = harness(); const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    const abort = new AbortController(); abort.abort();
    expect(await h.setup.save({ ...proposal(h), signal: abort.signal })).toEqual({ kind: "cancelled" });
    const during = new AbortController();
    const manager = createBackgroundTunnelManager({ ...h.opts, inspectProcess: async (pid) => {
      during.abort(); return { kind: "present", identity: { pid, command: "test", startedKey: "self" } };
    } });
    const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager });
    expect(await setup.save({ ...proposal(h), signal: during.signal })).toEqual({ kind: "cancelled" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it.each(["open", "write", "fsync", "rename"])("precommit %s failure keeps old bytes and cleans owned files", async (stage) => {
    let h: ReturnType<typeof harness>;
    const io: Partial<SetupFileOperations> = {
      openSync: (...args) => { if (stage === "open") throw new Error(SECRET); return fs.openSync(...args); },
      writeFileSync: (...args) => { if (stage === "write") throw new Error(SECRET); return fs.writeFileSync(...args); },
      fsyncSync: (...args) => { if (stage === "fsync") throw new Error(SECRET); return fs.fsyncSync(...args); },
      renameSync: (...args) => { if (stage === "rename") throw new Error(SECRET); return fs.renameSync(...args); },
    };
    h = harness(true, io); const before = names(h); const bytes = fs.readFileSync(h.profilePath); const key = fs.readFileSync(h.key);
    let error: unknown; try { await h.setup.save(proposal(h)); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(String(error)).not.toContain(SECRET); expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes); expect(fs.readFileSync(h.key)).toEqual(key);
  });
  it("profile rename is the sole commit point; credential is already private and fsynced", async () => {
    let h: ReturnType<typeof harness>; let syncs = 0;
    h = harness(true, { fsyncSync: (fd) => { syncs++; fs.fsyncSync(fd); }, renameSync: (from, to) => {
      expect(to).toBe(h.profilePath); const facts = parseTunnelProfile(fs.readFileSync(from, "utf8"));
      expect(fs.readFileSync(facts.keyFile, "utf8")).toBe(SECRET); expect(fs.lstatSync(facts.keyFile).mode & 0o777).toBe(0o600);
      expect(syncs).toBeGreaterThanOrEqual(3); expect(parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).keyFile).toBe(h.key);
      fs.renameSync(from, to);
    } });
    await h.setup.save(proposal(h));
  });
  it("makes the credential directory entry durable before the commit rename", async () => {
    const events: string[] = []; const fds = new Map<number, string>(); let h!: ReturnType<typeof harness>;
    h = harness(true, {
      openSync: ((...args: Parameters<typeof fs.openSync>) => {
        const fd = fs.openSync(...args);
        fds.set(fd, String(args[0]));
        return fd;
      }) as typeof fs.openSync,
      fsyncSync: (fd) => { events.push(`fsync:${fds.get(fd) ?? "?"}`); fs.fsyncSync(fd); },
      renameSync: (...args) => { events.push("rename"); fs.renameSync(...args); },
    });
    expect(await h.setup.save(proposal(h))).toMatchObject({ kind: "saved" });
    const credentialDirectory = join(h.dir, ".credentials");
    const synced = events.indexOf(`fsync:${credentialDirectory}`);
    expect(synced).toBeGreaterThanOrEqual(0);
    expect(synced).toBeLessThan(events.indexOf("rename"));
  });
  it("refuses before commit when the credential directory cannot be synchronized", async () => {
    let h!: ReturnType<typeof harness>; const fds = new Map<number, string>();
    h = harness(true, {
      openSync: ((...args: Parameters<typeof fs.openSync>) => {
        const fd = fs.openSync(...args); fds.set(fd, String(args[0])); return fd;
      }) as typeof fs.openSync,
      fsyncSync: (fd) => { if (fds.get(fd) === join(h.dir, ".credentials")) throw new Error(SECRET); fs.fsyncSync(fd); },
    });
    const bytes = fs.readFileSync(h.profilePath);
    let error: unknown; try { await h.setup.save(proposal(h)); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID", field: "setup.transaction" });
    expect(String(error)).not.toContain(SECRET);
    expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
    expect(fs.existsSync(join(h.dir, ".credentials"))).toBe(false);
  });
  it("cannot report synced when a newly created profile-directory ancestor cannot be synchronized", async () => {
    let renamed = false; const h = harness(false);
    const profilePath = join(h.dir, "new-config", "tunnel", "tunnel.yaml");
    const manager = createBackgroundTunnelManager({ ...h.opts, profilePath });
    const setup = createTunnelProfileSetup({ env: {}, profilePath, manager, nodePath: "/abs/node", mcpScriptPath: "/abs/mcp-stdio.js",
      io: {
        renameSync: (...args) => { fs.renameSync(...args); renamed = true; },
        openSync: (...args) => {
          if (renamed && args[0] === h.dir) throw new Error("ancestor sync unavailable");
          return fs.openSync(...args);
        },
      },
    });
    expect(await setup.save({ expectedRevision: null, tunnelId: ID, binding: { kind: "path" as const, path: h.bindingPath }, credential: { kind: "replace", secret: SECRET } }))
      .toMatchObject({ kind: "saved", durability: "uncertain" });
  });

  it("a failed postcommit directory sync reports committed/uncertain, never rolls back or deletes the new key", async () => {
    let renamed = false;
    const h = harness(true, { renameSync: (...args) => { fs.renameSync(...args); renamed = true; },
      fsyncSync: (fd) => { if (renamed) throw new Error(SECRET); fs.fsyncSync(fd); } });
    expect(await h.setup.save(proposal(h))).toMatchObject({ kind: "saved", durability: "uncertain" });
    const facts = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")); expect(fs.readFileSync(facts.keyFile, "utf8")).toBe(SECRET);
  });
  it.each([1, 2, 3])("fsync failure at stage %i leaves no uncommitted generation or temp", async (stage) => {
    let syncs = 0;
    const h = harness(true, { fsyncSync: (fd) => { if (++syncs === stage) throw new Error(SECRET); fs.fsyncSync(fd); } });
    const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it("partial profile write failure rolls back both owned files", async () => {
    let writes = 0;
    const h = harness(true, { writeFileSync: (fd, data, options) => {
      if (++writes === 2) { fs.writeFileSync(fd, "partial"); throw new Error(SECRET); }
      fs.writeFileSync(fd, data, options);
    } });
    const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it("abort after staged writes returns cancelled and removes both owned files", async () => {
    const abort = new AbortController(); let writes = 0;
    const h = harness(true, { writeFileSync: (...args) => { fs.writeFileSync(...args); if (++writes === 2) abort.abort(); } });
    const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    expect(await h.setup.save({ ...proposal(h), signal: abort.signal })).toEqual({ kind: "cancelled" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it("rechecks optimistic revision immediately before commit and retains a concurrent edit", async () => {
    let writes = 0; let h: ReturnType<typeof harness>;
    h = harness(true, { writeFileSync: (...args) => { fs.writeFileSync(...args); if (++writes === 2) fs.appendFileSync(h.profilePath, "# concurrent\n"); } });
    const bytes = fs.readFileSync(h.profilePath, "utf8"); const before = names(h);
    await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_CONFIG_CONFLICT" });
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath, "utf8")).toBe(bytes + "# concurrent\n");
  });
  it("lost ownership lock prevents commit and never deletes a foreign lock", async () => {
    let syncs = 0; let h: ReturnType<typeof harness>;
    h = harness(true, { fsyncSync: (fd) => {
      fs.fsyncSync(fd);
      if (++syncs === 3) fs.writeFileSync(join(h.dir, "background-state.json.lock.d/holder.json"), '{"token":"foreign-successor"}');
    } });
    const bytes = fs.readFileSync(h.profilePath);
    await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
    expect(names(h).filter((n) => n.includes("credential-") || n.endsWith(".tmp"))).toEqual([]);
    expect(fs.readFileSync(join(h.dir, "background-state.json.lock.d/holder.json"), "utf8")).toContain("foreign-successor");
  });
  it("cleanup refusal is sanitized and is never falsely reported as cancelled/saved", async () => {
    const h = harness(true, { renameSync: () => { throw new Error(SECRET); }, unlinkSync: () => { throw new Error(SECRET); } });
    const bytes = fs.readFileSync(h.profilePath);
    await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID", field: "setup.cleanup" });
    expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
    // A filesystem that refuses deletion necessarily leaves operator cleanup
    // residue. Crucially none of it is referenced by the unchanged profile.
    expect(parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8")).keyFile).toBe(h.key);
  });
  it("hardens the dedicated credential directory before any secret write", async () => {
    const h = harness(); const before = fs.readFileSync(h.profilePath, "utf8");
    const writes = vi.fn(fs.writeFileSync);
    const harden = vi.fn(() => { throw new Error("inherited acl"); });
    const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager: h.manager,
      io: { writeFileSync: writes }, credentialDirectoryGuard: harden } as unknown as Parameters<typeof createTunnelProfileSetup>[0]);
    await expect(setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(harden).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(before);
  });

  it.each(["", "a\nb", "x".repeat(4097)])("invalid credential refuses before any writes", async (secret) => {
    const h = harness(); const before = names(h);
    await expect(h.setup.save({ ...proposal(h), credential: { kind: "replace", secret } })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(names(h)).toEqual(before);
  });
  it("two setup instances contend on the actual manager lock", async () => {
    const h = harness(); let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const manager = createBackgroundTunnelManager({ ...h.opts, listProcesses: async () => {
      entered(); await gate; return { kind: "ok", processes: [] };
    } });
    const first = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager });
    const saving = first.save(proposal(h));
    await ready;
    try { await expect(h.setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" }); }
    finally { release(); }
    expect(await saving).toMatchObject({ kind: "saved" });
  });
  it("C-R1: a precommit failure after managed binding creation retains the valid published generation (A-R8)", async () => {
    let h: ReturnType<typeof harness>;
    const io: Partial<SetupFileOperations> = { fsyncSync: () => { throw new Error(SECRET); } };
    h = harness(false, io); const before = names(h);
    let error: unknown; try { await h.setup.save(proposal(h)); } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    // A published managed candidate is a VALID, atomically-committed generation —
    // it is RETAINED (never deleted by shared pathname), so a retry reuses it.
    const bindingDir = join(h.dir, ".ce-bindings");
    expect(fs.readdirSync(bindingDir).filter((n) => n.startsWith("ce-")).length).toBe(1);
    expect(fs.lstatSync(bindingDir).mode & 0o777).toBe(0o700);
    // The old/absent profile is untouched (no commit happened).
    expect(fs.existsSync(h.profilePath)).toBe(false);
    expect(names(h)).toEqual([...before, ".ce-bindings"].sort());
  });
  it("C-R2: identity change regenerates a managed binding for the new identity, keeping recipients", async () => {
    const h = harness(false);
    const saved = await h.setup.save({ ...proposal(h), binding: { kind: "managed", recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }] } });
    expect(saved).toMatchObject({ kind: "saved" });
    const oldDir = join(h.dir, ".ce-bindings");
    const oldDoc = JSON.parse(fs.readFileSync(join(oldDir, fs.readdirSync(oldDir)[0]!), "utf8"));
    expect(oldDoc.managed.tunnelId).toBe(ID);
    const next = await h.setup.save({
      expectedRevision: h.setup.inspect().revision, tunnelId: "tunnel_zzzzzz999999", organizationId: "org-new",
      credential: { kind: "keep" },
    });
    expect(next).toMatchObject({ kind: "saved" });
    const parsed = parseTunnelProfile(fs.readFileSync(h.profilePath, "utf8"));
    expect(parsed.tunnelId).toBe("tunnel_zzzzzz999999");
    expect(parsed.mcpCommand).toBeDefined();
    const bindingPath = parseTunnelMcpCommand(parsed.mcpCommand!).bindingPath;
    expect(bindingPath).toBeDefined();
    const newDoc = JSON.parse(fs.readFileSync(bindingPath!, "utf8"));
    expect(newDoc.managed).toEqual({ tunnelId: "tunnel_zzzzzz999999", organizationId: "org-new", adapter: "pi" });
    expect(newDoc.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
  });
  it("O_EXCL failures never unlink an existing collision file", async () => {
    let collision = "";
    const h = harness(true, { openSync: (...args) => {
      if (typeof args[0] === "string" && args[0].includes("credential-")) {
        collision = args[0]; fs.writeFileSync(collision, "foreign-collision", { flag: "wx", mode: 0o600 });
      }
      return fs.openSync(...args);
    } });
    await expect(h.setup.save(proposal(h))).rejects.toBeDefined();
    expect(fs.readFileSync(collision, "utf8")).toBe("foreign-collision");
  });
  it("refuses symlink profiles rather than reading or replacing their targets", () => {
    const h = harness(); const real = join(h.dir, "real.yaml"); fs.renameSync(h.profilePath, real); fs.symlinkSync(real, h.profilePath);
    expect(() => h.setup.inspect()).toThrow();
  });

  describe("configuration-mutation authority is independent of runtime health", () => {
    // Dogfood reproduction: a not-yet-configured environment has no healthy
    // runtime, so health is unavailable by definition. Mutation safety is
    // decided by ownership/lock evidence, never by health. A missing client
    // binary must not turn first setup into CE_TUNNEL_HEALTH_UNAVAILABLE.
    it.each([true, false])("health unavailable (missing client) + confirmed no owner allows setup (existing=%s)", async (existing) => {
      const h = harness(existing);
      const manager = createBackgroundTunnelManager({ ...h.opts, clientPath: join(h.dir, "NO-SUCH-CLIENT") });
      const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager, nodePath: "/abs/node", mcpScriptPath: "/abs/mcp-stdio.js" });
      await expect(setup.save({ ...proposal(h), binding: { kind: "path" as const, path: h.bindingPath } })).resolves.toMatchObject({ kind: "saved" });
    });
    it.each(["running", "stop-unconfirmed"] as const)("health unavailable + %s owner refuses setup", async (state) => {
      const h = harness(true);
      const record = { version: 1, runId: "r1", pid: 4242, profilePath: h.profilePath, profileSha256: "x", tunnelId: ID,
        keyFile: h.key, urlFile: join(h.dir, "health.url"), mcpCommand: undefined, logPath: join(h.dir, "log"),
        commandIdentity: "c", processStartedKey: "k", startedAt: 1, termRequestedAt: state === "stop-unconfirmed" ? 2 : undefined,
        state, stoppedAt: undefined, note: undefined };
      fs.writeFileSync(join(h.dir, "background-state.json"), JSON.stringify(record));
      const manager = createBackgroundTunnelManager({ ...h.opts, clientPath: join(h.dir, "NO-SUCH-CLIENT") });
      const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager });
      await expect(setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    });
    it("ownership inspection failure refuses setup even with health unavailable", async () => {
      const h = harness(true);
      const manager = createBackgroundTunnelManager({ ...h.opts, clientPath: join(h.dir, "NO-SUCH-CLIENT"),
        listProcesses: async () => ({ kind: "unknown" }) });
      const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager });
      await expect(setup.save(proposal(h))).rejects.toMatchObject({ code: "CE_TUNNEL_MANAGER_BUSY" });
    });
    it("setup allowance never grants Start: the real-start gate stays exact and separate", async () => {
      const h = harness(true);
      const manager = createBackgroundTunnelManager({ ...h.opts, clientPath: join(h.dir, "NO-SUCH-CLIENT") });
      await expect(manager.start()).rejects.toMatchObject({ code: "CE_TUNNEL_BACKGROUND_UNAUTHORIZED" });
    });
  });
});

describe("explicit existing binding changes", () => {
  it.each(["keep", "replace"] as const)("supports changed binding with %s credential and preserves all unrelated YAML", async (kind) => {
    const h = harness();
    const selected = join(h.dir, "new binding.json"); fs.copyFileSync(h.bindingPath, selected);
    const oldCommand = h.command.replace("/abs/node /abs/mcp-stdio.js", "'/abs tools/node' '/abs tools/mcp-stdio.js'");
    const before = fs.readFileSync(h.profilePath, "utf8").replace(h.command, oldCommand).replace("mcp:", "# operator MCP settings\nmcp:");
    fs.writeFileSync(h.profilePath, before);
    const oldKey = fs.readFileSync(h.key);
    const credential = kind === "keep" ? { kind } : { kind, secret: SECRET };
    expect(await h.setup.save({ ...proposal(h), organizationId: "org-old", binding: { kind: "path" as const, path: selected }, credential })).toMatchObject({ kind: "saved" });
    const after = fs.readFileSync(h.profilePath, "utf8"); const facts = parseTunnelProfile(after);
    const nextCommand = oldCommand.replace(h.bindingPath, () => `'${selected}'`);
    expect(facts.mcpCommand).toBe(nextCommand);
    expect(after).toBe(before.replace(oldCommand, () => nextCommand).replace(`file:${h.key}`, () => `file:${facts.keyFile}`));
    expect(fs.readFileSync(h.key)).toEqual(oldKey);
    if (kind === "keep") expect(facts.keyFile).toBe(h.key);
    else expect(fs.readFileSync(facts.keyFile, "utf8")).toBe(SECRET);
  });
  it("omitted binding preserves complete command bytes without re-selection", async () => {
    const h = harness(); const before = fs.readFileSync(h.profilePath, "utf8");
    await h.setup.save({ ...proposal(h), organizationId: "org-old", credential: { kind: "keep" } });
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(before);
  });
  it("invalid new binding refuses before credential/profile writes", async () => {
    const h = harness(); const selected = join(h.dir, "bad-binding.json"); fs.writeFileSync(selected, "{invalid");
    const before = names(h); const bytes = fs.readFileSync(h.profilePath); let writes = 0;
    const setup = createTunnelProfileSetup({ env: {}, profilePath: h.profilePath, manager: h.manager,
      io: { writeFileSync: (...args) => { writes++; fs.writeFileSync(...args); } } });
    await expect(setup.save({ ...proposal(h), binding: { kind: "path" as const, path: selected } })).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(writes).toBe(0); expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it.each(["same-path", "hardlink"])("selected binding cannot alias old credential during Replace: %s", async (alias) => {
    const h = harness(); const selected = alias === "same-path" ? h.key : join(h.dir, "new-binding.json");
    if (alias === "hardlink") fs.linkSync(h.key, selected);
    const input = { ...proposal(h), binding: { kind: "path" as const, path: selected } }; const before = names(h); const bytes = fs.readFileSync(h.profilePath);
    const opened = vi.spyOn(fs, "openSync");
    await expect(h.setup.save(input)).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID" });
    expect(opened.mock.calls.some(([path]) => path === selected)).toBe(false);
    expect(names(h)).toEqual(before); expect(fs.readFileSync(h.profilePath)).toEqual(bytes);
  });
  it("does not open a credential symlink target selected as the binding", () => {
    const h = harness(); const credentialLink = join(h.dir, "credential-link");
    fs.symlinkSync(h.key, credentialLink);
    fs.writeFileSync(h.profilePath, fs.readFileSync(h.profilePath, "utf8").replace(`file:${h.key}`, `file:${credentialLink}`));
    const opened = vi.spyOn(fs, "openSync");
    expect(() => h.setup.validateBinding(h.key)).toThrow();
    expect(opened.mock.calls.some(([path]) => path === h.key)).toBe(false);
  });

  it("domain validation excludes existing credential aliases without exposing the reference", () => {
    const h = harness(); const selected = join(h.dir, "new-binding.json"); fs.copyFileSync(h.bindingPath, selected);
    const before = names(h); const opened = vi.spyOn(fs, "openSync");
    expect(h.setup.validateBinding(selected)).toEqual({ path: selected });
    expect(() => h.setup.validateBinding(h.key)).toThrow();
    expect(opened.mock.calls.some(([path]) => path === h.key)).toBe(false);
    expect(names(h)).toEqual(before);
  });
  it("first setup creates an absent profile directory safely through the manager lock", async () => {
    const h = harness(false); const profilePath = join(h.dir, "new-config", "tunnel", "tunnel.yaml");
    const manager = createBackgroundTunnelManager({ ...h.opts, profilePath });
    const setup = createTunnelProfileSetup({ env: {}, profilePath, manager, nodePath: "/abs/node", mcpScriptPath: "/abs/mcp-stdio.js" });
    expect(setup.inspect()).toMatchObject({ exists: false, revision: null });
    expect(fs.existsSync(join(h.dir, "new-config"))).toBe(false);
    expect(await setup.save({ expectedRevision: null, tunnelId: ID, binding: { kind: "path" as const, path: h.bindingPath },
      credential: { kind: "replace", secret: SECRET } })).toMatchObject({ kind: "saved" });
    expect(fs.lstatSync(join(h.dir, "new-config", "tunnel")).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(profilePath).mode & 0o777).toBe(0o600);
    expect(parseTunnelProfile(fs.readFileSync(profilePath, "utf8")).mcpCommand).toContain(h.bindingPath);
  });
});

describe("command/profile encoding", () => {
  it("quotes space-bearing paths safely without shell substitution and round-trips through the strict parser", () => {
    const command = buildTunnelMcpCommand({ nodePath: "/safe path/node", scriptPath: "/safe path/mcp-stdio.js", bindingPath: "/safe path/binding.json" });
    expect(command).toBe("'/safe path/node' '/safe path/mcp-stdio.js' --config '/safe path/binding.json'");
    const text = serializeTunnelProfile(buildTunnelProfile({ tunnelId: ID, organizationId: "org-team", keyFile: "/abs/key", healthUrlFile: "/abs/health.url", mcpCommand: command }));
    expect(parseTunnelProfile(text)).toMatchObject({ mcpCommand: command, organizationId: "org-team" });
  });
  it.each(["/tmp/a;touch-pwn.json", "/tmp/$(echo-pwn).json", "/tmp/a'b.json", "/tmp/a\nb.json"])("rejects unsafe command path %s", (bindingPath) => {
    expect(() => buildTunnelMcpCommand({ nodePath: "/abs/node", scriptPath: "/abs/mcp-stdio.js", bindingPath })).toThrow();
  });
  it("C-R1b: a profile.size refusal after managed binding creation retains the valid generation; old profile untouched (A-R8)", async () => {
    // Existing profile padded near the 64 KiB limit: building nextText (longer
    // command referencing a new managed binding) exceeds MAX_PROFILE_BYTES and
    // must refuse WITHOUT leaving the newly created managed binding behind.
    const h = harness();
    // Pad the existing profile to just below the 64 KiB read limit so it still
    // loads, while the rebuilt profile (longer .credentials key + managed
    // binding command) exceeds it and must refuse.
    const base = fs.readFileSync(h.profilePath, "utf8");
    const padded = `${base}\n# ${"x".repeat(Math.max(0, 65_536 - Buffer.byteLength(base, "utf8") - 60))}\n`;
    expect(Buffer.byteLength(padded, "utf8")).toBeLessThan(65_536);
    fs.writeFileSync(h.profilePath, padded);
    const before = names(h);
    let error: unknown;
    try {
      await h.setup.save({ ...proposal(h), binding: { kind: "managed", recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }] } });
    } catch (e) { error = e; }
    expect(error).toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID", field: "profile.size" });
    // A-R8: the published managed generation is VALID and atomically committed, so
    // it is retained (never deleted by shared pathname); historical files preserved.
    const bindingDir = join(h.dir, ".ce-bindings");
    expect(fs.readdirSync(bindingDir).filter((n) => n.startsWith("ce-")).length).toBe(1);
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(padded); // old profile untouched
  });

describe("REAL-START-FIX-01 — profile migration", () => {
  function staleProfile(h: ReturnType<typeof harness>, nodePath = "/old/node") {
    return [
      "config_version: 1", "control_plane:",
      '  base_url: "https://api.openai.com"',
      `  tunnel_id: "${ID}"`,
      '  organization_id: "org-old"',
      `  api_key: "file:${h.key}"`,
      "health:", '  listen_addr: "127.0.0.1:0"', `  url_file: "${join(h.dir, "health.url")}"`,
      "admin_ui:", "  open_browser: false", "  allow_remote_ui: false", "  log_buffer_events: 0",
      "harpoon:", "  capture_payloads: false",
      "log:", "  level: info", "  format: json", "  http_raw_unsafe: false",
      "mcp:", "  commands:", "    - channel: main",
      `      command: "${nodePath} /abs/mcp-stdio.js --config ${h.bindingPath} --channel main"`, "",
    ].join("\n");
  }

  it("repairs a stale profile in place, preserving identity/credential/binding", async () => {
    const h = harness();
    const credentialBefore = fs.readFileSync(h.key, "utf8");
    fs.writeFileSync(h.profilePath, staleProfile(h));
    const result = await h.setup.migrate();
    expect(result).toMatchObject({ kind: "migrated", profilePath: h.profilePath, durability: "synced" });
    const text = fs.readFileSync(h.profilePath, "utf8");
    expect(text).not.toContain("allow_remote_ui");
    expect(text).not.toContain("log_buffer_events");
    expect(text).toContain(`tunnel_id: "${ID}"`);
    expect(text).toContain('organization_id: "org-old"');
    expect(text).toContain(`api_key: "file:${h.key}"`);
    expect(text).toContain(`--config ${h.bindingPath} --channel main`);
    expect(text).toContain("/abs/node /abs/mcp-stdio.js"); // node repointed to the approved path
    expect(text).not.toContain("/old/node");
    expect(fs.readFileSync(h.key, "utf8")).toBe(credentialBefore);
    expect(names(h).some((n) => n.endsWith(".tmp") || n.includes("lock.d"))).toBe(false);
    expect(parseTunnelProfile(text).mcpCommand).toContain(h.bindingPath);
  });

  it("is unchanged when the profile is already canonical", async () => {
    const h = harness();
    const before = fs.readFileSync(h.profilePath, "utf8");
    await expect(h.setup.migrate()).resolves.toEqual({ kind: "unchanged" });
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(before);
  });

  it("leaves the original profile untouched when the commit fails (rollback)", async () => {
    const h = harness(true, { renameSync: () => { throw new Error("boom"); } });
    fs.writeFileSync(h.profilePath, staleProfile(h));
    const before = fs.readFileSync(h.profilePath, "utf8");
    await expect(h.setup.migrate()).rejects.toMatchObject({ code: "CE_TUNNEL_PROFILE_INVALID", field: "setup.transaction" });
    expect(fs.readFileSync(h.profilePath, "utf8")).toBe(before);
    expect(names(h).some((n) => n.endsWith(".tmp"))).toBe(false);
  });
});
});
