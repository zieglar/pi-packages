// Append-only ledger validation. Never called by Public workflows.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const file = process.argv[2] === undefined || process.argv[2].startsWith("--")
  ? join(root, "docs/release/public-export-ledger.jsonl") : process.argv[2];
let schema;
try { schema = JSON.parse(readFileSync(join(root, "docs/release/public-export-ledger.schema.json"), "utf8")); } catch (error) {
  throw new Error(`invalid ledger schema: ${error instanceof Error ? error.message : String(error)}`);
}
const records = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`invalid JSONL at ${index + 1}`); }
});
const required = ["schema", "exportId", "seq", "recordedAt", "backfilled", "status", "sourceRepository", "sourceCommits", "sourceHead", "targetRepository", "targetBase", "targetCommit", "exportedPaths", "contentDigest", "verification", "evidence"];
const statuses = new Set(["PENDING_EXPORT", "COMMITTED", "VERIFIED", "UNKNOWN", "PUSHED", "CI_VERIFIED"]);
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
for (const record of records) {
  for (const field of required) if (!Object.hasOwn(record, field)) throw new Error(`${record.exportId}: missing ${field}`);
  if (record.schema !== 1 || !/^PX-\d{4}$/.test(record.exportId) || !Number.isInteger(record.seq) || record.seq < 1
    || typeof record.backfilled !== "boolean" || !statuses.has(record.status)
    || record.sourceRepository !== "zieglar/pi-packages-dev" || record.targetRepository !== "zieglar/pi-packages"
    || !Number.isFinite(Date.parse(record.recordedAt)) || !Array.isArray(record.sourceCommits)
    || !record.sourceCommits.every(sha) || !(record.sourceHead === null || sha(record.sourceHead))
    || !(record.targetBase === null || sha(record.targetBase)) || !(record.targetCommit === null || sha(record.targetCommit))
    || !Array.isArray(record.exportedPaths) || !/^[0-9a-f]{64}$/.test(record.contentDigest)
    || typeof record.verification !== "object" || record.verification === null
    || !Array.isArray(record.evidence) || record.evidence.length === 0) throw new Error(`${record.exportId}: schema validation failed`);
  if (record.status === "PENDING_EXPORT" && record.targetCommit !== null) throw new Error(`${record.exportId}: pending has a commit`);
  for (const path of record.exportedPaths) {
    if (typeof path.path !== "string" || /[\0\r\n]/.test(path.path) || !sha(path.sourceCommit) || !sha(path.blob)
      || (path.operation !== undefined && !["A", "M", "D"].includes(path.operation))
      || (path.targetBaseBlob !== undefined && path.targetBaseBlob !== null && !sha(path.targetBaseBlob))) throw new Error(`${record.exportId}: invalid path record`);
  }
}
const ids = new Set(records.map(r => r.exportId));
if (ids.size === 0) throw new Error("ledger must contain at least one exportId");
for (const id of ids) {
  const events = records.filter(r => r.exportId === id).sort((a, b) => a.seq - b.seq);
  events.forEach((event, index) => { if (event.seq !== index + 1) throw new Error(`${id}: non-contiguous seq`); });
  const first = events[0];
  const identityFields = ["backfilled", "sourceRepository", "sourceCommits", "sourceHead",
    "targetRepository", "targetBase", "exportedPaths", "excludedPaths", "contentDigest"];
  const committed = events.find(event => event.status === "COMMITTED");
  for (const event of events.slice(1)) {
    for (const field of identityFields) {
      if (JSON.stringify(event[field]) !== JSON.stringify(first[field])) {
        throw new Error(`${id}: export identity cannot change across events (${field})`);
      }
    }
    if (committed && event.seq > committed.seq && event.targetCommit !== committed.targetCommit) {
      throw new Error(`${id}: targetCommit cannot change after COMMITTED`);
    }
  }
  const statuses = events.map(r => r.status);
  if (statuses.includes("UNKNOWN")) {
    if (statuses.length !== 1) throw new Error(`${id}: UNKNOWN cannot be superseded by inferred events`);
  } else {
    const first = statuses[0];
    if (first === "VERIFIED") {
      if (statuses.some(s => s !== "VERIFIED")) throw new Error(`${id}: historical verification cannot be downgraded`);
    } else {
      const expected = ["PENDING_EXPORT", "COMMITTED", "PUSHED", "CI_VERIFIED"];
      for (let i = 0; i < statuses.length; i += 1) {
        if (statuses[i] !== expected[i]) throw new Error(`${id}: invalid transition ${statuses.join(" -> ")}`);
      }
    }
  }
  for (const event of events) {
    if (event.backfilled && event.status === "PENDING_EXPORT") throw new Error(`${id}: pending cannot masquerade as historical record`);
    if (event.status !== "PENDING_EXPORT" && !event.targetCommit) throw new Error(`${id}: completed event lacks target commit`);
    if (event.targetCommit && event.sourceCommits.includes(event.targetCommit)) throw new Error(`${id}: source and target are unrelated repositories`);
  }
}
const raw = readFileSync(file, "utf8");
if (/(?:ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|password\s*[:=]|Pi-Project-Evidence|handoff-evidence|\/Users\/)/i.test(raw)) {
  throw new Error("ledger contains forbidden path or possible secret");
}
if (process.argv.includes("--git-verify")) {
  const env = { ...process.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.PUBLIC_GIT_OBJECTS };
  for (const event of records) {
    for (const source of event.sourceCommits) execFileSync("git", ["cat-file", "-e", `${source}^{commit}`], { cwd: root, stdio: "ignore" });
    if (event.targetCommit) {
      if (!process.env.PUBLIC_GIT_OBJECTS) throw new Error("PUBLIC_GIT_OBJECTS is required for target verification");
      const publicGitDir = join(process.env.PUBLIC_GIT_OBJECTS, "..");
      execFileSync("git", ["--git-dir", publicGitDir, "cat-file", "-e", `${event.targetCommit}^{commit}`], { env, stdio: "ignore" });
      execFileSync("git", ["--git-dir", publicGitDir, "merge-base", "--is-ancestor", event.targetBase ?? event.targetCommit, event.targetCommit], { env, stdio: "ignore" });
    }
    for (const path of event.exportedPaths) {
      const sourceRevision = path.operation === "D" ? `${path.sourceCommit}^` : path.sourceCommit;
      const sourceBlob = execFileSync("git", ["rev-parse", `${sourceRevision}:${path.path}`], { cwd: root, encoding: "utf8" }).trim();
      if (sourceBlob !== path.blob) throw new Error(`${event.exportId}: per-path sourceCommit blob mismatch for ${path.path}`);
      if (event.sourceHead) {
        const blob = execFileSync("git", ["rev-parse", `${event.sourceHead}:${path.path}`], { cwd: root, encoding: "utf8" }).trim();
        if (blob !== path.blob) throw new Error(`${event.exportId}: source blob mismatch for ${path.path}`);
      }
      if (event.targetCommit) {
      const perCommit = event.status === "COMMITTED" && records.some(other => other.exportId === event.exportId && other.status === "PENDING_EXPORT");
      const publicGitDir = join(process.env.PUBLIC_GIT_OBJECTS, "..");
      if (perCommit) {
        if (event.targetBase === null) throw new Error(`${event.exportId}: COMMITTED requires targetBase`);
        const changed = execFileSync("git", ["--git-dir", publicGitDir, "diff", "--name-status", "-z", event.targetBase, event.targetCommit], { env, encoding: "utf8" });
        const tokens = changed.split("\0").filter(Boolean);
        const actual = new Map();
        for (let index = 0; index < tokens.length; index += 2) actual.set(tokens[index + 1], tokens[index]);
        if (actual.size !== event.exportedPaths.length) throw new Error(`${event.exportId}: target commit changes do not match export inventory`);
        for (const path of event.exportedPaths) {
          if (actual.get(path.path) !== path.operation) throw new Error(`${event.exportId}: target commit operation mismatch for ${path.path}`);
        }
      }
        const blob = execFileSync("git", ["--git-dir", publicGitDir, "rev-parse", `${event.targetCommit}:${path.path}`], { env, encoding: "utf8" }).trim();
        if (blob !== path.blob) throw new Error(`${event.exportId}: target blob mismatch for ${path.path}`);
      }
    }
    for (const path of event.unmappedTargetPaths ?? []) {
      if (typeof path.path !== "string" || !sha(path.targetBlob)) throw new Error(`${event.exportId}: invalid UNKNOWN target path`);
      if (!event.targetCommit) throw new Error(`${event.exportId}: UNKNOWN target commit unavailable`);
      const publicGitDir = join(process.env.PUBLIC_GIT_OBJECTS, "..");
      const blob = execFileSync("git", ["--git-dir", publicGitDir, "rev-parse", `${event.targetCommit}:${path.path}`], { env, encoding: "utf8" }).trim();
      if (blob !== path.targetBlob) throw new Error(`${event.exportId}: UNKNOWN target blob mismatch for ${path.path}`);
    }
    const digestPaths = event.status === "UNKNOWN" ? (event.unmappedTargetPaths ?? []) : event.exportedPaths;
    const actual = createHash("sha256").update(digestPaths.map(({ path, blob, targetBlob }) => `${path}\0${blob ?? targetBlob}\n`).join("")).digest("hex");
    if (actual !== event.contentDigest) throw new Error(`${event.exportId}: contentDigest mismatch`);
  }
  console.log(`Verified ${records.length} append-only events, ${ids.size} exports, JSONL schema, transitions and content digests.`);
} else {
  console.log(`Validated ${records.length} append-only events, ${ids.size} exports, JSONL schema and transitions.`);
}
