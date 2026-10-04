#!/usr/bin/env node
/**
 * Wayforge static architecture gates. Scans production TypeScript source and
 * fails with actionable file/line messages when an ownership boundary is
 * violated:
 *
 *   gate 1  exactly one `setModel(` callsite, located only in the Pi
 *           compatibility adapter (the sole parent-session mutation point);
 *   gate 2  no direct low-level `@earendil-works/pi-ai` transport imports;
 *   gate 3  Pi extension API imports only in the compatibility adapter and
 *           the inert extension entry;
 *   gate 4  no adapter or recovery component declares forbidden lifecycle or
 *           fallback-loop authority (setModel, abort, retry, fallback,
 *           continueSession, ...).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? join(process.cwd(), "src");
const ADAPTER_PATH = "runtime/pi-compatibility-adapter.ts";
const EXTENSION_PATHS = new Set([ADAPTER_PATH, "extension.ts"]);
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const SET_MODEL_RE = /\bsetModel\s*\(/g;
const IMPORT_RE = /import\s[^;]*?from\s*["']([^"']+)["']/g;
const FORBIDDEN_MEMBER_RE =
  /\b(?:setModel|abort|retry|retryLoop|fallback|fallbackLoop|continueSession|resumeLoop)\s*[(:]/g;

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      out.push(...listFiles(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

function rel(path) {
  return relative(root, path).split(sep).join("/");
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

const files = listFiles(root);
const violations = [];
let setModelCount = 0;

for (const file of files) {
  const relPath = rel(file);
  const content = readFileSync(file, "utf8");

  // Gate 1: setModel( callsites.
  for (const match of content.matchAll(SET_MODEL_RE)) {
    setModelCount += 1;
    if (relPath !== ADAPTER_PATH) {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: setModel( is only permitted in ${ADAPTER_PATH}`,
      );
    }
  }

  // Gate 2 & 3: import restrictions.
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? "";
    const line = lineOf(content, match.index ?? 0);
    if (specifier.startsWith("@earendil-works/pi-ai")) {
      violations.push(
        `${relPath}:${line}: direct low-level pi-ai import "${specifier}" is forbidden; use the Pi compatibility adapter`,
      );
    } else if (
      (specifier === PI_PACKAGE || specifier.startsWith(`${PI_PACKAGE}/`)) &&
      !EXTENSION_PATHS.has(relPath)
    ) {
      violations.push(
        `${relPath}:${line}: Pi extension API import is only permitted in ${ADAPTER_PATH} and extension.ts`,
      );
    }
  }

  // Gate 4: forbidden lifecycle/fallback authority in adapters and recovery.
  if (relPath.startsWith("adapters/") || relPath.startsWith("recovery/")) {
    for (const match of content.matchAll(FORBIDDEN_MEMBER_RE)) {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: forbidden lifecycle/fallback member "${match[0].replace(/\s*[(:]$/, "")}" in adapter or recovery component`,
      );
    }
  }
}

// Gate 1 (global): exactly one setModel( callsite overall.
if (setModelCount !== 1) {
  violations.push(
    `<root>: expected exactly 1 setModel( callsite in production source, found ${setModelCount} (must be ${ADAPTER_PATH})`,
  );
}

if (violations.length > 0) {
  console.error(`ARCHITECTURE VIOLATIONS (${violations.length}):`);
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(`ARCHITECTURE OK: 4 gates passed (scanned ${files.length} files)`);
