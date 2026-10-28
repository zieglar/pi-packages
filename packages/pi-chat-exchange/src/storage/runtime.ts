import { resolveSqliteDriver } from "./sqlite-driver-selection.js";
import type { NativeModuleInfo, SqliteConnection, SqliteDriver } from "./sqlite-driver.js";
import { NATIVE_ABI_VERSION, NATIVE_DEFAULT_VERSION } from "./native-compat.js";
import { nativeTarget } from "./native-artifact.js";

/** Legacy release pins retained as diagnostics only; never the admission authority. */
export const APPROVED_NODE_VERSION = "v24.21.0";
export const APPROVED_SQLITE_VERSION = "3.53.4";
export const APPROVED_SQLITE_SOURCE_ID =
  "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";

/** Required SQLite capability labels. PARITY INVARIANT: every entry listed here
 * must be behaviorally verified in BOTH collectors — readRuntimeIdentity and the
 * NODE_PROBE subprocess battery — before either may report it as evidence. */
export const REQUIRED_SQLITE_CAPABILITIES = Object.freeze([
  "defensive", "statement-get", "statement-all", "statement-run", "transaction-state",
  "authorizer-transaction", "authorizer-savepoint",
  "transaction-commit", "strict-tables", "json-functions", "check-constraints",
  "foreign-key-enforcement", "triggers",
]);
const REQUIRED_COMPILE_OPTIONS = Object.freeze(["THREADSAFE=1", "MUTEX_PTHREADS"]);
const FORBIDDEN_COMPILE_OPTIONS = new Set(["OMIT_WAL", "OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_CHECK", "OMIT_COMPILEOPTION_DIAGS"]);
const SUPPORTED_TARGETS = Object.freeze(["darwin/arm64", "linux/x64"]);

/** Node builtin driver candidate range only; Rust uses Node-API instead. */
export const CANDIDATE_NODE_RANGE = Object.freeze({ minimum: "v24.12.0", majors: Object.freeze([24, 25, 26]) });
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
export function isCandidateNodeVersion(nodeVersion: string | undefined): boolean {
  const match = NODE_VERSION_PATTERN.exec(nodeVersion ?? "");
  if (match === null) return false;
  const [, major, minor, patch] = match;
  if (![major, minor, patch].every((part) => {
    const value = Number(part);
    return Number.isSafeInteger(value) && String(value) === part;
  })) return false;
  if (!(CANDIDATE_NODE_RANGE.majors as readonly number[]).includes(Number(major))) return false;
  return Number(major) !== 24 || Number(minor) >= Number(CANDIDATE_NODE_RANGE.minimum.split(".")[1]);
}

/** Discovery hints only, never the admission policy. */
export const MISE_DISCOVERY_NODE_VERSIONS = Object.freeze(["v24.21.0", "v24.22.0", "v24.22.1"]);

// Upstream-confirmed defect protection, NOT a locally reproduced corruption:
// https://sqlite.org/wal.html section 11. Affected: 3.7.0..3.51.2; fixed 3.51.3.
export const MINIMUM_SQLITE_VERSION = "3.51.3";
const SQLITE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
function meetsSqliteFloor(sqliteVersion: string | undefined): boolean {
  const match = SQLITE_VERSION_PATTERN.exec(sqliteVersion ?? "");
  if (match === null) return false;
  const [, major, minor, patch] = match;
  if (![major, minor, patch].every((part) => {
    const value = Number(part);
    return Number.isSafeInteger(value) && String(value) === part;
  })) return false;
  const floor = MINIMUM_SQLITE_VERSION.split(".").map(Number) as [number, number, number];
  const parts = [Number(major), Number(minor), Number(patch)];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! !== floor[index]!) return parts[index]! > floor[index]!;
  }
  return true;
}

/** Source identity is a well-formedness observation, never an exact allowlist. */
const SQLITE_SOURCE_ID_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [0-9a-f]{64}$/;

export interface RuntimeIdentity {
  readonly driver?: "node-sqlite" | "rust-native";
  readonly nodeVersion: string;
  readonly napiVersion?: string;
  readonly sqliteVersion: string | undefined;
  readonly sqliteSourceId: string;
  readonly platform: string;
  readonly arch: string;
  readonly compileOptions: readonly string[];
  readonly sqliteCapabilities: readonly string[];
  readonly native?: NativeModuleInfo;
}

export class RuntimeEligibilityError extends Error {
  readonly code = "STORAGE_RUNTIME_INELIGIBLE";
  constructor(message: string) {
    super(message);
    this.name = "RuntimeEligibilityError";
  }
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") && new Set(value).size === value.length;
}

