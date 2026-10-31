import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMatrix, parseRelease, releaseDecision, runtimeDigest, installOfficial } from '../tunnel-compat.mjs';
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
for (const failure of ['archive attestation', 'checksum attestation', 'checksum mismatch', null]) {
  test(`actual installer ${failure ? `refuses ${failure} before extraction or execution` : 'executes only after verification and extraction'}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'ce-installer-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const zipName = `tunnel-client-v${release.version}-linux-amd64.zip`;
    const archive = Buffer.from('synthetic-archive');
    const checksum = createHash('sha256').update(archive).digest('hex');
    const calls = [];
    const runner = (binary, args) => {
      calls.push({ binary, args });
      if (binary === 'curl') {
        const path = args[args.indexOf('--output') + 1];
        if (path.endsWith('.zip')) writeFileSync(path, archive);
        else if (path.endsWith('SHA256SUMS.txt')) writeFileSync(path, `${failure === 'checksum mismatch' ? '0'.repeat(64) : checksum} *${zipName}\n`);
        else writeFileSync(path, '{}');
        return '';
      }
      if (binary === 'gh') {
        assert.deepEqual(args.slice(0, 2), ['attestation', 'verify']);
        for (const [flag, value] of Object.entries({ '--repo': 'openai/tunnel-client', '--signer-workflow': 'openai/tunnel-client/.github/workflows/release.yml', '--source-ref': `refs/tags/v${release.version}`, '--source-digest': release.sourceCommit, '--signer-digest': release.sourceCommit, '--predicate-type': 'https://slsa.dev/provenance/v1' })) assert.equal(args[args.indexOf(flag) + 1], value);
        assert(args.includes('--deny-self-hosted-runners'));
        if ((failure === 'archive attestation' && args[2].endsWith('.zip')) || (failure === 'checksum attestation' && args[2].endsWith('SHA256SUMS.txt'))) throw new Error('attestation refused');
        return '';
      }
      if (binary === 'unzip' && args[0] === '-Z1') return 'tunnel-client\ncloudflared\ncloudflared-manifest.json\n';
      if (binary === 'unzip' && args[0] === '-q') {
        mkdirSync(join(root, 'bin'));
        writeFileSync(join(root, 'bin/tunnel-client'), 'synthetic-client');
        return '';
      }
      assert.equal(binary, join(root, 'bin/tunnel-client'));
      assert.deepEqual(args, ['--version']);
      assert(existsSync(binary));
      return `${release.version}+${release.sourceCommit}`;
    };
    const install = () => installOfficial(release, root, { runCommand: runner, platform: 'linux', arch: 'x64' });
    if (failure) {
      await assert.rejects(install(), failure.includes('attestation') ? /attestation refused/ : /official archive checksum/);
      assert(calls.some(call => call.binary === 'gh'), 'must reach actual verification, not platform refusal');
      assert(calls.every(call => ['curl', 'gh'].includes(call.binary)), 'no archive listing, extraction or executable invocation');
      assert(!existsSync(join(root, 'bin')), 'no extracted installation remains');
    } else {
      const result = await install();
      assert.equal(result.binary, join(root, 'bin/tunnel-client'));
      assert.equal(result.sha256, checksum);
      assert.deepEqual(calls.map(call => call.binary), ['curl', 'curl', 'curl', 'gh', 'gh', 'unzip', 'unzip', result.binary]);
      assert.equal(calls[5].args[0], '-Z1');
      assert.deepEqual(calls[6].args, ['-q', join(root, zipName), 'tunnel-client', 'cloudflared', 'cloudflared-manifest.json', '-d', join(root, 'bin')]);
    }
  });
}
