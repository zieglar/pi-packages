#!/usr/bin/env python3
"""Immutable desktop-at-intake observations; never attest the actual originating chat."""
import argparse
import contextlib
import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_wake
import wake


def policy(config):
    guard = config.get('conversationGuard', {})
    return guard.get('targetSelection') == 'desktop-at-intake' and type(guard.get('captureAfterAuditSequence')) is int


def directory(config):
    state = auto_wake.private_dir(config['stateDir'])
    return auto_wake.private_dir(state / 'conversation-targets')


def request_path(config, message_id):
    if not wake.hook_match('msg_' + wake.HOOK_ID, message_id):
        raise ValueError('MESSAGE_ID_INVALID')
    return Path(config['stateDir']) / 'conversation-targets' / ('request-' + message_id + '.json')


def fingerprint(config, runtime):
    guard = config['conversationGuard']
    values = [guard.get('targetSelection'), guard.get('captureAfterAuditSequence'), config['conversationMarker'],
              runtime['runtimeSessionId'], runtime['hookSenderEndpointId'], runtime['hookRecipientEndpointId'],
              runtime['hookExchangeId'], runtime['policyDigest'], runtime['ceSessionId'], runtime['participantId']]
    return hashlib.sha256(json.dumps(values, ensure_ascii=True, separators=(',', ':')).encode()).hexdigest()


def runtime_for(config, session_id, endpoint_id, deadline=None):
    timeout = 7 if deadline is None else min(7, deadline - time.monotonic())
    if timeout <= 0:
        raise ValueError('CAPTURE_TOO_LATE')
    runtime = auto_wake.resolve_runtime(config, timeout=timeout)
    if runtime['runtimeSessionId'] != session_id or runtime['hookSenderEndpointId'] != endpoint_id:
        raise ValueError('INTAKE_OWNER_CHANGED')
    return runtime


