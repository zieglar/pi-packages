import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertLocalFilesystemType, FilesystemSafetyError } from "../../src/storage/filesystem.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
const mount = vi.mocked(execFileSync);
const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ce-darwin-fs-"));
  roots.push(root);
  return root;
}
function nestedDirectory(): string {
  const path = join(directory(), "nested");
  mkdirSync(path);
  return path;
}
beforeEach(() => {
  mount.mockReset();
  mount.mockReturnValue("/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n");
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Darwin local filesystem identity", () => {
  it("accepts local APFS by mount identity across VFS type numbering variants", () => {
    const path = directory();
    for (const type of [17, 23, 25, 26]) {
      expect(() => assertLocalFilesystemType("darwin", type, path)).not.toThrow();
    }
    expect(mount).toHaveBeenCalledWith("/sbin/mount", expect.objectContaining({ shell: false }));
  });

  it("accepts HFS by mount identity", () => {
    mount.mockReturnValue("/dev/disk1s1 on / (hfs, local, journaled)\n");
    expect(() => assertLocalFilesystemType("darwin", 23, directory())).not.toThrow();
  });

  it("rejects unknown and unsupported local filesystem identities", () => {
    mount.mockReturnValue("/dev/disk9s1 on / (zfs, local)\n");
    expect(() => assertLocalFilesystemType("darwin", 25, directory())).toThrow(FilesystemSafetyError);
  });

  it.each(["nfs", "smbfs"])("rejects a matching remote submount beneath an APFS root: %s", name => {
    const path = nestedDirectory();
    mount.mockReturnValue(`/dev/disk3s1s1 on / (apfs, local)\nserver:/share on ${path} (${name}, remote)\n`);
    expect(() => assertLocalFilesystemType("darwin", 26, path)).toThrow(FilesystemSafetyError);
  });
  it("rejects a remote mount point whose name contains the mount separator", () => {
    const path = `${nestedDirectory()} on disk`;
    mkdirSync(path);
    mount.mockReturnValue(`/dev/disk3s1s1 on / (apfs, local)\nserver:/share on ${path} (nfs, remote)\n`);
    expect(() => assertLocalFilesystemType("darwin", 26, path)).toThrow(FilesystemSafetyError);
  });

  it("rejects case aliases that resolve to a remote mount", () => {
    const path = nestedDirectory();
    mount.mockReturnValue(`/dev/disk3s1s1 on / (apfs, local)\nserver:/share on ${path} (nfs, remote)\n`);
    expect(() => assertLocalFilesystemType("darwin", 26, path.toUpperCase())).toThrow(FilesystemSafetyError);
  });

  it("rejects a directory without a matching mount entry", () => {
    mount.mockReturnValue("/dev/disk3s1s1 on / (apfs, local)\n");
    expect(() => assertLocalFilesystemType("darwin", 26, "/Volumes/not-mounted")).toThrow(FilesystemSafetyError);
  });


  it("fails closed when mount identity is unavailable or the path is not mounted", () => {
    mount.mockImplementation(() => { throw new Error("mount failed"); });
    expect(() => assertLocalFilesystemType("darwin", 26, directory())).toThrow(FilesystemSafetyError);
    mount.mockReturnValue("/dev/disk3s1s1 on / (apfs, local)\n");
    expect(() => assertLocalFilesystemType("darwin", 26, directory())).not.toThrow();
    expect(() => assertLocalFilesystemType("darwin", 26)).toThrow(FilesystemSafetyError);
  });

  it("leaves Linux numeric allowlist and fail-closed behavior unchanged", () => {
    expect(() => assertLocalFilesystemType("linux", 0xef53)).not.toThrow();
    expect(() => assertLocalFilesystemType("linux", 0x6969)).toThrow(FilesystemSafetyError);
    expect(() => assertLocalFilesystemType("linux", 0x12345678)).toThrow(FilesystemSafetyError);
  });
});
