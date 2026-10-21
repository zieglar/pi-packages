import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureManagedBinding,
  formatRecipientList,
  managedBindingFileName,
  parseRecipientList,
} from "../../dist/tunnel/managed-binding.js";

const dirs: string[] = [];
function dir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "ce-managed-binding-"));
  dirs.push(d);
  return d;
}
afterEach(() => { while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ID = "tunnel_abcdefgh123456";
const ORG = "org-AbC123XYZ789";
const SELF = { adapter: "pi", endpointId: "ce-self" } as const;

describe("managed binding naming", () => {
  it("derives ce-<tunnel tail6>-<org tail6>.yaml preserving case", () => {
    expect(managedBindingFileName({ tunnelId: ID, organizationId: ORG, adapter: "pi" }))
      .toBe("ce-123456-XYZ789.yaml");
  });
  it("uses 'none' when organization is unset", () => {
    expect(managedBindingFileName({ tunnelId: ID, organizationId: undefined, adapter: "pi" }))
      .toBe("ce-123456-none.yaml");
  });
  it("never includes secrets, credential references, or path segments", () => {
    const name = managedBindingFileName({ tunnelId: ID, organizationId: ORG, adapter: "pi" });
    expect(name).toMatch(/^ce-[A-Za-z0-9]{6}-[A-Za-z0-9]{4,6}\.yaml$/);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name).not.toContain("cap_");
  });
  it.each(["notatunnel", "tunnel_short", "", "tunnel_!!!!!!"])("refuses invalid tunnel identity %s", (tunnelId) => {
    expect(() => managedBindingFileName({ tunnelId, organizationId: undefined, adapter: "pi" }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
});

describe("managed binding creation and ownership", () => {
  it("creates a 0700 directory and 0600 document with minimal permissions", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const result = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: ORG, adapter: "pi" });
    expect(result.reused).toBe(false);
    expect(result.path).toBe(join(d, ".ce-bindings", "ce-123456-XYZ789.yaml"));
    const doc = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(doc.managed).toEqual({ tunnelId: ID, organizationId: ORG, adapter: "pi" });
    expect(doc.recipients).toEqual([]);
    expect(doc.payloadRead.enabled).toBe(false);
    expect(doc.ack.enabled).toBe(false);
    expect(doc.debugExecutionGuard.enabled).toBe(false);
    expect(fs.lstatSync(result.path).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(join(d, ".ce-bindings")).mode & 0o777).toBe(0o700);
    // The Store is NOT created here: only the binding document exists.
    expect(fs.existsSync(join(d, ".ce-bindings", "ce-store.sqlite"))).toBe(false);
  });
  it("reuses an identical document without modification", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const first = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: ORG, adapter: "pi" });
    const mtime = fs.lstatSync(first.path).mtimeMs;
    const second = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: ORG, adapter: "pi" });
    expect(second.reused).toBe(true);
    expect(second.path).toBe(first.path);
    expect(fs.lstatSync(first.path).mtimeMs).toBe(mtime);
  });
  it("changed recipients produce a new digest-suffixed generation; the base is untouched", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const first = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: ORG, adapter: "pi" });
    const firstText = fs.readFileSync(first.path, "utf8");
    const second = ensureManagedBinding(profilePath, {
      tunnelId: ID, organizationId: ORG, adapter: "pi",
      recipients: [{ adapter: "chatgpt", endpointId: "chatgpt/main" }],
    });
    expect(second.reused).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(second.path).toMatch(/ce-123456-XYZ789-[0-9a-f]{8}\.yaml$/);
    expect(fs.readFileSync(first.path, "utf8")).toBe(firstText); // base generation never mutated
    const doc = JSON.parse(fs.readFileSync(second.path, "utf8"));
    expect(doc.recipients).toEqual([{ adapter: "chatgpt", endpointId: "chatgpt/main" }]);
  });
  it("a same-name file with a different identity is never reused or overwritten", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const first = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    const firstText = fs.readFileSync(first.path, "utf8");
    // Same tail6 would need a crafted id; simulate a foreign document at the name.
    fs.writeFileSync(first.path, JSON.stringify({ ...JSON.parse(firstText), managed: { tunnelId: "tunnel_FOREIGN999999", adapter: "pi" } }));
    const result = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(result.path).toMatch(/ce-123456-none-[0-9a-f]{8}\.yaml$/);
    expect(fs.readFileSync(first.path, "utf8")).toContain("FOREIGN"); // foreign file intact
  });
  it("refuses a foreign non-private file at the managed name (fail closed)", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true, mode: 0o700 });
    const name = join(d, ".ce-bindings", "ce-123456-none.yaml");
    // Default 0644: not operator-private, so it is refused, never bypassed.
    fs.writeFileSync(name, JSON.stringify({ version: 1, store: { directory: d }, exchange: { namespace: "x", idempotencyKey: "x" }, endpoint: { adapter: "pi", endpointId: "x" }, recipients: [] }));
    expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
  it("a foreign but private unmanaged file at the managed name moves to a digest candidate", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true, mode: 0o700 });
    const name = join(d, ".ce-bindings", "ce-123456-none.yaml");
    fs.writeFileSync(name, JSON.stringify({ version: 1, store: { directory: d }, exchange: { namespace: "x", idempotencyKey: "x" }, endpoint: { adapter: "pi", endpointId: "x" }, recipients: [] }), { mode: 0o600 });
    // Private and parseable, but no managed provenance -> cannot be proven ours;
    // disambiguate to the hash-suffixed candidate without touching the foreign file.
    const result = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(result.path).toMatch(/ce-123456-none-[0-9a-f]{8}\.yaml$/);
    expect(fs.readFileSync(name, "utf8")).toContain('"namespace":"x"');
  });
  it("refuses a symlinked managed directory", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true });
    fs.rmSync(join(d, ".ce-bindings"), { recursive: true });
    fs.symlinkSync(d, join(d, ".ce-bindings"));
    expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
});

