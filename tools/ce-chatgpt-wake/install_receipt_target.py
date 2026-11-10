#!/usr/bin/env python3
"""Install the receipt observer behind a closed desktop gate; never activate title-match."""
import argparse
import datetime
import hashlib
import json
import os
import sqlite3
import stat
import subprocess
from pathlib import Path

import activate_explicit_only as gate

# Install dependencies before their users. Existing CE authority/policy files are never written.
OWNER_FILES = ('receipt_target.py', 'conversation_guard.py', 'wake.py', 'notification.py',
               'resolve-runtime.mjs', 'auto_wake.py')
PACKAGE_FILES = ('desktop-target.ts', 'native-inbound.ts', 'index.ts')
ROOT_BASE = (*gate.BASELINE_FILES, 'tools/ce-chatgpt-wake/conversation_guard.py',
             'tools/ce-chatgpt-wake/receipt_target.py')
atomic_write = gate.atomic_write


def read_owned(path, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1
                or info.st_mode & (0o077 if private else 0o022)):
            raise ValueError('UNSAFE_FILE')
        return stream.read()


def sha(path, private=False):
    return hashlib.sha256(read_owned(path, private)).hexdigest()


def owned_directory(path, private=False):
    info = path.lstat()
    if (path.resolve(strict=True) != path or not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid() or info.st_mode & (0o077 if private else 0o022)):
        raise ValueError('UNSAFE_DIRECTORY')


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=True) + '\n').encode()


def read_json(path):
    try:
        return json.loads(read_owned(path, True).decode(), object_pairs_hook=gate.auto_wake.wake.unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('INSTALL_JSON_INVALID') from error


def verify_files(root, expected, private=False):
    for relative, digest in expected.items():
        path = root / relative
        if digest is None:
            if path.exists() or path.is_symlink():
                raise ValueError('BASELINE_CHANGED')
        elif sha(path, private) != digest:
            raise ValueError('BASELINE_CHANGED')


def active_processes(root):
    # Only PIDs escape this boundary; command arguments can contain private input.
    raw = subprocess.check_output(['/bin/ps', '-axo', 'pid=,args='], timeout=3).decode(errors='replace')
    prefix = str(root / 'tools/ce-chatgpt-wake') + '/'
    found = []
    for line in raw.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) == 2 and any(prefix + name in fields[1]
                                   for name in ('wake.py', 'auto_wake.py', 'notification.py', 'receipt_target.py')):
            found.append({'pid': int(fields[0])})
    for marker in Path('/private/tmp').glob('cew-*/command-in-flight'):
        value = marker.read_text().strip()
        if not value.isdigit():
            raise ValueError('INFLIGHT_MARKER_UNKNOWN')
        try:
            os.kill(int(value), 0)
        except ProcessLookupError:
            continue
        raise ValueError('ACTIVE_DESKTOP_COMMAND')
    return found


