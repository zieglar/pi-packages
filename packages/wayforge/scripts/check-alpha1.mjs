#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const failures = [];
const requiredFiles = [
  "docs/alpha-1-durable-resume.md",
  "docs/evidence/phase-1b2-alpha1-restart-dogfood.json",
  "test/restart-integration.test.ts",
];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) failures.push(`missing required Alpha 1 artifact: ${file}`);
}
const doc = existsSync(join(root, requiredFiles[0])) ? readFileSync(join(root, requiredFiles[0]), "utf8") : "";
for (const text of ["Crash-safety matrix", "at-most-once", "CONFLICTING_DRIFT", "production `~/.pi`"]) {
  if (!doc.includes(text)) failures.push(`Alpha 1 safety document must contain: ${text}`);
}
try {
  const evidence = JSON.parse(readFileSync(join(root, requiredFiles[1]), "utf8"));
  if (evidence.runtime_input !== false || evidence.provider_traffic !== false || evidence.production_pi_access !== false) {
    failures.push("Alpha 1 evidence must be non-runtime, provider-free, and production-Pi-free");
  }
  if (evidence.negative_drift?.classification !== "CONFLICTING_DRIFT" || evidence.negative_drift?.result !== "blocked") {
    failures.push("Alpha 1 evidence must record conflicting drift as blocked");
  }
  if (Object.values(evidence.redaction ?? {}).some((value) => value !== false)) {
    failures.push("Alpha 1 evidence redaction flags must all be false");
  }
} catch {
  failures.push("Alpha 1 evidence must be valid JSON");
}
if (failures.length > 0) {
  console.error(`ALPHA 1 GATE FAILURES (${failures.length}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("ALPHA 1 OK: durable restart and negative-drift evidence is sanitized and complete");
