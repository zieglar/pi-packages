import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const guard = resolve(import.meta.dirname, 'support/release-integration-npm.mjs');

function probe(code, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ce-release-guard-'));
  try {
    const log = join(root, 'calls.jsonl'), routes = join(root, 'routes.json');
    writeFileSync(routes, JSON.stringify({ view: { status: 1, stderr: 'npm error code E404' }, pack: { status: 0, stdout: '[{"filename":"fixture.tgz","files":[]}]' }, publish: { status: 0, stdout: 'substitute only' } }));
    const r = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '-e', code], {
      encoding: 'utf8', env: { PATH: '', CE_NPM_STUB_LOG: log, CE_NPM_STUB_ROUTES: routes, ...extraEnv },
    });
    return { ...r, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : [] };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test('guard intercepts ESM and CommonJS npm calls with no executable PATH', () => {
  const r = probe("import {execFileSync} from 'node:child_process';import {createRequire} from 'node:module';console.log(execFileSync('npm',['publish','/tmp/fixture.tgz'],{encoding:'utf8'}));const req=createRequire(import.meta.url);console.log(req('node:child_process').execFileSync('npm',['pack'],{encoding:'utf8'}));");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(x => x.argv[0]), ['publish', 'pack']);
  assert.match(r.stdout, /substitute only/);
});
test('guard refuses other executables, subprocess APIs and unexpected npm commands', () => {
  for (const code of ["execFileSync('/usr/bin/touch',['/tmp/ce-must-not-run'])", "execFileSync('npm',['dist-tag','add','x'])", "spawnSync('npm',['publish','x'])", "exec('npm publish')"]) {
    const r = probe(`import {execFileSync,spawnSync,exec} from 'node:child_process';${code}`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /release verification guard/);
    assert.equal(r.calls.length, 0);
  }
});
test('guard refuses publication credentials and OIDC before recording any call', () => {
  for (const key of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const r = probe("import {execFileSync} from 'node:child_process';execFileSync('npm',['publish','x'])", { [key]: 'synthetic-do-not-use' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /release verification guard/);
    assert.equal(r.calls.length, 0);
    assert(!r.stderr.includes('synthetic-do-not-use'));
  }
});
test('verification workflow is PR-only, read-only and downloads current-run evidence', () => {
  const req = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { parse } = req('yaml');
  const w = parse(readFileSync(resolve(import.meta.dirname, '../../../../.github/workflows/tunnel-release-integration.yml'), 'utf8'));
  assert.deepEqual(Object.keys(w.on), ['pull_request']);
  assert.deepEqual(w.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(w.jobs), ['qualify', 'verify']);
  assert.equal(w.jobs.verify.needs, 'qualify');
  const upload = w.jobs.qualify.steps.find(s => s.uses?.startsWith('actions/upload-artifact'));
  const download = w.jobs.verify.steps.find(s => s.uses?.startsWith('actions/download-artifact'));
  assert.equal(upload.with.name, download.with.name);
  assert.deepEqual(Object.keys(download.with).sort(), ['name', 'path']);
  assert.equal(w.jobs.verify.steps.find(s => s.name === 'Production entrypoints with npm substitute').env.CE_EXPECTED_RESULT_SHA256, '${{ needs.qualify.outputs.result_sha256 }}');
  for (const job of Object.values(w.jobs)) {
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions, undefined);
    assert(job['timeout-minutes'] <= 15);
    for (const s of job.steps) {
      if (s.uses) assert.match(s.uses, /@[a-f0-9]{40}$/);
      assert(!/npm publish|gh release|gh workflow run|npm-release\.mjs publish/.test(s.run ?? ''));
      assert(!JSON.stringify(s).includes('secrets.'));
    }
  }
});