def latest_audit(owner):
    db = sqlite3.connect(Path(owner['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON')
        return db.execute('SELECT COALESCE(MAX(sequence),0) FROM audit_event WHERE exchange_id=?',
                          (owner['hookExchangeId'],)).fetchone()[0]
    finally:
        db.close()


def install(root, package, source, package_source, baseline, backup, *, owner_probe=gate.current_owner,
            process_probe=active_processes, cutoff_probe=latest_audit):
    """Probe overrides are test seams; the CLI cannot replace authority or quiescence probes."""
    root, package, source, package_source, backup = map(Path, (root, package, source, package_source, backup))
    if not all(p.is_absolute() for p in (root, package, source, package_source, backup)):
        raise ValueError('ABSOLUTE_PATH_REQUIRED')
    for path in (root, root / 'tools', root / 'tools/ce-chatgpt-wake', root / 'tools/ce-ovis-desktop',
                 source, package_source, backup.parent):
        owned_directory(path, True)
    for path in (package, package / 'pi-extension'):
        owned_directory(path)
    if backup.exists() or backup.is_symlink() or any(backup.is_relative_to(p) for p in (root, package, source, package_source)):
        raise ValueError('BACKUP_PATH_INVALID')
    expected_keys = {'owner': set(ROOT_BASE), 'package': set(PACKAGE_FILES),
                     'sourceOwner': set(OWNER_FILES), 'sourcePackage': set(PACKAGE_FILES)}
    if (not isinstance(baseline, dict) or set(baseline) != set(expected_keys)
            or any(not isinstance(baseline[k], dict) or set(baseline[k]) != keys for k, keys in expected_keys.items())):
        raise ValueError('EXPECTED_BASELINE_REQUIRED')
    for kind, values in baseline.items():
        for name, digest in values.items():
            if digest is None and ((kind == 'package' and name == 'desktop-target.ts') or
                                   (kind == 'owner' and name == 'tools/ce-chatgpt-wake/receipt_target.py')):
                continue
            if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
                raise ValueError('HASH_INVALID')
    if baseline['owner']['tools/ce-chatgpt-wake/receipt_target.py'] is not None or baseline['package']['desktop-target.ts'] is not None:
        raise ValueError('TARGET_ALREADY_EXISTS')
    verify_files(root, baseline['owner'], True)
    verify_files(package / 'pi-extension', baseline['package'])
    verify_files(source, baseline['sourceOwner'], True)
    verify_files(package_source, baseline['sourcePackage'], True)
    entry_bytes = read_owned(root / 'config.json', True)
    if read_json(root / 'config.json') != {'autoWakeConfig': str(root / 'auto-wake.json')}:
        raise ValueError('OWNING_ENTRY_CHANGED')
    config = gate.auto_wake.load_config(root / 'auto-wake.json')
    if config['ownerDirectory'] != str(root) or config['packageRoot'] != str(package):
        raise ValueError('OWNER_PATH_CHANGED')
    if config.get('conversationGuard') != {'mode': 'explicit-only'}:
        raise ValueError('NOT_PREVIOUS_EXPLICIT_ONLY')
    owned_directory(Path(config['stateDir']), True)
    if process_probe(root):
        raise ValueError('ACTIVE_WAKE')
    claims = gate.quiet_claims(Path(config['stateDir']))
    owner = owner_probe(config)
    state = Path(config['stateDir'])
    with gate.auto_wake.locked(state / '.admission.lock'), gate.auto_wake.locked(state / '.desktop.lock'):
        verify_files(root, baseline['owner'], True)
        verify_files(package / 'pi-extension', baseline['package'])
        gate.quiet_claims(state)
        if process_probe(root):
            raise ValueError('ACTIVE_WAKE')
        if owner_probe(config) != owner:
            raise ValueError('OWNER_CHANGED')
        return install_locked(root, package, source, package_source, baseline, backup, config, entry_bytes,
                              owner, claims, owner_probe, process_probe, cutoff_probe)


def install_locked(root, package, source, package_source, baseline, backup, config, entry_bytes,
                   owner, claims, owner_probe, process_probe, cutoff_probe):
    backup.mkdir(mode=0o700)
    before, modes = {}, {}
    for kind, base, files in (('owner', root, baseline['owner']),
                              ('package', package / 'pi-extension', baseline['package'])):
        for name, digest in files.items():
            relative = kind + '/' + name
            before[relative] = digest
            if digest is not None:
                target = backup / 'before' / relative
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                data = read_owned(base / name, kind == 'owner')
                if hashlib.sha256(data).hexdigest() != digest:
                    raise ValueError('BASELINE_CHANGED')
                modes[relative] = stat.S_IMODE((base / name).lstat().st_mode)
                atomic_write(target, data)
    result = {'preparedAt': datetime.datetime.now(datetime.UTC).isoformat(), 'ownerDirectory': str(root),
              'packageDirectory': str(package), 'stateDir': config['stateDir'], 'before': before, 'beforeModes': modes,
              'sourceOwner': baseline['sourceOwner'], 'sourcePackage': baseline['sourcePackage'],
              'owner': owner, 'quietClaims': claims, 'phase': 'PREPARED', 'mode': 'explicit-only'}
    atomic_write(backup / 'installation.json', json_bytes(result))
    # Everything after this durable close fails closed, including failed verification or restoration.
    atomic_write(root / 'config.json', b'{}\n')
    result['phase'] = 'CLOSED'
    atomic_write(backup / 'installation.json', json_bytes(result))
    if process_probe(root):
        raise ValueError('ACTIVE_WAKE_AFTER_CLOSE')
    gate.quiet_claims(Path(config['stateDir']))
    if owner_probe(config) != owner:
        raise ValueError('OWNER_CHANGED')
    verify_files(root, {k: v for k, v in baseline['owner'].items() if k != 'config.json'}, True)
    verify_files(package / 'pi-extension', baseline['package'])
    for name in OWNER_FILES:
        relative = 'tools/ce-chatgpt-wake/' + name
        verify_files(root, {relative: baseline['owner'][relative]}, True)
        data = read_owned(source / name, True)
        if hashlib.sha256(data).hexdigest() != baseline['sourceOwner'][name]:
            raise ValueError('SOURCE_CHANGED')
        atomic_write(root / 'tools/ce-chatgpt-wake' / name, data)
    for name in PACKAGE_FILES:
        verify_files(package / 'pi-extension', {name: baseline['package'][name]})
        data = read_owned(package_source / name, True)
        if hashlib.sha256(data).hexdigest() != baseline['sourcePackage'][name]:
            raise ValueError('SOURCE_CHANGED')
        atomic_write(package / 'pi-extension' / name, data)
    cutoff = cutoff_probe(owner)
    if type(cutoff) is not int or not 0 <= cutoff <= 9007199254740991:
        raise ValueError('CUTOFF_INVALID')
    config['conversationGuard'] = {'mode': 'explicit-only', 'targetSelection': 'desktop-at-intake',
                                  'captureAfterAuditSequence': cutoff}
    config_bytes = json_bytes(config)
    result.update(phase='VERIFYING', captureAfterAuditSequence=cutoff,
                  installedConfigHash=hashlib.sha256(config_bytes).hexdigest())
    result['installed'] = {**baseline['owner'],
                           **{'tools/ce-chatgpt-wake/' + k: v for k, v in baseline['sourceOwner'].items()},
                           'auto-wake.json': result['installedConfigHash']}
    atomic_write(backup / 'installation.json', json_bytes(result))
    atomic_write(root / 'auto-wake.json', config_bytes)
    verify_files(root / 'tools/ce-chatgpt-wake', baseline['sourceOwner'], True)
    verify_files(package / 'pi-extension', baseline['sourcePackage'], True)
    unchanged = {k: v for k, v in baseline['owner'].items() if k.startswith('tools/ce-ovis-desktop/')}
    verify_files(root, unchanged, True)
    if sha(root / 'auto-wake.json', True) != result['installedConfigHash'] or read_json(root / 'config.json') != {}:
        raise ValueError('INSTALLED_CONFIG_CHANGED')
    if process_probe(root):
        raise ValueError('ACTIVE_WAKE_AFTER_INSTALL')
    gate.quiet_claims(Path(config['stateDir']))
    if owner_probe(config) != owner:
        raise ValueError('OWNER_CHANGED')
    result['phase'] = 'READY_TO_REOPEN_EXPLICIT_ONLY'
    atomic_write(backup / 'installation.json', json_bytes(result))
    try:
        atomic_write(root / 'config.json', entry_bytes)
        if sha(root / 'config.json', True) != baseline['owner']['config.json']:
            raise ValueError('ENTRY_RESTORE_FAILED')
    except BaseException:
        # Removing the entry denies the Hook without allocating another temporary file.
        try:
            os.unlink(root / 'config.json')
        except FileNotFoundError:
            pass
        raise
    result['phase'] = 'INSTALLED_EXPLICIT_ONLY_RELOAD_REQUIRED'
    return result


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--close-entry', metavar='INSTALLATION_JSON')
    for name in ('package', 'source', 'package-source', 'baseline', 'backup'):
        parser.add_argument('--' + name)
    args = parser.parse_args()
    try:
        if args.close_entry:
            result = gate.close_entry(args.root, read_json(Path(args.close_entry)), process_probe=active_processes)
            print(json.dumps(result))
            return
        if not all((args.package, args.source, args.package_source, args.baseline, args.backup)):
            parser.error('--package, --source, --package-source, --baseline and --backup are required for installation')
        result = install(args.root, args.package, args.source, args.package_source,
                         read_json(Path(args.baseline)), args.backup)
        print(json.dumps({k: result[k] for k in ('phase', 'mode', 'captureAfterAuditSequence')}))
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        reason = str(error) if isinstance(error, ValueError) and str(error).isupper() and str(error).replace('_', '').isalnum() else 'INSTALLATION_UNAVAILABLE'
        print(json.dumps({'status': 'STOPPED', 'reason': reason, 'desktopGate': 'VERIFY_BEFORE_REOPENING'}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