def object_json(raw):
    try:
        value = json.loads(raw, object_pairs_hook=wake.unique_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ValueError('TARGET_JSON_INVALID') from error
    if not isinstance(value, dict):
        raise ValueError('TARGET_JSON_INVALID')
    return value


# Pi emits type/customType/data in this order. Native data fields before its
# messageId are flat metadata; a nested association is never searched for it.
CONTROL_HEADER = re.compile(
    rb'^\s*\{\s*"type"\s*:\s*"custom"\s*,\s*"customType"\s*:\s*'
    rb'"ce-inbound-(?:wake|receive|feedback)"\s*,\s*"data"\s*:\s*\{'
    rb'[^{}]*?"messageId"\s*:\s*"([^"\\]*)"')


def target_records(raw, message_id):
    """Select the native record's own MID before any JSON decoding."""
    header = CONTROL_HEADER.match(raw)
    if header is None or header.group(1) != message_id.encode('ascii'):
        return []
    # Use the existing strict decoder, including duplicate-key rejection. A
    # torn/merged target line is not reconstructed into proof of native receipt.
    return [object_json(raw)]


def inbound_claim(config, runtime, message_id, require_read=False, *, metadata_only=False):
    claims, reads = [], []
    fd = os.open(config['nativeSessionFile'], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb' if metadata_only else 'r') as stream:
        wake.private_hook_file(stream.fileno())
        header = object_json(stream.readline())
        if header.get('type') != 'session' or header.get('id') != runtime['runtimeSessionId']:
            raise ValueError('NATIVE_SESSION_CHANGED')
        for line in stream:
            if metadata_only:
                # Decode only the target's own control records. Business records,
                # including a torn earlier write on the same line, are never parsed.
                entries = target_records(line, message_id)
            else:
                entries = [object_json(line)]
            for entry in entries:
                if entry.get('type') != 'custom':
                    continue
                data = entry.get('data')
                if not isinstance(data, dict) or data.get('messageId') != message_id:
                    continue
                if entry.get('customType') == 'ce-inbound-wake':
                    claims.append(data)
                elif (entry.get('customType') == 'ce-inbound-feedback' and isinstance(data.get('association'), dict)
                      and data['association'].get('kind') == 'FEEDBACK'):
                    claims.append(data)
                elif entry.get('customType') == 'ce-inbound-receive':
                    reads.append(data.get('status'))
    if len(claims) != 1:
        raise ValueError('INBOUND_CLAIM_REQUIRED')
    claim = claims[0]
    meta = claim.get('metadata')
    if (not isinstance(meta, dict) or not {'payloadDigest', 'payloadLength', 'createdAt'} <= set(meta)
            or type(claim.get('admittedAt')) is not int):
        raise ValueError('INBOUND_METADATA_DENIED')
    if (claim.get('runtimeSessionId') != runtime['runtimeSessionId']
            or claim.get('endpointId') != runtime['hookSenderEndpointId']
            or meta.get('messageId') != message_id or meta.get('exchangeId') != runtime['hookExchangeId']
            or meta.get('from') != runtime['hookRecipientEndpointId'] or meta.get('to') != runtime['hookSenderEndpointId']
            or type(claim.get('auditSequence')) is not int or meta.get('auditSequence') != claim['auditSequence']):
        raise ValueError('INBOUND_METADATA_DENIED')
    cutoff = (max(config['afterAuditSequence'], config['conversationGuard'].get('captureAfterAuditSequence', config['afterAuditSequence']))
              if metadata_only else config['conversationGuard']['captureAfterAuditSequence'])
    if claim['auditSequence'] <= cutoff:
        raise ValueError('BEFORE_CAPTURE_CUTOFF')
    if require_read and (not reads or reads[-1] != 'RETURNED'):
        raise ValueError('REQUEST_NOT_RECEIVED')
    db = sqlite3.connect(Path(runtime['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON')
        row = db.execute('''SELECT exchange_id,from_endpoint_json,to_endpoint_json,payload_digest,payload_length,created_at
FROM message WHERE message_id=?''', (message_id,)).fetchone()
        if row is None:
            raise ValueError('INBOUND_MESSAGE_MISSING')
        actual = (row[0], object_json(row[1]), object_json(row[2]), *row[3:])
        expected = (meta['exchangeId'], {'adapter': 'chatgpt', 'endpointId': meta['from']},
                    {'adapter': 'pi', 'endpointId': meta['to']}, meta['payloadDigest'], meta['payloadLength'], meta['createdAt'])
        if actual != expected:
            raise ValueError('INBOUND_METADATA_DENIED')
        if db.execute('SELECT kind,subject_id FROM audit_event WHERE exchange_id=? AND sequence=?',
                      (meta['exchangeId'], claim['auditSequence'])).fetchone() != ('message_created', message_id):
            raise ValueError('INBOUND_AUDIT_DENIED')
    finally:
        db.close()
    return claim


@contextlib.contextmanager
def capture_lock(folder, deadline):
    try:
        with auto_wake.locked(folder / '.capture.lock', wait_seconds=max(0, min(5, deadline - time.monotonic()))):
            yield
    except BlockingIOError as error:
        raise ValueError('CAPTURE_LOCK_BUSY') from error


def capture(message_id, config, session_id, endpoint_id):
    if not policy(config):
        return {'messageId': message_id, 'status': 'DISABLED'}
    deadline = time.monotonic() + 18
    runtime = runtime_for(config, session_id, endpoint_id, deadline)
    claim = inbound_claim(config, runtime, message_id)
    admitted = claim.get('admittedAt')
    now = int(time.time() * 1000)
    if type(admitted) is not int or not -5000 <= now - admitted <= 30000:
        raise ValueError('CAPTURE_TOO_LATE')
    folder = directory(config)
    path = request_path(config, message_id)
    # A concurrent capture waits briefly instead of losing the target without a reason.
    with capture_lock(folder, deadline):
        if int(time.time() * 1000) - admitted > 30000 or time.monotonic() >= deadline:
            raise ValueError('CAPTURE_TOO_LATE')
        if os.path.lexists(path):
            saved = auto_wake.read_private(path)
            return {'messageId': message_id, 'status': saved['status']}
        if os.path.lexists(path.with_suffix('.tmp')):
            raise ValueError('CAPTURE_STATE_UNCERTAIN')
        saved = {'version': 2, 'requestMessageId': message_id, 'exchangeId': runtime['hookExchangeId'],
                 'auditSequence': claim['auditSequence'], 'admittedAt': admitted,
                 'policySha256': fingerprint(config, runtime), 'selection': 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN',
                 'status': 'UNAVAILABLE', 'reason': 'CAPTURE_MAY_HAVE_OCCURRED',
                 'markerObservation': 'UNKNOWN'}
        # Durable marker precedes observation. Interrupted captures are never recaptured at reply time.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(saved, stream, ensure_ascii=False, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        parent = os.open(folder, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
        cfg = {'agentDesktop': config['agentDesktop'], 'desktopTmpDir': tempfile.mkdtemp(prefix='cew-', dir='/private/tmp'),
               'desktopSession': 'ce-intake-' + message_id[4:], 'stateDir': str(folder),
               'conversationMarker': config['conversationMarker'],
               'executionEnd': min(deadline, time.monotonic() + (30000 - (time.time() * 1000 - admitted)) / 1000)}
        try:
            desktop = wake.ChatGptCli(cfg)
            windows = desktop.call(['list-windows', '--app', 'ChatGPT'])['data']
            if len(windows) != 1:
                raise ValueError('UNIQUE_CHATGPT_WINDOW_REQUIRED')
            window = windows[0]
            cfg.update(windowId=window['id'], windowTitle=window['title'], pid=window['pid'],
                       processInstance=window['process_instance'])
            envelope = desktop.snapshot()
            diagnostic = wake.control_diagnostics(envelope)
            diagnostic['selectedWindow'] = {'id': window['id'], 'title': window['title'],
                                            'pid': window['pid'], 'processInstance': window['process_instance']}
            saved.update(candidateCounts={'composer': len(diagnostic['composerCandidates']), 'send': len(diagnostic['sendCandidates'])},
                         draftState=diagnostic['draftState'], draftLength=diagnostic['draftLength'],
                         controls=diagnostic, idle={'sendEnabled': diagnostic['sendCandidates'][0]['enabled'] if len(diagnostic['sendCandidates']) == 1 else None,
                                                   'stopCandidates': len(diagnostic['stopCandidates'])})
            # Sampling records a target observation, never an input authorization.
            observation = wake.observe(envelope, cfg, require_marker=False)
            if not isinstance(observation['input'].get('value'), str):
                raise ValueError('DRAFT_STATE_UNKNOWN')
            if observation['draft']:
                raise ValueError('DRAFT_NOT_EMPTY')
            areas = [n for n in wake.nodes(envelope['data']['tree']) if n.get('role') == 'webarea']
            title = areas[0].get('name')
            marker = 'MATCH' if wake.marker_present(wake.nodes(areas[0]), config['conversationMarker']) else 'MISSING'
            if not wake.hook_text(title, 512) or not title.strip():
                raise ValueError('CURRENT_TITLE_MISSING')
            if int(time.time() * 1000) - admitted > 30000:
                raise ValueError('CAPTURE_TOO_LATE')
            current = runtime_for(config, session_id, endpoint_id, deadline)
            if fingerprint(config, current) != saved['policySha256']:
                raise ValueError('CAPTURE_POLICY_CHANGED')
            saved.update(status='CAPTURED', reason='OBSERVED_TARGET' if marker == 'MATCH' else 'OBSERVED_TARGET_MARKER_MISSING',
                         markerObservation=marker, observedAt=int(time.time() * 1000),
                         target={'title': title, 'windowId': window['id'], 'pid': window['pid'],
                                 'processInstance': window['process_instance'], 'conversationMarker': config['conversationMarker']})
        except (ValueError, OSError, auto_wake.subprocess.SubprocessError) as error:
            saved['reason'] = str(error) if isinstance(error, ValueError) and wake.hook_match('[A-Z][A-Z0-9_]{1,79}', str(error)) else 'CAPTURE_UNAVAILABLE'
        wake.write_state(path, saved)
        return {'messageId': message_id, 'status': saved['status'], 'reason': saved['reason']}


def key_path(config, key):
    if not wake.hook_text(key, 256):
        raise ValueError('REPLY_KEY_INVALID')
    return Path(config['stateDir']) / 'conversation-targets' / ('reply-' + hashlib.sha256(key.encode()).hexdigest() + '.json')


def captured_target(config, runtime, message_id):
    claim = inbound_claim(config, runtime, message_id, require_read=True)
    saved = auto_wake.read_private(request_path(config, message_id))
    if (not isinstance(saved, dict) or saved.get('status') != 'CAPTURED'
            or type(saved.get('version')) is not int or saved['version'] not in (1, 2)
            or (saved['version'] == 2 and saved.get('markerObservation') not in ('MATCH', 'MISSING'))
            or saved.get('policySha256') != fingerprint(config, runtime)
            or saved.get('requestMessageId') != message_id or saved.get('exchangeId') != runtime['hookExchangeId']
            or saved.get('admittedAt') != claim['admittedAt'] or saved.get('auditSequence') != claim['auditSequence']
            or saved.get('selection') != 'DESKTOP_AT_INTAKE_NOT_ACTUAL_ORIGIN'
            or type(saved.get('observedAt')) is not int or not -5000 <= saved['observedAt'] - claim['admittedAt'] <= 30000):
        raise ValueError('TARGET_BINDING_UNAVAILABLE')
    target = saved.get('target')
    if (not isinstance(target, dict) or set(target) != {'title', 'windowId', 'pid', 'processInstance', 'conversationMarker'}
            or any(not wake.hook_text(target.get(k), 512) for k in ('title', 'windowId', 'processInstance', 'conversationMarker'))
            or not target['title'].strip() or type(target.get('pid')) is not int or target['pid'] <= 0
            or target['conversationMarker'] != config['conversationMarker']):
        raise ValueError('TARGET_BINDING_UNAVAILABLE')
    return saved


def binding_digest(binding):
    return hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def confirmation(path, binding):
    saved = auto_wake.read_private(path)
    if (not isinstance(saved, dict) or set(saved) != {'version', 'bindingSha256', 'observedThroughSequence'}
            or saved['version'] != 1 or saved['bindingSha256'] != binding_digest(binding)
            or type(saved['observedThroughSequence']) is not int or saved['observedThroughSequence'] < 0):
        raise ValueError('REPLY_CONFIRMATION_DENIED')
    return saved


def prepare(message_id, task_id, key, config, session_id, endpoint_id):
    if not policy(config) or not wake.hook_text(task_id, 256):
        raise ValueError('RECEIPT_POLICY_REQUIRED')
    runtime = runtime_for(config, session_id, endpoint_id)
    saved = captured_target(config, runtime, message_id)
    binding = {'version': 1, 'requestMessageId': message_id, 'exchangeId': runtime['hookExchangeId'],
               'taskId': task_id, 'taskIdProvenance': 'AGENT_DECLARED_CORRELATION_LABEL',
               'idempotencyKey': key, 'policySha256': saved['policySha256']}
    folder = directory(config)
    path = key_path(config, key)
    with auto_wake.locked(folder / '.prepare.lock', wait_seconds=10):
        if os.path.lexists(path):
            if auto_wake.read_private(path) != binding:
                raise ValueError('REPLY_KEY_CONFLICT')
        else:
            if os.path.lexists(path.with_suffix('.tmp')):
                raise ValueError('REPLY_KEY_UNCERTAIN')
            # Existing committed messages cannot acquire a newly invented association.
            db = sqlite3.connect(Path(runtime['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
            try:
                db.execute('PRAGMA query_only=ON')
                if db.execute('SELECT 1 FROM message WHERE exchange_id=? AND idempotency_key=?',
                              (runtime['hookExchangeId'], key)).fetchone() is not None:
                    raise ValueError('REPLY_ALREADY_COMMITTED')
            finally:
                db.close()
            wake.write_state(path, binding)
        ready = path.with_name(path.stem + '.ready.json')
        if os.path.lexists(ready):
            confirmation(ready, binding)
        else:
            if os.path.lexists(ready.with_suffix('.tmp')):
                raise ValueError('REPLY_KEY_UNCERTAIN')
            # An outbound audit after this read proves the binding was already published.
            db = sqlite3.connect(Path(runtime['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
            try:
                db.execute('PRAGMA query_only=ON')
                if db.execute('SELECT 1 FROM message WHERE exchange_id=? AND idempotency_key=?',
                              (runtime['hookExchangeId'], key)).fetchone() is not None:
                    raise ValueError('REPLY_ALREADY_COMMITTED')
                through = db.execute('SELECT COALESCE(MAX(sequence), 0) FROM audit_event WHERE exchange_id=?',
                                     (runtime['hookExchangeId'],)).fetchone()[0]
            finally:
                db.close()
            wake.write_state(ready, {'version': 1, 'bindingSha256': binding_digest(binding),
                                     'observedThroughSequence': through})
    return {'messageId': message_id, 'status': 'PREPARED', 'taskId': task_id, 'idempotencyKey': key}


def lookup_reply(event, config, runtime):
    if not policy(config):
        return None
    db = sqlite3.connect(Path(runtime['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
    try:
        db.execute('PRAGMA query_only=ON')
        row = db.execute('SELECT idempotency_key FROM message WHERE message_id=?', (event['messageId'],)).fetchone()
    finally:
        db.close()
    if not row or not row[0]:
        return None
    path = key_path(config, row[0])
    if not os.path.lexists(path):
        return None
    binding = auto_wake.read_private(path)
    if (not isinstance(binding, dict) or binding.get('idempotencyKey') != row[0]
            or binding.get('exchangeId') != event['exchangeId']
            or binding.get('policySha256') != fingerprint(config, runtime)):
        raise ValueError('REPLY_BINDING_DENIED')
    ready = path.with_name(path.stem + '.ready.json')
    if not os.path.lexists(ready):
        return None
    through = confirmation(ready, binding)['observedThroughSequence']
    if int(event['eventKey'].rsplit('/', 1)[1]) <= through:
        raise ValueError('REPLY_ASSOCIATION_NOT_PRIOR')
    saved = captured_target(config, runtime, binding['requestMessageId'])
    # Legacy or marker-missing observations support local CE correlation only.
    if saved.get('version') != 2 or saved.get('markerObservation') != 'MATCH':
        return None
    return {**saved['target'], 'requestMessageId': binding['requestMessageId'], 'exchangeId': binding['exchangeId'],
            'taskId': binding['taskId'], 'selection': saved['selection']}

def current_binding(record, config):
    owner = Path(config['ownerDirectory'])
    if auto_wake.read_private(owner / 'config.json') != {'autoWakeConfig': str(owner / 'auto-wake.json')}:
        raise ValueError('WAKE_ENTRY_CLOSED')
    fresh = auto_wake.load_config(owner / 'auto-wake.json')
    if fresh['conversationGuard']['mode'] != 'title-match' or not policy(fresh):
        raise ValueError('GUARD_NOT_AUTOMATIC')
    runtime = auto_wake.resolve_runtime(fresh)
    event = auto_wake.read_private(auto_wake.claim_path(fresh, record['messageId']))['event']
    target = lookup_reply(event, fresh, runtime)
    if target is None:
        raise ValueError('TARGET_BINDING_UNAVAILABLE')
    return fresh, runtime, target



def verify_view(target, windows, envelope):
    if (len(windows) != 1 or windows[0].get('id') != target['windowId'] or windows[0].get('pid') != target['pid']
            or windows[0].get('process_instance') != target['processInstance']):
        raise ValueError('TARGET_WINDOW_CHANGED')
    import conversation_guard
    result = conversation_guard.check_title(target['title'], windows, envelope)
    if result != 'MATCH':
        raise ValueError('TARGET_' + result)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--endpoint-id', required=True)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--capture')
    action.add_argument('--prepare-reply')
    parser.add_argument('--task-id')
    args = parser.parse_args()
    message_id = args.capture or args.prepare_reply
    try:
        outer = auto_wake.read_private(args.config)
        if not isinstance(outer, dict) or set(outer) != {'autoWakeConfig'}:
            raise ValueError('OWNING_ENTRY_CHANGED')
        config = auto_wake.load_config(outer['autoWakeConfig'])
        if Path(args.config) != Path(config['ownerDirectory']) / 'config.json':
            raise ValueError('OWNING_ENTRY_CHANGED')
        if args.capture:
            result = capture(message_id, config, args.session_id, args.endpoint_id)
        else:
            # The key is disclosed only after the durable association is confirmed.
            key = 'ce-desktop-' + secrets.token_hex(32)
            result = prepare(message_id, args.task_id, key, config, args.session_id, args.endpoint_id)
        print(json.dumps(result))
    except (ValueError, OSError, KeyError, sqlite3.Error, auto_wake.subprocess.SubprocessError) as error:
        expected = {'CAPTURE_LOCK_BUSY', 'CAPTURE_TOO_LATE', 'BEFORE_CAPTURE_CUTOFF'}
        reason = str(error) if isinstance(error, ValueError) and str(error) in expected else 'TARGET_OPERATION_REFUSED'
        print(json.dumps({'messageId': message_id, 'status': 'UNAVAILABLE', 'reason': reason}))
        return 0 if reason in expected else 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
