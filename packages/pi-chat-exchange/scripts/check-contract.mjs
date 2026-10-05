#!/usr/bin/env node
/**
 * Static architecture gates for pi-chat-exchange (the package `check` script).
 *
 * Import/export edges are resolved from the TypeScript AST (import and export
 * declarations, dynamic import(), and require() calls) — not regexes — and
 * dependency direction is enforced TRANSITIVELY (through barrels):
 *
 *   protocol  <- core <- adapters <- bin      (arrows point at dependencies)
 *
 * 1. src/protocol must never reach src/core or src/adapters.
 * 2. src/core must never reach src/adapters.
 * 3. src/adapters/mcp and src/adapters/pi must never reach each other.
 * 4. protocol and core stay adapter/product neutral: no MCP SDK imports, no
 *    product/adapter tokens (identifiers or string literals).
 * 5. No Pi-runtime coupling anywhere: src must not import @earendil-works/*.
 * 6. No environment access on the MCP surface (src/adapters/mcp, src/bin).
 * 7. The MCP surface stays strictly the ping smoke: no capability operation
 *    may appear there, and the ping tool is the only registered tool.
 * 8. Runtime dependencies must be exactly pinned (no semver ranges).
 *
 * Negative fixtures in scripts/fixtures/*.fixture.ts prove the gate REJECTS
 * violations (each fixture declares its role and must trigger >= 1 rule).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(packageRoot, "src");
const errors = [];

const FORBIDDEN_EXTERNAL = /^@earendil-works\//;
const MCP_SDK = /^@modelcontextprotocol\//;
const PRODUCT_IDENTIFIER = /mcp|^pi(?:$|Session|Runtime|Provider|Conversation)|stdio|tunnel|chatgpt|openai|claude|codex|moshi|herdr|wayforge|sendusermessage/i;
const PRODUCT_STRING =
  /chatgpt|openai|claude|codex|modelcontextprotocol|@earendil-works|sendusermessage|moshi|herdr|wayforge|\bmcp\b|\bpi\b|piSession|\bstdio\b/i;

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else if (extname(entry) === ".ts") files.push(path);
  }
  return files;
}

/** Parse one file and collect module edges, external imports, and tokens. */
function analyze(path, roleDir) {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2023, true);
  const internal = [];
  const external = [];
  const envAccess = [];
  const importSpecifiers = new Set();

  const visit = (node) => {
    const specifier =
      (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : ts.isCallExpression(node) &&
            ((node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
              (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
              node.arguments.length === 1 &&
              ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : undefined;
    if (typeof specifier === "string") {
      importSpecifiers.add(specifier);
      if (specifier.startsWith(".")) {
        const resolved = resolveTs(roleDir, specifier);
        if (resolved) internal.push(resolved);
      } else {
        external.push(specifier);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "process" &&
      node.name.text === "env"
    ) {
      envAccess.push(true);
    }
    node.forEachChild(visit);
  };
  visit(source);

  const identifiers = [];
  const strings = [];
  const scanTokens = (node) => {
    if (ts.isIdentifier(node)) identifiers.push(node.text);
    else if (ts.isStringLiteral(node) && !importSpecifiers.has(node.text)) {
      // Module paths are not product semantics; only content strings are.
      strings.push(node.text);
    }
    node.forEachChild(scanTokens);
  };
  source.forEachChild(scanTokens);

  return { path, roleDir, internal, external, envAccess, identifiers, strings };
}

function resolveTs(fromDir, specifier) {
  const base = resolve(fromDir, specifier);
  const candidates = [base, `${base}.ts`];
  // TypeScript ESM sources import compiled ".js" paths that map to ".ts".
  if (/\.js$/.test(specifier)) candidates.push(base.replace(/\.js$/, ".ts"));
  candidates.push(join(base, "index.ts"));
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function relativePackage(path) {
  return path.slice(packageRoot.length + 1);
}

const srcFiles = walk(srcRoot);
const analyzed = srcFiles.map((path) => analyze(path, dirname(path)));
const edges = new Map(analyzed.map((file) => [file.path, file.internal]));

/** Transitive reachability through resolved (barrel-inclusive) edges. */
function reaches(fromPath, predicate, seen = new Set()) {
  for (const next of edges.get(fromPath) ?? []) {
    if (seen.has(next)) continue;
    seen.add(next);
    if (predicate(next)) return true;
    if (reaches(next, predicate, seen)) return true;
  }
  return false;
}

const isProtocol = (path) => path.startsWith(join(srcRoot, "protocol"));
const isCore = (path) => path.startsWith(join(srcRoot, "core"));
const isAdapters = (path) => path.startsWith(join(srcRoot, "adapters"));
const isMcp = (path) => path.startsWith(join(srcRoot, "adapters", "mcp"));
const isPi = (path) => path.startsWith(join(srcRoot, "adapters", "pi"));

function applyRules(file, bucket) {
  const label = relativePackage(file.path);
  const push = (message) => bucket.push(`${label}: ${message}`);
  for (const spec of file.external) {
    if (FORBIDDEN_EXTERNAL.test(spec)) {
      push("must not import @earendil-works/* (no Pi-runtime coupling)");
    }
    if (MCP_SDK.test(spec) && (isProtocol(file.path) || isCore(file.path) || file.roleDir === join(srcRoot, "protocol") || file.roleDir === join(srcRoot, "core"))) {
      push("protocol/core must not depend on the MCP SDK (adapter-neutral layers)");
    }
  }
  if (file.envAccess.length > 0 && (isMcp(file.path) || file.roleDir === join(srcRoot, "adapters", "mcp") || file.roleDir === join(srcRoot, "bin"))) {
    push("MCP surface must not access process.env");
  }
  if (isProtocol(file.path) || file.roleDir === join(srcRoot, "protocol")) {
    if (reaches(file.path, (target) => isCore(target) || isAdapters(target))) {
      push("protocol must not reach core or adapters (transitively, barrels included)");
    }
  }
  if (isCore(file.path) || file.roleDir === join(srcRoot, "core")) {
    if (reaches(file.path, (target) => isAdapters(target))) {
      push("core must not reach adapters (transitively, barrels included)");
    }
  }
  const inMcpRole = isMcp(file.path) || file.roleDir === join(srcRoot, "adapters", "mcp");
  const inPiRole = isPi(file.path) || file.roleDir === join(srcRoot, "adapters", "pi");
  if (inMcpRole && reaches(file.path, isPi)) {
    push("MCP adapter must not reach the Pi adapter");
  }
  if (inPiRole && reaches(file.path, isMcp)) {
    push("Pi adapter must not reach the MCP adapter");
  }
  if (isProtocol(file.path) || isCore(file.path) || file.roleDir === join(srcRoot, "protocol") || file.roleDir === join(srcRoot, "core")) {
    for (const identifier of file.identifiers) {
      if (PRODUCT_IDENTIFIER.test(identifier)) {
        push(`protocol/core must stay product/adapter neutral (identifier "${identifier}")`);
        break;
      }
    }
    for (const value of file.strings) {
      if (PRODUCT_STRING.test(value)) {
        push(`protocol/core must stay product/adapter neutral (string "${value.slice(0, 40)}")`);
        break;
      }
    }
  }
}

for (const file of analyzed) applyRules(file, errors);

// MCP surface stays strictly the ping smoke: no capability operation names on
// the MCP adapter, and the server registers exactly the ping tool.
const capabilitiesSource = readFileSync(join(srcRoot, "protocol", "capabilities.ts"), "utf8");
const capabilityOperations = [...capabilitiesSource.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
const mcpSources = analyzed.filter((file) => isMcp(file.path));
for (const operation of capabilityOperations) {
  for (const file of mcpSources) {
    if (file.strings.includes(operation)) {
      errors.push(`${relativePackage(file.path)}: MCP surface must not expose capability operation "${operation}" before the durable host exists`);
    }
  }
}
const serverSource = readFileSync(join(srcRoot, "adapters", "mcp", "server.ts"), "utf8");
if (!/tools:\s*\[\s*PING_TOOL\s*\]/.test(serverSource)) {
  errors.push("src/adapters/mcp/server.ts: the MCP surface must register exactly the ping tool");
}

// Runtime dependencies must be exactly pinned (no semver ranges).
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

// Negative fixtures: the same rules must REJECT each deliberately violating
// fixture; a fixture that no longer trips a rule means the gate rotted.
// Expected fixture violations do NOT fail the check — only real-src
// violations or a non-proving fixture do.
const fixturesDir = join(packageRoot, "scripts", "fixtures");
const provedFixtures = [];
if (existsSync(fixturesDir)) {
  for (const path of walk(fixturesDir)) {
    const firstLine = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    const role = /@role (\S+)/.exec(firstLine)?.[1];
    if (!role) {
      errors.push(`${relativePackage(path)}: fixture must declare "@role <src-subdir>"`);
      continue;
    }
    const roleDir = join(srcRoot, ...role.split("/"));
    const file = analyze(path, roleDir);
    edges.set(file.path, file.internal);
    const violations = [];
    applyRules(file, violations);
    if (violations.length === 0) {
      errors.push(`${relativePackage(path)}: negative fixture no longer proves rejection (0 violations)`);
    } else {
      provedFixtures.push(`${relativePackage(path)} -> ${violations.length} violation(s)`);
    }
  }
}

if (errors.length > 0) {
  console.error(`PI-CHAT-EXCHANGE CONTRACT VIOLATIONS (${errors.length}):`);
  for (const error of errors.sort()) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log("PI-CHAT-EXCHANGE CONTRACT OK: layering protocol<-core<-adapters, adapter separation, neutral protocol/core, no Pi coupling, ping-only MCP surface, pinned deps");
  for (const proof of provedFixtures.sort()) console.log(`  fixture rejected: ${proof}`);
}
