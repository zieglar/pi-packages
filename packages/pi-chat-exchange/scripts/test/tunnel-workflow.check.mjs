import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
const requireFromHost = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { parse } = requireFromHost('yaml');
const root = resolve(import.meta.dirname, '../../../..');
const load = name => parse(readFileSync(resolve(root, '.github/workflows', name), 'utf8'));
const commands = job => job.steps.map(s => s.run ?? '').join('\n');
test('fixed PR lane is required, pinned and does not depend on latest', () => {
  const ci = load('ci.yml'), job = ci.jobs['tunnel-compat'];
  assert(ci.on.pull_request !== undefined); assert.match(commands(job), /result\.json" 0\.0\.19/);
  assert.doesNotMatch(commands(job), /result\.json" latest/); assert(!job['continue-on-error']);
  assert.match(commands(job), /tunnel-compat\.check\.mjs/);
  // Existing validate job already owns full TS tests/build/typecheck.
  assert.match(commands(ci.jobs.validate), /pnpm typecheck/); assert.match(commands(ci.jobs.validate), /pnpm test/);
});
test('latest monitor only scheduled/manual, read-only, no writes or raw log upload', () => {
  const w = load('tunnel-client-latest.yml'); assert(w.on.schedule); assert(w.on.workflow_dispatch !== undefined);
  assert.equal(w.on.pull_request, undefined); assert.deepEqual(w.permissions, { contents: 'read' });
  const job = w.jobs.latest; assert.match(commands(job), /result\.json" latest/);
  assert.doesNotMatch(commands(job), /gh (issue|pr)|git push|publish|setup|pairing/i);
  assert.equal(job.steps.find(s => s.uses?.startsWith('actions/upload-artifact')).with.path, '${{ runner.temp }}/tunnel-latest/result.json');
});
test('release depends on fresh no-OIDC latest job and gate is enforced by both publication entry points', () => {
  const w = load('npm-publish.yml'); assert.equal(w.jobs.publish.needs, 'tunnel-latest');
  assert.deepEqual(w.jobs['tunnel-latest'].permissions, { contents: 'read' });
  assert.match(commands(w.jobs['tunnel-latest']), /result\.json" latest/);
  assert.equal(w.jobs.publish.env.CE_TUNNEL_COMPAT_RESULT, '${{ runner.temp }}/tunnel-release/result.json');
  const script = readFileSync(resolve(root, 'packages/pi-chat-exchange/scripts/npm-release.mjs'), 'utf8');
  assert(script.indexOf('await assertTunnelReleaseReady({ directory })') < script.indexOf('assertVersionAbsent(pkg, directory, run)'));
  assert.match(script, /const \{ artifactPath \} = await preflight\(\)/);
});
test('all new/modified workflows use pinned actions and bounded read-only client jobs', () => {
  for (const name of ['ci.yml', 'npm-publish.yml', 'tunnel-client-latest.yml']) {
    const w = load(name);
    for (const [key, job] of Object.entries(w.jobs)) {
      for (const step of job.steps ?? []) if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (['tunnel-compat', 'tunnel-latest', 'latest'].includes(key)) {
        assert(job['timeout-minutes'] <= 15); assert(!job.permissions?.['id-token']);
        assert(!commands(job).includes('CE_TUNNEL_BACKGROUND_ALLOW'));
      }
    }
  }
});
