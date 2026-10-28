import { DatabaseSync } from "node:sqlite";

/** Minimum candidate Node version; SQLite identity and behavior also qualify. */
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
]);
const REQUIRED_COMPILE_OPTIONS = Object.freeze(["THREADSAFE=1", "MUTEX_PTHREADS"]);
const FORBIDDEN_COMPILE_OPTIONS = new Set(["OMIT_WAL", "OMIT_FOREIGN_KEY", "OMIT_TRIGGER", "OMIT_CHECK", "OMIT_COMPILEOPTION_DIAGS"]);
const SUPPORTED_TARGETS = Object.freeze(["darwin/arm64", "linux/x64"]);

/** Candidate Node range: >=v24.21.0 <v25. Every candidate must still carry the
 * exact approved SQLite identity below; the range admits no SQLite cross-mix. */
export const CANDIDATE_NODE_RANGE = Object.freeze({ minimum: APPROVED_NODE_VERSION, exclusiveBound: "v25.0.0" });
const NODE_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
export function isCandidateNodeVersion(nodeVersion: string | undefined): boolean {
  const match = NODE_VERSION_PATTERN.exec(nodeVersion ?? "");
  if (match === null) return false;
  const [, major, minor, patch] = match;
  // Canonical decimal parts only: rejects leading zeros and unsafe integers.
  if (![major, minor, patch].every((part) => {
    const value = Number(part);
    return Number.isSafeInteger(value) && String(value) === part;
  })) return false;
  return Number(major) === 24 && Number(minor) >= 21;
}

/** Discovery hints only, never the admission policy; range admission decides. */
export const MISE_DISCOVERY_NODE_VERSIONS = Object.freeze(["v24.21.0", "v24.22.0", "v24.22.1"]);

/** The single approved SQLite identity shared by every candidate Node. */
export const APPROVED_SQLITE_IDENTITY = Object.freeze({
  sqliteVersion: APPROVED_SQLITE_VERSION,
  sqliteSourceId: APPROVED_SQLITE_SOURCE_ID,
  requiredCompileOptions: REQUIRED_COMPILE_OPTIONS,
  requiredCapabilities: REQUIRED_SQLITE_CAPABILITIES,
  targets: SUPPORTED_TARGETS,
});

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
  if (!isCandidateNodeVersion(identity?.nodeVersion)) {
    throw new RuntimeEligibilityError(
      `durable storage requires Node >=${CANDIDATE_NODE_RANGE.minimum} and <${CANDIDATE_NODE_RANGE.exclusiveBound}; received ${identity?.nodeVersion ?? "unavailable"}`,
    );
  }
  const approved = APPROVED_SQLITE_IDENTITY;
  if (identity.sqliteVersion !== approved.sqliteVersion) {
    throw new RuntimeEligibilityError(`durable storage requires SQLite ${approved.sqliteVersion}; received ${identity.sqliteVersion ?? "unavailable"}`);
  }
  if (identity.sqliteSourceId !== approved.sqliteSourceId) {
    throw new RuntimeEligibilityError("durable storage SQLite source identity is not approved");
  }
  if (!approved.targets.includes(`${identity.platform}/${identity.arch}`)) {
    throw new RuntimeEligibilityError(`durable storage does not support ${identity.platform}/${identity.arch}`);
  }
  if (!stringArray(identity.compileOptions)
    || !approved.requiredCompileOptions.every((option) => identity.compileOptions.includes(option))
    || identity.compileOptions.some((option) => FORBIDDEN_COMPILE_OPTIONS.has(option.split("=")[0] ?? ""))) {
    throw new RuntimeEligibilityError("durable storage SQLite compile options are unavailable or unsafe");
  }
  if (!stringArray(identity.sqliteCapabilities)
    || !approved.requiredCapabilities.every((capability) => identity.sqliteCapabilities.includes(capability))) {
    throw new RuntimeEligibilityError("durable storage SQLite APIs are unavailable or unsafe");
  }
}


/** Self-contained so the admitted child executes the same compiled probe body.
 * Keep this function free of module captures; only its DatabaseSync argument is used. */
export function probeSqliteCapabilities(probe: DatabaseSync): Pick<RuntimeIdentity, "sqliteSourceId" | "compileOptions" | "sqliteCapabilities"> {
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
  // SQLite's stable authorization codes: SQLITE_TRANSACTION=22, SQLITE_SAVEPOINT=32,
  // SQLITE_DENY=1, SQLITE_OK=0. Preprepared statements must also be denied.
  const savepoint = probe.prepare("SAVEPOINT runtime_probe_sp");
  probe.setAuthorizer((action) => (action === 22 || action === 32 ? 1 : 0));
  let transactionDenied = false;
  try { probe.exec("BEGIN"); } catch { transactionDenied = true; }
  let savepointDenied = false;
  try { savepoint.run(); } catch { savepointDenied = true; }
  probe.setAuthorizer(null);
  if (!transactionDenied || !savepointDenied || active() !== false) {
    throw new Error("authorizer transaction/savepoint denial unavailable");
  }
  probe.exec("BEGIN");
  probe.prepare("INSERT INTO runtime_probe VALUES (?)").run(2);
  probe.exec("ROLLBACK");
  if (active() !== false || probe.prepare("SELECT COUNT(*) AS remaining FROM runtime_probe").get()?.remaining !== 0) {
    throw new Error("transaction reset/rollback unavailable");
  }
  return { sqliteSourceId: row.sourceId, compileOptions, sqliteCapabilities: [
    "defensive", "statement-get", "statement-all", "statement-run", "transaction-state",
    "authorizer-transaction", "authorizer-savepoint",
  ] };
}

export function readRuntimeIdentity(): RuntimeIdentity {
  let probe: DatabaseSync | undefined;
  try {
    probe = new DatabaseSync(":memory:");
    return { ...probeSqliteCapabilities(probe), nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite, platform: process.platform, arch: process.arch };
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
