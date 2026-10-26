"""Opt-in real install/PTTY regression. No client, provider, network runtime or mocks.
All evidence is retained, including failures. Only exact owned Popen handles are signaled.
"""
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import pty
import re
import select
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import time
import urllib.parse

from loopback_registry import CandidateRegistry
from supervised_pty import SupervisedPty

if len(sys.argv) not in (4, 5) or (len(sys.argv) == 5 and sys.argv[4] not in ('tarball', 'managed-npm')):
    raise RuntimeError('Expected Node, npm CLI, archive and optional tarball/managed-npm mode')
managed = len(sys.argv) == 5 and sys.argv[4] == 'managed-npm'
source = 'npm:@zieglar/pi-chat-exchange@0.2.0'
node_source, npm_source, archive = (pathlib.Path(s).resolve(strict=True) for s in sys.argv[1:4])
base = pathlib.Path('/private/tmp/ce-distribution-fix')
base.mkdir(mode=448, exist_ok=True)
# Shared evidence base must be OUR OWN non-symlink, owner-private directory;
# a pre-created world-writable replacement or symlink is refused, never used.
_base_stat = os.lstat(base)
if not stat.S_ISDIR(_base_stat.st_mode) or _base_stat.st_uid != os.geteuid() or (_base_stat.st_mode & 0o077) != 0:
    raise RuntimeError('Unsafe shared evidence base: ' + str(base))
r = pathlib.Path(tempfile.mkdtemp(prefix='installed-host-', dir=base))
r.chmod(448)
(r / 'result.json').write_text(json.dumps({'PACKAGE_INSTALL': 'INCOMPLETE', 'REAL_HOST_LOAD': 'INCOMPLETE', 'FIRST_RUN': 'INCOMPLETE', 'CLOUD_TRANSPORT': 'NOT_VERIFIED'}, indent=2))
print('Installed-host evidence:', r, flush=True)
for d in ['bin', 'home', 'agent', 'tmp', 'cache', 'xdg/config', 'xdg/data', 'xdg/cache', 'consumer', 'host', 'run']:
    (r / d).mkdir(parents=True, exist_ok=True)
node = r / 'bin/node'
shutil.copy2(node_source, node)
# Native Pi calls npm itself; copy the exact approved npm closure, not a global
# wrapper or inherited PATH command. All install/remove commands disable hooks.
shutil.copytree(npm_source.parent.parent, r / 'npm', symlinks=False)
npm_source = r / 'npm/bin/npm-cli.js'
for name in ['npmrc', 'global-npmrc']:
    (r / 'home' / name).write_text('')
