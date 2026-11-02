"""Bounded cleanup for groups created with start_new_session and private AX hosts."""
import os
import re
import signal
import subprocess
import time
from pathlib import Path


def require_executable(value, label):
    # Operator configuration uses absolute native paths, never PATH lookup or probing.
    try:
        path = Path(value)
        valid = path.is_absolute() and path.is_file() and os.access(path, os.X_OK)
    except (TypeError, ValueError, OSError):
        valid = False
    if not valid:
        raise ValueError(label + '_EXECUTABLE_REQUIRED')


def client_running(inventory, executable, existing_paths=()):
    # ps renders paths with spaces without shell quoting. Match the configured
    # path before considering argument boundaries; inventory conveys no ownership.
    if not isinstance(existing_paths, (list, tuple)) or any(not isinstance(value, str) or not Path(value).is_absolute() for value in existing_paths):
        raise ValueError('EXISTING_CLIENT_PATHS_REQUIRED')
    paths = {value for item in (executable, *existing_paths) for value in (item, str(Path(item).resolve()))}
    configured = [re.compile(r'^(?:' + re.escape(value) + r'|"' + re.escape(value) + r'"|\'' + re.escape(value) + r'\')\s+run(?:\s|$)') for value in paths]
    standard = re.compile(r'^(?:.*/)?tunnel-client\s+run(?:\s|$)')
    for line in inventory.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2:
            continue
        command = fields[1]
        invocation = re.match(r'^(.*?)\s+run(?:\s|$)', command)
        same_binary = invocation is not None and str(Path(invocation[1].strip('\"\'')).resolve()) in paths
        if same_binary or any(pattern.match(command) for pattern in configured) or standard.match(command):
            return True
    return False


def child_environment(config, root):
    env = {key: value for key, value in os.environ.items() if not key.startswith('CE_')}
    env.update(HOME=config['isolatedHome'], XDG_CONFIG_HOME=config['isolatedHome'] + '/.config',
               CE_TUNNEL_PROFILE=str(root / 'tunnel.yaml'), CE_TUNNEL_CLIENT_PATH=config['client'])
    return env


def group_members(pgid):
    rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,stat='], text=True)
    return [int(p) for p, g, state in (line.split() for line in rows.splitlines())
            if int(g) == pgid and not state.startswith('Z')]


def stop_group(child, grace=2):
    # A reaped leader does not mean its subprocesses have exited.
    for sig, budget in [(signal.SIGTERM, grace), (signal.SIGKILL, 2)]:
        if group_members(child.pid):
            try:
                os.killpg(child.pid, sig)
            except ProcessLookupError:
                pass
        end = time.monotonic() + budget
        while group_members(child.pid) and time.monotonic() < end:
            child.poll()
            time.sleep(0.05)
        if not group_members(child.pid):
            child.wait(timeout=2)
            return True
    return False


def namespace_hosts(directory):
    directory = Path(directory)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_DESKTOP_TMP_REQUIRED')
    proc = subprocess.run(['/usr/sbin/lsof', '-n', '-U', '-Fpn'], capture_output=True, text=True, timeout=5)
    if proc.returncode not in (0, 1):
        raise ValueError('DESKTOP_HOST_DISCOVERY_FAILED')
    found = set()
    pid = None
    for line in proc.stdout.splitlines():
        if line.startswith('p'):
            pid = int(line[1:])
        elif line.startswith('n') and line[1:].startswith(str(directory) + '/') and pid is not None:
            found.add(pid)
    return found


def host_identity(pid):
    proc = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'comm='], capture_output=True, text=True, timeout=2)
    if proc.returncode != 0:
        return None
    started = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True, timeout=2)
    return (proc.stdout.strip(), started.stdout.strip()) if started.returncode == 0 else None


def stop_hosts(directory, executable, startup_uncertain=False):
    expected = str(Path(executable).resolve())
    identities = {}
    end = time.monotonic() + 5
    while time.monotonic() < end:
        hosts = namespace_hosts(directory)
        if not hosts and not startup_uncertain:
            return True
        for pid in hosts:
            identity = host_identity(pid)
            if identity is None:
                continue
            command = identity[0]
            # Recheck executable, start time and private socket before signalling.
            if str(Path(command).resolve()) != expected:
                raise ValueError('DESKTOP_HOST_IDENTITY_MISMATCH')
            if pid in identities and identities[pid] != identity:
                raise ValueError('DESKTOP_HOST_IDENTITY_CHANGED')
            identities[pid] = identity
            if pid in namespace_hosts(directory) and host_identity(pid) == identity:
                try:
                    os.kill(pid, signal.SIGTERM if time.monotonic() < end - 2 else signal.SIGKILL)
                except ProcessLookupError:
                    pass
        time.sleep(0.05)
    return not startup_uncertain and not namespace_hosts(directory)
