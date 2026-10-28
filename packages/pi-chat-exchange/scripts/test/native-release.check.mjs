import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { apiGet, publishRelease } from "../native-release.mjs";

const options = { repository: "zieglar/pi-packages", version: "0.1.0", sha: "a".repeat(40) };
const assets = ["aarch64-apple-darwin", "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]
  .map(target => `ce-sqlite-0.1.0-${target}.node`)
  .concat(["SHA256SUMS", "native-manifest.json", "native-identities.json", "provenance.jsonl"]);
const response = (code, body) => ({ status: code === 200 ? 0 : 1, stdout: `HTTP/2.0 ${code} Status\r\ncontent-type: application/json\r\n\r\n${JSON.stringify(body)}` });
function fixture(overrides = {}, failWrite = -1) {
  const calls = [];
  let writes = 0;
  const run = args => {
    calls.push(args);
    if (args[0] === "api" && args[1] === "--include") {
      const path = args.at(-1);
      if (path.endsWith("immutable-releases")) return overrides.immutable ?? response(200, { enabled: true });
      if (path.includes("git/ref")) return overrides.tag ?? response(404, { message: "Not Found" });
      return overrides.release ?? response(404, { message: "Not Found" });
    }
    return { status: ++writes === failWrite ? 1 : 0, stdout: "" };
  };
  return { calls, run, writes: () => writes };
}
for (const kind of ["tag", "release"]) test(`existing ${kind} refuses before any write`, () => {
  const f = fixture({ [kind]: response(200, { id: 1, draft: true }) });
  assert.throws(() => publishRelease(options, ["asset.node"], f.run), /already exists/);
  assert.equal(f.writes(), 0);
});
for (const code of [401, 403, 429, 500]) test(`HTTP ${code} is not absence`, () => {
  const f = fixture({ tag: response(code, { message: "failure" }) });
  assert.throws(() => publishRelease(options, [], f.run), /refused/);
  assert.equal(f.writes(), 0);
});
for (const result of [{ status: 1, stdout: "" }, { status: 1, stdout: "HTTP/2.0 404 Status\n\n<html>" }, response(404, { message: "unauthorized" })]) {
  test(`invalid/ambiguous API response refuses: ${result.stdout}`, () => {
    assert.throws(() => apiGet("fixture", () => result));
  });
}
test("disabled repository immutable releases refuse", () => {
  const f = fixture({ immutable: response(200, { enabled: false }) });
  assert.throws(() => publishRelease(options, [], f.run), /administrator/);
  assert.equal(f.writes(), 0);
});
test("new version creates an exact SHA tag, draft assets, then publishes", () => {
  const f = fixture();
  publishRelease(options, assets, f.run);
  const writes = f.calls.filter(args => !(args[0] === "api" && args[1] === "--include"));
  assert.deepEqual(writes[0], ["api", "--method", "POST", "repos/zieglar/pi-packages/git/refs", "-f", "ref=refs/tags/ce-sqlite-v0.1.0", "-f", `sha=${options.sha}`]);
  assert.ok(writes[1].includes("--verify-tag"));
  assert.ok(writes[1].includes("--draft"));
  assert.ok(writes[1].includes("provenance.jsonl"));
  assert.deepEqual(writes[2], ["release", "edit", "ce-sqlite-v0.1.0", "--repo", options.repository, "--draft=false"]);
  assert.ok(!writes.flat().some(arg => /clobber|force|delete/.test(arg)));
});
for (const step of [1, 2, 3]) test(`write failure ${step} stops immediately without retry/cleanup`, () => {
  const f = fixture({}, step);
  assert.throws(() => publishRelease(options, assets, f.run), /manual review; no retry/);
  assert.equal(f.writes(), step);
});
test("repository/version/commit validation prevents writes", () => {
  for (const bad of [{ repository: "evil/repo" }, { version: "latest" }, { sha: "main" }]) {
    const f = fixture();
    assert.throws(() => publishRelease({ ...options, ...bad }, [], f.run), /invalid release/);
    assert.equal(f.calls.length, 0);
  }
});
test("missing or additional release files refuse before creating a tag", () => {
  for (const files of [assets.slice(1), [...assets, "unexpected.bin"]]) {
    const f = fixture();
    assert.throws(() => publishRelease(options, files, f.run), /fixed version inventory/);
    assert.equal(f.writes(), 0);
  }
});

test("workflow keeps Store admission and privileged jobs separate", () => {
  const source = readFileSync(new URL("../../../../.github/workflows/native-release.yml", import.meta.url), "utf8");
  const store = source.slice(source.indexOf("      - name: Build TypeScript and verify cross-driver databases"), source.indexOf("      - name: Test release refusal"));
  assert.match(store, /matrix.target == 'aarch64-apple-darwin' \|\|/);
  assert.match(store, /matrix.target == 'x86_64-unknown-linux-gnu'/);
  assert.doesNotMatch(store, /x86_64-apple-darwin/);
  const build = source.slice(source.indexOf("  build:"), source.indexOf("  attest:"));
  assert.doesNotMatch(build, /contents: write|id-token: write|attestations: write/);
  const attest = source.slice(source.indexOf("  attest:"), source.indexOf("  release:"));
  assert.match(attest, /attestations: write/);
  assert.match(attest, /id-token: write/);
  assert.doesNotMatch(attest, /contents: write/);
  assert.match(attest, /subject-path: release-files\/\*/);
  for (const job of [attest, source.slice(source.indexOf("  release:"))]) {
    assert.match(job, /github.ref == 'refs\/heads\/main'/);
    assert.match(job, /github.repository == 'zieglar\/pi-packages'/);
    assert.match(job, /github.event_name == 'workflow_dispatch'/);
  }
  assert.match(source, /--source-digest "\$GITHUB_SHA"/);
  assert.match(source, /sha256sum --check SHA256SUMS/);
  assert.match(source, /cancel-in-progress: false/);
  for (const match of source.matchAll(/uses: [^@\s]+@([^\s]+)/g)) assert.match(match[1], /^[a-f0-9]{40}$/);
  // Syntax-check every literal shell body without executing GitHub operations.
  for (const match of source.matchAll(/^        run: \|\n((?:          .*\n|\n)+)/gm)) {
    const script = match[1].replace(/^          /gm, "").replace(/\$\{\{[^}]+\}\}/g, "fixture");
    execFileSync("bash", ["-n"], { input: script });
  }
});
