import { DatabaseSync } from "node:sqlite";

export const APPROVED_NODE_VERSION = "v24.21.0";
export const APPROVED_SQLITE_VERSION = "3.53.4";
export const APPROVED_SQLITE_SOURCE_ID =
  "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";

export interface RuntimeIdentity {
  readonly nodeVersion: string;
  readonly sqliteVersion: string | undefined;
  readonly sqliteSourceId: string;
  readonly platform: string;
  readonly arch: string;
}

export class RuntimeEligibilityError extends Error {
  readonly code = "STORAGE_RUNTIME_INELIGIBLE";

  constructor(message: string) {
    super(message);
    this.name = "RuntimeEligibilityError";
  }
}

const SUPPORTED_TARGETS = new Set(["darwin/arm64", "linux/x64"]);

export function assertRuntimeEligibility(identity: RuntimeIdentity): void {
  if (identity.nodeVersion !== APPROVED_NODE_VERSION) {
    throw new RuntimeEligibilityError(
      `durable storage requires Node ${APPROVED_NODE_VERSION}; received ${identity.nodeVersion}`,
    );
  }
  if (identity.sqliteVersion !== APPROVED_SQLITE_VERSION) {
    throw new RuntimeEligibilityError(
      `durable storage requires SQLite ${APPROVED_SQLITE_VERSION}; received ${identity.sqliteVersion ?? "unavailable"}`,
    );
  }
  if (identity.sqliteSourceId !== APPROVED_SQLITE_SOURCE_ID) {
    throw new RuntimeEligibilityError("durable storage SQLite source identity is not approved");
  }
  const target = `${identity.platform}/${identity.arch}`;
  if (!SUPPORTED_TARGETS.has(target)) {
    throw new RuntimeEligibilityError(`durable storage does not support ${target}`);
  }
}

export function readRuntimeIdentity(): RuntimeIdentity {
  const probe = new DatabaseSync(":memory:");
  try {
    const row = probe.prepare("SELECT sqlite_source_id() AS sourceId").get() as
      | { sourceId?: unknown }
      | undefined;
    if (typeof row?.sourceId !== "string") {
      throw new RuntimeEligibilityError("SQLite did not return a source identity");
    }
    return {
      nodeVersion: process.version,
      sqliteVersion: process.versions.sqlite,
      sqliteSourceId: row.sourceId,
      platform: process.platform,
      arch: process.arch,
    };
  } finally {
    probe.close();
  }
}

export function assertHostRuntimeEligibility(): RuntimeIdentity {
  const identity = readRuntimeIdentity();
  assertRuntimeEligibility(identity);
  return identity;
}