export function assertRuntimeEligibility(identity: RuntimeIdentity): void {
  const driver = identity.driver ?? "node-sqlite";
  if (driver === "node-sqlite") {
    if (!isCandidateNodeVersion(identity.nodeVersion)) {
      throw new RuntimeEligibilityError(
        `durable storage requires Node >=${CANDIDATE_NODE_RANGE.minimum} within majors ${(CANDIDATE_NODE_RANGE.majors as readonly number[]).join("/")}; received ${identity.nodeVersion ?? "unavailable"}`,
      );
    }
    // Real isolated qualification reproduced SIGSEGV when a transaction callback
    // closes a connection with an active authorizer. Keep measured failures refused.
    if (identity.nodeVersion === "v24.19.0" || identity.nodeVersion === "v25.9.0") {
      throw new RuntimeEligibilityError("durable storage refuses this Node runtime: reproduced native transaction-close crash");
    }
  } else if (driver === "rust-native") {
    const napi = Number(identity.napiVersion ?? process.versions.napi);
    if (!Number.isSafeInteger(napi) || napi < 8) {
      throw new RuntimeEligibilityError(`Rust Native requires Node-API >= 8; received ${identity.napiVersion ?? "unavailable"}`);
    }
    const native = identity.native;
    if (native === undefined
      || native.abiVersion !== NATIVE_ABI_VERSION
      || native.middlewareVersion !== NATIVE_DEFAULT_VERSION
      || native.target !== nativeTarget()) {
      throw new RuntimeEligibilityError("Rust Native middleware version, ABI or target is not approved");
    }
  } else {
    throw new RuntimeEligibilityError("unknown SQLite driver");
  }
  if (!meetsSqliteFloor(identity.sqliteVersion)) {
    throw new RuntimeEligibilityError(
      `durable storage requires SQLite >=${MINIMUM_SQLITE_VERSION} (upstream WAL-reset corruption fix; https://sqlite.org/wal.html section 11); received ${identity.sqliteVersion ?? "unavailable"}`,
    );
  }
  if (!SQLITE_SOURCE_ID_PATTERN.test(identity.sqliteSourceId ?? "")) {
    throw new RuntimeEligibilityError("durable storage SQLite source identity is missing or malformed");
  }
  if (!SUPPORTED_TARGETS.includes(`${identity.platform}/${identity.arch}`)) {
    throw new RuntimeEligibilityError(`durable storage does not support ${identity.platform}/${identity.arch}`);
  }
  if (!stringArray(identity.compileOptions)
    || !REQUIRED_COMPILE_OPTIONS.every((option) => identity.compileOptions.includes(option))
    || identity.compileOptions.some((option) => FORBIDDEN_COMPILE_OPTIONS.has(option.split("=")[0] ?? ""))) {
    throw new RuntimeEligibilityError("durable storage SQLite compile options are unavailable or unsafe");
  }
  if (!stringArray(identity.sqliteCapabilities)
    || !REQUIRED_SQLITE_CAPABILITIES.every((capability) => identity.sqliteCapabilities.includes(capability))) {
    throw new RuntimeEligibilityError("durable storage SQLite APIs are unavailable or unsafe");
  }
}

/** Self-contained so the admitted child executes the same compiled probe body.
 * Keep this function free of module captures; only its connection argument is used. */
