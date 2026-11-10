#!/usr/bin/env python3
"""One bounded explicit-only cutover. No CE sends, payload reads, GUI calls or policy writes."""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import sqlite3
import stat
import subprocess
import time
import uuid
from pathlib import Path

spec = importlib.util.spec_from_file_location('cutover_driver', Path(__file__).with_name('auto_wake.py'))
assert spec and spec.loader
auto_wake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(auto_wake)

BASELINE_FILES = ('config.json', 'auto-wake.json', 'tools/ce-chatgpt-wake/wake.py',
                  'tools/ce-chatgpt-wake/auto_wake.py', 'tools/ce-chatgpt-wake/notification.py',
                  'tools/ce-chatgpt-wake/resolve-runtime.mjs', 'tools/ce-ovis-desktop/bridge.py',
                  'tools/ce-ovis-desktop/lifecycle.py')
SOURCE_FILES = ('conversation_guard.py', 'auto_wake.py')


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('UNSAFE_DIRECTORY')


def sha(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        auto_wake.wake.private_hook_file(stream.fileno())
        return hashlib.sha256(stream.read()).hexdigest()


def verify_files(root, expected):
    for name, digest in expected.items():
        if sha(root / name) != digest:
            raise ValueError('BASELINE_CHANGED')


def atomic_write(path, content):
    temporary = path.parent / ('.explicit-only-' + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def active_processes(root):
    # Never return process arguments: a desktop client's argv can contain private input.
    raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,args='], timeout=3).decode('utf8', errors='replace')
    found = []
    prefix = str(root / 'tools/ce-chatgpt-wake') + '/'
    for line in raw.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and any(prefix + name in fields[1] for name in ('wake.py', 'auto_wake.py', 'notification.py')):
            found.append({'pid': int(fields[0])})
    for marker in Path('/private/tmp').glob('cew-*/command-in-flight'):
        value = marker.read_text().strip()
        if not value.isdigit():
            raise ValueError('INFLIGHT_MARKER_UNKNOWN')
        try:
            os.kill(int(value), 0)
            raise ValueError('ACTIVE_DESKTOP_COMMAND')
        except ProcessLookupError:
            pass
    return found


def quiet_claims(state):
    claims = []
    for path in state.glob('msg_*.json'):
        if path.name.endswith('.dispatch.json'):
            continue
        saved = auto_wake.read_private(path)
        if not isinstance(saved, dict) or saved.get('stage') not in ('OBSERVED', 'SUPPRESSED'):
            raise ValueError('UNSETTLED_WAKE')
        claims.append({'messageId': path.stem, 'stage': saved['stage']})
    return claims


def current_owner(config):
    runtime = auto_wake.resolve_runtime(config)
    # Selected policy/process proof is supplemented by the actual attached CE Owner.
    uri = Path(runtime['databasePath']).as_uri() + '?mode=ro'
    db = sqlite3.connect(uri, uri=True, timeout=2)
    owners = {}
    try:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        for role in ('Sender', 'Recipient'):
            rows = db.execute('''SELECT p.participant_id,o.session_id,o.expires_at,o.fencing_token FROM participant p
JOIN participant_ownership o USING(participant_id)
JOIN participant_session s ON s.participant_id=p.participant_id AND s.session_id=o.session_id
JOIN exchange_membership m ON m.participant_id=p.participant_id
JOIN exchange e ON e.exchange_id=m.exchange_id
WHERE p.endpoint_adapter=? AND p.endpoint_id=? AND m.exchange_id=? AND s.detached_at IS NULL AND e.state='OPEN' ''',
                              (runtime['hook' + role + 'Adapter'], runtime['hook' + role + 'EndpointId'], runtime['hookExchangeId'])).fetchall()
            if len(rows) != 1:
                raise ValueError('ATTACHED_OWNER_REQUIRED')
            expiry = datetime.datetime.fromisoformat(rows[0][2].replace('Z', '+00:00'))
            if expiry.tzinfo is None or expiry <= datetime.datetime.now(datetime.UTC):
                raise ValueError('OWNER_LEASE_EXPIRED')
            if role == 'Sender' and rows[0][:2] != (runtime['participantId'], runtime['ceSessionId']):
                raise ValueError('SENDER_OWNER_CHANGED')
            owners[role] = {'participantId': rows[0][0], 'sessionId': rows[0][1], 'fencingToken': rows[0][3]}
    finally:
        db.close()
    return {**runtime, 'owners': owners}


def cutover(root, source, baseline, backup, *, owner_probe=current_owner, process_probe=active_processes):
    """Probe seams are deterministic tests only. The CLI cannot override them."""
    root, source, backup = Path(root), Path(source), Path(backup)
    if not all(p.is_absolute() for p in (root, source, backup)):
        raise ValueError('ABSOLUTE_PATH_REQUIRED')
    private_directory(root)
    if (not isinstance(baseline, dict) or set(baseline) != {'files', 'source'}
            or set(baseline['files']) != set(BASELINE_FILES) or set(baseline['source']) != set(SOURCE_FILES)):
        raise ValueError('BASELINE_INVALID')
    verify_files(root, baseline['files'])
    verify_files(source, baseline['source'])
    if os.path.lexists(root / 'tools/ce-chatgpt-wake/conversation_guard.py'):
        raise ValueError('GUARD_ALREADY_PRESENT')
    config = auto_wake.load_config(root / 'auto-wake.json')
    state = Path(config['stateDir'])
    private_directory(state)
    original_outer = (root / 'config.json').read_bytes()
    if auto_wake.read_private(root / 'config.json') != {'autoWakeConfig': str(root / 'auto-wake.json')}:
        raise ValueError('OWNING_ENTRY_CHANGED')
    claims = quiet_claims(state)
    if process_probe(root):
        raise ValueError('ACTIVE_WAKE')
    owner = owner_probe(config)
    with auto_wake.locked(state / '.admission.lock'), auto_wake.locked(state / '.desktop.lock'):
        verify_files(root, baseline['files'])
        quiet_claims(state)
        if process_probe(root):
            raise ValueError('ACTIVE_WAKE')
        if owner_probe(config) != owner:
            raise ValueError('OWNER_CHANGED')
        backup.mkdir(mode=0o700, parents=True)
        for name in BASELINE_FILES:
            destination = backup / 'before' / name
            destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            atomic_write(destination, (root / name).read_bytes())
        atomic_write(backup / 'baseline.json', (json.dumps(baseline, indent=2) + '\n').encode())
        atomic_write(backup / 'quiescence.json', (json.dumps({'claims': claims, 'owner': owner}, indent=2) + '\n').encode())
        # Empty config is rejected by the old Hook before notification/desktop effects.
        # A local Hook refusal cannot undo the already-committed CE message.
        atomic_write(root / 'config.json', b'{}\n')
        try:
            deadline = time.monotonic() + 12
            while process_probe(root):
                if time.monotonic() >= deadline:
                    raise ValueError('OLD_ENTRY_NOT_DRAINED')
                time.sleep(.05)
            quiet_claims(state)
            for name in SOURCE_FILES:
                atomic_write(root / 'tools/ce-chatgpt-wake' / name, (source / name).read_bytes())
            config['conversationGuard'] = {'mode': 'explicit-only'}
            atomic_write(root / 'auto-wake.json', (json.dumps(config, indent=2) + '\n').encode())
            installed = {name: sha(root / name) for name in (*BASELINE_FILES, 'tools/ce-chatgpt-wake/conversation_guard.py')
                         if name != 'config.json'}
            installed['config.json'] = hashlib.sha256(original_outer).hexdigest()
            result = {'mode': 'explicit-only', 'preparedAt': datetime.datetime.now(datetime.UTC).isoformat(),
                      'ownerDirectory': str(root), 'installed': installed, 'stateDir': str(state),
                      'afterAuditSequence': config['afterAuditSequence']}
            # Persist rollback evidence before reopening even the guarded entry.
            atomic_write(backup / 'activation.json', (json.dumps(result, indent=2) + '\n').encode())
            if owner_probe(config) != owner:
                raise ValueError('OWNER_CHANGED_BEFORE_REOPEN')
            atomic_write(root / 'config.json', original_outer)
            return result
        except BaseException:
            atomic_write(root / 'config.json', b'{}\n')
            raise


def close_entry(root, activation, *, process_probe=active_processes):
    """Close the controlled ingress first. Diagnostics never block safe closure.

    Existing admitted work is not cancelled; it is reported for operator reconciliation.
    No code, attempt journal, CE authority or old automatic mode is restored.
    """
    root = Path(root)
    if not root.is_absolute() or not isinstance(activation, dict) or activation.get('ownerDirectory') != str(root):
        raise ValueError('ROLLBACK_OWNER_MISMATCH')
    private_directory(root)
    outer = auto_wake.read_private(root / 'config.json')
    if outer not in ({}, {'autoWakeConfig': str(root / 'auto-wake.json')}):
        raise ValueError('ENTRY_NOT_RECOGNIZED')
    prior_outer_sha = sha(root / 'config.json')
    atomic_write(root / 'config.json', b'{}\n')
    report = {'entry': 'CLOSED', 'installedDrift': [], 'unsettledClaims': [],
              'activeProcesses': None, 'diagnosticErrors': []}
    expected = activation.get('installed')
    if not isinstance(expected, dict):
        expected = {}
        report['diagnosticErrors'].append('ACTIVATION_HASHES_UNAVAILABLE')
    for name in (*BASELINE_FILES, 'tools/ce-chatgpt-wake/conversation_guard.py'):
        try:
            digest = prior_outer_sha if name == 'config.json' else sha(root / name)
            if digest != expected.get(name):
                report['installedDrift'].append(name)
        except (ValueError, OSError):
            report['installedDrift'].append(name)
    try:
        state = Path(activation['stateDir'])
        private_directory(state)
        for path in state.glob('msg_*.json'):
            if path.name.endswith('.dispatch.json'):
                continue
            try:
                saved = auto_wake.read_private(path)
                stage = saved.get('stage') if isinstance(saved, dict) else None
            except (ValueError, OSError):
                stage = None
            if stage not in ('OBSERVED', 'SUPPRESSED'):
                known = ('ADMITTED', 'AUTO_MAY_HAVE_OCCURRED', 'UNKNOWN', 'FALLBACK_MAY_HAVE_OCCURRED', 'FALLBACK_FINISHED')
                report['unsettledClaims'].append({'messageId': path.stem,
                                                 'stage': stage if stage in known else 'UNREADABLE_OR_UNKNOWN'})
    except (ValueError, OSError, KeyError, TypeError) as error:
        report['diagnosticErrors'].append(type(error).__name__)
    try:
        report['activeProcesses'] = process_probe(root)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        report['diagnosticErrors'].append(type(error).__name__)
    return report


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--source')
    parser.add_argument('--baseline')
    parser.add_argument('--backup')
    parser.add_argument('--close-entry', metavar='ACTIVATION_JSON')
    args = parser.parse_args()
    if args.close_entry:
        report = close_entry(args.root, auto_wake.read_private(args.close_entry))
        print(json.dumps(report, indent=2))
    else:
        if not all((args.source, args.baseline, args.backup)):
            parser.error('--source, --baseline and --backup are required for cutover')
        result = cutover(args.root, args.source, auto_wake.read_private(args.baseline), args.backup)
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
