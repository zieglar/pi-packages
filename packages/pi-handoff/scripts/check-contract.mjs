#!/usr/bin/env node
/**
 * Static contract gates for pi-handoff (the package `check` script).
 *
 * These gates exist so the frozen Phase 0/1 invariants survive refactors:
 * 1. No Pi-runtime coupling: src/ must not import @earendil-works/* packages
 *    (the smoke and protocol must remain usable without Pi internals).
 * 2. No environment access on the MCP surface: src/mcp and src/bin must not
 *    reference process.env (credential/secret leakage prevention).
 * 3. Surface ownership: the ChatGPT-facing tool list must not contain any
 *    internal consumer operation or forbidden mutation name.
 * 4. Runtime dependencies must be exactly pinned (no semver ranges).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

const CONSUMER_OPERATIONS = [
  "claim_next",
  "acknowledge",
  "heartbeat",
  "report_activity",
  "settle",
  "publish_result",
  "release",
];
const FORBIDDEN_MUTATIONS = ["submit_result", "mark_completed", "acknowledge_delivery"];

function* sourceFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if ([".ts", ".js", ".mjs"].includes(extname(entry))) yield path;
  }
}

const srcFiles = [...sourceFiles(join(packageRoot, "src"))];

for (const file of srcFiles) {
  const content = readFileSync(file, "utf8");
  const relative = file.slice(packageRoot.length + 1);
  if (/@earendil-works\//.test(content)) {
    errors.push(`${relative}: must not import @earendil-works/* (no Pi-runtime coupling in Phase 1)`);
  }
  if (/process\.env/.test(content) && (relative.startsWith("src/mcp/") || relative.startsWith("src/bin/"))) {
    errors.push(`${relative}: MCP surface must not access process.env`);
  }
}

const surfaces = readFileSync(join(packageRoot, "src", "protocol", "surfaces.ts"), "utf8");
const chatgptBlock = /export const CHATGPT_TOOLS = \[([^\]]*)\]/s.exec(surfaces);
if (!chatgptBlock) {
  errors.push("src/protocol/surfaces.ts: CHATGPT_TOOLS block not found");
} else {
  const tools = [...chatgptBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  for (const name of [...CONSUMER_OPERATIONS, ...FORBIDDEN_MUTATIONS]) {
    if (tools.includes(name)) {
      errors.push(`src/protocol/surfaces.ts: ChatGPT surface must not expose internal operation "${name}"`);
    }
  }
  if (tools.length !== 5) {
    errors.push(`src/protocol/surfaces.ts: expected exactly 5 ChatGPT tools, found ${tools.length}`);
  }
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
} catch (error) {
  console.error(`package.json: unreadable or malformed manifest: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    errors.push(`package.json: runtime dependency ${name} must be exactly pinned, found "${version}"`);
  }
}

if (errors.length > 0) {
  console.error(`PI-HANDOFF CONTRACT VIOLATIONS (${errors.length}):`);
  for (const error of errors.sort()) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log("PI-HANDOFF CONTRACT OK: no Pi coupling, no env access on MCP surface, surface ownership intact, deps pinned");
}
