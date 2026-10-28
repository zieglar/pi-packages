import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = join(new URL("../..", import.meta.url).pathname);
const validator = join(root, "docs/release/validate-public-export-ledger.mjs");
let records;
try {
  records = JSON.parse(`[${readFileSync(join(root, "docs/release/public-export-ledger.jsonl"), "utf8").trim().split("\n").join(",")}]`);
} catch (error) {
  throw new Error(`invalid ledger fixture: ${error instanceof Error ? error.message : String(error)}`);
}
const env = { ...process.env, LC_ALL: "C", LANG: "C", PUBLIC_GIT_OBJECTS: "/Users/zieglar/Code/pi-packages/.git/objects" };
function run(events) {
  const directory = mkdtempSync(join(tmpdir(), "ce-ledger-check-"));
  try {
    const file = join(directory, "ledger.jsonl");
    writeFileSync(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    return spawnSync(process.execPath, [validator, file, "--git-verify"], { cwd: root, env, encoding: "utf8" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
const clone = () => structuredClone(records.filter(record => !(record.exportId === "PX-0004" && record.status !== "PENDING_EXPORT")));
function pendingCommit(mutate) {
  const all = clone();
  const next = structuredClone(all.find(record => record.exportId === "PX-0004"));
  next.seq = 2; next.status = "COMMITTED"; next.targetCommit = next.targetBase;
  mutate(next);
  all.push(next);
  return all;
}

test("accepted current ledger and file-level Git provenance pass", () => {
  const result = run(records);
  assert.equal(result.status, 0, result.stderr);
});

test("cannot replace pending inventory with a false empty COMMITTED event", () => {
  const result = run(pendingCommit(next => {
    next.exportedPaths = [];
    next.contentDigest = createHash("sha256").update("").digest("hex");
  }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity cannot change/);
});

test("cannot mark the unmodified Public base as an export commit", () => {
  const result = run(pendingCommit(() => {}));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target commit changes|operation mismatch/);
});

test("per-path sourceCommit cannot be forged", () => {
  const all = clone();
  all.find(record => record.exportId === "PX-0004").exportedPaths[0].sourceCommit = "0".repeat(40);
  const result = run(all);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sourceCommit|fatal|invalid object/);
});

test("UNKNOWN target blob is checked against the Public tree", () => {
  const all = clone();
  const unknown = all.find(record => record.exportId === "PX-0002");
  unknown.unmappedTargetPaths[0].targetBlob = "0".repeat(40);
  unknown.contentDigest = createHash("sha256").update(unknown.unmappedTargetPaths.map(({ path, targetBlob }) => `${path}\0${targetBlob}\n`).join("")).digest("hex");
  const result = run(all);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UNKNOWN target blob mismatch/);
});
