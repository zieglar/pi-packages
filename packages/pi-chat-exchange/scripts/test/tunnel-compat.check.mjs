import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMatrix, parseRelease, releaseDecision, runtimeDigest } from '../tunnel-compat.mjs';
const sha = 'a'.repeat(40), digest = 'b'.repeat(64);
const release = { version: '0.0.19', sourceCommit: sha, publishedAt: '2026-10-30T20:26:10Z', url: 'https://github.com/openai/tunnel-client/releases/tag/v0.0.19' };
const lane = kind => ({ status: 'VERIFIED', kind, evidence: 'evidence/test.json' });
function fixture() {
  return { schemaVersion: 1, regressionVersion: '0.0.19', records: [{ ce: { version: '0.2.2', baselineCommit: sha, runtimeSha256: digest, worktree: 'modified' }, client: release, testedAt: '2026-10-31T12:44:20Z', environment: { os: 'darwin', arch: 'arm64', node: '24.21.0', pi: '1.3.0', native: '0.1.0' }, offline: lane('automated-offline'), lifecycle: lane('real-client-local'), cloud: lane('manual-cloud'), limitations: ['namespaced Cloud NOT_VERIFIED'] }] };
}
const now = Date.parse('2026-10-31T13:00:00Z');
const offline = { schemaVersion: 1, status: 'VERIFIED', kind: 'automated-offline', client: release, runtimeSha256: digest, ceVersion: '0.2.2', testedAt: new Date(now).toISOString(), checks: { profile: true, health: true, normalStop: true, childFailureExit: true, failureStop: true, cleanup: true } };
const decide = (matrix = fixture(), result = offline, latest = release) => releaseDecision({ matrix, offline: result, latest, ceVersion: '0.2.2', runtimeSha256: digest, now });
test('valid matrix and same-source latest evidence are ready', () => { validateMatrix(fixture()); assert.equal(decide().status, 'RELEASE_READY'); });
test('latest drift and runtime drift never reuse historical Cloud evidence', () => {
  assert.equal(decide(fixture(), offline, { ...release, version: '0.0.20', url: 'https://github.com/openai/tunnel-client/releases/tag/v0.0.20' }).status, 'RELEASE_NOT_READY');
  const m = fixture(); m.records[0].ce.runtimeSha256 = 'c'.repeat(64); assert.equal(decide(m).status, 'RELEASE_NOT_READY');
});
test('missing, synthetic, blocked or failed Cloud cannot satisfy manual gate', () => {
  for (const status of ['FAILED', 'BLOCKED', 'NOT_VERIFIED']) { const m = fixture(); m.records[0].cloud = { status }; assert.equal(decide(m).status, 'RELEASE_NOT_READY'); }
  const m = fixture(); m.records[0].cloud.kind = 'automated-offline'; assert.throws(() => validateMatrix(m));
});
test('fresh offline result is mandatory, bound to version, source and all actual checks', () => {
  for (const x of [null, { ...offline, testedAt: '2026-10-20T00:00:00Z' }, { ...offline, testedAt: '2030-01-01T00:00:00Z' }, { ...offline, runtimeSha256: 'c'.repeat(64) }, { ...offline, status: 'FAILED' }, { ...offline, client: { ...release, sourceCommit: 'd'.repeat(40) } }, { ...offline, checks: { ...offline.checks, cleanup: false } }]) assert.equal(decide(fixture(), x).status, 'RELEASE_NOT_READY');
});
test('matrix rejects invalid statuses, duplicate combos, private evidence paths and invalid commits', () => {
  for (const mutate of [m => m.records[0].cloud.status = 'PASS', m => m.records.push(structuredClone(m.records[0])), m => m.records[0].cloud.evidence = '/private/tmp/sensitive', m => m.records[0].ce.baselineCommit = 'HEAD']) { const m = fixture(); mutate(m); assert.throws(() => validateMatrix(m)); }
});
test('official stable release metadata and source commit validated at boundary', () => {
  const raw = { tag_name: 'v0.0.19', draft: false, prerelease: false, published_at: release.publishedAt, html_url: release.url };
  assert.equal(parseRelease(raw, sha).version, '0.0.19');
  for (const bad of [{ ...raw, tag_name: 'v0.0.19;touch x' }, { ...raw, prerelease: true }, { ...raw, html_url: 'https://evil.test/release' }]) assert.throws(() => parseRelease(bad, sha));
});
test('runtime digest covers package metadata, source and Pi extension bytes deterministically', () => {
  const root = mkdtempSync(join(tmpdir(), 'ce-digest-')); mkdirSync(join(root, 'src')); mkdirSync(join(root, 'pi-extension')); mkdirSync(join(root, 'native')); writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'src/a.ts'), 'a'); writeFileSync(join(root, 'pi-extension/index.ts'), 'b'); writeFileSync(join(root, 'native/tunnel-keychain.swift'), 'helper'); const first = runtimeDigest(root); assert.equal(first, runtimeDigest(root)); writeFileSync(join(root, 'src/a.ts'), 'changed'); assert.notEqual(first, runtimeDigest(root));
});
test("the executed Keychain helper is part of runtime evidence identity", () => {
  const root = mkdtempSync(join(tmpdir(), "ce-digest-helper-")); mkdirSync(join(root, "src")); mkdirSync(join(root, "pi-extension")); mkdirSync(join(root, "native"));
  writeFileSync(join(root, "package.json"), "{}"); writeFileSync(join(root, "src/a.ts"), "a"); writeFileSync(join(root, "pi-extension/index.ts"), "b"); writeFileSync(join(root, "native/tunnel-keychain.swift"), "helper");
  const before = runtimeDigest(root); writeFileSync(join(root, "native/tunnel-keychain.swift"), "changed"); assert.notEqual(before, runtimeDigest(root));
});
test("readMatrix rejects damaged and identity-mismatched evidence files", async () => {
  const { readMatrix } = await import("../tunnel-compat.mjs");
  const root = mkdtempSync(join(tmpdir(), "ce-evidence-refusal-")); mkdirSync(join(root, "compatibility/evidence"), { recursive: true });
  const m = fixture(); writeFileSync(join(root, "compatibility/tunnel-client.json"), JSON.stringify(m)); writeFileSync(join(root, "compatibility/evidence/test.json"), "{bad");
  assert.throws(() => readMatrix(root));
  const e = m.records[0]; const evidence = { ce: e.ce, client: e.client, testedAt: e.testedAt, offline: e.offline, lifecycle: { ...e.lifecycle, start: true, health: true, normalStop: true, cleanup: true }, cloud: { ...e.cloud, durableMatch: true, normalOwnershipRelease: true, hardStopCleanup: true, receptionOnly: true, forward: { messageId: "msg_A", receiptId: "rcpt_B", createdAudit: 1, receiptAudit: 2 }, reverse: { messageId: "msg_C", receiptId: "rcpt_D", createdAudit: 3, receiptAudit: 4 } } };
  writeFileSync(join(root, "compatibility/evidence/test.json"), JSON.stringify(evidence)); assert.deepEqual(readMatrix(root), m);
  evidence.ce.runtimeSha256 = "c".repeat(64); writeFileSync(join(root, "compatibility/evidence/test.json"), JSON.stringify(evidence)); assert.throws(() => readMatrix(root));
});
test("official archive provenance and checksum failures are refused", async () => {
  const { verifyOfficialChecksumAndAttestation } = await import("../tunnel-compat.mjs");
  const dir = mkdtempSync(join(tmpdir(), "ce-installer-")); const zipName = `tunnel-client-v${release.version}-linux-amd64.zip`;
  const runner = (binary, args) => { if (binary === "gh") return; const name = args[args.indexOf("--output") + 1]; if (name.endsWith(".zip")) writeFileSync(name, "synthetic-archive"); else if (name.endsWith("SHA256SUMS.txt")) writeFileSync(name, `${"a".repeat(64)} *${zipName}`); };
  await assert.rejects(verifyOfficialChecksumAndAttestation(release, dir, runner), /official archive checksum/);
  const rejected = mkdtempSync(join(tmpdir(), "ce-installer-"));
  await assert.rejects(verifyOfficialChecksumAndAttestation(release, rejected, (binary, args) => { if (binary === "gh") throw new Error("attestation refused"); if (args.at(-1) === "SHA256SUMS.txt") writeFileSync(args[args.indexOf("--output") + 1], "sha256: unused\n"); }), /attestation refused/);
});