export function probeSqliteCapabilities(probe: SqliteConnection): Pick<RuntimeIdentity, "sqliteSourceId" | "compileOptions" | "sqliteCapabilities"> {
  // Require the expected SQLite result code: an unrelated busy/I/O failure
  // does not prove authorization or constraint enforcement.
  const rejectsWithCode = (write: () => unknown, expected: number): boolean => {
    try { write(); } catch (error) {
      return typeof error === "object" && error !== null && (error as { errcode?: unknown }).errcode === expected;
    }
    return false;
  };
  const active = (): boolean => probe.isTransaction;
  const row = probe.prepare("SELECT sqlite_source_id() AS sourceId").get();
  if (typeof row?.sourceId !== "string") throw new Error("missing SQLite source identity");
  const compileOptions = probe.prepare("PRAGMA compile_options").all().map((option) => {
    const value = Object.values(option)[0];
    if (typeof value !== "string") throw new Error("malformed SQLite compile option");
    return value;
  }).sort();
  probe.enableDefensive(true);
  probe.exec("PRAGMA writable_schema=ON");
  if (probe.prepare("PRAGMA writable_schema").get()?.writable_schema !== 0) throw new Error("defensive mode unavailable");
  probe.exec("CREATE TABLE runtime_probe (value INTEGER); BEGIN");
  if (active() !== true) throw new Error("transaction state unavailable");
  const written = probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(1);
  if (written.changes !== 1 || probe.prepare("SELECT value FROM runtime_probe").get()?.value !== 1
    || probe.prepare("SELECT value FROM runtime_probe").all().length !== 1) throw new Error("statement APIs unavailable");
  probe.exec("ROLLBACK");
  if (active() !== false) throw new Error("transaction state unavailable");
  // Parsed authorizer actions; preprepared statements must also be denied.
  const savepoint = probe.prepare("SAVEPOINT runtime_probe_sp");
  probe.setAuthorizerPolicy("deny-transaction-control");
  const transactionDenied = rejectsWithCode(() => probe.exec("BEGIN"), 23);
  const savepointDenied = rejectsWithCode(() => savepoint.run(), 23);
  probe.setAuthorizerPolicy("off");
  if (!transactionDenied || !savepointDenied || active() !== false) {
    throw new Error("authorizer transaction/savepoint denial unavailable");
  }
  probe.exec("BEGIN");
  probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(2);
  probe.exec("ROLLBACK");
  if (active() !== false || probe.prepare("SELECT COUNT(*) AS remaining FROM runtime_probe").get()?.remaining !== 0) {
    throw new Error("transaction reset/rollback unavailable");
  }
  // A committed row must remain visible after the transaction ends. Disk durability
  // is qualified separately; this in-memory probe cannot establish it.
  probe.exec("BEGIN");
  probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(3);
  probe.exec("COMMIT");
  if (active() !== false || probe.prepare("SELECT value FROM runtime_probe").get()?.value !== 3) {
    throw new Error("transaction commit unavailable");
  }
  // STRICT typing: a TEXT write into an INTEGER STRICT column must be denied
  // with SQLITE_CONSTRAINT_DATATYPE.
  probe.exec("CREATE TABLE runtime_probe_strict (value INTEGER) STRICT");
  if (!rejectsWithCode(() => probe.prepare("INSERT INTO runtime_probe_strict VALUES (?)").run("text"), 3091)) {
    throw new Error("STRICT table enforcement unavailable");
  }
  // JSON1 functions are required by the durable schema.
  if (probe.prepare("SELECT json_extract('{\"ce\":1}', '$.ce') AS extracted").get()?.extracted !== 1) {
    throw new Error("JSON functions unavailable");
  }
  // CHECK constraints: violation denied with the expected extended code.
  probe.exec("CREATE TABLE runtime_probe_check (value INTEGER CHECK (value > 0))");
  if (!rejectsWithCode(() => probe.prepare("INSERT INTO runtime_probe_check VALUES (0)").run(), 275)
    || probe.prepare("INSERT INTO runtime_probe_check VALUES (1)").run().changes !== 1) {
    throw new Error("CHECK constraint enforcement unavailable");
  }
  // Foreign-key enforcement: orphan insert and referenced-parent delete denied.
  probe.exec("PRAGMA foreign_keys=ON");
  probe.exec("CREATE TABLE runtime_probe_parent (id INTEGER PRIMARY KEY); CREATE TABLE runtime_probe_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES runtime_probe_parent(id))");
  if (!rejectsWithCode(() => probe.prepare("INSERT INTO runtime_probe_child VALUES (1, 9)").run(), 787)) {
    throw new Error("foreign-key enforcement unavailable");
  }
  probe.prepare("INSERT INTO runtime_probe_parent VALUES (9)").run();
  probe.prepare("INSERT INTO runtime_probe_child VALUES (2, 9)").run();
  if (!rejectsWithCode(() => probe.prepare("DELETE FROM runtime_probe_parent WHERE id = 9").run(), 787)) {
    throw new Error("foreign-key enforcement unavailable");
  }
  // Triggers: an AFTER INSERT trigger must fire and persist its effect.
  probe.exec("CREATE TABLE runtime_probe_log (value INTEGER); CREATE TRIGGER runtime_probe_trigger AFTER INSERT ON runtime_probe BEGIN INSERT INTO runtime_probe_log VALUES (NEW.value); END");
  probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(4);
  if (probe.prepare("SELECT value FROM runtime_probe_log").get()?.value !== 4) {
    throw new Error("trigger execution unavailable");
  }
  return { sqliteSourceId: row.sourceId, compileOptions, sqliteCapabilities: [
    "defensive", "statement-get", "statement-all", "statement-run", "transaction-state",
    "authorizer-transaction", "authorizer-savepoint",
    "transaction-commit", "strict-tables", "json-functions", "check-constraints",
    "foreign-key-enforcement", "triggers",
  ] };
}

export function readRuntimeIdentity(driver: SqliteDriver = resolveSqliteDriver()): RuntimeIdentity {
  let probe: SqliteConnection | undefined;
  try {
    probe = driver.open(":memory:");
    const identity: RuntimeIdentity = {
      ...probeSqliteCapabilities(probe),
      driver: driver.kind,
      nodeVersion: process.version,
      ...(process.versions.napi === undefined ? {} : { napiVersion: process.versions.napi }),
      sqliteVersion: driver.kind === "node-sqlite" ? process.versions.sqlite : driver.nativeInfo?.sqliteVersion,
      platform: process.platform,
      arch: process.arch,
      ...(driver.nativeInfo === undefined ? {} : { native: driver.nativeInfo }),
    };
    return identity;
  } catch {
    throw new RuntimeEligibilityError("could not verify the required SQLite runtime identity and APIs");
  } finally {
    probe?.close();
  }
}

export function assertHostRuntimeEligibility(driver?: SqliteDriver): RuntimeIdentity {
  const identity = readRuntimeIdentity(driver);
  assertRuntimeEligibility(identity);
  return identity;
}
