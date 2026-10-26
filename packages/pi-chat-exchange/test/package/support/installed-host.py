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
import tempfile
import termios
import time
import urllib.parse

from supervised_pty import SupervisedPty

node_source, npm_source, archive = (pathlib.Path(s).resolve(strict=True) for s in sys.argv[1:])
base = pathlib.Path('/private/tmp/ce-distribution-fix')
base.mkdir(mode=448, exist_ok=True)
# Shared evidence base must be OUR OWN non-symlink, owner-private directory;
# a pre-created world-writable replacement or symlink is refused, never used.
_base_stat = os.lstat(base)
if not stat.S_ISDIR(_base_stat.st_mode) or _base_stat.st_uid != os.geteuid() or (_base_stat.st_mode & 0o077) != 0:
    raise RuntimeError('Unsafe shared evidence base: ' + str(base))
r = pathlib.Path(tempfile.mkdtemp(prefix='installed-host-', dir=base))
r.chmod(448)
print('Installed-host evidence:', r, flush=True)
for d in ['bin', 'home', 'agent', 'tmp', 'cache', 'xdg/config', 'xdg/data', 'xdg/cache', 'consumer', 'host', 'run']:
    (r / d).mkdir(parents=True, exist_ok=True)
node = r / 'bin/node'
shutil.copy2(node_source, node)
env = {'HOME': str(r / 'home'), 'TMPDIR': str(r / 'tmp') + '/', 'PI_CODING_AGENT_DIR': str(r / 'agent'), 'PATH': str(r / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin', 'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8', 'XDG_CONFIG_HOME': str(r / 'xdg/config'), 'XDG_DATA_HOME': str(r / 'xdg/data'), 'XDG_CACHE_HOME': str(r / 'xdg/cache'), 'npm_config_cache': str(r / 'cache/npm'), 'npm_config_userconfig': str(r / 'home/npmrc'), 'npm_config_globalconfig': str(r / 'home/global-npmrc'), 'npm_config_registry': 'https://registry.npmjs.org/', 'npm_config_ignore_scripts': 'true', 'npm_config_audit': 'false', 'npm_config_fund': 'false', 'npm_config_update_notifier': 'false'}
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
        'sessionId': session_match.group(1),
    }
    (r / 'durable-expect.json').write_text(json.dumps(expect, indent=2))
    module = str(pathlib.Path(__file__).resolve().parent / 'durable_state.py')
    outcomes = {}
    for mode in ['profile', 'policy', 'mutex', 'store']:
        result = subprocess.run(['/usr/bin/python3', '-B', module, mode, str(r / 'durable-expect.json')], capture_output=True, text=True, timeout=120)
        outcomes[mode] = {'exit': result.returncode, 'stderr': (result.stderr or '').strip()[:400]}
        if result.returncode != 0:
            raise RuntimeError('durable ' + mode + ' refused: ' + outcomes[mode]['stderr'] + '; evidence ' + str(r))
    (r / 'durable-state.json').write_text(json.dumps({'expect': expect, 'outcomes': outcomes}, indent=2))


def verify_module_origin():
    """Every filesystem module resolution the Host performed must stay inside
    this run's installed trees (consumer/host/node/run). Read-only analysis of
    the trace the committed preload recorded during the run."""
    trace = r / 'run/module-resolution.jsonl'
    if not trace.is_file():
        raise RuntimeError('module resolution trace missing')
    allowed = [str(r / 'consumer') + '/', str(r / 'host') + '/', str(r / 'bin') + '/', str(r / 'run') + '/', str(node)]
    total = 0
    outside = []
    for line in trace.read_text(errors='replace').splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        resolved = record.get('resolved') or ''
        if not resolved.startswith('file:'):
            continue
        total += 1
        path = urllib.parse.unquote(urllib.parse.urlparse(resolved).path)
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
command('node-version', [node, '--version'])
if (r / 'node-version.log').read_text().strip() != 'v24.21.0':
    raise RuntimeError('Unapproved Node')
(r / 'archive-sha256.txt').write_text(hashlib.sha256(archive.read_bytes()).hexdigest() + '\n')
command('consumer-install', [node, npm_source, 'install', '--prefix', r / 'consumer', '--omit=dev', '--ignore-scripts', '--save-exact', archive])
command('host-install', [node, npm_source, 'install', '--prefix', r / 'host', '--ignore-scripts', '--save-exact', '@earendil-works/pi-coding-agent@1.3.0'])
for tree in ['consumer', 'host']:
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
    (r / (tree + '-tree.json')).write_text(json.dumps(audit, indent=2))
    (r / (tree + '-lifecycle.json')).write_text(json.dumps(hooks, indent=2))
    for lock in (r / tree / 'node_modules').glob('.package-lock.json'):
        shutil.copy2(lock, r / (tree + '-package-lock.json'))
cli = r / 'host/node_modules/@earendil-works/pi-coding-agent/dist/cli.js'
package = r / 'consumer/node_modules/@zieglar/pi-chat-exchange'
assert not package.is_symlink() and (package / 'dist/bin/mcp-stdio.js').is_file()
env.update({'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0', 'CE_NODE_PATH': str(node), 'CE_TUNNEL_CLIENT_PATH': str(r / 'run/absent-synthetic-client'), 'CE_TUNNEL_PROFILE': str(r / 'run/profile/tunnel.yaml')})
(r / 'runtime-env.json').write_text(json.dumps(env, indent=2))
sb = r / 'runtime.sb'
sb.write_text('(version 1)\n(allow default)\n(deny network*)\n(deny file-read* (subpath "/Users") (subpath "/opt/homebrew") (subpath "' + str(r / 'cache') + '") (literal "' + str(archive) + '"))\n(deny process-exec (subpath "/Users") (subpath "/opt/homebrew") (regex "tunnel-client"))\n(allow process-exec (literal "/bin/ps") (with no-sandbox))\n')
sandbox = ['/usr/bin/sandbox-exec', '-f', sb]
# Developer-tree denial uses a KNOWN-EXISTING sentinel (/Users always exists on
# macOS) and requires the EXACT EPERM errno inside the sandbox — an ENOENT exit
# would prove nothing. The archive literal-deny gets the same exact treatment.
command('sentinel-positive', [node, '-e', 'require("node:fs").readdirSync("/Users");require("node:fs").readFileSync(process.argv[1],"utf8")'.replace('process.argv[1]','"' + str(archive) + '"'), archive])
command('deny-developer-tree', sandbox + [node, '-e', 'try{require("node:fs").readdirSync("/Users")}catch(e){process.exit(e.code==="EPERM"?0:3)}process.exit(2)'])
command('deny-known-archive-read', sandbox + [node, '-e', 'try{require("node:fs").readFileSync("' + str(archive) + '","utf8")}catch(e){process.exit(e.code==="EPERM"?0:3)}process.exit(2)'])
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
command('owned-ps-probe', sandbox + ['/bin/ps', '-p', str(os.getpid()), '-o', 'pid=,lstart='])
command('pi-version', sandbox + [node, cli, '--version'])
command('pi-install', sandbox + [node, cli, 'install', package])
listing = command('pi-list', sandbox + [node, cli, 'list'])
assert str(package) in listing
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
    (r / 'result.json').write_text(json.dumps({'PACKAGE_INSTALL': 'PASS', 'REAL_HOST_LOAD': 'PASS', 'FIRST_RUN': 'PASS', 'CLOUD_TRANSPORT': 'NOT_VERIFIED'}, indent=2))
    verify_durable()
    verify_module_origin()
finally:
    try:
        p.close()
    finally:
        os.close(master)
        ps_after = ps_identity('ps-after')
        if ps_after != ps_before:
            raise RuntimeError('OS ps identity drift')
        (r / 'host.txt').write_text(text())
        (r / 'pty-actions.json').write_text(json.dumps({'argv': argv, 'pid': p.pid, 'exit': p.poll(), 'guardianOutcome': 'raw/guardian-outcome.json', 'actions': actions}, indent=2))
