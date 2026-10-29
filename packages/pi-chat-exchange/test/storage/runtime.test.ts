import { describe, expect, it } from "vitest";
import {
  APPROVED_NODE_VERSION,
  APPROVED_SQLITE_SOURCE_ID,
  APPROVED_SQLITE_VERSION,
  CANDIDATE_NODE_RANGE,
  MINIMUM_SQLITE_VERSION,
  REQUIRED_SQLITE_CAPABILITIES,
  RuntimeEligibilityError,
  assertRuntimeEligibility,
  readRuntimeIdentity,
  type RuntimeIdentity,
} from "../../src/storage/runtime.js";
import { nativeTarget } from "../../src/storage/native-artifact.js";

// Every required capability label; the collectors must prove each behaviorally.
const REQUIRED_CAPABILITIES = [
  "defensive", "statement-get", "statement-all", "statement-run", "transaction-state",
  "authorizer-transaction", "authorizer-savepoint",
  "transaction-commit", "strict-tables", "json-functions", "check-constraints",
  "foreign-key-enforcement", "triggers",
];
const SQLITE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SQLITE_SOURCE_ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{64}$/;

const eligible: RuntimeIdentity = {
  nodeVersion: "v24.21.0",
  sqliteVersion: "3.53.4",
  sqliteSourceId:
    "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc",
  platform: "darwin",
  arch: "arm64",
  compileOptions: ["THREADSAFE=1", "MUTEX_PTHREADS"],
  sqliteCapabilities: REQUIRED_CAPABILITIES,
};