describe("recipient list parsing (wizard input)", () => {
  it("empty means no recipients — never a wildcard", () => {
    expect(parseRecipientList("", SELF)).toEqual([]);
    expect(parseRecipientList("   ", SELF)).toEqual([]);
  });
  it("parses comma-separated adapter:endpointId", () => {
    expect(parseRecipientList("chatgpt:chatgpt/main, mcp:ops/alerts", SELF)).toEqual([
      { adapter: "chatgpt", endpointId: "chatgpt/main" },
      { adapter: "mcp", endpointId: "ops/alerts" },
    ]);
  });
  it.each([
    "only-adapter",
    "pi:pi/self",                    // self adapter
    "chatgpt:ce-self",               // self endpoint
    "chatgpt:dup, chatgpt:dup",      // duplicate
    "chatgpt:cap_0123456789abcdef",  // credential-shaped
    ":no-adapter",
    "chatgpt:",
  ])("refuses %s", (text) => {
    expect(() => parseRecipientList(text, SELF))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
  it("round-trips through formatRecipientList", () => {
    const recipients = parseRecipientList("chatgpt:chatgpt/main, mcp:ops/alerts", SELF);
    expect(formatRecipientList(recipients)).toBe("chatgpt:chatgpt/main, mcp:ops/alerts");
    expect(parseRecipientList(formatRecipientList(recipients), SELF)).toEqual(recipients);
  });
});

describe("R1 review remediations", () => {
  it("two tunnels sharing a tail6 get distinct exchange namespaces and endpoints", () => {
    const d = dir();
    const a = ensureManagedBinding(join(d, "a.yaml"), { tunnelId: "tunnel_AAAAAA123456", organizationId: undefined, adapter: "pi" });
    const b = ensureManagedBinding(join(d, "b.yaml"), { tunnelId: "tunnel_BBBBBB123456", organizationId: undefined, adapter: "pi" });
    expect(a.config.exchange.namespace).not.toBe(b.config.exchange.namespace);
    expect(a.config.endpoint.endpointId).not.toBe(b.config.endpoint.endpointId);
    expect(a.config.exchange.namespace).toMatch(/^ce-[0-9a-f]{16}$/);
  });
  it("refuses to adopt a pre-existing world-readable managed directory", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true, mode: 0o755 });
    expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
  it("refuses to reuse a non-private managed document", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const first = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    fs.chmodSync(first.path, 0o644);
    expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
  });
  it("refuses an oversized recipient set instead of persisting an unreadable document", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const many = Array.from({ length: 400 }, (_, i) => ({ adapter: `a${i}`, endpointId: `e${i}/${"x".repeat(200)}` }));
    expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi", recipients: many }))
      .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    expect(fs.existsSync(join(d, ".ce-bindings"))).toBe(false);
  });

  it("B-R4#1: never opens the credential file as a managed candidate (pre-open exclusion)", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const credential = join(d, "credential.yaml");
    fs.writeFileSync(credential, "SECRET-CONTENT", { mode: 0o600 });
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true, mode: 0o700 });
    // Hardlink the credential AT the managed base name: a candidate that IS the
    // credential must be refused before any open, not merely after fstat.
    const candidate = join(d, ".ce-bindings", "ce-123456-none.yaml");
    fs.linkSync(credential, candidate);
    const opened: string[] = [];
    const realOpen = fs.openSync;
    const spy = (path: fs.PathLike, ...rest: unknown[]) => { opened.push(String(path)); return (realOpen as Function)(path, ...rest); };
    const orig = fs.openSync;
    try {
      (fs as { openSync: typeof fs.openSync }).openSync = spy as typeof fs.openSync;
      expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi", credentialFile: credential }))
        .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    } finally {
      (fs as { openSync: typeof fs.openSync }).openSync = orig;
    }
    // The credential path was never opened for content.
    expect(opened.filter((p) => p === candidate || p === credential)).toEqual([]);
    // Credential bytes were never read into the process via the managed path.
  });

  it("A-R6: a directory-fsync failure retains the self-created candidate; a retry REUSES it after re-syncing the directory", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const candidate = join(d, ".ce-bindings", "ce-123456-none.yaml");
    const origOpen = fs.openSync;
    const origFsync = fs.fsyncSync;
    let failDirSync = true;
    let dirSyncAttempts = 0;
    (fs as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = function (fd: number) {
      const st = fs.fstatSync(fd);
      if (st.isDirectory()) {
        dirSyncAttempts++;
        if (failDirSync) throw new Error("dir-fsync-fail");
      }
      (origFsync as Function).call(fs, fd);
    } as typeof fs.fsyncSync;
    try {
      // First attempt: dir fsync fails -> candidate retained, refusal raised.
      expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
        .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
      // The complete+file-fsynced candidate is RETAINED (never unlinked).
      expect(fs.existsSync(candidate)).toBe(true);
      // Retry WITHOUT deleting: same identity + content -> reused, and the reuse
      // path re-syncs the directory (C-R7#1) before returning.
      failDirSync = false;
      const retry = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
      expect(retry.reused).toBe(true);
      expect(retry.path).toBe(candidate);
      expect(retry.created).toBeUndefined();
      expect(dirSyncAttempts).toBeGreaterThanOrEqual(2); // initial failed + reuse re-sync
    } finally {
      (fs as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = origFsync;
    }
  });

  it("A-R6: a foreign candidate is never overwritten; publish disambiguates to the digest name", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const candidate = join(d, ".ce-bindings", "ce-123456-none.yaml");
    fs.mkdirSync(join(d, ".ce-bindings"), { recursive: true, mode: 0o700 });
    // Private but foreign (not managed): the base name is occupied.
    fs.writeFileSync(candidate, JSON.stringify({ version: 1, store: { directory: d }, exchange: { namespace: "x", idempotencyKey: "x" }, endpoint: { adapter: "pi", endpointId: "x" }, recipients: [] }), { mode: 0o600 });
    const result = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    // Foreign file preserved verbatim; publish disambiguated to digest-suffixed name.
    expect(fs.readFileSync(candidate, "utf8")).toContain('"namespace":"x"');
    expect(result.path).toMatch(/ce-123456-none-[0-9a-f]{8}\.yaml$/);
    expect(result.reused).toBe(false);
  });


  it("returns the fd-verified created identity on create and omits it on reuse", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const first = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(first.reused).toBe(false);
    // created identity matches the file's real inode/dev (fd-derived, no lstat race).
    expect(first.created).toBeDefined();
    const st = fs.lstatSync(first.path);
    expect(first.created!.ino).toBe(st.ino);
    expect(first.created!.dev).toBe(st.dev);
    // Reuse of the identical document returns no created identity.
    const again = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(again.reused).toBe(true);
    expect(again.created).toBeUndefined();
  });

  it("retains a valid published candidate when the redundant post-publish re-read fails (A-R8)", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const candidate = join(d, ".ce-bindings", "ce-123456-none.yaml");
    // Corrupt the post-write re-read so validation fails after a successful write.
    const origRead = fs.readFileSync;
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = function (path: unknown, ...rest: unknown[]) {
      if (typeof path === "number" || String(path) === candidate) {
        // Only corrupt the post-write read of the candidate (by fd or path).
        const isCandidate = String(path) === candidate;
        // Heuristic: fd-based read after creation vs path read. Corrupt only when
        // the file exists (post-write), so the pre-write ENOENT path is untouched.
        if (isCandidate ? true : fs.existsSync(candidate)) return Buffer.from("{not-json");
      }
      return (origRead as Function).call(fs, path, ...rest);
    } as typeof fs.readFileSync;
    try {
      expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
        .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    } finally {
      (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = origRead;
    }
    // A-R8: the candidate was published from a validated staging generation, so a
    // post-publish re-read failure RETAINS it (never unlinks the shared pathname).
    expect(fs.existsSync(candidate)).toBe(true);
    // Idempotent: a retry reuses the retained valid candidate.
    const retry = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(retry.reused).toBe(true);
    expect(retry.path).toBe(candidate);
  });

  it("removes the self-created file when creation-time permission validation fails", () => {
    const d = dir();
    const profilePath = join(d, "tunnel.yaml");
    const candidate = join(d, ".ce-bindings", "ce-123456-none.yaml");
    // Force the created file to a non-0600 mode so the permission check refuses
    // AFTER creation; the identity-checked cleanup must remove it (not poison retry).
    const origFstat = fs.fstatSync;
    (fs as { fstatSync: typeof fs.fstatSync }).fstatSync = function (fd: number, ...rest: unknown[]) {
      const st = (origFstat as Function).call(fs, fd, ...rest);
      if (st.isFile() && st.mode === 0o100600) {
        // Report world-readable to trip the permission refusal.
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mode: 0o100644 });
      }
      return st;
    } as typeof fs.fstatSync;
    try {
      expect(() => ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" }))
        .toThrow(expect.objectContaining({ code: "CE_TUNNEL_PROFILE_INVALID" }));
    } finally {
      (fs as { fstatSync: typeof fs.fstatSync }).fstatSync = origFstat;
    }
    expect(fs.existsSync(candidate)).toBe(false);
    // A clean retry now succeeds (no poisoned candidate).
    const ok = ensureManagedBinding(profilePath, { tunnelId: ID, organizationId: undefined, adapter: "pi" });
    expect(ok.reused).toBe(false);
  });
});
