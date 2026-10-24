import { DatabaseSync } from "node:sqlite";

/** Legacy default, not the eligibility policy; use APPROVED_RUNTIME_TUPLES. */
export const APPROVED_NODE_VERSION = "v24.21.0";
export const APPROVED_SQLITE_VERSION = "3.53.4";
export const APPROVED_SQLITE_SOURCE_ID =
  "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";

/** Required SQLite capability labels. PARITY INVARIANT: every entry listed here
 * must be behaviorally verified in BOTH collectors — readRuntimeIdentity and the
 * NODE_PROBE subprocess battery — before either may report it as evidence. */
export const REQUIRED_SQLITE_CAPABILITIES = Object.freeze([
  "defensive", "statement-get", "statement-all", "statement-run", "transaction-state",
]);
const REQUIRED_COMPILE_OPTIONS = Object.freeze(["THREADSAFE=1", "MUTEX_PTHREADS"]);
const FORBIDDEN_COMPILE_OPTIONS = new Set(["OMIT_WAL", "OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_CHECK", "OMIT_COMPILEOPTION_DIAGS"]);
const SUPPORTED_TARGETS = Object.freeze(["darwin/arm64", "linux/x64"]);

/** Exact tuples only: no independent version sets that could admit cross-mixes. */
export const APPROVED_RUNTIME_TUPLES = Object.freeze(
  ["v24.21.0", "v24.22.1"].map((nodeVersion) => Object.freeze({
    nodeVersion,
    sqliteVersion: APPROVED_SQLITE_VERSION,
    sqliteSourceId: APPROVED_SQLITE_SOURCE_ID,
    requiredCompileOptions: REQUIRED_COMPILE_OPTIONS,
    requiredCapabilities: REQUIRED_SQLITE_CAPABILITIES,
    targets: SUPPORTED_TARGETS,
  })),
);

export interface RuntimeIdentity {
  readonly nodeVersion: string;
  readonly sqliteVersion: string | undefined;
  readonly sqliteSourceId: string;
  readonly platform: string;
  readonly arch: string;
  readonly compileOptions: readonly string[];
  readonly sqliteCapabilities: readonly string[];
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
  const tuple = APPROVED_RUNTIME_TUPLES.find((candidate) => candidate.nodeVersion === identity?.nodeVersion);
  if (tuple === undefined) {
    throw new RuntimeEligibilityError(
      `durable storage requires Node ${APPROVED_RUNTIME_TUPLES.map((candidate) => candidate.nodeVersion).join(" or ")}; received ${identity?.nodeVersion ?? "unavailable"}`,
    );
  }
  if (identity.sqliteVersion !== tuple.sqliteVersion) {
    throw new RuntimeEligibilityError(`durable storage requires SQLite ${tuple.sqliteVersion}; received ${identity.sqliteVersion ?? "unavailable"}`);
  }
  if (identity.sqliteSourceId !== tuple.sqliteSourceId) {
    throw new RuntimeEligibilityError("durable storage SQLite source identity is not approved");
  }
  if (!tuple.targets.includes(`${identity.platform}/${identity.arch}`)) {
    throw new RuntimeEligibilityError(`durable storage does not support ${identity.platform}/${identity.arch}`);
  }
  if (!stringArray(identity.compileOptions)
    || !tuple.requiredCompileOptions.every((option) => identity.compileOptions.includes(option))
    || identity.compileOptions.some((option) => FORBIDDEN_COMPILE_OPTIONS.has(option.split("=")[0] ?? ""))) {
    throw new RuntimeEligibilityError("durable storage SQLite compile options are unavailable or unsafe");
  }
  if (!stringArray(identity.sqliteCapabilities)
    || !tuple.requiredCapabilities.every((capability) => identity.sqliteCapabilities.includes(capability))) {
    throw new RuntimeEligibilityError("durable storage SQLite APIs are unavailable or unsafe");
  }
}

// Deliberate indirection: TypeScript narrows `database.isTransaction` boolean
// literal type at the first read; this wrapper keeps later re-reads boolean-typed
// after BEGIN/ROLLBACK mutations inside readRuntimeIdentity.
function transactionState(database: DatabaseSync): boolean {
  return database.isTransaction;
}

export function readRuntimeIdentity(): RuntimeIdentity {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(":memory:");
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
    if (transactionState(probe) !== true) throw new Error("transaction state unavailable");
    const written = probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(1);
    if (written.changes !== 1 || probe.prepare("SELECT value FROM runtime_probe").get()?.value !== 1
      || probe.prepare("SELECT value FROM runtime_probe").all().length !== 1) throw new Error("statement APIs unavailable");
    probe.exec("ROLLBACK");
    if (transactionState(probe) !== false) throw new Error("transaction state unavailable");
    return {
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      sqliteSourceId: row.sourceId,
      platform: process.platform,
      arch: process.arch,
      compileOptions,
      sqliteCapabilities: [...REQUIRED_SQLITE_CAPABILITIES],
    };
  } catch {
    throw new RuntimeEligibilityError("could not verify the required SQLite runtime identity and APIs");
  } finally {
    probe?.close();
  }
}

export function assertHostRuntimeEligibility(): RuntimeIdentity {
  const identity = readRuntimeIdentity();
  assertRuntimeEligibility(identity);
  return identity;
}
