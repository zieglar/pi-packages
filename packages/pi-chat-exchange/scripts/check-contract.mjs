#!/usr/bin/env node
/**
 * Static architecture gates for pi-chat-exchange (the package `check` script).
 *
 * Import/export edges are resolved from the TypeScript AST (import and export
 * declarations, dynamic import(), and require() calls) — not regexes — and
 * dependency direction is enforced TRANSITIVELY (through barrels):
 *
 *   protocol <- core <- private storage/control/endpoints <- bin
 *
 * 1. Protocol/core cannot reach private storage, filesystem/SQLite drivers,
 *    outer layers, or composition, transitively.
 * 2. Private storage cannot reach control surfaces, endpoint integrations, or bin.
 * 3. The public package barrel cannot expose private storage transitively.
 * 4. Control surfaces and endpoint integrations cannot reach each other.
 * 5. One endpoint integration cannot depend on a different endpoint integration.
 * 6. Protocol/core stay product-neutral and free of transport SDK dependencies.
 * 7. Endpoint integrations cannot require MCP SDK; no runtime Pi coupling here.
 * 8. MCP control/bin remain environment-free; control is ping-only by default
 *    and gains messaging tools ONLY through the injected, endpoint-bound port
 *    defined in control/mcp/messaging-tools.ts (never storage/host imports).
 *    The host layer (src/host) is authority-only: environment-free, MCP-SDK-free,
 *    and it never reaches control, endpoint, or composition layers.
 * 9. Runtime dependencies must be exactly pinned.
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
const STORAGE_DRIVER = /^node:(?:fs|fs\/promises|sqlite)$/;
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
const isStorage = (path) => path.startsWith(join(srcRoot, "storage") + "/");
const isControl = (path) => path.startsWith(join(srcRoot, "control") + "/");
const isEndpoints = (path) => path.startsWith(join(srcRoot, "endpoints") + "/");
const isBin = (path) => path.startsWith(join(srcRoot, "bin") + "/");
const isHost = (path) => path.startsWith(join(srcRoot, "host") + "/");
const isOuter = (path) => isStorage(path) || isControl(path) || isEndpoints(path) || isBin(path) || isHost(path);
const isMcp = (path) => path.startsWith(join(srcRoot, "control", "mcp") + "/");

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
    if (
      STORAGE_DRIVER.test(spec) &&
      (isProtocol(file.path) ||
        isCore(file.path) ||
        file.roleDir === join(srcRoot, "protocol") ||
        file.roleDir === join(srcRoot, "core"))
    ) {
      push("protocol/core must not depend on filesystem or SQLite storage drivers");
    }
  }
  if (file.envAccess.length > 0 && (isMcp(file.path) || file.roleDir === join(srcRoot, "control", "mcp") || file.roleDir === join(srcRoot, "bin"))) {
    push("MCP surface must not access process.env");
  }
  if (isProtocol(file.path) || file.roleDir === join(srcRoot, "protocol")) {
    if (reaches(file.path, (target) => isCore(target) || isOuter(target))) {
      push("protocol must not reach core or outer layers (transitively, barrels included)");
    }
  }
  if (isCore(file.path) || file.roleDir === join(srcRoot, "core")) {
    if (reaches(file.path, isOuter)) {
      push("core must not reach outer layers (transitively, barrels included)");
    }
  }
  const inStorageRole =
    isStorage(file.path) ||
    file.roleDir === join(srcRoot, "storage") ||
    file.roleDir.startsWith(join(srcRoot, "storage") + "/");
  if (inStorageRole) {
    if (reaches(file.path, (target) => isControl(target) || isEndpoints(target) || isBin(target))) {
      push("private storage must not reach control, endpoint, or composition layers");
    }
    if (file.external.some((spec) => MCP_SDK.test(spec) || FORBIDDEN_EXTERNAL.test(spec))) {
      push("private storage must not depend on MCP or Pi runtime packages");
    }
  }
  if (
    (file.path === join(srcRoot, "index.ts") || file.roleDir === srcRoot) &&
    reaches(file.path, isStorage)
  ) {
    push("the public package barrel must not expose private storage");
  }
  const inControlRole = isControl(file.path) || file.roleDir.startsWith(join(srcRoot, "control") + "/");
  const inEndpointRole = isEndpoints(file.path) || file.roleDir.startsWith(join(srcRoot, "endpoints") + "/");
  if (inControlRole && reaches(file.path, (target) => isEndpoints(target) || isBin(target))) {
    push("control surface must not reach endpoint integrations or composition");
  }
  if (inEndpointRole && reaches(file.path, (target) => isControl(target) || isBin(target))) {
    push("endpoint integration must not reach control surfaces or composition");
  }
  if (inEndpointRole) {
    if (file.external.some((spec) => MCP_SDK.test(spec))) push("endpoint integration must not require MCP SDK");
    const kind = file.roleDir.slice(srcRoot.length + 1).split("/")[1];
    const ownRoot = join(srcRoot, "endpoints", kind ?? "") + "/";
    if (reaches(file.path, (target) => isEndpoints(target) && !target.startsWith(ownRoot))) {
      push("endpoint integration must not reach another endpoint integration");
    }
  }
  const inHostRole =
    isHost(file.path) ||
    file.roleDir === join(srcRoot, "host") ||
    file.roleDir.startsWith(join(srcRoot, "host") + "/");
  if (inHostRole) {
    if (reaches(file.path, (target) => isControl(target) || isEndpoints(target) || isBin(target))) {
      push("host layer must not reach control, endpoint, or composition layers");
    }
    if (file.external.some((spec) => MCP_SDK.test(spec))) push("host layer must not require the MCP SDK");
    if (file.envAccess.length > 0) push("host layer must stay environment-free; trusted configuration is passed in");
  }
  const inMcpControl =
    isMcp(file.path) ||
    file.roleDir === join(srcRoot, "control", "mcp") ||
    file.roleDir.startsWith(join(srcRoot, "control", "mcp") + "/");
  if (inMcpControl && reaches(file.path, (target) => isStorage(target) || isHost(target))) {
    push("MCP control surface must not reach storage or the host; composition belongs in bin");
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

// MCP surface: ping stays the only advertised tool by default; the messaging
// tools exist only as descriptors in messaging-tools.ts and are registered
// exclusively through the injected, endpoint-bound port. The messaging tool
// names may appear in control/mcp only inside messaging-tools.ts.
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
const serverSource = readFileSync(join(srcRoot, "control", "mcp", "server.ts"), "utf8");
if (!/messaging === undefined \? \[PING_TOOL\] : \[PING_TOOL, \.\.\.MESSAGING_TOOLS\]/.test(serverSource)) {
  errors.push("src/control/mcp/server.ts: the MCP surface must stay ping-only by default and add messaging tools only through the injected MESSAGING_TOOLS");
}
for (const file of mcpSources) {
  if (file.path.endsWith("messaging-tools.ts")) continue;
  for (const name of ["ce_send", "ce_inbox_list", "ce_read_payload"]) {
    if (file.strings.includes(name)) {
      errors.push(`${relativePackage(file.path)}: messaging tool name "${name}" may appear only in control/mcp/messaging-tools.ts`);
    }
  }
}

// Runtime dependencies must be exactly pinned (no semver ranges).
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
} catch (error) {
  console.error(`package.json: unreadable or malformed manifest: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (manifest.engines?.node !== "24.21.0 || 24.22.1") {
  errors.push(`package.json: durable storage requires engines.node to be exactly "24.21.0 || 24.22.1", found "${String(manifest.engines?.node)}"`);
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
  console.log("PI-CHAT-EXCHANGE CONTRACT OK: private storage boundary, protocol<-core direction, plane and endpoint separation, neutral protocol/core, no Pi coupling, ping-default MCP with port-bound messaging, host layer isolation, pinned deps");
  for (const proof of provedFixtures.sort()) console.log(`  fixture rejected: ${proof}`);
}
