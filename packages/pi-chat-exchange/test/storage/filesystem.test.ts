import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  rmSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FilesystemSafetyError,
  assertLocalFilesystemType,
  assertSecureDatabaseArtifacts,
  prepareDatabasePath,
  withRestrictiveUmask,
} from "../../src/storage/filesystem.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-chat-exchange-storage-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("durable storage filesystem safety", () => {
  it("requires an explicit absolute database directory", () => {
    expect(() => prepareDatabasePath({ directory: "relative", filename: "store.sqlite" })).toThrow(
      FilesystemSafetyError,
    );
  });

  it("creates a private directory and returns a contained database path", () => {
    const directory = join(temporaryRoot(), "database");
    expect(prepareDatabasePath({ directory, filename: "store.sqlite" })).toBe(
      join(directory, "store.sqlite"),
    );
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);
  });

  it("rejects traversal and production Pi directories", () => {
    const root = temporaryRoot();
    expect(() => prepareDatabasePath({ directory: root, filename: "../outside.sqlite" })).toThrow(
      FilesystemSafetyError,
    );
    expect(() =>
      prepareDatabasePath({ directory: join(process.env.HOME ?? root, ".pi", "storage"), filename: "store.sqlite" }),
    ).toThrow(FilesystemSafetyError);
  });

  it("rejects symlinked or non-private directories", () => {
    const root = temporaryRoot();
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    expect(() => prepareDatabasePath({ directory: link, filename: "store.sqlite" })).toThrow(
      FilesystemSafetyError,
    );

    const broad = join(root, "broad");
    mkdirSync(broad, { mode: 0o755 });
    expect(() => prepareDatabasePath({ directory: broad, filename: "store.sqlite" })).toThrow(
      FilesystemSafetyError,
    );
  });

  it("requires owned regular database artifacts with mode 0600", () => {
    const directory = join(temporaryRoot(), "database");
    const databasePath = prepareDatabasePath({ directory, filename: "store.sqlite" });
    closeSync(openSync(databasePath, "wx", 0o600));
    closeSync(openSync(`${databasePath}-wal`, "wx", 0o600));
    closeSync(openSync(`${databasePath}-shm`, "wx", 0o600));
    expect(() => assertSecureDatabaseArtifacts(databasePath)).not.toThrow();

    chmodSync(databasePath, 0o644);
    expect(() => assertSecureDatabaseArtifacts(databasePath)).toThrow(FilesystemSafetyError);
  });

  it("rejects a symlinked database artifact", () => {
    const directory = join(temporaryRoot(), "database");
    const databasePath = prepareDatabasePath({ directory, filename: "store.sqlite" });
    const target = join(directory, "target");
    closeSync(openSync(target, "wx", 0o600));
    symlinkSync(target, databasePath);
    expect(() => assertSecureDatabaseArtifacts(databasePath)).toThrow(FilesystemSafetyError);
  });

  it("uses and restores a restrictive process umask", () => {
    const before = process.umask();
    let during = -1;
    withRestrictiveUmask(() => {
      during = process.umask();
    });
    expect(during).toBe(0o077);
    expect(process.umask()).toBe(before);
  });

  it.runIf(process.platform === "darwin")("accepts the approved local Darwin filesystem by mount identity", () => {
    expect(() => assertLocalFilesystemType("darwin", 26, temporaryRoot())).not.toThrow();
  });
  it("accepts approved local Linux filesystem identifiers and rejects remote or unknown ones", () => {
    expect(() => assertLocalFilesystemType("linux", 0xef53)).not.toThrow();
    expect(() => assertLocalFilesystemType("linux", 0x6969)).toThrow(FilesystemSafetyError);
    expect(() => assertLocalFilesystemType("linux", 0x12345678)).toThrow(FilesystemSafetyError);
  });
});
