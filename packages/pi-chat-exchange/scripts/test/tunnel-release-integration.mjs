// Author-only no-publication integration. Downloaded evidence is never promoted
// or refreshed here; only invalid copies are created for negative cases.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot, runtimeDigest, readMatrix, releaseDecision, discoverRelease } from '../tunnel-compat.mjs';

for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GH_TOKEN', 'GITHUB_TOKEN']) {
  assert(!process.env[key], `verification must not receive ${key}`);
}
const [input, output] = process.argv.slice(2);
assert(input && output, 'usage: integration INPUT_RESULT OUTPUT_SUMMARY');
const inputBytes = readFileSync(resolve(input));
const inputSha = createHash('sha256').update(inputBytes).digest('hex');
assert.equal(inputSha, process.env.CE_EXPECTED_RESULT_SHA256, 'download must match this run producer output');
const original = JSON.parse(inputBytes);
const digest = runtimeDigest();
assert.equal(original.runtimeSha256, digest);
const matrix = readMatrix(), pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
const latest = await discoverRelease();
assert.equal(releaseDecision({ matrix, offline: original, latest, ceVersion: pkg.version, runtimeSha256: digest }).status, 'RELEASE_READY');
const executionSha = process.env.GITHUB_SHA;
assert.match(executionSha ?? '', /^[a-f0-9]{40}$/);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'ce-release-integration-')));
const cases = [];
try {
  // Only this fixed, nonpublishing npm command is real. All release CLI npm calls
  // below are intercepted in-process, with no executable fallback or credentials.
  const inventory = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--dry-run'], { cwd: packageRoot, encoding: 'utf8', timeout: 60_000 }))[0].files;
  const fixture = join(root, 'package');
  for (const name of ['src', 'dist', 'pi-extension', 'native', 'scripts', 'compatibility', 'package.json', 'README.md', 'LICENSE']) cpSync(join(packageRoot, name), join(fixture, name), { recursive: true });
  assert.equal(runtimeDigest(fixture), digest);
  const routes = join(root, 'routes.json');
  const filename = `zieglar-pi-chat-exchange-${pkg.version}.tgz`;
  writeFileSync(routes, JSON.stringify({ view: { status: 1, stdout: '', stderr: 'npm error code E404' }, pack: { status: 0, stdout: JSON.stringify([{ filename, files: inventory }]) }, publish: { status: 0, stdout: 'SUBSTITUTE_ONLY_NO_PUBLICATION' } }));
  const variants = [
    ['missing', null],
    ['stale', { ...original, testedAt: '2020-01-01T00:00:00Z' }],
    ['wrong-source', { ...original, client: { ...original.client, sourceCommit: '0'.repeat(40) } }],
    ['wrong-runtime', { ...original, runtimeSha256: '0'.repeat(64) }],
    ['failed-cleanup', { ...original, checks: { ...original.checks, cleanup: false } }],
    ['valid', original],
  ];
  for (const [label, evidence] of variants) {
    const resultPath = join(root, `${label}.json`);
    if (label === 'valid') writeFileSync(resultPath, inputBytes);
    else if (evidence) writeFileSync(resultPath, JSON.stringify(evidence));
    for (const command of ['preflight', 'publish']) {
      const logPath = join(root, `${label}-${command}.jsonl`);
      // Explicit environment contains no publication auth, inherited NODE_OPTIONS,
      // HOME/npm config, or executable PATH. Only official public API fetch is live.
      const child = spawnSync(process.execPath, ['--import', resolve(import.meta.dirname, 'support/release-integration-npm.mjs'), join(fixture, 'scripts/npm-release.mjs'), command], {
        cwd: fixture, encoding: 'utf8', timeout: 120_000,
        env: { PATH: '', LANG: 'C', CE_NPM_STUB_LOG: logPath, CE_NPM_STUB_ROUTES: routes, CE_TUNNEL_COMPAT_RESULT: evidence ? resultPath : '', EXPECTED_SHA: executionSha, GITHUB_SHA: executionSha },
      });
      const calls = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      assert.equal(child.error, undefined, `${label}/${command}: child execution error`);
      if (label !== 'valid') {
        assert.equal(child.status, 1, `${label}/${command}: must refuse`);
        assert.match(child.stderr, /RELEASE_NOT_READY/, `${label}/${command}: must fail at gate`);
        assert.equal(calls.length, 0, `${label}/${command}: zero npm calls`);
      } else {
        assert.equal(child.status, 0, `${label}/${command}: ${child.stderr}`);
        assert.deepEqual(calls.map(call => call.argv[0]), command === 'publish' ? ['view', 'pack', 'pack', 'publish'] : ['view', 'pack', 'pack']);
        if (command === 'publish') assert.deepEqual(calls.at(-1).argv, ['publish', join(realpathSync(fixture), '.pi-artifacts', filename)]);
        assert.equal(createHash('sha256').update(readFileSync(resultPath)).digest('hex'), inputSha);
      }
      cases.push({ evidence: label, entrypoint: command, gate: label === 'valid' ? 'RELEASE_READY' : 'RELEASE_NOT_READY', exit: child.status, npmCallCount: calls.length, npmCommands: calls.map(call => call.argv[0]), substitutePublishCount: calls.filter(call => call.argv[0] === 'publish').length });
    }
  }
  writeFileSync(resolve(output), JSON.stringify({ schemaVersion: 1, status: 'VERIFIED', kind: 'no-publication-release-integration', runId: process.env.GITHUB_RUN_ID ?? null, executionSha, inputSha256: inputSha, runtimeSha256: digest, ceVersion: pkg.version, latest, originalTestedAt: original.testedAt, verifiedAt: new Date().toISOString(), cases, safety: { npmExecutor: 'in-process substitute; no OS fallback', realPublish: false, oidc: false, credentials: false }, limitations: ['Real npm registry/version absence, tarball bytes and OIDC publication are substituted', 'PR merge checkout validation; official release workflow remains unchanged', 'Cloud NOT_VERIFIED by this integration'] }, null, 2) + '\n');
  console.log(`Verified ${cases.length} gate/entrypoint cases; zero real publication`);
} finally { rmSync(root, { recursive: true, force: true }); }
