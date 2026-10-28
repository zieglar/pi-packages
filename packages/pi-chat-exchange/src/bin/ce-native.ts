#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadVerifiedNativeArtifact, nativeCacheRoot, nativeTarget, prepareNativeArtifact } from "../storage/native-artifact.js";
import { NATIVE_COMPAT, parseNativeCompat, type NativeCompat } from "../storage/native-compat.js";
import { resolve } from "node:path";
import { defaultDriverSelectionFile, readDriverSelection, writeDriverSelection, type SqliteDriverSelection } from "../storage/sqlite-driver-selection.js";

interface Args {
  command: string;
  version?: string;
  root?: string;
  manifest?: NativeCompat;
  manifestFile?: string;
  selectionFile?: string;
}

function usage(): never {
  console.error("Usage: ce-native status | prepare [--version X] | select --driver node-sqlite|rust-native [--version X] [--root DIR] [--manifest FILE] [--selection FILE]");
  process.exit(2);
}

function readManifest(path: string): NativeCompat {
  try {
    return parseNativeCompat(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw Object.assign(new Error(`invalid Native compatibility manifest: ${path}`), { code: "CE_NATIVE_MANIFEST_INVALID" });
  }
}

function parse(argv: string[]): Args {
  const [command, ...rest] = argv;
  if (command === undefined) usage();
  const args: Args = { command };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) usage();
    if (flag === "--version") args.version = value;
    else if (flag === "--root") args.root = value;
    else if (flag === "--manifest") {
      args.manifest = readManifest(value);
      args.manifestFile = resolve(value);
    }
    else if (flag === "--selection") args.selectionFile = value;
    else if (flag === "--driver") args.command = `${command}:${value}`;
    else usage();
    i += 1;
  }
  return args;
}

function manifestOptions(args: Args, selectionManifestFile?: string) {
  const manifest = args.manifest ?? (selectionManifestFile === undefined ? undefined : readManifest(selectionManifestFile));
  return {
    ...(args.version === undefined ? {} : { version: args.version }),
    ...(args.root === undefined ? {} : { root: args.root }),
    ...(manifest === undefined ? {} : { manifest }),
  };
}

function status(args: Args): void {
  const selection = readDriverSelection(args.selectionFile);
  const result: Record<string, unknown> = {
    selectionFile: args.selectionFile ?? defaultDriverSelectionFile(),
    driver: selection.driver,
    nativeVersion: selection.nativeVersion ?? null,
    target: nativeTarget(),
    cacheRoot: args.root ?? nativeCacheRoot(),
  };
  if (selection.driver === "rust-native") {
    try {
      const verified = loadVerifiedNativeArtifact({ ...(selection.nativeVersion === undefined ? {} : { version: selection.nativeVersion }), ...manifestOptions(args, selection.manifestFile) });
      result.ready = true;
      result.native = verified.info;
    } catch (error) {
      result.ready = false;
      result.error = error instanceof Error && "code" in error ? error.code : "CE_NATIVE_LOAD_FAILED";
    }
  } else {
    result.ready = true;
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  if (args.command === "status") return status(args);
  if (args.command === "prepare") {
    const prepared = await prepareNativeArtifact(manifestOptions(args));
    console.log(JSON.stringify({ prepared: true, path: prepared.path, info: prepared.info }, null, 2));
    return;
  }
  if (args.command.startsWith("select:")) {
    const driver = args.command.slice("select:".length);
    if (driver !== "node-sqlite" && driver !== "rust-native") usage();
    const selection: SqliteDriverSelection = driver === "node-sqlite"
      ? { driver }
      : { driver, nativeVersion: args.version ?? (args.manifest ?? NATIVE_COMPAT).defaultVersion };
    if (driver === "rust-native") {
      if (args.root !== undefined && resolve(args.root) !== nativeCacheRoot()) {
        throw Object.assign(new Error("select requires the default runtime cache root; use --root only for prepare/status qualification"), { code: "CE_NATIVE_SELECTION_ROOT_INVALID" });
      }
      const verified = loadVerifiedNativeArtifact(manifestOptions(args));
      writeDriverSelection({ ...selection, ...(args.manifestFile === undefined ? {} : { manifestFile: args.manifestFile }) }, args.selectionFile);
      console.log(JSON.stringify({ selected: selection, native: verified.info }, null, 2));
    } else {
      writeDriverSelection(selection, args.selectionFile);
      console.log(JSON.stringify({ selected: selection }, null, 2));
    }
    return;
  }
  usage();
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error && "code" in error ? `${error.code}: ${error.message}` : String(error));
  process.exitCode = 1;
}
