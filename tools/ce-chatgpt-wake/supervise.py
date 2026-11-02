#!/usr/bin/env python3
"""Own one bounded existing-Tunnel test window; stop only children we spawned."""
import datetime
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ce-ovis-desktop'))
from health_probe import health_probe  # type: ignore[import-not-found]
from lifecycle import stop_group, stop_hosts, namespace_hosts  # type: ignore[import-not-found]
config_file = Path(sys.argv[1]).resolve()
try:
    config = json.loads(config_file.read_text())
except (OSError, ValueError) as error:
    raise ValueError(f'INVALID_SUPERVISOR_CONFIG: {error}') from error
root = Path(config['runDirectory'])
os.umask(0o077)
stop = False


def stopping(*_args):
    global stop
    stop = True


for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, stopping)
end = datetime.datetime.fromisoformat(config['deadline'].replace('Z', '+00:00')).timestamp()
if not 0 < end - time.time() <= 900:
    raise ValueError('BOUNDED_WINDOW_REQUIRED')
if any((root / name).exists() for name in ('supervisor.json', 'peer-ready.json', 'peer-closed.json', 'peer-failure.json', 'stop-request')):
    raise ValueError('WINDOW_ALREADY_USED_PREPARE_NEW_DIRECTORY')
try:
    desktop_configs = [json.loads(Path(t['desktopConfig']).read_text()) for t in config.get('tasks', [config])]
except (OSError, ValueError) as error:
    raise ValueError(f'INVALID_DESKTOP_CONFIG: {error}') from error
desktop_namespaces = {(d['desktopTmpDir'], d['agentDesktop']) for d in desktop_configs}
for directory, _executable in desktop_namespaces:
    Path(directory).mkdir(mode=0o700, parents=True, exist_ok=True)
    if (Path(directory) / 'command-in-flight').exists() or namespace_hosts(directory):
        raise ValueError('DESKTOP_NAMESPACE_ALREADY_IN_USE')
# Exact existing runtime conflict check; never terminate someone else's Client.
ps = subprocess.check_output(['/bin/ps', '-axo', 'pid=,command='], text=True)
if any('tunnel-client run ' in line and 'ctx-mode' not in line for line in ps.splitlines()):
    raise ValueError('EXISTING_CLIENT_RUNNING')
env = {**os.environ, 'HOME': config['isolatedHome'], 'XDG_CONFIG_HOME': config['isolatedHome'] + '/.config', 'CE_TUNNEL_PROFILE': str(root / 'tunnel.yaml'), 'CE_TUNNEL_CLIENT_PATH': config['client']}
peer = client = None
logs = []
status = {'state': 'STARTING', 'deadline': config['deadline'], 'supervisorPid': os.getpid()}


def save():
    tmp = root / 'supervisor.json.tmp'
    tmp.write_text(json.dumps(status, indent=2))
    os.replace(tmp, root / 'supervisor.json')


def launch(args, name):
    f = (root / (name + '-private.log')).open('w')
    logs.append(f)
    return subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=f, stderr=f, start_new_session=True)


try:
    peer = launch([config['node'], str(Path(__file__).with_name('peer.mjs')), str(config_file)], 'peer')
    status['peerPid'] = peer.pid
    save()
    ready_by = min(end, time.time() + 30)
    while not (root / 'peer-ready.json').exists():
        if stop or peer.poll() is not None or (root / 'peer-failure.json').exists() or time.time() > ready_by:
            raise RuntimeError('PI_PEER_NOT_READY')
        time.sleep(0.2)
    client = launch([config['client'], 'run', '--config', str(root / 'tunnel.yaml')], 'client')
    status.update(clientPid=client.pid, state='AWAITING_HEALTH')
    save()
    while not stop and time.time() < end:
        if peer.poll() == 0 and client.poll() is None and not (root / 'peer-failure.json').exists() and (root / 'peer-closed.json').exists() and (root / 'completed.json').exists():
            completed = json.loads((root / 'completed.json').read_text())
            if completed.get('rounds') == 2 and completed.get('actualCeRepliesReadAndAcked') is True:
                status['reason'] = 'COMPLETED'
                break
        if peer.poll() is not None or client.poll() is not None or (root / 'peer-failure.json').exists():
            raise RuntimeError('CHILD_EXITED')
        if (root / 'health.url').exists() and status['state'] != 'READY':
            probe = health_probe([config['client'], 'health', '--url-file', str(root / 'health.url'), '--pid', str(client.pid), '--require-control-plane-poll', '--json'], env=env, cwd=root, deadline=time.monotonic()+max(0,end-time.time()), stop_requested=lambda: stop or (root / 'stop-request').exists())
            if probe is not None and probe.returncode == 0:
                status.update(state='READY', readyAt=datetime.datetime.now(datetime.UTC).isoformat())
                save()
        if stop or time.time() >= end or (root / 'stop-request').exists():
            break
        time.sleep(1)
except Exception as error:
    status.update(state='STOPPING', reason=type(error).__name__ + ':' + str(error))
finally:
    cleanup_ok = True
    (root / 'stop-request').write_text('supervisor shutdown\n')
    for child, label in [(client, 'client'), (peer, 'peer')]:
        if child is None:
            continue
        if label == 'peer' and child.poll() is None:
            (root / 'stop-request').write_text('supervisor shutdown\n')
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.send_signal(signal.SIGTERM)
        elif child.poll() is None:
            child.send_signal(signal.SIGTERM)
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            status[label + 'Forced'] = True
        try:
            cleaned = stop_group(child)
            cleanup_ok = cleanup_ok and cleaned
            status[label + 'GroupStopped'] = cleaned
        except (OSError, subprocess.SubprocessError):
            cleanup_ok = False
            status[label + 'GroupStopped'] = False
        status[label + 'Exit'] = child.returncode
    for directory, executable in desktop_namespaces:
        try:
            uncertain = (Path(directory) / 'command-in-flight').exists()
            cleanup_ok = stop_hosts(directory, executable, startup_uncertain=uncertain) and cleanup_ok
        except (ValueError, OSError, subprocess.SubprocessError):
            cleanup_ok = False
    status['desktopHostsStopped'] = cleanup_ok
    for log in logs:
        log.close()
    status.update(state='CLOSED' if cleanup_ok else 'CLEANUP_UNCONFIRMED', healthAbsent=not (root / 'health.url').exists(), closedAt=datetime.datetime.now(datetime.UTC).isoformat())
    save()