(r / 'agent/settings.json').write_text(json.dumps({'npmCommand': [str(node), str(npm_source)]}))
env = {'HOME': str(r / 'home'), 'TMPDIR': str(r / 'tmp') + '/', 'PI_CODING_AGENT_DIR': str(r / 'agent'), 'PATH': str(r / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'XDG_CONFIG_HOME': str(r / 'xdg/config'), 'XDG_DATA_HOME': str(r / 'xdg/data'), 'XDG_CACHE_HOME': str(r / 'xdg/cache'), 'npm_config_cache': str(r / 'cache/npm'), 'npm_config_userconfig': str(r / 'home/npmrc'), 'npm_config_globalconfig': str(r / 'home/global-npmrc'), 'npm_config_registry': 'https://registry.npmjs.org/', 'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false', 'npm_config_update_notifier': 'false', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0'}
(r / 'install-env.json').write_text(json.dumps(env, indent=2))

def verify_durable():
    """Durable post-run state (read-only, private fixture only): first-run is
    proven by what the real Host actually persisted, not by PTY strings."""
    transcript = text()
    session_match = re.search(r'Register ONLY current trusted Pi Session ([0-9a-f-]{36})', transcript)
    if not session_match:
        raise RuntimeError('Registered session id absent from transcript')
    expect = {
        'profileDir': str(r / 'run/profile'), 'tunnelId': 'tunnel_Distribution01',
        'credential': 'distribution-fixture-not-a-real-key', 'nodePath': str(node),
        'mcpScript': str(package / 'dist/bin/mcp-stdio.js'), 'endpoint': 'pi/distribution',
        'sessionId': session_match.group(1), 'nodeArgvPrefix': list(map(str, sandbox)),
    }
    (r / 'durable-expect.json').write_text(json.dumps(expect, indent=2))
    module = str(pathlib.Path(__file__).resolve().parent / 'durable_state.py')
    outcomes = {}
    for mode in ['profile', 'policy', 'mutex', 'store']:
        result = subprocess.run(['/usr/bin/python3', '-B', module, mode, str(r / 'durable-expect.json')], env=env, cwd=r / 'run', capture_output=True, text=True, timeout=120)
        outcomes[mode] = {'exit': result.returncode, 'stderr': (result.stderr or '').strip()[:400]}
        if result.returncode != 0:
            raise RuntimeError('durable ' + mode + ' refused: ' + outcomes[mode]['stderr'] + '; evidence ' + str(r))
    (r / 'durable-state.json').write_text(json.dumps({'expect': expect, 'outcomes': outcomes}, indent=2))


def verify_module_origin():
    """Every filesystem module resolution the Host performed must stay inside
    this run's installed trees (consumer/host/bin/run/node). Read-only analysis
    of the trace the committed preload recorded during the run.

    The native managed tree is a legitimate origin ONLY under managed npm; the
    tarball route keeps its strict original allowlist so a managed-root load
    there is still an escape rather than a silently accepted second route."""
    trace = r / 'run/module-resolution.jsonl'
    if not trace.is_file():
        raise RuntimeError('module resolution trace missing')
    allowed = [str(r / 'consumer') + '/', str(r / 'host') + '/', str(r / 'bin') + '/', str(r / 'run') + '/', str(node)]
    if managed:
        allowed.insert(0, str(r / 'agent/npm') + '/')
    total = 0
    outside = []
    for line in trace.read_text(errors='replace').splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        resolved = record.get('resolved') or ''
        if resolved.startswith('file:'):
            path = urllib.parse.unquote(urllib.parse.urlparse(resolved).path)
        elif resolved.startswith('/'):
            path = resolved  # CJS resolutions are absolute paths, not URLs.
        else:
            continue
        path = str(pathlib.Path(path).resolve(strict=True))
        total += 1
        if not any(path.startswith(root) for root in allowed):
            outside.append({'path': path, 'spec': record.get('spec'), 'parent': record.get('parent')})
    summary = {'filesystemResolutions': total, 'outsideAllowedRoots': outside[:20], 'outsideCount': len(outside)}
    (r / 'module-origin.json').write_text(json.dumps(summary, indent=2))
    if total < 500 or outside:
        raise RuntimeError('module origin check failed: ' + json.dumps(summary) + '; evidence ' + str(r))


def command(label, args, timeout=90, expected=0):
    start = time.monotonic()
    with (r / (label + '.log')).open('wb') as log:
        p = subprocess.run(list(map(str, args)), cwd=r / 'run', env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
    with (r / 'commands.jsonl').open('a') as f:
        f.write(json.dumps({'label': label, 'argv': list(map(str, args)), 'exit': p.returncode, 'seconds': time.monotonic() - start}) + '\n')
    if p.returncode != expected:
        raise RuntimeError(label + ' exit ' + str(p.returncode) + '; see ' + str(r))
    return (r / (label + '.log')).read_text(errors='replace')
def owned_command(label, args, timeout=150):
    """Native Pi spawns npm: reuse the existing independent guardian so timeout
    or outer-runner death cannot leave an unowned package-manager descendant."""
    root = r / 'commands' / label
    root.mkdir(parents=True)
    master_fd, slave_fd = pty.openpty()
    child = None
    output = bytearray()
    started = time.monotonic()
    try:
        child = SupervisedPty(root, list(map(str, args)), env, r / 'run', slave_fd)
        os.close(slave_fd)
        slave_fd = None
        while child.poll() is None:
            if time.monotonic() - started > timeout:
                raise TimeoutError('Owned command exceeded budget: ' + label)
            if select.select([master_fd], [], [], .05)[0]:
                try:
                    output.extend(os.read(master_fd, 65536))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
        code = child.wait(timeout=5)
        with (r / 'commands.jsonl').open('a') as log:
            log.write(json.dumps({'label': label, 'argv': list(map(str, args)),
                'exit': code, 'seconds': time.monotonic() - started,
                'guardian': str(root / 'raw/guardian-outcome.json')}) + '\n')
        if code != 0:
            raise RuntimeError(label + ' exit ' + str(code) + '; evidence ' + str(r))
    finally:
        try:
            if child is not None:
                child.close()
        finally:
            if slave_fd is not None:
                os.close(slave_fd)
            os.close(master_fd)
            (r / (label + '.log')).write_bytes(output)

command('node-version', [node, '--version'])
if (r / 'node-version.log').read_text().strip() != 'v24.21.0':
    raise RuntimeError('Unapproved Node')
(r / 'archive-sha256.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '\n')
command('npm-version', [node, npm_source, '--version'])
command('host-install', [node, npm_source, 'install', '--prefix', r / 'host', '--ignore-scripts', '--save-exact', '@earendil-works/pi-coding-agent@1.3.0'])
# Bootstrap CLI needed BEFORE the guide ships with the candidate; the shipped
# guide's own route is compared against it below so a doc/bootstrap divergence
# cannot hide behind a hardcoded path.
bootstrap_cli = r / 'host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
cli = bootstrap_cli

def native_install(label):
    # Installation phase only: own loopback candidate plus explicitly selected
    # npmjs dependency registry. Runtime below is offline and Seatbelt denied.
    # The private registry npmrc and offline flag are restored in `finally` so a
    # failed install cannot leave a dead loopback port configured for later
    # stages; only this private ephemeral root is ever affected.
    env.pop('npm_config_offline', None)
    try:
        with CandidateRegistry(archive, r / 'registry-requests.jsonl') as registry:
            (r / 'home/npmrc').write_text('@zieglar:registry=' + registry.url + '/\n')
            (r / (label + '-registry.json')).write_text(json.dumps(registry.metadata, indent=2))
            owned_command(label, [node, cli, 'install', source], timeout=150)
    finally:
        (r / 'home/npmrc').write_text('')
        env['npm_config_offline'] = 'true'

if managed:
    native_install('pi-managed-install')
else:
    command('consumer-install', [node, npm_source, 'install', '--prefix', r / 'consumer', '--omit=dev', '--ignore-scripts', '--save-exact', archive])
consumer_tree = 'agent/npm' if managed else 'consumer'
def audit_installed_trees(label):
    for tree in [consumer_tree, 'host']:
        audit = []
        hooks = []
        for directory, dirs, files in os.walk(r / tree, followlinks=False):
            for name in dirs + files:
                entry = pathlib.Path(directory) / name
                st = entry.lstat()
                real = entry.resolve()
                if not real.is_relative_to(r / tree):
                    raise RuntimeError('External installed reference: ' + str(entry))
                if entry.is_file() and (not entry.is_symlink()) and (st.st_nlink != 1):
                    raise RuntimeError('Installed hardlink: ' + str(entry))
                audit.append({'path': str(entry.relative_to(r)), 'link': entry.is_symlink(), 'nlink': st.st_nlink})
                if name == 'package.json' and (not entry.is_symlink()):
                    data = json.loads(entry.read_text())
                    scripts = data.get('scripts', {})
                    hooks.append({'path': str(entry.relative_to(r)), 'name': data.get('name'), 'version': data.get('version'), 'scripts': {k: v for k, v in scripts.items() if k in ['preinstall', 'install', 'postinstall', 'prepare']}})
        (r / (label + '-' + tree.replace('/', '-') + '-tree.json')).write_text(json.dumps(audit, indent=2))
        (r / (label + '-' + tree.replace('/', '-') + '-lifecycle.json')).write_text(json.dumps(hooks, indent=2))
        for lock in (r / tree / 'node_modules').glob('.package-lock.json'):
            shutil.copy2(lock, r / (label + '-' + tree.replace('/', '-') + '-package-lock.json'))

audit_installed_trees('initial')
package = r / consumer_tree / 'node_modules/@zieglar/pi-chat-exchange'
if json.loads((package / 'package.json').read_text())['version'] != '0.2.0':
    raise RuntimeError('Installed candidate identity mismatch')
def verify_installed_payload(label):
    if managed and (r / 'agent/npm/node_modules/@earendil-works/pi-coding-agent').exists():
        raise RuntimeError('Native Pi failed to suppress host peer installation')
    hashes = {}
    with tarfile.open(archive, 'r:gz') as packed:
        for member in packed.getmembers():
            if member.isdir():
                continue
            relative = pathlib.PurePosixPath(member.name)
            if not member.isfile() or relative.parts[0] != 'package' or '..' in relative.parts:
                raise RuntimeError('Unsafe archive payload path')
            installed = package.joinpath(*relative.parts[1:])
            if not installed.resolve(strict=True).is_relative_to(package) or installed.is_symlink():
                raise RuntimeError('Borrowed installed payload')
            stream = packed.extractfile(member)
            if stream is None or stream.read() != installed.read_bytes():
                raise RuntimeError('Installed payload differs from tested archive: ' + member.name)
            hashes[str(relative)] = hashlib.sha256(installed.read_bytes()).hexdigest()
    (r / (label + '-payload-sha256.json')).write_text(json.dumps(hashes, indent=2))

verify_installed_payload('initial')
# Execute the shipped guide's actual local-prefix entry with the copied approved
# Node, not an independently hardcoded alternative that could hide a doc defect.
guide = (package / 'docs/independent-install.md').read_text()
cli_match = re.search(r'^CE_PI_CLI="\$HOME/ce-install/(host/[^"\n]+)"$', guide, re.MULTILINE)
if not cli_match:
    raise RuntimeError('Shipped guide has no explicit local-prefix CLI route')
cli = r / cli_match.group(1)
if not cli.is_file() or not cli.resolve().is_relative_to(r / 'host'):
    raise RuntimeError('Shipped guide CLI route is not inside the installed host')
if cli.resolve(strict=True) != bootstrap_cli.resolve(strict=True):
    raise RuntimeError('Shipped guide CLI route differs from the bootstrap CLI used for managed install: '
                       + str(cli) + ' vs ' + str(bootstrap_cli))
(r / 'guide-cli-route.json').write_text(json.dumps({'guideDerived': str(cli),
    'bootstrapUsedForInstall': str(bootstrap_cli), 'identical': True}, indent=2))
assert not package.is_symlink() and (package / 'dist/bin/mcp-stdio.js').is_file()
env.update({'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0', 'CE_NODE_PATH': str(node), 'CE_TUNNEL_CLIENT_PATH': str(r / 'run/absent-synthetic-client'), 'CE_TUNNEL_PROFILE': str(r / 'run/profile/tunnel.yaml')})
(r / 'runtime-env.json').write_text(json.dumps(env, indent=2))
author_tree = pathlib.Path(__file__).resolve().parents[5]
sb = r / 'runtime.sb'
sb.write_text('(version 1)\n(allow default)\n(deny network*)\n(deny file-read* (subpath "/Users") (subpath "/opt/homebrew") (subpath ' + json.dumps(str(author_tree)) + ') (subpath "' + str(r / 'cache') + '") (literal "' + str(archive) + '"))\n(deny process-exec (subpath "/Users") (subpath "/opt/homebrew") (regex "tunnel-client"))\n(allow process-exec (literal "/bin/ps") (with no-sandbox))\n')
sandbox = ['/usr/bin/sandbox-exec', '-f', sb]
# Developer-tree denial uses a KNOWN-EXISTING sentinel (/Users always exists on
# macOS) and requires the EXACT EPERM errno inside the sandbox — an ENOENT exit
# would prove nothing. The archive literal-deny gets the same exact treatment.
command('sentinel-positive', [node, '-e', 'require("node:fs").readdirSync("/Users");require("node:fs").readFileSync(process.argv[1],"utf8")'.replace('process.argv[1]','"' + str(archive) + '"'), archive])
command('deny-developer-tree', sandbox + [node, '-e', 'try{require("node:fs").readdirSync("/Users")}catch(e){process.exit(e.code==="EPERM"?0:3)}process.exit(2)'])
command('deny-known-archive-read', sandbox + [node, '-e', 'try{require("node:fs").readFileSync("' + str(archive) + '","utf8")}catch(e){process.exit(e.code==="EPERM"?0:3)}process.exit(2)'])
# The archive stage itself lives under /private/tmp, not /Users. It must be
# denied explicitly too; a known-existing staged manifest gives an EPERM proof.
staged_manifest = str(author_tree / 'package.json')
command('staged-source-positive', [node, '-e', 'require("node:fs").readFileSync(process.argv[1])', staged_manifest])
command('deny-staged-source', sandbox + [node, '-e', 'try{require("node:fs").readFileSync(process.argv[1])}catch(e){process.exit(e.code==="EPERM"?0:3)}process.exit(2)', staged_manifest])
command('deny-runtime-network', sandbox + [node, '-e', 'const n=require("node:net"); const s=n.connect({host:"127.0.0.1",port:9});s.on("error",e=>process.exit(e.code==="EPERM"?0:2));setTimeout(()=>process.exit(3),1500)'])
# Exact preapproved OS utility exception only. Its execution is outside Seatbelt;
# the Host and every other child remain sandboxed. Never run a broad ps probe.
def ps_identity(label):
    stat = pathlib.Path('/bin/ps').stat()
    data = {'sha256': hashlib.sha256(pathlib.Path('/bin/ps').read_bytes()).hexdigest(), 'mode': oct(stat.st_mode), 'uid': stat.st_uid}
    command(label + '-codesign', ['/usr/bin/codesign', '-dv', '--verbose=4', '/bin/ps'])
    (r / (label + '.json')).write_text(json.dumps(data, indent=2))
    return data
ps_before = ps_identity('ps-before')
if ps_before != {'sha256': 'a06fe087161557f1f8c030672eaedcd90bc6a8e92b8f2d44e07cffedc3349205', 'mode': '0o104755', 'uid': 0}:
    raise RuntimeError('OS ps is not the preapproved utility identity')
command('owned-ps-probe', sandbox + ['/bin/ps', '-p', str(os.getpid()), '-o', 'pid=,lstart='])
command('pi-version', sandbox + [node, cli, '--version'])
if not managed:
    command('pi-install', sandbox + [node, cli, 'install', package])
listing = command('pi-list', sandbox + [node, cli, 'list'])
assert (source if managed else str(package)) in listing
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 180, 0, 0))
# Minimal reuse of the independent verifier's module-resolution trace (committed
# copy): every filesystem resolution the Host performs must stay inside this
# run's installed trees. Copied into the private run dir because the sandbox
# denies reads of the author worktree.
trace_preload = r / 'run/module_trace.cjs'
shutil.copy2(pathlib.Path(__file__).resolve().parent / 'module_trace.cjs', trace_preload)
env['CE_TRACE_OUT'] = str(r / 'run/module-resolution.jsonl')
argv = list(map(str, sandbox + [node, '--require', str(trace_preload), cli, '--offline', '--no-mcp', '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes', '--no-tools', '--no-approve', '--verbose']))
p = SupervisedPty(r, argv, env, r / 'run', slave)
os.close(slave)
raw = bytearray()
actions = []
start = time.monotonic()

def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if select.select([master], [], [], 0.05)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as e:
                if e.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            raw.extend(data)
            with (r / 'host.raw').open('ab') as f:
                f.write(data)

def text():
    return re.sub('\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07]*(?:\\x07|\\x1b\\\\))', '', raw.decode(errors='replace'))

def send(data, label=None):
    actions.append({'seconds': time.monotonic() - start, 'label': label or repr(data)})
    os.write(master, data)
    pump(0.35)

def wait(needle, timeout=15, since=0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        pump(0.1)
        if needle in text()[since:]:
            return
        if p.poll() is not None:
            break
    raise RuntimeError('PTY missing ' + repr(needle) + '; evidence ' + str(r))

def enter():
    send(b'\r')

def down(n=1):
    for _ in range(n):
        send(b'\x1b[B')

def choose(label):
    # Kit preserves focus on return; navigate by observed selected labels, not indexes.
    for _ in range(9):
        if text().rsplit('→', 1)[-1].startswith(' ' + label):
            enter()
            return
        down()
    raise RuntimeError('Cannot select ' + label)

def slash(s):
    at = len(text())
    send((s + '\r').encode())
    return at
def verify_native_lifecycle():
    if not managed:
        return
    # No transport is started in this PTY lane. Manager owned-stop/external/
    # UNKNOWN behavior is covered by the real synthetic manager test lane.
    # This lane proves native package lifecycle AFTER normal binding release
    # and a confirmed normal Host exit, never manufactures a deletion predicate.
    p.close()
    retained_roots = [r / 'run/profile', r / 'agent/sessions']
    unrelated = r / 'run/unrelated-source'
    unrelated.mkdir()
    (unrelated / 'package.json').write_text(json.dumps({'name': 'unrelated-fixture', 'pi': {'extensions': []}}))
    (unrelated / 'independent-session.fixture').write_text('unrelated owned fixture; not a production Session')
    command('pi-install-unrelated', sandbox + [node, cli, 'install', unrelated])
    retained_roots.append(unrelated)
    def snapshot():
        return {str(path.relative_to(r)): hashlib.sha256(path.read_bytes()).hexdigest()
                for root in retained_roots for path in root.rglob('*') if path.is_file()}
    before = snapshot()
    if not before or not any('/.credentials/' in path for path in before):
        raise RuntimeError('Missing retained credential/history fixture')
    # Observe the PERSISTED registration before removal so the post-remove
    # settings clause is falsifiable instead of vacuous on a renamed key.
    declared_before = json.loads((r / 'agent/settings.json').read_text()).get('packages', [])
    if source not in json.dumps(declared_before):
        raise RuntimeError('Managed declaration absent from settings BEFORE remove; '
                           'removal predicate would be vacuous: ' + json.dumps(declared_before)[:400])
    owned_command('pi-native-remove', sandbox + [node, cli, 'remove', source])
    listing = command('pi-list-removed', sandbox + [node, cli, 'list'])
    settings = json.loads((r / 'agent/settings.json').read_text())
    if source in json.dumps(settings.get('packages', [])) or source in listing or package.exists():
        raise RuntimeError('Native remove did not remove both declaration and managed files')
    # Reassert the approved copied npm closure before reinstall: a reinstall must
    # not silently fall back to some other resolver after removal.
    if settings.get('npmCommand') != [str(node), str(npm_source)]:
        raise RuntimeError('Approved copied npm closure lost from settings after remove: '
                           + json.dumps(settings.get('npmCommand')))
    (r / 'managed-declaration.json').write_text(json.dumps({'declaredBeforeRemove': declared_before,
        'declaredAfterRemove': settings.get('packages', []),
        'npmCommandReassertedBeforeReinstall': settings.get('npmCommand')}, indent=2))
    after_remove = snapshot()
    if str(unrelated) not in listing or before != after_remove:
        raise RuntimeError('Native remove changed retained or unrelated fixture state')
    native_install('pi-managed-reinstall')
    audit_installed_trees('reinstalled')
    verify_installed_payload('reinstalled')
    if json.loads((package / 'package.json').read_text())['version'] != '0.2.0' or before != snapshot():
        raise RuntimeError('Reinstall identity or retention mismatch')
    # A fresh real Host rehydrates retained configuration; it does not reuse an
    # ended native Session or silently activate/take over its released binding.
    smoke_root = r / 'reinstall'
    smoke_root.mkdir()
    fd, slave_fd = pty.openpty()
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 50, 180, 0, 0))
    smoke = SupervisedPty(smoke_root, argv, env, r / 'run', slave_fd)
    os.close(slave_fd)
    transcript = bytearray()
    def drain(seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if select.select([fd], [], [], .05)[0]:
                try:
                    data = os.read(fd, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        return
                    raise
                if not data:
                    return
                transcript.extend(data)
    try:
        drain(3)
        os.write(fd, b'\x1b[1;1R')
        drain(1)
        os.write(fd, b'/ce-tunnel doctor\r')
        drain(5)
        observed = transcript.decode(errors='replace')
        if 'MCP child=QUALIFIED' not in observed or 'No client executed' not in observed or 'Pi messaging bound' in observed:
            raise RuntimeError('Reinstalled real Host did not load shipped CE commands')
        os.write(fd, b'/quit\r')
        drain(2)
        if smoke.wait(timeout=10) != 0:
            raise RuntimeError('Reinstalled Host exit failure')
    finally:
        try:
            smoke.close()
        finally:
            os.close(fd)
            (r / 'reinstall-host.raw').write_bytes(transcript)
    verify_module_origin()  # Includes BOTH real Hosts, CJS and file URL paths.
    (r / 'native-lifecycle.json').write_text(json.dumps({'source': source,
        'managedRoot': str(package), 'removedRegistrationAndFiles': True,
        'retainedBefore': before, 'retainedAfterRemove': after_remove,
        'unrelatedSourceRetained': str(unrelated), 'reinstallHost': 'PASS',
        'transport': 'NOT_STARTED; separate synthetic manager tests',
        'cloud': 'NOT_VERIFIED'}, indent=2))

failures = []
try:
    pump(3)
    if p.poll() is not None:
        raise RuntimeError('Host exited before TUI')
    send(b'\x1b[1;1R', 'terminal cursor response')
    pump(1)
    at = slash('/ce-tunnel doctor')
    wait('client=CE_EXECUTABLE_UNTRUSTED', since=at)
    wait('MCP child=QUALIFIED', since=at)
    wait('No client executed', since=at)
    at = slash('/ce-tunnel setup')
    wait('Tunnel ID', since=at)
    send(b'tunnel_Distribution01')
    enter()
    wait('Organization ID', since=at)
    enter()
    wait('Credential', since=at)
    send(b'distribution-fixture-not-a-real-key', 'synthetic masked credential')
    enter()
    wait('Review', since=at)
    choose('Back · Edit configuration')
    choose('Advanced · Messaging')
    wait('Authorize messaging', since=at)
    choose('Authorize messaging')
    choose('Back · Review')
    choose('Review')
    wait('Review · Tunnel configuration', since=at)
    enter()
    wait('Confirm identity / routing changes', since=at)
    enter()
    wait('Save confirmation', since=at)
    choose('Save configuration')
    wait('configuration saved', since=at)
    profile = r / 'run/profile/tunnel.yaml'
    assert profile.is_file()
    at = slash('/ce-tunnel convert')
    wait('ALL old legacy', since=at)
    enter()
    pump(0.3)
    enter()
    wait('multi-session configuration selected', since=at)
    at = slash('/new')
    pump(1)
    at = slash('/ce-tunnel register pi/distribution')
    wait('Register ONLY current trusted Pi Session', since=at)
    enter()
    wait('selected configuration saved', since=at)
    at = slash('/reload')
    pump(2)
    at = slash('/ce-tunnel activate')
    wait('Activate current session', since=at)
    choose('Activate current session')
    wait('Pi messaging bound', since=at)
    at = slash('/ce-tunnel deactivate')
    wait('Deactivate current Pi messaging?', since=at)
    enter()
    wait('Pi messaging deactivated', since=at)
    slash('/quit')
    pump(2)
    if p.poll() is None:
        send(b'\x03')
        send(b'\x03')
        pump(1)
    code = p.wait(timeout=10)
    if code != 0:
        raise RuntimeError('Host exit ' + str(code))
    verify_durable()
    verify_module_origin()
    verify_native_lifecycle()
except BaseException as error:
    failures.append(('run/validation', error))
finally:
    # Attempt every owned cleanup/evidence step, retaining the original error
    # AND subsequent cleanup failures. No saved PID or process group is signalled.
    try:
        p.close()
    except BaseException as error:
        failures.append(('guardian cleanup', error))
    try:
        os.close(master)
    except BaseException as error:
        failures.append(('PTY close', error))
    try:
        ps_after = ps_identity('ps-after')
        if ps_after != ps_before:
            raise RuntimeError('OS ps identity drift')
    except BaseException as error:
        failures.append(('ps identity', error))
    try:
        (r / 'host.txt').write_text(text())
        (r / 'pty-actions.json').write_text(json.dumps({'argv': argv, 'pid': p.pid, 'exit': p.poll(), 'guardianOutcome': 'raw/guardian-outcome.json', 'actions': actions}, indent=2))
    except BaseException as error:
        failures.append(('PTY evidence', error))
    status = 'FAILED' if failures else 'PASS'
    (r / 'result.json').write_text(json.dumps({'INSTALL_ROUTE': 'managed-npm' if managed else 'tarball', 'NATIVE_REMOVE_REINSTALL': status if managed else 'NOT_REQUESTED', 'PACKAGE_INSTALL': status, 'REAL_HOST_LOAD': status, 'FIRST_RUN': status, 'CLOUD_TRANSPORT': 'NOT_VERIFIED', 'errors': [{'stage': stage, 'error': repr(error)} for stage, error in failures]}, indent=2))
    if failures:
        raise RuntimeError('; '.join(stage + ': ' + repr(error) for stage, error in failures)) from failures[0][1]
