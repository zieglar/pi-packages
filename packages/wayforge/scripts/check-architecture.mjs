#!/usr/bin/env node
/**
 * Wayforge static architecture gates. Scans production TypeScript source and
 * fails with actionable file/line messages when an ownership boundary is
 * violated:
 *
 *   gate 1  exactly one `setModel(` callsite, located only in the Pi
 *           compatibility adapter (the sole parent-session mutation point);
 *   gate 2  no direct low-level `@earendil-works/pi-ai` transport imports;
 *   gate 3  Pi extension API imports only in the compatibility adapter, the
 *           extension entry, and the extension tool surface;
 *   gate 4  no adapter or recovery component declares forbidden lifecycle or
 *           fallback-loop authority (setModel, abort, retry, fallback,
 *           continueSession, ...);
 *   gate 5  exactly one runtime `new RecoveryCoordinator(` construction, in
 *           the workflow runtime factory (the sole recovery planner);
 *   gate 6  exactly one runtime `new HealthRegistry(` construction, in the
 *           workflow runtime factory (the sole cooldown boundary);
 *   gate 7  `new HealthProjector(` only in the workflow runtime factory;
 *   gate 8  `new PiCompatibilityAdapter(` and `new MainModelController(` only
 *           in the extension entry (the only place holding live Pi objects);
 *   gate 9  pi-subagents imports only through the public
 *           `pi-subagents/delegation` contract.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? join(process.cwd(), "src");
const ADAPTER_PATH = "runtime/pi-compatibility-adapter.ts";
const EXTENSION_PATHS = new Set([
  ADAPTER_PATH,
  "extension.ts",
  "runtime/extension-tools.ts",
]);
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const RUNTIME_FACTORY_PATH = "workflow/runtime-factory.ts";
const SET_MODEL_RE = /\bsetModel\s*\(/g;
const IMPORT_RE = /import\s[^;]*?from\s*["']([^"']+)["']/g;
const FORBIDDEN_MEMBER_RE =
  /\b(?:setModel|abort|retry|retryLoop|fallback|fallbackLoop|continueSession|resumeLoop)\s*[(:]/g;
const DELEGATION_EXPORT = "pi-subagents/delegation";

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

function countConstructor(content, name) {
  const pattern = new RegExp(`\\bnew\\s+${name}\\s*\\(`, "g");
  return [...content.matchAll(pattern)];
}

const files = listFiles(root);
const violations = [];
let setModelCount = 0;
const coordinatorSites = [];
const healthSites = [];
const projectorSites = [];
const adapterSites = [];
const mainControllerSites = [];

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

  // Gate 2, 3 & 9: import restrictions.
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? "";
    const line = lineOf(content, match.index ?? 0);
    if (specifier.startsWith("@earendil-works/pi-ai")) {
      violations.push(
        `${relPath}:${line}: direct low-level pi-ai import "${specifier}" is forbidden; use the Pi compatibility adapter`,
      );
    } else if (specifier.startsWith("pi-subagents") && specifier !== DELEGATION_EXPORT) {
      violations.push(
        `${relPath}:${line}: pi-subagents import "${specifier}" is forbidden; only the public "${DELEGATION_EXPORT}" contract may be used`,
      );
    } else if (
      (specifier === PI_PACKAGE || specifier.startsWith(`${PI_PACKAGE}/`)) &&
      !EXTENSION_PATHS.has(relPath)
    ) {
      violations.push(
        `${relPath}:${line}: Pi extension API import is only permitted in ${ADAPTER_PATH}, extension.ts, and runtime/extension-tools.ts`,
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

  // Gates 5-8: collect construction sites for the singleton owners.
  for (const match of countConstructor(content, "RecoveryCoordinator")) {
    coordinatorSites.push({ relPath, line: lineOf(content, match.index ?? 0) });
  }
  for (const match of countConstructor(content, "HealthRegistry")) {
    healthSites.push({ relPath, line: lineOf(content, match.index ?? 0) });
  }
  for (const match of countConstructor(content, "HealthProjector")) {
    projectorSites.push({ relPath, line: lineOf(content, match.index ?? 0) });
  }
  for (const match of countConstructor(content, "PiCompatibilityAdapter")) {
    adapterSites.push({ name: "PiCompatibilityAdapter", relPath, line: lineOf(content, match.index ?? 0) });
  }
  for (const match of countConstructor(content, "MainModelController")) {
    mainControllerSites.push({ name: "MainModelController", relPath, line: lineOf(content, match.index ?? 0) });
  }
}

// Gate 1 (global): exactly one setModel( callsite overall.
if (setModelCount !== 1) {
  violations.push(
    `<root>: expected exactly 1 setModel( callsite in production source, found ${setModelCount} (must be ${ADAPTER_PATH})`,
  );
}

// Gate 5: exactly one RecoveryCoordinator construction, in the runtime factory.
if (coordinatorSites.length !== 1 || coordinatorSites[0].relPath !== RUNTIME_FACTORY_PATH) {
  violations.push(
    `<root>: expected exactly 1 \`new RecoveryCoordinator(\` in ${RUNTIME_FACTORY_PATH}, found ${coordinatorSites.length}` +
      `${coordinatorSites.map((site) => ` [${site.relPath}:${site.line}]`).join("")}`,
  );
}

// Gate 6: exactly one HealthRegistry construction, in the runtime factory.
if (healthSites.length !== 1 || healthSites[0].relPath !== RUNTIME_FACTORY_PATH) {
  violations.push(
    `<root>: expected exactly 1 \`new HealthRegistry(\` in ${RUNTIME_FACTORY_PATH}, found ${healthSites.length}` +
      `${healthSites.map((site) => ` [${site.relPath}:${site.line}]`).join("")}`,
  );
}

// Gate 7: HealthProjector construction only in the runtime factory.
for (const site of projectorSites) {
  if (site.relPath !== RUNTIME_FACTORY_PATH) {
    violations.push(
      `${site.relPath}:${site.line}: \`new HealthProjector(\` is only permitted in ${RUNTIME_FACTORY_PATH} (sole health projection boundary)`,
    );
  }
}

// Gate 8: live-Pi component construction only in the extension entry.
for (const site of [...adapterSites, ...mainControllerSites]) {
  if (site.relPath !== "extension.ts") {
    violations.push(
      `${site.relPath}:${site.line}: \`new ${site.name}(\` is only permitted in extension.ts (live-Pi construction boundary)`,
    );
  }
}

if (violations.length > 0) {
  console.error(`ARCHITECTURE VIOLATIONS (${violations.length}):`);
  for (const violation of violations) {
    console.error(`  - ${violation}`);
  }
  process.exit(1);
}

console.log(`ARCHITECTURE OK: 9 gates passed (scanned ${files.length} files)`);
