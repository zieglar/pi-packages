#!/usr/bin/env python3
"""Single-owner outbound CE Hook: one guarded wake, then explicit-button fallback."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import wake
import notification
import conversation_guard

CONFIG_FIELDS = {'stateDir', 'profilePath', 'packageRoot', 'nativeSessionFile', 'python', 'node',
                 'agentDesktop', 'terminalNotifier', 'ownerDirectory', 'conversationMarker',
                 'maxWaitSeconds', 'notificationTimeoutSeconds', 'afterAuditSequence'}


def private_dir(path):
    directory = Path(path)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_REQUIRED')
    return directory


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        wake.private_hook_file(stream.fileno())
        raw = stream.read(65537)
    if len(raw) > 65536:
        raise ValueError('PRIVATE_FILE_TOO_LARGE')
    try:
        return json.loads(raw.decode('utf8'), object_pairs_hook=wake.unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('PRIVATE_FILE_INVALID') from error


def load_config(path):
    config = read_private(path)
    if not isinstance(config, dict) or set(config) not in (CONFIG_FIELDS, CONFIG_FIELDS | {'conversationGuard'}):
        raise ValueError('AUTO_CONFIG_INVALID')
    for key in CONFIG_FIELDS - {'conversationMarker', 'maxWaitSeconds', 'notificationTimeoutSeconds', 'afterAuditSequence'}:
        value = config[key]
        if not wake.hook_text(value, 4096) or not os.path.isabs(value) or os.path.normpath(value) != value:
            raise ValueError('AUTO_CONFIG_PATH_INVALID')
    if not wake.hook_text(config['conversationMarker'], 256):
        raise ValueError('AUTO_CONFIG_MARKER_INVALID')
    for key, maximum in [('maxWaitSeconds', 120), ('notificationTimeoutSeconds', 900)]:
        if type(config[key]) is not int or not 1 <= config[key] <= maximum:
            raise ValueError('AUTO_CONFIG_LIMIT_INVALID')
    if Path(path) != Path(config['ownerDirectory']) / 'auto-wake.json':
        raise ValueError('AUTO_CONFIG_OWNER_INVALID')
    if type(config['afterAuditSequence']) is not int or not 0 <= config['afterAuditSequence'] <= 9007199254740991:
        raise ValueError('ACTIVATION_WATERMARK_INVALID')
    config['conversationGuard'] = conversation_guard.validate_config(
        config.get('conversationGuard', {'mode': 'explicit-only'}))
    return config


def clean_env():
    # Workers and their desktop/notification children do not inherit CE credentials.
    return {'HOME': str(Path.home()), 'PATH': '/opt/homebrew/bin:/usr/bin:/bin',
            'LANG': 'en_US.UTF-8', 'PYTHONDONTWRITEBYTECODE': '1'}


def resolve_runtime(config, *, timeout=7):
    result = subprocess.run([config['node'], str(Path(config['ownerDirectory']) / 'tools/ce-chatgpt-wake/resolve-runtime.mjs'),
                             str(Path(config['ownerDirectory']) / 'auto-wake.json')],
                            capture_output=True, text=True, timeout=timeout, env=clean_env(), check=True)
    try:
        runtime = json.loads(result.stdout, object_pairs_hook=wake.unique_object)
    except json.JSONDecodeError as error:
        raise ValueError('RUNTIME_AUTHORITY_DENIED') from error
    if not isinstance(runtime, dict) or not wake.HOOK_CONFIG_FIELDS.issubset(runtime):
        raise ValueError('RUNTIME_AUTHORITY_DENIED')
    return runtime


def verify_store(event, runtime):
    # Metadata only: payload bytes remain behind CE's authorized read tools.
    uri = Path(runtime['databasePath']).as_uri() + '?mode=ro'
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        row = db.execute('SELECT exchange_id, from_endpoint_json, to_endpoint_json, payload_digest, payload_length, created_at FROM message WHERE message_id=?',
                         (event['messageId'],)).fetchone()
        expected = (event['exchangeId'], event['sender'], event['recipient'], event['payloadDigest'], event['payloadLength'], event['createdAt'])
        if row is None:
            raise ValueError('COMMITTED_METADATA_DENIED')
        try:
            endpoints = (json.loads(row[1]), json.loads(row[2]))
        except json.JSONDecodeError as error:
            raise ValueError('COMMITTED_METADATA_DENIED') from error
        if (row[0], *endpoints, *row[3:]) != expected:
            raise ValueError('COMMITTED_METADATA_DENIED')
        audit = db.execute('SELECT kind, subject_id FROM audit_event WHERE sequence=?',
                           (int(event['eventKey'].rsplit('/', 1)[1]),)).fetchone()
        if audit != ('message_created', event['messageId']):
            raise ValueError('COMMITTED_AUDIT_DENIED')
        if db.execute('SELECT state FROM exchange WHERE exchange_id=?', (event['exchangeId'],)).fetchone() != ('OPEN',):
            raise ValueError('EXCHANGE_NOT_OPEN')
        for role, endpoint in (('sender', event['sender']), ('recipient', event['recipient'])):
            rows = db.execute('''SELECT o.expires_at, o.session_id, p.participant_id FROM participant p
JOIN participant_ownership o USING(participant_id)
JOIN participant_session s ON s.participant_id=p.participant_id AND s.session_id=o.session_id
JOIN exchange_membership m ON m.participant_id=p.participant_id
WHERE p.endpoint_adapter=? AND p.endpoint_id=? AND m.exchange_id=? AND s.detached_at IS NULL''',
                              (endpoint['adapter'], endpoint['endpointId'], event['exchangeId'])).fetchall()
            if len(rows) != 1:
                raise ValueError('ATTACHED_OWNER_REQUIRED')
            if role == 'sender' and rows[0][1] != runtime['ceSessionId']:
                raise ValueError('SENDER_SESSION_CHANGED')
            if role == 'sender' and rows[0][2] != runtime['participantId']:
                raise ValueError('SENDER_PARTICIPANT_CHANGED')
            expiry = datetime.datetime.fromisoformat(rows[0][0].replace('Z', '+00:00'))
            if expiry.tzinfo is None or expiry <= datetime.datetime.now(datetime.UTC):
                raise ValueError('OWNER_LEASE_EXPIRED')


def claim_path(config, message_id):
    if not wake.hook_match('msg_' + wake.HOOK_ID, message_id):
        raise ValueError('MESSAGE_ID_INVALID')
    return Path(config['stateDir']) / (message_id + '.json')


@contextlib.contextmanager
def locked(path, wait_seconds=0):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'r+') as stream:
        wake.private_hook_file(stream.fileno())
        deadline = time.monotonic() + wait_seconds
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.02)
        yield


def dispatch_path(config, message_id):
    return Path(config['stateDir']) / (message_id + '.dispatch.json')


def write_dispatch(config, message_id, admission):
    path = dispatch_path(config, message_id)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(admission, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def read_dispatch(config, message_id):
    path = dispatch_path(config, message_id)
    if not os.path.lexists(path):
        # The claim exists but the dispatch result was never recorded: the spawn outcome
        # is unknown, so the caller must not treat this message as queued.
        return {'messageId': message_id, 'dispatch': 'UNKNOWN'}
    saved = read_private(path)
    if saved.get('messageId') != message_id or saved.get('dispatch') not in ('QUEUED', 'UNKNOWN'):
        raise ValueError('DISPATCH_JOURNAL_INVALID')
    return saved


def enqueue(raw, config, resolve=None, spawn=None):
    runtime = (resolve or resolve_runtime)(config)
    event = wake.validate_hook(raw, {key: runtime[key] for key in wake.HOOK_CONFIG_FIELDS})
    if int(event['eventKey'].rsplit('/', 1)[1]) <= config['afterAuditSequence']:
        raise ValueError('BEFORE_ACTIVATION')
    verify_store(event, runtime)
    directory = private_dir(config['stateDir'])
    file = claim_path(config, event['messageId'])
    fingerprint = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
    with locked(directory / '.admission.lock', wait_seconds=5):
        if os.path.lexists(file):
            saved = read_private(file)
            if saved.get('recordSha256') != fingerprint:
                raise ValueError('MESSAGE_CONFLICT')
            return read_dispatch(config, event['messageId'])
        # Admission never rewrites the claim after spawn, so a worker cannot lose a
        # recorded stage to a late admission write.
        saved = {'event': event, 'recordSha256': fingerprint, 'stage': 'ADMITTED'}
        fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(saved, stream)
            stream.flush()
            os.fsync(stream.fileno())
        parent_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
        admission = {'messageId': event['messageId'], 'dispatch': 'UNKNOWN'}
        try:
            (spawn or spawn_worker)(event['messageId'], config)
            admission['dispatch'] = 'QUEUED'
        except (OSError, subprocess.SubprocessError):
            admission['dispatch'] = 'UNKNOWN'
        write_dispatch(config, event['messageId'], admission)
        return admission


def spawn_worker(message_id, config):
    log = Path(config['stateDir']) / (message_id + '.log')
    fd = os.open(log, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        subprocess.Popen([config['python'], '-B',
                          str(Path(config['ownerDirectory']) / 'tools/ce-chatgpt-wake/auto_wake.py'), '--config',
                          str(Path(config['ownerDirectory']) / 'auto-wake.json'), '--message-id', message_id],
                         stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, env=clean_env(),
                         start_new_session=True, close_fds=True)


def attempt_wake(record, config, runtime, mode):
    target = config.get('_receiptTarget')
    def current_authority():
        if target is None:
            validate_current(record, config, resolve_runtime(config))
            return
        import receipt_target
        fresh, current, selected = receipt_target.current_binding(record, config)
        if selected != target:
            raise ValueError('TARGET_BINDING_CHANGED')
        validate_current(record, fresh, current)

    class GuardedDesktop(wake.ChatGptCli):
        def snapshot(self):
            envelope = super().snapshot()
            if target is not None:
                import receipt_target
                windows = self.call(['list-windows', '--app', 'ChatGPT'])['data']
                receipt_target.verify_view(target, windows, envelope)
            return envelope

        # Recheck selected ownership immediately before each mutating desktop command.
        def fill(self, ref, text):
            current_authority()
            view = wake.observe(self.snapshot(), desktop_config)
            if view['draft']:
                raise ValueError('NONEMPTY_DRAFT')
            super().fill(view['input']['ref_id'], text)

        def submit(self, ref):
            current_authority()
            view = wake.observe(self.snapshot(), desktop_config)
            if view['draft'] != wake.notice(record, desktop_config) or 'disabled' in view['send'].get('states', []):
                raise ValueError('DRAFT_OR_SEND_READBACK_MISMATCH')
            super().submit(view['send']['ref_id'])

    directory = private_dir(Path(config['stateDir']) / record['messageId'] / mode)
    desktop_config = {'agentDesktop': config['agentDesktop'], 'stateDir': str(directory),
                      'desktopSession': record['testId'] + '-' + mode,
                      'conversationMarker': config['conversationMarker'],
                      'targetEndpoint': runtime['hookRecipientEndpointId'], 'replyEndpoint': runtime['hookSenderEndpointId'],
                      'maxWaitSeconds': config['maxWaitSeconds'], 'refuseBusy': True,
                      'executionEnd': time.monotonic() + config['maxWaitSeconds']}
    journal = directory / (record['messageId'] + '.json')
    try:
        with locked(Path(config['stateDir']) / '.desktop.lock'):
            # Keep the socket path short enough for agent-desktop on macOS.
            tmp = tempfile.mkdtemp(prefix='cew-', dir='/private/tmp')
            desktop_config['desktopTmpDir'] = tmp
            desktop = GuardedDesktop(desktop_config)
            windows = desktop.call(['list-windows', '--app', 'ChatGPT'])['data']
            if len(windows) != 1:
                raise ValueError('UNIQUE_CHATGPT_WINDOW_REQUIRED')
            window = windows[0]
            if target is not None and (window['id'] != target['windowId'] or window['pid'] != target['pid']
                                       or window['process_instance'] != target['processInstance']):
                raise ValueError('TARGET_WINDOW_CHANGED')
            desktop_config.update(windowId=window['id'], windowTitle=window['title'],
                                  pid=window['pid'], processInstance=window['process_instance'])
            view = wake.observe(desktop.snapshot(), desktop_config)
            if view['draft']:
                raise ValueError('NONEMPTY_DRAFT')
            wake.run(record, desktop_config, desktop)
            return read_private(journal)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        if os.path.lexists(journal):
            return read_private(journal)
        # All commands above run before wake.run: no input or submission command was issued.
        return {'stage': 'OBSERVING', 'result': {'noticeSubmission': 'NOT_ATTEMPTED',
                'reason': str(error) if isinstance(error, ValueError) else type(error).__name__}}


def interactive_fallback(record, config, runtime):
    root = private_dir(Path(config['stateDir']) / record['messageId'])
    desktop_path = root / 'notification-desktop.json'
    wake.write_state(desktop_path, {'targetEndpoint': record['to'], 'replyEndpoint': record['replyTo'],
                                    'stateDir': str(root / 'manual')})
    notify_config = {'terminalNotifier': config['terminalNotifier'], 'stateDir': str(root / 'notification'),
                     'desktopConfig': str(desktop_path), 'actionTitle': '读取 CE 消息',
                     'timeoutSeconds': config['notificationTimeoutSeconds']}
    if config.get('_receiptTarget') is not None:
        notify_config['targetTitle'] = config['_receiptTarget']['title']
        notify_config['actionTitle'] = '回到目标会话后继续'

    def consented_wake(incoming, _desktop):
        if config.get('_receiptTarget') is not None:
            import receipt_target
            try:
                fresh, current, target = receipt_target.current_binding(record, config)
            except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
                return {'noticeSubmission': 'NOT_ATTEMPTED', 'reason': 'TARGET_BINDING_UNAVAILABLE'}
            if target != config['_receiptTarget']:
                return {'noticeSubmission': 'NOT_ATTEMPTED', 'reason': 'TARGET_BINDING_CHANGED'}
            validate_current(record, fresh, current)
            return attempt_wake(incoming, {**fresh, '_receiptTarget': target}, current, 'manual')['result']
        current = resolve_runtime(config)
        validate_current(record, config, current)
        return attempt_wake(incoming, config, current, 'manual')['result']

    return notification.post(record, notify_config, handler=lambda task, cfg: notification.handle(
        task, cfg, wake=consented_wake))


def validate_current(record, config, runtime):
    saved = read_private(claim_path(config, record['messageId']))
    event = saved['event']
    if (event['sender']['endpointId'] != runtime['hookSenderEndpointId'] or
            event['recipient']['endpointId'] != runtime['hookRecipientEndpointId'] or
            event['exchangeId'] != runtime['hookExchangeId']):
        raise ValueError('CURRENT_AUTHORITY_CHANGED')
    verify_store(event, runtime)


def work(message_id, config, resolve=None, attempt=None, fallback=None):
    directory = private_dir(config['stateDir'])
    file = claim_path(config, message_id)
    with locked(directory / (message_id + '.lock')):
        saved = read_private(file)
        if saved['stage'] != 'ADMITTED':
            return saved
        runtime = (resolve or resolve_runtime)(config)
        event = saved['event']
        record = {'testId': 'CE-WAKE-AUTO-' + message_id[4:], 'messageId': message_id,
                  'to': event['recipient']['endpointId'], 'replyTo': event['sender']['endpointId'], 'disposition': 'CREATED'}
        validate_current(record, config, runtime)
        # CHECK_ONLY owns its own durable per-message action journal before any
        # desktop input. Ordinary keys leave the strict business guard below.
        import check_only
        try:
            check_result = check_only.dispatch(event, config, runtime)
        except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
            saved['stage'] = 'UNKNOWN'
            saved['checkOnly'] = {'deliveryMode': 'CHECK_ONLY', 'stage': 'UNKNOWN'}
            wake.write_state(file, saved)
            return saved
        if check_result is not None:
            saved['stage'] = check_result['stage']
            saved['checkOnly'] = check_result
            wake.write_state(file, saved)
            return saved
        target = None
        mode = config.get('conversationGuard', {'mode': 'explicit-only'})['mode']
        if mode == 'ownership-check':
            # This opt-in path submits a fixed metadata probe. It never calls
            # the legacy business-task notice or its automatic button fallback.
            import ownership_loop
            saved['stage'] = 'OWNERSHIP_MAY_HAVE_OCCURRED'
            wake.write_state(file, saved)
            try:
                outcome = ownership_loop.outgoing(event, config, runtime)
                saved['stage'] = outcome['stage']
                saved['ownership'] = outcome
            except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
                saved['stage'] = 'UNKNOWN'
            wake.write_state(file, saved)
            return saved
        if mode == 'title-match' and config.get('conversationGuard', {}).get('targetSelection') == 'desktop-at-intake':
            try:
                import receipt_target
                target = receipt_target.lookup_reply(event, config, runtime)
            except (ImportError, ValueError, OSError, sqlite3.Error, subprocess.SubprocessError):
                target = None
        decision = conversation_guard.automatic_decision(mode, target=target)
        if decision is not None:
            saved['stage'] = 'SUPPRESSED'
            saved['conversationGuard'] = decision
            saved['manualFetch'] = {'messageId': message_id, 'association': 'UNAVAILABLE',
                                    'requiresHumanSelection': True}
            wake.write_state(file, saved)
            return saved
        if target is not None:
            config = {**config, '_receiptTarget': target}
            saved['receiptTarget'] = target
        saved['stage'] = 'AUTO_MAY_HAVE_OCCURRED'
        wake.write_state(file, saved)
        try:
            result = (attempt or attempt_wake)(record, config, runtime, 'auto')
            saved['auto'] = result
            if result.get('stage') == 'NOTICE_OBSERVED' and result.get('result', {}).get('noticeSubmission') == 'OBSERVED':
                saved['stage'] = 'OBSERVED'
            elif result.get('stage') == 'OBSERVING' and result.get('result', {}).get('noticeSubmission') == 'NOT_ATTEMPTED':
                saved['stage'] = 'FALLBACK_MAY_HAVE_OCCURRED'
                wake.write_state(file, saved)
                saved['notification'] = (fallback or interactive_fallback)(record, config, runtime)
                saved['stage'] = 'FALLBACK_FINISHED'
            else:
                saved['stage'] = 'UNKNOWN'
        except (ValueError, OSError, subprocess.SubprocessError):
            saved['stage'] = 'UNKNOWN'
        wake.write_state(file, saved)
        return saved


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--message-id', required=True)
    args = parser.parse_args()
    try:
        result = work(args.message_id, load_config(args.config))
        print(json.dumps({'messageId': args.message_id, 'stage': result['stage']}))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError):
        print('AUTO_WAKE_STOPPED', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
