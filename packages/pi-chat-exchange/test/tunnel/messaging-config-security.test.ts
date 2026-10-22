import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { publishMessagingPair, readMessagingPair, type PiSideConfigInput } from "../../dist/tunnel/messaging-config.js";
import { ensureManagedBinding } from "../../dist/tunnel/managed-binding.js";
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "ce-pair-security-")); dirs.push(dir);
  const profile = join(dir, "tunnel.yaml");
  const config = ensureManagedBinding(profile, { tunnelId: "tunnel_abcdefgh123456", organizationId: "org-old", adapter: "chatgpt",
    endpointId: "chatgpt/main", recipients: [{ adapter: "pi", endpointId: "pi/main" }], capabilities: { payloadRead: true, ack: true } }).config;
  const input: PiSideConfigInput = { chatgptEndpoint: config.endpoint, piEndpoint: { adapter: "pi", endpointId: "pi/main" },
    piSessionId: "runtime-session", exchangeNamespace: config.exchange.namespace, exchangeIdempotencyKey: config.exchange.idempotencyKey,
    store: config.store, payloadRead: true, ack: true };
  return { dir, profile, config, input };
}
describe("immutable messaging publication security", () => {
  it.each(["binding", "allowlist"])("a foreign file inserted at the final %s syscall is never overwritten or deleted", (kind) => {
    const f = fixture(); let foreignPath = "";
    const unlink = vi.spyOn(fs, "unlinkSync"); const rename = vi.spyOn(fs, "renameSync");
    expect(() => publishMessagingPair(f.profile, f.config, f.input, { io: {
      linkSync: (from, to) => {
        if ((kind === "binding" && String(to).endsWith(".yaml")) || (kind === "allowlist" && String(to).endsWith(".json"))) {
          foreignPath = String(to); fs.writeFileSync(to, "FOREIGN-CONFIG", { mode: 0o600 });
        }
        fs.linkSync(from, to);
      },
    } })).toThrow(expect.objectContaining({ code: "CE_TUNNEL_CONFIG_CONFLICT" }));
    expect(fs.readFileSync(foreignPath, "utf8")).toBe("FOREIGN-CONFIG");
    expect(unlink).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });
  it("post-publication directory sync failure reports uncertain and a retry safely reuses the pair", () => {
    const f = fixture(); let linked = false;
    const publication = publishMessagingPair(f.profile, f.config, f.input, { io: {
      linkSync: (from, to) => { fs.linkSync(from, to); linked = true; },
      fsyncSync: (fd) => { if (linked && fs.fstatSync(fd).isDirectory()) throw new Error("dir-sync-failed"); fs.fsyncSync(fd); },
    } });
    expect(publication.durability).toBe("uncertain");
    const original = fs.readFileSync(publication.allowlistPath);
    const retry = publishMessagingPair(f.profile, f.config, f.input);
    expect(retry.durability).toBe("synced"); expect(retry.bindingPath).toBe(publication.bindingPath);
    expect(fs.readFileSync(retry.allowlistPath)).toEqual(original);
  });
  it.each(["same-path", "hardlink", "symlink"])("credential alias %s is refused without reading credential bytes", (kind) => {
    const f = fixture(); const pair = publishMessagingPair(f.profile, f.config, f.input);
    const key = kind === "same-path" ? pair.bindingPath : join(f.dir, "key");
    fs.writeFileSync(key, "SYNTHETIC-KEY-NOT-TO-READ", { mode: 0o600 });
    if (kind !== "same-path") { fs.unlinkSync(pair.allowlistPath); if (kind === "hardlink") fs.linkSync(key, pair.allowlistPath); else fs.symlinkSync(key, pair.allowlistPath); }
    const identity = fs.lstatSync(key); const read = fs.readSync; let secretReads = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const selected = fs.fstatSync(args[0]); if (selected.ino === identity.ino && selected.dev === identity.dev) secretReads++;
      return read(...args);
    });
    expect(() => readMessagingPair(f.profile, pair.bindingPath, key)).toThrow();
    expect(() => publishMessagingPair(f.profile, f.config, f.input, { credentialFile: key })).toThrow();
    expect(secretReads).toBe(0);
  });
  it("checks the opened fd before reading after a final path-to-key swap", () => {
    const f = fixture(); const pair = publishMessagingPair(f.profile, f.config, f.input); const key = join(f.dir, "key");
    fs.writeFileSync(key, "SYNTHETIC-KEY", { mode: 0o600 }); const identity = fs.lstatSync(key);
    const open = fs.openSync;
    vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[0] === pair.allowlistPath) { fs.unlinkSync(pair.allowlistPath); fs.linkSync(key, pair.allowlistPath); }
      return open(...args);
    });
    const read = fs.readSync; let secretReads = 0;
    vi.spyOn(fs, "readSync").mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const selected = fs.fstatSync(args[0]); if (selected.ino === identity.ino && selected.dev === identity.dev) secretReads++;
      return read(...args);
    });
    expect(() => readMessagingPair(f.profile, pair.bindingPath, key)).toThrow(); expect(secretReads).toBe(0);
  });
  it("failed publication leaves existing generation bytes intact and never performs destructive compensation", () => {
    const f = fixture(); const first = publishMessagingPair(f.profile, f.config, f.input);
    const binding = fs.readFileSync(first.bindingPath); const allowlist = fs.readFileSync(first.allowlistPath);
    const unlink = vi.spyOn(fs, "unlinkSync"); const rename = vi.spyOn(fs, "renameSync");
    expect(() => publishMessagingPair(f.profile, f.config, { ...f.input, piSessionId: "new" }, { io: {
      linkSync: () => { throw new Error("synthetic failure"); },
    } })).toThrow();
    expect(fs.readFileSync(first.bindingPath)).toEqual(binding); expect(fs.readFileSync(first.allowlistPath)).toEqual(allowlist);
    expect(unlink).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });
});