describe("durable storage runtime eligibility", () => {
  it.each(["v22.19.0", "v24.19.0", "v25.2.1", "v25.9.0", "v26.12.1"])(
    "Native admits Pi-supported %s without the built-in SQLite version exclusions", (nodeVersion) => {
      expect(() => assertRuntimeEligibility({
        ...eligible, driver: "rust-native", nodeVersion, napiVersion: "10",
        native: { abiVersion: 1, middlewareVersion: "0.1.0", target: nativeTarget(),
          sqliteVersion: "3.54.1", sqliteSourceId: eligible.sqliteSourceId,
          buildId: "qualification", rustc: "qualification" },
      })).not.toThrow();
    },
  );
  it.each(["v22.18.0", "v20.99.0", "v22.19.0-rc.1", "v022.19.0", "22.19.0"])(
    "Native refuses %s below or outside the declared Pi Host floor", (nodeVersion) => {
      expect(() => assertRuntimeEligibility({
        ...eligible, driver: "rust-native", nodeVersion, napiVersion: "10",
      })).toThrow(/Pi Host requires/);
    },
  );
  it("retains the legacy pins as diagnostics, never as the admission authority", () => {
    expect(APPROVED_NODE_VERSION).toBe("v24.21.0");
    expect(APPROVED_SQLITE_VERSION).toBe("3.53.4");
    expect(APPROVED_SQLITE_SOURCE_ID).toBe(eligible.sqliteSourceId);
    expect(CANDIDATE_NODE_RANGE).toEqual({ minimum: "v24.12.0", majors: [24, 25, 26] });
    expect(REQUIRED_SQLITE_CAPABILITIES).toEqual(expect.arrayContaining(REQUIRED_CAPABILITIES));
    expect(() => assertRuntimeEligibility(eligible)).not.toThrow();
  });

  it("accepts a different well-formed SQLite version/source as observations, not identity", () => {
    const observed: RuntimeIdentity = {
      ...eligible,
      nodeVersion: "v26.12.1",
      sqliteVersion: "3.54.0",
      sqliteSourceId: "2025-01-18 00:00:00 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    };
    expect(() => assertRuntimeEligibility(observed)).not.toThrow();
  });

  it.each(["v24.19.0", "v25.9.0"])("refuses %s with reproduced native transaction-close crashes", (nodeVersion) => {
    expect(() => assertRuntimeEligibility({ ...eligible, nodeVersion })).toThrow(/native transaction-close crash/);
  });

  // Upstream-confirmed WAL-reset corruption (https://sqlite.org/wal.html section 11):
  // SQLite 3.7.0..3.51.2 affected under CE's WAL/multiprocess/autocheckpoint
  // preconditions; fixed in 3.51.3. Backports 3.50.7/3.44.6 conservatively excluded.
  it("pins the SQLite safety floor protecting against the upstream WAL-reset defect", () => {
    expect(MINIMUM_SQLITE_VERSION).toBe("3.51.3");
  });

  it.each(["3.50.4", "3.51.2", "3.50.0", "3.44.6", "3.50.7", "3.7.0", "2.99.99"])(
    "refuses affected SQLite %s even with complete behavioral evidence", (sqliteVersion) => {
      expect(() => assertRuntimeEligibility({ ...eligible, sqliteVersion })).toThrow(RuntimeEligibilityError);
    },
  );

  it.each(["3.51.3", "3.51.4", "3.52.0", "3.53.4", "3.54.0", "4.0.0"])(
    "admits SQLite %s at or above the upstream fix with complete behavioral evidence", (sqliteVersion) => {
      expect(() => assertRuntimeEligibility({ ...eligible, sqliteVersion })).not.toThrow();
    },
  );

  it.each(["v24.12.0", "v24.12.1", "v24.21.0", "v24.22.1", "v24.999.999", "v25.0.0", "v25.2.1", "v26.0.0", "v26.12.1"])(
    "admits candidate %s with complete behavioral SQLite evidence", (nodeVersion) => {
      expect(() => assertRuntimeEligibility({ ...eligible, nodeVersion })).not.toThrow();
      expect(() => assertRuntimeEligibility({ ...eligible, nodeVersion, sqliteSourceId: "wrong" })).toThrow(RuntimeEligibilityError);
    },
  );

  it.each(["v24.11.9", "v22.19.0", "v22.14.0", "v23.0.0", "v23.99.0", "v27.0.0", "v28.1.0", "24.21.0", "v24.021.0", "v24.21.0-rc.1", "v24.21.0+custom", "v24.21.0\n", "v24.9007199254740992.0"])(
    "refuses noncandidate %j", (nodeVersion) => {
      expect(() => assertRuntimeEligibility({ ...eligible, nodeVersion })).toThrow(RuntimeEligibilityError);
    },
  );

  it.each([undefined, "", "unapproved", "3.53", "3.53.4.1", "3.53.4-rc1", "v3.53.4"])(
    "refuses a missing or malformed SQLite version observation %j", (sqliteVersion) => {
      expect(() => assertRuntimeEligibility({ ...eligible, sqliteVersion } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );

  it.each([undefined, "", "wrong", "2026-07-24 19:02:57", "2026-07-24 19:02:57 bf7c7f30", "2026-07-24T19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc", "2026-07-24 19:02:57 BF7C7F30031888F4E796E429AB3978879485813AACA6F641C7B33E4E09459BCC"])(
    "refuses a missing or malformed SQLite source identity %j", (sqliteSourceId) => {
      expect(() => assertRuntimeEligibility({ ...eligible, sqliteSourceId } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );

  it.each(REQUIRED_CAPABILITIES)("requires %s evidence", (missing) => {
    expect(() => assertRuntimeEligibility({ ...eligible, sqliteCapabilities: eligible.sqliteCapabilities.filter((label) => label !== missing) })).toThrow(RuntimeEligibilityError);
  });

  it.each([undefined, null, "THREADSAFE=1", [], ["THREADSAFE=0", "MUTEX_PTHREADS"], ["THREADSAFE=1"]])(
    "refuses missing, malformed or unsafe compile evidence %j", (compileOptions) => {
      expect(() => assertRuntimeEligibility({ ...eligible, compileOptions } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );

  it.each(["OMIT_WAL", "OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_CHECK", "OMIT_COMPILEOPTION_DIAGS", "OMIT_WAL=1"])(
    "refuses SQLite compiled with %s", (option) => {
      expect(() => assertRuntimeEligibility({ ...eligible, compileOptions: [...eligible.compileOptions, option] })).toThrow(RuntimeEligibilityError);
    },
  );

  it.each([undefined, null, true, [], ["defensive"]])(
    "refuses incomplete SQLite API evidence %j", (sqliteCapabilities) => {
      expect(() => assertRuntimeEligibility({ ...eligible, sqliteCapabilities } as unknown as RuntimeIdentity)).toThrow(RuntimeEligibilityError);
    },
  );

  it.each([
    ["darwin", "arm64"],
    ["linux", "x64"],
  ] as const)("accepts the supported %s/%s target", (platform, arch) => {
    expect(() => assertRuntimeEligibility({ ...eligible, platform, arch })).not.toThrow();
  });

  it.each([
    ["darwin", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const)("rejects the unsupported %s/%s target", (platform, arch) => {
    expect(() => assertRuntimeEligibility({ ...eligible, platform, arch })).toThrow(RuntimeEligibilityError);
  });

  it("observes the actual runtime identity and proves the required behaviors", () => {
    const identity = readRuntimeIdentity();
    expect(identity.nodeVersion).toBe(process.version);
    expect(identity.platform).toBe(process.platform);
    expect(identity.arch).toBe(process.arch);
    expect(identity.sqliteVersion).toMatch(SQLITE_VERSION_PATTERN);
    expect(identity.sqliteSourceId).toMatch(SQLITE_SOURCE_ID_PATTERN);
    expect(identity.compileOptions).toEqual(expect.arrayContaining([...eligible.compileOptions]));
    expect(identity.sqliteCapabilities).toEqual(expect.arrayContaining(REQUIRED_CAPABILITIES));
  });
});
