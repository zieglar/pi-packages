import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createNodeSqliteDriver } from "./sqlite-driver-node.js";
import { createRustNativeDriver } from "./sqlite-driver-rust.js";
import { loadVerifiedNativeArtifact } from "./native-artifact.js";
import { NATIVE_COMPAT, parseNativeCompat, type NativeCompat } from "./native-compat.js";
import type { SqliteDriver } from "./sqlite-driver.js";

export interface SqliteDriverSelection {
  readonly driver: "node-sqlite" | "rust-native";
  readonly nativeVersion?: string;
  /** Optional operator-owned compatibility manifest; useful for independently
   * versioned artifacts and isolated qualification. Absolute path required. */
  readonly manifestFile?: string;
}

export interface ResolveDriverOptions {
  readonly root?: string;
  readonly manifest?: NativeCompat;
  readonly selectionFile?: string;
}

export function defaultDriverSelectionFile(): string {
  return join(homedir(), ".config", "pi-chat-exchange", "sqlite-driver.json");
}

function invalidSelection(): never {
  throw Object.assign(new Error("invalid SQLite driver selection"), { code: "CE_SQLITE_DRIVER_SELECTION_INVALID" });
}

export function readDriverSelection(path = defaultDriverSelectionFile()): SqliteDriverSelection {
  // Native is the only production driver. An absent file selects it at the declared default
  // version; node-sqlite requires an explicit selection and is never a fallback.
  if (!existsSync(path)) return { driver: "rust-native", nativeVersion: NATIVE_COMPAT.defaultVersion };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return invalidSelection();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return invalidSelection();
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return invalidSelection();
  if (record.driver === "node-sqlite" && Object.keys(record).length === 2) return { driver: "node-sqlite" };
  if (record.driver === "rust-native" && typeof record.nativeVersion === "string"
    && (Object.keys(record).length === 3 || (Object.keys(record).length === 4 && typeof record.manifestFile === "string"))) {
    const manifestFile = record.manifestFile;
    if (manifestFile !== undefined && (typeof manifestFile !== "string" || !manifestFile.startsWith("/") || manifestFile.includes("\u0000"))) return invalidSelection();
    return { driver: "rust-native", nativeVersion: record.nativeVersion,
      ...(manifestFile === undefined ? {} : { manifestFile }) };
  }
  return invalidSelection();
}

/** Atomic replacement of the operator-selected driver file. */
export function writeDriverSelection(selection: SqliteDriverSelection, path = defaultDriverSelectionFile()): void {
  const directory = join(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const document = { version: 1, driver: selection.driver,
    ...(selection.nativeVersion === undefined ? {} : { nativeVersion: selection.nativeVersion }),
    ...(selection.manifestFile === undefined ? {} : { manifestFile: selection.manifestFile }) };
  const temporary = join(directory, `.sqlite-driver-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

/** Resolve the actual selected driver; never falls back after Native failure.
 * `node:sqlite` is a non-default compatibility driver: it is loaded lazily and only
 * when the operator explicitly selected it, so a Native deployment never imports it. */
export function resolveSqliteDriver(options: ResolveDriverOptions = {}): SqliteDriver {
  const selection = readDriverSelection(options.selectionFile);
  if (selection.driver === "node-sqlite") return createNodeSqliteDriver();
  let manifest = options.manifest ?? NATIVE_COMPAT;
  if (selection.manifestFile !== undefined) {
    try {
      manifest = parseNativeCompat(JSON.parse(readFileSync(selection.manifestFile, "utf8")));
    } catch {
      return invalidSelection();
    }
  }
  const verified = loadVerifiedNativeArtifact({
    ...(selection.nativeVersion === undefined ? {} : { version: selection.nativeVersion }),
    ...(options.root === undefined ? {} : { root: options.root }),
    manifest,
  });
  return createRustNativeDriver(createRequire(import.meta.url), verified.path);
}
