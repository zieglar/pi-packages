import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { admitExecutable, qualifyNodeExecutable, resolveApprovedNode, resolveTunnelClient, diagnoseTunnelClient } from "../../src/runtime/executables.js";

import { APPROVED_NODE_VERSION, APPROVED_SQLITE_VERSION, APPROVED_SQLITE_SOURCE_ID } from "../../src/storage/runtime.js";
const roots: string[] = [];
function fixture(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-executable-"));
  chmodSync(root, 0o700);
  roots.push(root);
  return root;
}
function binary(root: string, name = "node"): string {
  const path = join(root, name);
  copyFileSync(process.execPath, path);
  chmodSync(path, 0o700);
  return path;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("executable admission", () => {
  it("admits a trusted absolute executable with spaces outside mise", () => {
    const path = binary(fixture(), "approved node");
    expect(admitExecutable(path)).toBe(path);
    expect(qualifyNodeExecutable(path).nodeVersion).toBe(process.version);
  });
  it("validates symlink targets and canonicalizes a safe link", () => {
    const root = fixture(); const path = binary(root); const link = join(root, "node-link");
    symlinkSync(path, link);
    expect(admitExecutable(link)).toBe(path);
    chmodSync(path, 0o777);
    expect(() => admitExecutable(link)).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
  it("refuses writable ancestors before executing a candidate", () => {
    const root = fixture(); const dir = join(root, "writable"); mkdirSync(dir, { mode: 0o777 });
    const path = binary(dir); chmodSync(dir, 0o777);
    expect(() => qualifyNodeExecutable(path)).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
  it("does not treat a plain operator working directory as a project", () => {
    const root = fixture(); const path = binary(root);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    try { expect(admitExecutable(path)).toBe(path); } finally { cwd.mockRestore(); }
  });
  it("refuses repository executables outside the nested working directory", () => {
    const root = fixture(); mkdirSync(join(root, ".git")); mkdirSync(join(root, "nested"));
    const path = binary(root); const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(root, "nested"));
    try { expect(() => admitExecutable(path)).toThrow("CE_EXECUTABLE_UNTRUSTED"); } finally { cwd.mockRestore(); }
  });
  it("refuses project-local files even when executable and operator-owned", () => {
    const root = fixture(); const path = binary(root);
    expect(() => admitExecutable(path, { projectRoot: root })).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
  it.each(["node", "./node", "", "/missing/ce-node", "/usr/bin/../bin/node", "/tmp/node\nsecret"])("refuses unsafe candidate %j", (path) => {
    expect(() => admitExecutable(path)).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
  it("does not run a project PATH executable to discover Node or client", () => {
    const root = fixture(); const marker = join(root, "executed");
    for (const name of ["node", "tunnel-client"]) {
      writeFileSync(join(root, name), `#!/bin/sh\n: > '${marker}'\nprintf 'UNTRUSTED_PATH_EXECUTED'\n`, { mode: 0o700 });
    }
    const env = { PATH: root, HOME: root };
    expect(resolveApprovedNode({ env, homeDir: root, execPath: "/missing/current", systemDirectories: [] })).toBeUndefined();
    expect(resolveTunnelClient({ env, systemDirectories: [] })).toBeUndefined();
    expect(() => realpathSync(marker)).toThrow();
  });
  it.skipIf(process.platform !== "darwin")("admits a safe deny-only macOS ACL without altering it", () => {
    const path = binary(fixture());
    execFileSync("/bin/chmod", ["+a", "everyone deny delete", path]);
    try {
      expect(qualifyNodeExecutable(path).nodeVersion).toBe(process.version);
      expect(execFileSync("/bin/ls", ["-lde", path], { encoding: "utf8" })).toContain("deny delete");
    } finally { execFileSync("/bin/chmod", ["-N", path]); }
  });
  it.skipIf(process.platform !== "darwin").each(["file", "ancestor"])("refuses macOS allow ACL on executable %s before probing", (kind) => {
    const root = fixture(); const dir = join(root, "installation"); mkdirSync(dir, { mode: 0o700 });
    const marker = join(root, "executed"); const path = join(dir, "node");
    writeFileSync(path, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o700 });
    execFileSync("/bin/chmod", ["+a", "everyone allow write", kind === "file" ? path : dir]);
    try {
      expect(() => qualifyNodeExecutable(path)).toThrow("CE_EXECUTABLE_UNTRUSTED");
      expect(() => realpathSync(marker)).toThrow();
    } finally { execFileSync("/bin/chmod", ["-N", kind === "file" ? path : dir]); }
  });
});

describe("qualified Node selection", () => {
  it("prefers an explicit approved absolute path without mise", () => {
    const path = binary(fixture());
    expect(resolveApprovedNode({ env: { CE_NODE_PATH: path }, execPath: "/missing/current", systemDirectories: [] })).toBe(path);
  });
  it("fails closed for invalid explicit settings rather than falling back", () => {
    expect(() => resolveApprovedNode({ env: { CE_NODE_PATH: "node" } })).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
  it("qualifies a privately installed current runtime, not a caller-supplied version label", () => {
    const root = fixture(); const path = binary(root);
    expect(resolveApprovedNode({ env: {}, execPath: path, homeDir: root, systemDirectories: [] })).toBe(path);
  });
  it("rejects an unsafe current-runtime installation instead of assuming CI paths are trusted", () => {
    const root = fixture(); const dir = join(root, "hostedtoolcache"); mkdirSync(dir, { mode: 0o700 });
    const path = binary(dir); chmodSync(dir, 0o777);
    expect(resolveApprovedNode({ env: {}, execPath: path, homeDir: root, systemDirectories: [] })).toBeUndefined();
  });
  it("discovers only from controlled directories", () => {
    const root = fixture(); const path = binary(root);
    expect(resolveApprovedNode({ env: {}, execPath: "/missing/current", systemDirectories: [root] })).toBe(path);
  });
  it.each(["24.21.0", "24.22.1"])("retains a validated legacy mise %s location without requiring mise", (version) => {
    const root = fixture(); const dir = join(root, `installs/node/${version}/bin`); mkdirSync(dir, { recursive: true });
    const path = binary(dir);
    expect(resolveApprovedNode({ env: { MISE_DATA_DIR: root }, execPath: "/missing/current", systemDirectories: [] })).toBe(path);
  });
  it("rejects unapproved actual Node identity and hides subprocess output", () => {
    const root = fixture(); const path = join(root, "wrong-node");
    writeFileSync(path, '#!/bin/sh\nprintf "private-output-secret"\n', { mode: 0o700 });
    expect(() => qualifyNodeExecutable(path)).toThrow("CE_NODE_INELIGIBLE");
    try { qualifyNodeExecutable(path); } catch (error) { expect(String(error)).not.toContain("private-output-secret"); }
  });
  it.each([
    { nodeVersion: "v24.21.1" }, { sqliteVersion: "unapproved" },
    { sqliteSourceId: "unapproved" }, { platform: "unsupported" },
    { compileOptions: undefined }, { compileOptions: ["THREADSAFE=0"] },
    { sqliteCapabilities: undefined }, { sqliteCapabilities: ["defensive"] },
  ])("rejects well-formed but unapproved probe identity %j", (override) => {
    const path = join(fixture(), "wrong-node");
    const identity = { nodeVersion: APPROVED_NODE_VERSION, sqliteVersion: APPROVED_SQLITE_VERSION,
      sqliteSourceId: APPROVED_SQLITE_SOURCE_ID, platform: "linux", arch: "x64",
      compileOptions: ["THREADSAFE=1", "MUTEX_PTHREADS"],
      sqliteCapabilities: ["defensive", "statement-get", "statement-all", "statement-run", "transaction-state"], ...override };
    writeFileSync(path, `#!/bin/sh\nprintf '%s' '${JSON.stringify(identity)}'\n`, { mode: 0o700 });
    expect(() => qualifyNodeExecutable(path)).toThrow("CE_NODE_INELIGIBLE");
  });
  it("does not inherit NODE_OPTIONS into a qualification probe", () => {
    const path = binary(fixture());
    const before = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = "--require=/missing/private-hook.cjs";
    try { expect(qualifyNodeExecutable(path).nodeVersion).toBe(process.version); }
    finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
  });
});

it("opens and reopens a real temporary Store using copied approved Node with no mise environment", () => {
  const root = fixture(); const node = binary(root);
  const moduleUrl = new URL("../../dist/storage/store.js", import.meta.url).href;
  const location = { directory: join(root, "store"), filename: "store.sqlite" };
  const source = `import { initializeStore, openStore } from ${JSON.stringify(moduleUrl)};
const location = ${JSON.stringify(location)};
const first = initializeStore(location); const id = first.storeUuid; first.close();
const reopened = openStore(location);
console.log(JSON.stringify({node:process.version, executable:process.execPath, sameStore:reopened.storeUuid === id})); reopened.close();`;
  const result = JSON.parse(execFileSync(node, ["--input-type=module", "-e", source], {
    cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root }, encoding: "utf8",
    timeout: 10_000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "pipe"],
  }));
  expect(result).toEqual({ node: process.version, executable: node, sameStore: true });
});

describe("client selection", () => {
  it("accepts a trusted non-Homebrew explicit path without invoking it", () => {
    const root = fixture(); const path = join(root, "tunnel-client");
    const marker = join(root, "client-was-executed");
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\nexit 99\n`, { mode: 0o700 });
    expect(resolveTunnelClient({ env: { CE_TUNNEL_CLIENT_PATH: path }, systemDirectories: [] })).toBe(path);
    expect(() => realpathSync(marker)).toThrow();
  });
  it("refuses unsafe explicit clients rather than using a default", () => {
    expect(() => resolveTunnelClient({ env: { CE_TUNNEL_CLIENT_PATH: "tunnel-client" } })).toThrow("CE_EXECUTABLE_UNTRUSTED");
  });
});

describe("closed client installation diagnosis (same metadata admission)", () => {
  it("distinguishes absence, rejected discovery and trusted metadata without client execution", () => {
    const root = fixture(); const path = join(root, "tunnel-client"); const marker = join(root, "executed");
    const options = { env: {}, systemDirectories: [root] };
    expect(diagnoseTunnelClient(options)).toBe("CE_TUNNEL_CLIENT_MISSING");
    writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    expect(diagnoseTunnelClient(options)).toBe("TRUSTED_METADATA_ONLY");
    chmodSync(path, 0o777); expect(diagnoseTunnelClient(options)).toBe("CE_EXECUTABLE_UNTRUSTED");
    expect(() => realpathSync(marker)).toThrow();
  });
  it.each(["relative", "", "/missing/private-client"])("explicit invalid override %j never falls back", override => {
    const root = fixture(); binary(root, "tunnel-client");
    expect(diagnoseTunnelClient({ env: { CE_TUNNEL_CLIENT_PATH: override }, systemDirectories: [root] })).toBe("CE_EXECUTABLE_UNTRUSTED");
  });
  it.each(["ancestor", "symlink", "project"])("retains %s trust denial", kind => {
    const root = fixture(); const installation = join(root, "installation"); mkdirSync(installation, { mode: 0o700 });
    const target = binary(installation, "client"); const path = join(root, "tunnel-client"); symlinkSync(target, path);
    if (kind === "ancestor") chmodSync(installation, 0o777);
    else if (kind === "symlink") chmodSync(target, 0o777);
    expect(diagnoseTunnelClient({ env: {}, systemDirectories: [root], ...(kind === "project" ? { projectRoot: root } : {}) })).toBe("CE_EXECUTABLE_UNTRUSTED");
  });
  it.skipIf(process.platform !== "darwin")("retains macOS ACL denial", () => {
    const root = fixture(); const path = binary(root, "tunnel-client");
    execFileSync("/bin/chmod", ["+a", "everyone allow write", path]);
    try { expect(diagnoseTunnelClient({ env: {}, systemDirectories: [root] })).toBe("CE_EXECUTABLE_UNTRUSTED"); }
    finally { execFileSync("/bin/chmod", ["-N", path]); }
  });
});
