import { describe, expect, it } from "vitest";
import {
  APPROVED_NODE_VERSION,
  APPROVED_SQLITE_SOURCE_ID,
  APPROVED_SQLITE_VERSION,
  RuntimeEligibilityError,
  assertRuntimeEligibility,
  readRuntimeIdentity,
  type RuntimeIdentity,
} from "../../src/storage/runtime.js";

const approved: RuntimeIdentity = {
  nodeVersion: "v24.21.0",
  sqliteVersion: "3.53.4",
  sqliteSourceId:
    "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc",
  platform: "darwin",
  arch: "arm64",
};

describe("durable storage runtime eligibility", () => {
  it("pins the approved runtime and SQLite identities", () => {
    expect(APPROVED_NODE_VERSION).toBe(approved.nodeVersion);
    expect(APPROVED_SQLITE_VERSION).toBe(approved.sqliteVersion);
    expect(APPROVED_SQLITE_SOURCE_ID).toBe(approved.sqliteSourceId);
    expect(() => assertRuntimeEligibility(approved)).not.toThrow();
  });

  it.each([
    ["nodeVersion", "v24.21.1"],
    ["nodeVersion", "v25.0.0"],
    ["sqliteVersion", "3.53.5"],
    ["sqliteSourceId", `${approved.sqliteSourceId}-different`],
  ] as const)("rejects a mismatched %s", (field, value) => {
    expect(() => assertRuntimeEligibility({ ...approved, [field]: value })).toThrow(RuntimeEligibilityError);
  });

  it.each([
    ["darwin", "arm64"],
    ["linux", "x64"],
  ] as const)("accepts the supported %s/%s target", (platform, arch) => {
    expect(() => assertRuntimeEligibility({ ...approved, platform, arch })).not.toThrow();
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const)("rejects the unsupported %s/%s target", (platform, arch) => {
    expect(() => assertRuntimeEligibility({ ...approved, platform, arch })).toThrow(RuntimeEligibilityError);
  });

  it("reads the source identity from SQLite itself", () => {
    expect(readRuntimeIdentity()).toEqual({
      nodeVersion: APPROVED_NODE_VERSION,
      sqliteVersion: APPROVED_SQLITE_VERSION,
      sqliteSourceId: APPROVED_SQLITE_SOURCE_ID,
      platform: process.platform,
      arch: process.arch,
    });
  });
});
