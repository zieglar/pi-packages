// Author/CI tooling only. No Cloud access, account discovery or matrix mutation.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

export const packageRoot = resolve(import.meta.dirname, '..');
const helperRoot = dirname(packageRoot);
export const tunnelRepository = 'openai/tunnel-client';
const repository = tunnelRepository;
import { cpSync, chmodSync } from 'node:fs';
const statuses = new Set(['VERIFIED', 'FAILED', 'NOT_VERIFIED', 'BLOCKED']);
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const sha = /^[0-9a-f]{40}$/;
const hash = /^[0-9a-f]{64}$/;
const requiredChecks = ['profile', 'health', 'normalStop', 'childFailureExit', 'failureStop', 'cleanup'];
function requireValue(ok, field) { if (!ok) throw new Error(`Invalid Tunnel compatibility evidence: ${field}`); }
function object(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function date(x) { return typeof x === 'string' && /^\d{4}-\d\d-\d\dT/.test(x) && Number.isFinite(Date.parse(x)); }
function evidencePath(x) { return typeof x === 'string' && /^evidence\/[A-Za-z0-9._/-]+\.json$/.test(x) && !x.split('/').includes('..'); }
function client(x) {
  requireValue(object(x) && semver.test(x.version) && sha.test(x.sourceCommit) && date(x.publishedAt)
    && x.url === `https://github.com/${repository}/releases/tag/v${x.version}`, 'client');
}
export async function verifyOfficialChecksumAndAttestation(release, directory, runCommand = run) {
  client(release);
  const stem = `tunnel-client-v${release.version}-linux-amd64`, bundle = `tunnel-client-v${release.version}-provenance.sigstore.json`;
  const base = `https://github.com/${repository}/releases/download/v${release.version}`;
  for (const name of [`${stem}.zip`, 'SHA256SUMS.txt', bundle]) runCommand('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--output', join(directory, name), `${base}/${name}`]);
  const verify = ['--bundle', join(directory, bundle), '--repo', repository, '--signer-workflow', `${repository}/.github/workflows/release.yml`, '--source-ref', `refs/tags/v${release.version}`, '--source-digest', release.sourceCommit, '--signer-digest', release.sourceCommit, '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners'];
  for (const name of [`${stem}.zip`, 'SHA256SUMS.txt']) runCommand('gh', ['attestation', 'verify', join(directory, name), ...verify]);
  const sums = readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').split('\n').map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).filter(Boolean).filter(x => x[2] === `${stem}.zip`);
  requireValue(sums.length === 1 && createHash('sha256').update(readFileSync(join(directory, `${stem}.zip`))).digest('hex') === sums[0][1], 'official archive checksum');
  return { stem, bundle, base, checksum: sums[0][1] };
}
function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Invalid or unreadable Tunnel compatibility JSON'); }
}
export function validateMatrix(matrix) {
  requireValue(object(matrix) && matrix.schemaVersion === 1 && semver.test(matrix.regressionVersion) && Array.isArray(matrix.records) && matrix.records.length > 0, 'matrix');
  const seen = new Set();
  for (const r of matrix.records) {
    requireValue(object(r) && object(r.ce) && semver.test(r.ce.version) && sha.test(r.ce.baselineCommit) && hash.test(r.ce.runtimeSha256) && ['clean', 'modified'].includes(r.ce.worktree), 'ce');
    client(r.client);
    const untested = ['offline', 'lifecycle', 'cloud'].every(k => r[k]?.status === 'NOT_VERIFIED');
    requireValue((untested ? r.testedAt === null : date(r.testedAt)) && object(r.environment) && ['os', 'arch', 'node', 'pi', 'native'].every(k => typeof r.environment[k] === 'string' && /^[A-Za-z0-9._-]+$/.test(r.environment[k])), 'environment/date');
    requireValue(Array.isArray(r.limitations) && r.limitations.every(x => typeof x === 'string' && x.length <= 500), 'limitations');
    for (const [key, kind] of Object.entries({ offline: 'automated-offline', lifecycle: 'real-client-local', cloud: 'manual-cloud' })) {
      const lane = r[key]; requireValue(object(lane) && statuses.has(lane.status), key);
      if (lane.status === 'VERIFIED') requireValue(lane.kind === kind && evidencePath(lane.evidence), `${key}.kind/evidence`);
    }
    const id = JSON.stringify([r.ce.version, r.ce.runtimeSha256, r.client.version, r.environment]);
    requireValue(!seen.has(id), 'duplicate combination'); seen.add(id);
  }
  requireValue(matrix.records.some(r => r.client.version === matrix.regressionVersion && r.lifecycle.status === 'VERIFIED'), 'regressionVersion');
  return matrix;
}
export function runtimeDigest(root = packageRoot) {
  const files = ['package.json', 'native/tunnel-keychain.swift'];
  function walk(path) {
    for (const entry of readdirSync(join(root, path)).sort()) {
      const name = `${path}/${entry}`, st = lstatSync(join(root, name));
      requireValue(!st.isSymbolicLink(), 'runtime symlink');
      if (st.isDirectory()) walk(name); else if (st.isFile()) files.push(name);
    }
  }
  walk('src'); walk('pi-extension');
  const h = createHash('sha256');
  for (const name of files.sort()) {
    let bytes = readFileSync(join(root, name));
    if (name === 'package.json') {
      const p = readJson(join(root, name)); // Only runtime metadata affects manual evidence.
      bytes = Buffer.from(JSON.stringify(Object.fromEntries(['name', 'version', 'engines', 'dependencies', 'peerDependencies', 'pi'].map(k => [k, p[k] ?? null]))));
    }
    h.update(name + '\0').update(bytes).update('\0');
  }
  return h.digest('hex');
}
export function parseRelease(raw, commit) {
  requireValue(object(raw) && raw.draft === false && raw.prerelease === false && /^v\d+\.\d+\.\d+$/.test(raw.tag_name), 'stable official release');
  const value = { version: raw.tag_name.slice(1), sourceCommit: commit, publishedAt: raw.published_at, url: raw.html_url };
  client(value); return value;
}
async function api(path, fetcher = fetch) {
  const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pi-chat-exchange-compat' }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Official Tunnel release lookup failed: HTTP ${response.status}`);
  return response.json();
}
export async function discoverRelease(version = 'latest', fetcher = fetch) {
  requireValue(version === 'latest' || semver.test(version), 'requested version');
  const raw = await api(version === 'latest' ? 'releases/latest' : `releases/tags/v${version}`, fetcher);
  requireValue(object(raw) && /^v\d+\.\d+\.\d+$/.test(raw.tag_name), 'release tag');
  const commit = await api(`commits/${raw.tag_name}`, fetcher);
  return parseRelease(raw, commit.sha);
}
export function releaseDecision({ matrix, offline, latest, ceVersion, runtimeSha256, now = Date.now() }) {
  validateMatrix(matrix); client(latest);
  const reasons = [];
  const record = matrix.records.find(r => r.ce.version === ceVersion && r.ce.runtimeSha256 === runtimeSha256 && r.client.version === latest.version && r.client.sourceCommit === latest.sourceCommit && r.lifecycle.status === 'VERIFIED' && r.cloud.status === 'VERIFIED');
  if (!record) reasons.push('latest client lacks matching-source reviewed lifecycle and manual Cloud evidence');
  const age = now - Date.parse(offline?.testedAt);
  if (!object(offline) || offline.schemaVersion !== 1 || offline.kind !== 'automated-offline' || offline.status !== 'VERIFIED'
      || offline.ceVersion !== ceVersion || offline.runtimeSha256 !== runtimeSha256 || offline.client?.version !== latest.version || offline.client?.sourceCommit !== latest.sourceCommit
      || !Number.isFinite(age) || age < 0 || age > 24 * 60 * 60 * 1000 || !requiredChecks.every(k => offline.checks?.[k] === true)) reasons.push('fresh latest-client automated offline lifecycle result missing or invalid');
  return { status: reasons.length ? 'RELEASE_NOT_READY' : 'RELEASE_READY', latest: latest.version, runtimeSha256, reasons };
}
export function readMatrix(root = packageRoot) {
  const directory = join(root, 'compatibility');
  const matrix = validateMatrix(readJson(join(directory, 'tunnel-client.json')));
  for (const r of matrix.records) for (const key of ['offline', 'lifecycle', 'cloud']) {
    if (r[key].status !== 'VERIFIED') continue;
    const evidence = readJson(join(directory, r[key].evidence));
    requireValue(evidence.ce?.runtimeSha256 === r.ce.runtimeSha256 && evidence.client?.sourceCommit === r.client.sourceCommit && evidence.client?.version === r.client.version && evidence[key]?.status === 'VERIFIED', `${key} evidence identity`);
    requireValue(evidence[key].kind === r[key].kind && evidence.ce.version === r.ce.version && evidence.testedAt === r.testedAt, `${key} evidence scope`);
    if (key === 'lifecycle') requireValue(['start', 'health', 'normalStop', 'cleanup'].every(k => evidence.lifecycle[k] === true), 'lifecycle outcomes');
    if (key === 'cloud') {
      const cloud = evidence.cloud;
      requireValue(cloud.kind === 'manual-cloud' && cloud.durableMatch === true && cloud.normalOwnershipRelease === true && cloud.hardStopCleanup === true && cloud.receptionOnly === true, 'manual Cloud outcomes');
      for (const direction of ['forward', 'reverse']) requireValue(/^msg_[A-Z0-9]+$/.test(cloud[direction]?.messageId) && /^rcpt_[A-Z0-9]+$/.test(cloud[direction]?.receiptId) && Number.isSafeInteger(cloud[direction]?.createdAudit) && cloud[direction].createdAudit > 0 && Number.isSafeInteger(cloud[direction]?.receiptAudit) && cloud[direction].receiptAudit > cloud[direction].createdAudit, 'manual Cloud receipt');
    }
  }
  return matrix;
}
export async function assertTunnelReleaseReady({ directory = packageRoot, resultPath = process.env.CE_TUNNEL_COMPAT_RESULT, latest = undefined, now = Date.now() } = {}) {
  if (!resultPath) throw new Error('RELEASE_NOT_READY: CE_TUNNEL_COMPAT_RESULT must name this release run offline result');
  const matrix = readMatrix(directory), pkg = readJson(join(directory, 'package.json'));
  const offline = readJson(resultPath);
  const decision = releaseDecision({ matrix, offline, latest: latest ?? await discoverRelease(), ceVersion: pkg.version, runtimeSha256: runtimeDigest(directory), now });
  if (decision.status !== 'RELEASE_READY') throw new Error(`RELEASE_NOT_READY: ${decision.reasons.join('; ')}`);
  return decision;
}
function run(binary, args, options = {}) { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, ...options }); }
export async function installOfficial(release, output, trustedDirectory = undefined) {
  requireValue(process.platform === 'linux' && process.arch === 'x64', 'CI installer supports Linux x64 only');
  const root = resolve(output); mkdirSync(root, { recursive: true, mode: 0o700 });
  const stem = `tunnel-client-v${release.version}-linux-amd64`, bundle = `tunnel-client-v${release.version}-provenance.sigstore.json`;
  const names = [`${stem}.zip`, 'SHA256SUMS.txt', bundle];
  const base = `https://github.com/${repository}/releases/download/v${release.version}`;
  for (const name of names) run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--output', join(root, name), `${base}/${name}`], { timeout: 125_000 });
  const verify = ['--bundle', join(root, bundle), '--repo', repository, '--signer-workflow', `${repository}/.github/workflows/release.yml`, '--source-ref', `refs/tags/v${release.version}`, '--source-digest', release.sourceCommit, '--signer-digest', release.sourceCommit, '--predicate-type', 'https://slsa.dev/provenance/v1', '--deny-self-hosted-runners'];
  for (const name of [`${stem}.zip`, 'SHA256SUMS.txt']) run('gh', ['attestation', 'verify', join(root, name), ...verify]);
  const sums = readFileSync(join(root, 'SHA256SUMS.txt'), 'utf8').split('\n').map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line)).filter(Boolean).filter(x => x[2] === `${stem}.zip`);
  requireValue(sums.length === 1 && createHash('sha256').update(readFileSync(join(root, `${stem}.zip`))).digest('hex') === sums[0][1], 'official archive checksum');
  // The full official bundle is equivalent to Linux manual installation; never execute archive scripts.
  const members = run('unzip', ['-Z1', join(root, `${stem}.zip`)]).trim().split('\n');
  for (const name of ['tunnel-client', 'cloudflared', 'cloudflared-manifest.json']) requireValue(members.filter(x => x === name).length === 1, `archive member ${name}`);
  // Negative checksum/attestation paths are checked in targeted CI tests.
  run('unzip', ['-q', join(root, `${stem}.zip`), 'tunnel-client', 'cloudflared', 'cloudflared-manifest.json', '-d', join(root, 'bin')]);
  const binary = join(root, 'bin/tunnel-client');
  const version = run(binary, ['--version']).trim();
  requireValue(version.startsWith(`${release.version}+${release.sourceCommit} `) || version === `${release.version}+${release.sourceCommit}`, 'installed version/source');
  return { binary, version, source: `${base}/${stem}.zip`, sha256: sums[0][1], provenance: 'gh attestation verify: official release workflow, tag, source and signer commit, SLSA v1, hosted runner' };
}
export function writeResult(path, result) {
  mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = `## Tunnel compatibility\n\nStatus: **${result.status}**\n\nClient: ${result.client?.version ?? 'unknown'}; source: ${result.client?.sourceCommit ?? 'unknown'}\n\nOffline/local synthetic resources only. Cloud E2E: **NOT_VERIFIED by CI**.\n`;
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }
}
async function main() {
  const [command, output, version = 'latest'] = process.argv.slice(2);
  if (command === 'validate') { readMatrix(); console.log('Tunnel compatibility matrix valid'); }
  else if (command === 'gate') console.log(JSON.stringify(await assertTunnelReleaseReady()));
  else if (command === 'run') {
    requireValue(typeof output === 'string' && output.length > 0, 'result output path');
    let release; const testedAt = new Date().toISOString();
    try {
      release = await discoverRelease(version); const installed = await installOfficial(release, join(dirname(resolve(output)), 'official-client'), process.env.CE_TUNNEL_VERIFY_DIR);
      const { exerciseClient } = await import('./tunnel-compat-lifecycle.mjs');
      const checks = await exerciseClient({ binary: installed.binary, root: packageRoot });
      writeResult(output, { schemaVersion: 1, status: 'VERIFIED', kind: 'automated-offline', ceVersion: JSON.parse(readFileSync(join(packageRoot, 'package.json'))).version, runtimeSha256: runtimeDigest(), testedAt, client: release, installation: installed, checks, environment: { os: process.platform, arch: process.arch, node: process.version }, cloud: { status: 'NOT_VERIFIED' } });
    } catch {
      // Raw client/network logs can contain configuration. Upload only this closed result.
      writeResult(output, { schemaVersion: 1, status: 'FAILED', kind: 'automated-offline', testedAt, client: release, reason: 'Official discovery, verification, install or lifecycle check failed; no fallback performed', cloud: { status: 'NOT_VERIFIED' } });
      process.exitCode = 1;
    }
  } else throw new Error('usage: tunnel-compat.mjs validate | gate | run OUTPUT [latest|VERSION]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
