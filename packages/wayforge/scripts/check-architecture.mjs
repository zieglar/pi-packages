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
 *           extension entry, extension tool surface, and the explicit Pi continuation launcher;
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
 *           `pi-subagents/delegation` contract;
 *   gate 10 the durable execution stack (task store, wakeup scheduler,
 *           startup scanner, continuation launcher/factory) is constructed
 *           only in the single live durable composition root;
 *   gate 11 no pi-accounts integration may be imported anywhere;
 *   gate 12 exactly one CompletionAuthority construction, in extension.ts;
 *   gate 13 durable task completion literals/evidence writers live only in
 *           completion/completion-authority.ts (worker outcomes excluded);
 *   gate 14 completion CAS callsites live only in the completion authority;
 *   gate 15 versioned accounts protocol strings appear only in the dedicated adapter;
 *   gate 16 completion budget reservation callsites belong to the controller;
 *   gate 17 authoritative review dispatch belongs to the authority callback;
 *   gate 18 governed manual advice refuses before any review dispatch;
 *   gate 19 the authoritative advisor diagnostic event is emitted only
 *           by the workflow controller (non-authoritative side channel).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.argv[2] ?? join(process.cwd(), "src");
const ADAPTER_PATH = "runtime/pi-compatibility-adapter.ts";
const PI_CONTINUATION_LAUNCHER_PATH = "runtime/pi-continuation-launcher.ts";
const EXTENSION_PATHS = new Set([
  ADAPTER_PATH,
  "extension.ts",
  "runtime/extension-tools.ts",
  PI_CONTINUATION_LAUNCHER_PATH,
]);
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const RUNTIME_FACTORY_PATH = "workflow/runtime-factory.ts";
const SET_MODEL_RE = /\bsetModel\s*\(/g;
const IMPORT_RE = /import\s[^;]*?from\s*["']([^"']+)["']/g;
const FORBIDDEN_MEMBER_RE =
  /\b(?:setModel|abort|retry|retryLoop|fallback|fallbackLoop|continueSession|resumeLoop)\s*[(:]/g;
const DELEGATION_EXPORT = "pi-subagents/delegation";
const DURABLE_COMPOSITION_PATH = "runtime/durable-composition.ts";
const PI_ACCOUNTS_RE = /(^|\/)pi-accounts(\/|$)|@narumitw\//;
const PI_ACCOUNTS_CONTENT_RE = /pi-accounts|@narumitw\//i;
const PI_ACCOUNTS_ADAPTER_PATH = "adapters/pi-accounts-adapter.ts";
const ACCOUNTS_PROTOCOL_RE = /\baccounts:(?:topology|activation):v1\b/;
const COMPLETION_AUTHORITY_PATH = "completion/completion-authority.ts";
const COMPLETED_STATUS_RE = /\bstatus\s*:\s*["']completed["']/g;
const WORKFLOW_COMPLETED_WRITE_RE = /\.setStatus\s*\(\s*["']completed["']\s*\)/g;
const COMPLETION_EVIDENCE_WRITE_RE = /\bcompletionEvidence\s*:(?!\s*(?:Type\.|null\b))\s*/g;
const STORE_UPDATE_RE = /\.update\s*\(/g;
const COMPLETION_CAS_SHAPE_RE =
  /\bstatus\s*:\s*["']completed["']|\bcompletionEvidence\s*:(?!\s*(?:Type\.|null\b))/;
const DURABLE_OWNER_TYPES = [
  "WakeupService",
  "StartupRecoveryScanner",
  "PiContinuationLauncher",
  "PiSdkContinuationSessionFactory",
  "FilesystemDurableTaskStore",
];

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

function stripComments(content) {
  // Blank comment characters with spaces (newlines and offsets preserved) so
  // gate scanners match code, not prose. String literals are left untouched.
  const chars = content.split("");
  let quote = null;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") {
        chars[i] = " ";
        i += 1;
      }
      continue;
    } else if (ch === "/" && chars[i + 1] === "*") {
      chars[i] = " ";
      chars[i + 1] = " ";
      i += 2;
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < chars.length) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 1;
      }
    }
    i += 1;
  }
  return chars.join("");
}

function callArguments(content, openParenIndex) {
  // Slice the balanced argument region starting at "(". String literals are
  // skipped so parentheses inside them cannot unbalance the scan.
  let depth = 0;
  let quote = null;
  for (let i = openParenIndex; i < content.length; i += 1) {
    const ch = content[i];
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return content.slice(openParenIndex, i + 1);
    }
  }
  return content.slice(openParenIndex);
}

const files = listFiles(root);
const violations = [];
let setModelCount = 0;
const coordinatorSites = [];
const healthSites = [];
const projectorSites = [];
const adapterSites = [];
const mainControllerSites = [];
const completionAuthoritySites = [];

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

  // Gate 15: only the narrow protocol adapter may name the EventBus channels.
  if (PI_ACCOUNTS_CONTENT_RE.test(content) && relPath !== PI_ACCOUNTS_ADAPTER_PATH) {
    violations.push(`${relPath}: pi-accounts dependency references are forbidden outside ${PI_ACCOUNTS_ADAPTER_PATH}`);
  }
  if (ACCOUNTS_PROTOCOL_RE.test(content) && relPath !== PI_ACCOUNTS_ADAPTER_PATH) {
    violations.push(`${relPath}: accounts protocol channels are only permitted in ${PI_ACCOUNTS_ADAPTER_PATH}`);
  }

  // Gate 2, 3, 9 & 11: import restrictions.
  for (const match of content.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? "";
    const line = lineOf(content, match.index ?? 0);
    if (PI_ACCOUNTS_RE.test(specifier)) {
      violations.push(
        `${relPath}:${line}: pi-accounts integration import "${specifier}" is forbidden in Phase 1.1`,
      );
    } else if (specifier.startsWith("@earendil-works/pi-ai")) {
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
        `${relPath}:${line}: Pi extension API import is only permitted in ${ADAPTER_PATH}, extension.ts, runtime/extension-tools.ts, and ${PI_CONTINUATION_LAUNCHER_PATH}`,
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
  for (const match of countConstructor(content, "CompletionAuthority")) {
    completionAuthoritySites.push({ relPath, line: lineOf(content, match.index ?? 0) });
  }

  // Gates 16-18: concrete Advisor reservation and callback ownership.
  // Gates 16-18: concrete Advisor reservation and callback ownership.
  const ownershipSource = stripComments(content);
  const reservations = [...ownershipSource.matchAll(/\.reserveCompletionBudget\s*\(/g)];
  for (const match of reservations) {
    if (relPath !== "workflow/workflow-controller.ts" || reservations.length !== 1) {
      violations.push(`${relPath}:${lineOf(content, match.index ?? 0)}: completion budget reservation belongs only to the one-shot controller callback`);
    }
  }
  const completionReviews = [...ownershipSource.matchAll(/\.reviewCompletionEvidence\s*\(/g)];
  for (const match of completionReviews) {
    if (relPath !== "workflow/workflow-controller.ts" || completionReviews.length !== 1 ||
        !/review:\s*\(evidence\)\s*=>\s*this\.reviewCompletionEvidence\(evidence\)/.test(ownershipSource)) {
      violations.push(`${relPath}:${lineOf(content, match.index ?? 0)}: authoritative Advisor review callback is owned only by the CompletionAuthority request`);
    }
  }
  if (relPath === "workflow/workflow-controller.ts" && reservations.length > 0) {
    const adviceStart = ownershipSource.indexOf("  advise(");
    const adviceEnd = ownershipSource.indexOf("  private reviewCompletionEvidence(");
    const adviceBody = ownershipSource.slice(Math.max(0, adviceStart), adviceEnd < 0 ? undefined : adviceEnd);
    const guard = adviceBody.indexOf("advisor_reserved_for_completion");
    const dispatch = adviceBody.indexOf("this.reviewAdvisorEvidence(");
    if (!adviceBody.includes("this.options.completionAuthority !== undefined") || guard < 0 ||
        (dispatch >= 0 && guard > dispatch)) {
      violations.push(`${relPath}: governed advice must refuse before review; manual requests cannot consume completion reservation`);
    }
  }

  // Gate 19: authoritative advisor diagnostics are a controller-owned
  // best-effort side channel; only the controller may emit the event kind.
  for (const match of ownershipSource.matchAll(/\.emit\(\s*["']advisor_review_diagnostic["']/g)) {
    if (relPath !== "workflow/workflow-controller.ts") {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: authoritative advisor diagnostic emission is only permitted in workflow/workflow-controller.ts`,
      );
    }
  }

  // Gates 13-14: only the authority may author durable completion.
  if (relPath !== COMPLETION_AUTHORITY_PATH && relPath !== "adapters/pi-subagent-worker-adapter.ts") {
    for (const match of content.matchAll(COMPLETED_STATUS_RE)) {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: durable status completed is owned only by ${COMPLETION_AUTHORITY_PATH}`,
      );
    }
  }
  if (relPath !== "workflow/workflow-controller.ts") {
    for (const match of content.matchAll(WORKFLOW_COMPLETED_WRITE_RE)) {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: workflow completion publication is only permitted in workflow/workflow-controller.ts`,
      );
    }
  }
  if (relPath !== COMPLETION_AUTHORITY_PATH && relPath !== "durable/state.ts") {
    for (const match of content.matchAll(COMPLETION_EVIDENCE_WRITE_RE)) {
      violations.push(
        `${relPath}:${lineOf(content, match.index ?? 0)}: completion evidence writes are owned only by ${COMPLETION_AUTHORITY_PATH}`,
      );
    }
  }
  // Gate 14: completion CAS callsites (a durable store update whose payload
  // transitions to a completed/evidence-bearing state) live only in the
  // completion authority. Benign non-completion updates pass; comments are
  // stripped before matching.
  if (relPath !== COMPLETION_AUTHORITY_PATH) {
    const code = stripComments(content);
    for (const match of code.matchAll(STORE_UPDATE_RE)) {
      const start = match.index ?? 0;
      const args = callArguments(code, start + match[0].length - 1);
      if (COMPLETION_CAS_SHAPE_RE.test(args)) {
        violations.push(
          `${relPath}:${lineOf(content, start)}: completion CAS (durable store update into a completed/evidence-bearing state) is only permitted in ${COMPLETION_AUTHORITY_PATH}`,
        );
      }
    }
  }
  for (const ownerType of DURABLE_OWNER_TYPES) {
    for (const match of countConstructor(content, ownerType)) {
      const line = lineOf(content, match.index ?? 0);
      if (relPath !== DURABLE_COMPOSITION_PATH) {
        violations.push(
          `${relPath}:${line}: \`new ${ownerType}(\` is only permitted in ${DURABLE_COMPOSITION_PATH} (single live durable composition root)`,
        );
      }
    }
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

// Gate 12: exactly one completion authority construction, in extension.ts.
if (completionAuthoritySites.length !== 1 || completionAuthoritySites[0].relPath !== "extension.ts") {
  violations.push(
    `<root>: expected exactly 1 \`new CompletionAuthority(\` in extension.ts, found ${completionAuthoritySites.length}` +
      `${completionAuthoritySites.map((site) => ` [${site.relPath}:${site.line}]`).join("")}`,
  );
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

console.log(`ARCHITECTURE OK: 19 gates passed (scanned ${files.length} files)`);
