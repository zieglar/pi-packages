import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundAuthorizationStore } from "../../src/tunnel/background-authorization.js";

const roots: string[] = [];
const digest = "a".repeat(64);
const profile = "/profiles/operator.json";
function fixture() {
  const root = mkdtempSync("/private/tmp/ce-auth-");
  roots.push(root);
  const directory = join(root, "authorization");
  return { root, directory, store: createBackgroundAuthorizationStore({ directory, now: () => 123 }) };
}
function expectRefusal(action: () => unknown): void {
  try { action(); }
  catch (error) { expect((error as { code?: string }).code).toBe("CE_TUNNEL_BACKGROUND_UNAUTHORIZED"); return; }
  throw new Error("expected CE_TUNNEL_BACKGROUND_UNAUTHORIZED refusal");
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("operator background authorization", () => {
  it("reports synced commits and persists non-authoritative selection independently", () => {
    const { directory, store } = fixture();
    expect(store.readSelection()).toEqual({ kind: "absent" });
    expect(store.writeSelection(profile, "/bin/client")).toEqual({ committed: true, durability: "synced" });
    const fresh = createBackgroundAuthorizationStore({ directory });
    expect(fresh.readSelection()).toEqual({ kind: "valid", profilePath: profile, clientPath: "/bin/client" });
    expect(fresh.inspect(profile)).toEqual({ kind: "absent" });
    expect(store.write(profile, "granted", digest)).toEqual({ committed: true, durability: "synced" });
  });
  it.each(["grant", "selection"])("rejects hard-linked %s records without replacing either alias", kind => {
    const { root, store } = fixture();
    store.write(profile, "granted", digest); store.writeSelection(profile, "/bin/client");
    const file = kind === "grant" ? store.path(profile) : store.selectionPath();
    const alias = join(root, "record-alias"); fs.linkSync(file, alias);
    const before = readFileSync(file, "utf8");
    expect(kind === "grant" ? store.inspect(profile) : store.readSelection()).toEqual({ kind: "invalid" });
    expectRefusal(() => kind === "grant" ? store.write(profile, "revoked", digest) : store.writeSelection(profile, "/other/client"));
    expect(lstatSync(file).nlink).toBe(2); expect(readFileSync(alias, "utf8")).toBe(before);
  });
  it.each(["writeSync", "fsyncSync", "renameSync"] as const)("refuses %s failure before commit and preserves old grant", (operation) => {
    const { directory, store } = fixture();
    store.write(profile, "revoked", digest);
    const failing = createBackgroundAuthorizationStore({ directory, filesystem: { [operation]: () => { throw new Error("private details"); } } });
    expectRefusal(() => failing.write(profile, "granted", digest));
    expect(store.inspect(profile)).toEqual({ kind: "valid", state: "revoked", scopeDigest: digest });
    expect(readdirSync(directory)).toHaveLength(1);
  });
  it("returns uncertain after rename when directory sync fails, retaining committed record", () => {
    const { directory, store } = fixture();
    let syncs = 0;
    const failing = createBackgroundAuthorizationStore({ directory, filesystem: { fsyncSync: fd => { if (++syncs === 2) throw new Error("private details"); fs.fsyncSync(fd); } } });
    expect(failing.write(profile, "granted", digest)).toEqual({ committed: true, durability: "uncertain" });
    expect(store.inspect(profile)).toEqual({ kind: "valid", state: "granted", scopeDigest: digest });
  });
  it("visible uncertain grant and selection stay unusable while directory synchronization fails", () => {
    const { directory, store } = fixture();
    store.write(profile, "granted", digest); store.writeSelection(profile, "/bin/client");
    const failing = createBackgroundAuthorizationStore({ directory, filesystem: { fsyncSync: () => { throw new Error("sync-unavailable"); } } });
    expect(failing.inspect(profile)).toEqual({ kind: "invalid" });
    expect(failing.readSelection()).toEqual({ kind: "invalid" });
    expect(createBackgroundAuthorizationStore({ directory }).inspect(profile)).toMatchObject({ kind: "valid", state: "granted" });
  });
  it("preserves the previous selection on a pre-rename failure", () => {
    const { directory, store } = fixture();
    store.writeSelection(profile, "/bin/client");
    const failing = createBackgroundAuthorizationStore({ directory, filesystem: { renameSync: () => { throw new Error("private details"); } } });
    expectRefusal(() => failing.writeSelection(profile, "/other/client"));
    expect(store.readSelection()).toEqual({ kind: "valid", profilePath: profile, clientPath: "/bin/client" });
    expect(readdirSync(directory)).toHaveLength(1);
  });
  it("returns uncertain for selection when directory sync fails after rename", () => {
    const { directory, store } = fixture();
    let syncs = 0;
    const failing = createBackgroundAuthorizationStore({ directory, filesystem: { fsyncSync: fd => { if (++syncs === 2) throw new Error("private details"); fs.fsyncSync(fd); } } });
    expect(failing.writeSelection(profile, "/bin/client")).toEqual({ committed: true, durability: "uncertain" });
    expect(store.readSelection()).toEqual({ kind: "valid", profilePath: profile, clientPath: "/bin/client" });
  });
  it.each(["relative/client", "/a/../b", "/a//b", "/a\u0000b"])("rejects noncanonical selection client %s", path => {
    const { root, store } = fixture();
    expectRefusal(() => store.writeSelection(profile, path));
    expect(readdirSync(root)).toEqual([]);
  });
  it.each(["allow", "unknown"])("rejects %s ACL on ancestors and records", kind => {
    const { directory, store } = fixture();
    store.write(profile, "granted", digest);
    for (const target of [directory, store.path(profile)]) {
      const guarded = createBackgroundAuthorizationStore({ directory, readAcl: path => path === target ? (kind === "allow" ? "-rw-------+ 1 owner group 0 file\n 0: user:other allow read" : "unknown") : "drwx------ 1 owner group 0 dir" });
      expect(guarded.inspect(profile)).toEqual({ kind: "invalid" });
    }
  });
  it.each(["malformed", "mode", "extra", "path", "uid", "version", "timestamp", "symlink"])("rejects invalid selection %s without repair", kind => {
    const { root, directory, store } = fixture();
    store.writeSelection(profile, "/bin/client");
    const file = join(directory, "selection.json");
    if (kind === "mode") chmodSync(file, 0o644);
    else if (kind === "symlink") { fs.unlinkSync(file); writeFileSync(join(root, "target"), "secret"); symlinkSync(join(root, "target"), file); }
    else if (kind === "malformed") writeFileSync(file, "{");
    else { const data = JSON.parse(readFileSync(file, "utf8")); if (kind === "extra") data.extra = true; if (kind === "path") data.clientPath = "/a/../b"; if (kind === "uid") data.uid++; if (kind === "version") data.version = 2; if (kind === "timestamp") data.updatedAt = -1; writeFileSync(file, JSON.stringify(data)); }
    const before = readFileSync(file, "utf8");
    expect(store.readSelection()).toEqual({ kind: "invalid" });
    expect(readFileSync(file, "utf8")).toBe(before);
  });
  it("reports absence without creating directories", () => {
    const { root, store } = fixture();
    expect(store.inspect(profile)).toEqual({ kind: "absent" });
    expect(readdirSync(root)).toEqual([]);
  });
  it("persists grant, changed scope and revoked tombstone across fresh stores", () => {
    const { directory, store } = fixture();
    store.write(profile, "granted", digest);
    const fresh = createBackgroundAuthorizationStore({ directory, now: () => 123 });
    expect(fresh.inspect(profile)).toEqual({ kind: "valid", state: "granted", scopeDigest: digest });
    fresh.write(profile, "granted", "b".repeat(64));
    expect(store.inspect(profile)).toEqual({ kind: "valid", state: "granted", scopeDigest: "b".repeat(64) });
    fresh.write(profile, "revoked", digest);
    expect(store.inspect(profile)).toEqual({ kind: "valid", state: "revoked", scopeDigest: digest });
    expect(lstatSync(directory).mode & 0o7777).toBe(0o700);
    expect(lstatSync(store.path(profile)).mode & 0o7777).toBe(0o600);
    expect(JSON.parse(readFileSync(store.path(profile), "utf8"))).toEqual({ version: 1, uid: process.geteuid!(), profilePath: profile, state: "revoked", scopeDigest: digest, updatedAt: 123 });
    expect(readdirSync(directory)).toHaveLength(1);
  });
  it.each(["{", "{}", "null", "[]", "x".repeat(8193)])("rejects malformed record %s without repair", (text) => {
    const { store } = fixture();
    store.write(profile, "granted", digest);
    writeFileSync(store.path(profile), text);
    expect(store.inspect(profile)).toEqual({ kind: "invalid" });
    expect(readFileSync(store.path(profile), "utf8")).toBe(text);
  });
  it.each(["uid", "profilePath", "state", "scopeDigest", "updatedAt", "version", "extra"])("rejects invalid %s metadata", (key) => {
    const { store } = fixture();
    store.write(profile, "granted", digest);
    const data = JSON.parse(readFileSync(store.path(profile), "utf8"));
    data[key] = key === "uid" ? process.geteuid!() + 1 : "invalid";
    writeFileSync(store.path(profile), JSON.stringify(data));
    expect(store.inspect(profile)).toEqual({ kind: "invalid" });
  });
  it("rejects permissive files and permits explicit replacement", () => {
    const { store } = fixture();
    store.write(profile, "granted", digest);
    chmodSync(store.path(profile), 0o644);
    expect(store.inspect(profile)).toEqual({ kind: "invalid" });
    expect(lstatSync(store.path(profile)).mode & 0o777).toBe(0o644);
    store.write(profile, "revoked", digest);
    expect(store.inspect(profile)).toEqual({ kind: "valid", state: "revoked", scopeDigest: digest });
  });
  it("rejects symlink records without reading target", () => {
    const { root, directory, store } = fixture();
    mkdirSync(directory, { mode: 0o700 });
    const target = join(root, "target");
    writeFileSync(target, "secret", { mode: 0o600 });
    symlinkSync(target, store.path(profile));
    expect(store.inspect(profile)).toEqual({ kind: "invalid" });
    store.write(profile, "revoked", digest);
    expect(readFileSync(target, "utf8")).toBe("secret");
  });
  it.each(["directory", "ancestor", "symlink"])("rejects unsafe %s without healing", (kind) => {
    const { root, directory, store } = fixture();
    if (kind === "symlink") symlinkSync(root, directory);
    else mkdirSync(directory, { mode: kind === "directory" ? 0o755 : 0o700 });
    if (kind === "ancestor") chmodSync(root, 0o777);
    expect(store.inspect(profile)).toEqual({ kind: "invalid" });
    expectRefusal(() => store.write(profile, "granted", digest));
    if (kind === "directory") expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    if (kind === "ancestor") expect(lstatSync(root).mode & 0o777).toBe(0o777);
  });
  it.each(["relative.json", "/a/../b", "/a//b", "/a/./b", "/a\u0000b", "/a\nb"])("rejects noncanonical profile %s", (path) => {
    const { store } = fixture();
    expect(store.inspect(path)).toEqual({ kind: "invalid" });
    expectRefusal(() => store.path(path));
    expectRefusal(() => store.write(path, "granted", digest));
  });
  it("rejects invalid write inputs without creating storage", () => {
    const { root, store } = fixture();
    expectRefusal(() => store.write(profile, "granted", "A".repeat(64)));
    expect(readdirSync(root)).toEqual([]);
  });
});
