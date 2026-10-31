// Real official client, local synthetic control plane and isolated CE Store. Never Cloud.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function processRows() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : undefined;
  }).filter(Boolean);
}
async function waitFor(predicate, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await predicate()) return; await pause(100); }
  throw new Error('Synthetic lifecycle deadline exceeded');
}
export async function exerciseClient({ binary, root }) {
  const { buildTunnelProfile, serializeTunnelProfile, childEnvironment } = await import(pathToFileURL(join(root, 'dist/tunnel/profile.js')));
  const { parseHealthProbe } = await import(pathToFileURL(join(root, 'dist/tunnel/health.js')));
  const work = mkdtempSync(join(tmpdir(), 'ce-tunnel-ci-'));
  let cleanup = true;
  try {
    for (const [name, mode, id] of [
      ['legacy', 'normal', `tunnel_${'a'.repeat(32)}`],
      ['namespace', 'normal', `tunnel_ab12_${'a'.repeat(32)}`],
      ['failure', 'failure', `tunnel_${'b'.repeat(32)}`],
      ['failure-stop', 'failure-stop', `tunnel_${'c'.repeat(32)}`],
    ]) {
      const dir = join(work, name); mkdirSync(dir, { mode: 0o700 });
      const home = join(dir, 'home'); mkdirSync(join(home, '.config/pi-chat-exchange'), { recursive: true, mode: 0o700 });
      writeFileSync(join(home, '.config/pi-chat-exchange/sqlite-driver.json'), JSON.stringify({ version: 1, driver: 'node-sqlite' }), { mode: 0o600 });
      const binding = join(dir, 'binding.json');
      writeFileSync(binding, JSON.stringify({ version: 1, store: { directory: join(dir, 'store') }, exchange: { namespace: `ci-${name}`, idempotencyKey: `ci-${name}` }, endpoint: { adapter: 'chatgpt', endpointId: 'chatgpt/main' }, recipients: [] }), { mode: 0o600 });
      const key = join(dir, 'dummy-key'), healthFile = join(dir, 'health.url'), profile = join(dir, 'profile.yaml');
      writeFileSync(key, 'synthetic-local-only', { mode: 0o600 });
      const command = `${process.execPath} ${join(root, 'dist/bin/mcp-stdio.js')} --config ${binding}`;
      writeFileSync(profile, serializeTunnelProfile(buildTunnelProfile({ tunnelId: id, keyFile: key, mcpCommand: command, healthUrlFile: healthFile })), { mode: 0o600 });
      const env = childEnvironment({ HOME: home, PATH: '/usr/bin:/bin', TMPDIR: tmpdir(), MCP_STDIO_FAILURE_POLICY: 'restart', OPENAI_API_KEY: 'must-not-propagate' });
      assert.equal(env.MCP_STDIO_FAILURE_POLICY, 'exit'); assert.equal(env.OPENAI_API_KEY, undefined);
      const paths = [];
      const server = createServer((req, res) => {
        paths.push(req.url.split('?')[0]); req.resume();
        const payload = req.url.includes('/poll') ? { commands: [] } : { id, name: 'synthetic-ci' };
        setTimeout(() => { if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); } }, req.url.includes('/poll') ? 100 : 0);
      });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      const child = spawn(binary, ['run', '--profile-file', profile, '--control-plane.base-url', `http://127.0.0.1:${server.address().port}`], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let output = '', code, signal, faultPid;
      child.stdout.on('data', b => { output = (output + b).slice(-131072); });
      child.stderr.on('data', b => { output = (output + b).slice(-131072); });
      const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (c, s) => { code = c; signal = s; resolve(); }); });
      let hardStop = false;
      const timer = setTimeout(() => { hardStop = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} }, 45_000);
      try {
        await waitFor(async () => {
          assert.equal(code, undefined, 'client exited before health');
          if (!existsSync(healthFile)) return false;
          try {
            const stdout = execFileSync(binary, ['health', '--url-file', healthFile, '--pid', String(child.pid), '--require-control-plane-poll', '--json'], { env, encoding: 'utf8', timeout: 3000 });
            const probe = parseHealthProbe({ stdout, exitCode: 0 }); return probe.connectedEligible && probe.controlPlanePollObserved;
          } catch { return false; }
        }, 20_000);
        assert(paths.includes(`/v1/tunnels/${id}`) && paths.includes(`/v1/tunnels/${id}/poll`));
        const children = processRows().filter(p => p.ppid === child.pid && p.command === command);
        assert.equal(children.length, 1); faultPid = children[0].pid;
        if (mode !== 'normal') process.kill(faultPid, 'SIGKILL');
        if (mode === 'failure-stop') {
          // Only send Stop after the real client has entered fault handling.
          await waitFor(() => output.includes('"msg":"stdio MCP command failed; requesting tunnel-client shutdown"'), 5000);
          child.kill('SIGTERM');
        } else if (mode === 'normal') child.kill('SIGTERM');
        await Promise.race([exited, pause(10_000).then(() => { throw new Error('Client exit deadline'); })]);
        assert.equal(signal, null);
        // Fault shutdown and intentional Stop may race. Official semantics allow
        // nonzero after a real child failure; only normal Stop must be zero.
        if (mode === 'failure-stop') assert([0, 1].includes(code)); else assert.equal(code, mode === 'failure' ? 1 : 0);
        assert.equal(existsSync(healthFile), false);
        assert.equal(output.includes('restarting child'), false);
        assert(!processRows().some(p => p.command === command || p.pid === child.pid || p.pid === faultPid));
        assert.equal(hardStop, false);
      } finally {
        clearTimeout(timer);
        if (code === undefined) {
          child.kill('SIGTERM');
          try { await Promise.race([exited, pause(5000).then(() => { throw new Error('Cleanup deadline'); })]); }
          catch { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; }
        }
        // No force-close of foreign processes; these are the exact test group's descendants.
        const remaining = processRows().filter(p => p.command === command || p.pid === child.pid || p.pid === faultPid);
        if (remaining.length) { cleanup = false; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }
    }
    assert(cleanup);
    return { profile: true, health: true, normalStop: true, childFailureExit: true, failureStop: true, cleanup: true, namespacedSyntheticLocal: true };
  } finally { rmSync(work, { recursive: true, force: true }); }
}
