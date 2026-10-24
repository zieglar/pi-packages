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
  compileOptions: ["THREADSAFE=1", "MUTEX_PTHREADS"],
  sqliteCapabilities: ["defensive", "statement-get", "statement-all", "statement-run", "transaction-state"],
};

describe("durable storage runtime eligibility", () => {
  it("pins the approved runtime and SQLite identities", () => {
    expect(APPROVED_NODE_VERSION).toBe(approved.nodeVersion);
    expect(APPROVED_SQLITE_VERSION).toBe(approved.sqliteVersion);
    expect(APPROVED_SQLITE_SOURCE_ID).toBe(approved.sqliteSourceId);
    expect(() => assertRuntimeEligibility(approved)).not.toThrow();
  });


  it("accepts only the second explicitly qualified Node patch", () => {
    expect(() => assertRuntimeEligibility({ ...approved, nodeVersion: "v24.22.1" })).not.toThrow();
    for (const nodeVersion of ["v24.22.0", "v24.22.2", "v24.23.0", "v25.2.1"]) {
      expect(() => assertRuntimeEligibility({ ...approved, nodeVersion })).toThrow(RuntimeEligibilityError);
    }
  });

  it.each([undefined, null, "THREADSAFE=1", [], ["THREADSAFE=0", "MUTEX_PTHREADS"], ["THREADSAFE=1"]])(
    "refuses missing, malformed or unsafe compile evidence %j", (compileOptions) => {
      expect(() => assertRuntimeEligibility({ ...approved, compileOptions } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );

  it.each(["OMIT_WAL", "OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_CHECK", "OMIT_COMPILEOPTION_DIAGS", "OMIT_WAL=1"])(
    "refuses SQLite compiled with %s", (option) => {
      expect(() => assertRuntimeEligibility({ ...approved, compileOptions: [...approved.compileOptions, option] })).toThrow(RuntimeEligibilityError);
    },
  );

  it.each([undefined, null, true, [], ["defensive"]])(
    "refuses incomplete SQLite API evidence %j", (sqliteCapabilities) => {
      expect(() => assertRuntimeEligibility({ ...approved, sqliteCapabilities } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );
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
    const identity = readRuntimeIdentity();
    expect(identity).toMatchObject({
      nodeVersion: process.version,
      sqliteVersion: APPROVED_SQLITE_VERSION,
      sqliteSourceId: APPROVED_SQLITE_SOURCE_ID,
      platform: process.platform,
      arch: process.arch,
    });
    expect(identity.compileOptions).toEqual(expect.arrayContaining([...approved.compileOptions]));
    expect(identity.sqliteCapabilities).toEqual(expect.arrayContaining([...approved.sqliteCapabilities]));
  });
});
