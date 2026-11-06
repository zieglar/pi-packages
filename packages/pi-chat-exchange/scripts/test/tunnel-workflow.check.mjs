import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  // Shards preserve full default tests; the stable validate context owns their outcome.
  for (const [id, stepName, command] of [
    ['validate-storage', 'Test storage', 'pnpm --dir packages/pi-chat-exchange run test:storage'],
    ['validate-other', 'Test outside storage', "pnpm --dir packages/pi-chat-exchange test --exclude 'test/storage/**'"],
  ]) {
    const shard = ci.jobs[id];
    assert(shard, `missing ${id}`);
    assert.equal(shard.env.CE_DEFAULT_CLIENT_GUARD, '1');
    assert.equal(shard['continue-on-error'], undefined);
    for (const required of ['pnpm build', 'pnpm typecheck', 'pnpm check', 'tooling/check-workspace.mjs']) {
      assert.match(commands(shard), new RegExp(required.replaceAll('.', '\\.').replaceAll('/', '\\/')));
    }
    const testStep = shard.steps.find(step => step.name === stepName);
    assert(testStep, `missing ${id}/${stepName}`);
    assert.equal(testStep.run, command);
    assert.doesNotMatch(commands(shard), /inbox-ack-volume.*exclude|exclude.*inbox-ack-volume|--maxWorkers|test -- --exclude/);
  }
  assert.deepEqual(ci.jobs.validate.needs, ['validate-storage', 'validate-other']);
  assert.equal(ci.jobs.validate.if, 'always()');
  assert.deepEqual(ci.jobs.validate.steps[0].env, {
    STORAGE_RESULT: '${{ needs.validate-storage.result }}',
    OTHER_RESULT: '${{ needs.validate-other.result }}',
  });
  const aggregate = ci.jobs.validate.steps.find(step => step.name === 'Validate all test shards');
  assert(aggregate);
  for (const storage of ['success', 'failure', 'cancelled', 'skipped', '']) {
    for (const other of ['success', 'failure', 'cancelled', 'skipped', '']) {
      const result = spawnSync('bash', ['-e', '-c', aggregate.run], {
        env: { PATH: process.env.PATH, STORAGE_RESULT: storage, OTHER_RESULT: other },
        encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.status, storage === 'success' && other === 'success' ? 0 : 1,
        `storage=${storage} other=${other}: ${result.stderr}`);
    }
  }
  assert.equal(ci.concurrency.group, 'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}');
  assert.equal(ci.concurrency['cancel-in-progress'], "${{ github.ref != 'refs/heads/main' }}");
  const steps = job.steps;
  const buildIndex = steps.findIndex(step => step.run === 'pnpm --dir packages/pi-chat-exchange run build');
  const npmIndex = steps.findIndex(step => step.run === 'node --test scripts/test/npm-release.check.mjs');
  assert(buildIndex >= 0 && npmIndex > buildIndex, 'npm entrypoint regression requires built fixtures');
  assert.equal(steps[npmIndex]['working-directory'], 'packages/pi-chat-exchange');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(steps[npmIndex].env, undefined);
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
  const publish = w.jobs.publish;
  assert.equal(publish.env.CE_TUNNEL_COMPAT_RESULT, undefined);
  const download = publish.steps.find(s => s.uses?.startsWith('actions/download-artifact'));
  for (const command of ['preflight', 'publish']) {
    const step = publish.steps.find(s => s.run === `node scripts/npm-release.mjs ${command}`);
    assert.equal(step.env.CE_TUNNEL_COMPAT_RESULT, `${download.with.path}/result.json`);
  }
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
