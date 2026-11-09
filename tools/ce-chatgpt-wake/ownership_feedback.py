#!/usr/bin/env python3
"""Metadata/control bridge for native Task Ownership Guard feedback.

Classification reads only committed metadata. Consumption runs after native CE
read permission and receipt checks; business text is never returned or persisted.
The reserved idempotency namespace and local probe provide correlation, not a
native ChatGPT Conversation-ID or additional CE authority.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys

import auto_wake
import ownership_guard
import ownership_loop
import receipt_target
import wake

METADATA_FIELDS = {'messageId', 'exchangeId', 'from', 'to', 'payloadDigest', 'payloadLength', 'createdAt', 'auditSequence'}
RESERVED = 'ce-owner-feedback:'
KEY_PATTERN = re.compile(r'ce-owner-feedback:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(MATCH|WRONG_CONVERSATION|UNVERIFIED|UNKNOWN)')


def canonical(value):
    if not isinstance(value, (str, Path)):
        raise ValueError('FEEDBACK_PATH_INVALID')
    path = Path(value)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)) or path.resolve() != path:
        raise ValueError('FEEDBACK_PATH_INVALID')
    return path


def load_context(sidecar, database_path, runtime_session_id, endpoint_id):
    selected = auto_wake.read_private(canonical(sidecar))
    if (not isinstance(selected, dict) or set(selected) != {'schemaVersion', 'registryDirectory', 'observerConfig'}
            or type(selected['schemaVersion']) is not int or selected['schemaVersion'] != 1):
        raise ValueError('FEEDBACK_CONFIG_INVALID')
    config = auto_wake.load_config(canonical(selected['observerConfig']))
    session_path = canonical(config['nativeSessionFile'])
    fd = os.open(session_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        wake.private_hook_file(stream.fileno())
        raw = stream.readline(8193)
    if len(raw) > 8192:
        raise ValueError('FEEDBACK_SESSION_INVALID')
    header = json.loads(raw, object_pairs_hook=wake.unique_object)
    if not isinstance(header, dict) or header.get('type') != 'session' or header.get('id') != runtime_session_id:
        raise ValueError('FEEDBACK_SESSION_INVALID')
    directory = canonical(selected['registryDirectory'])
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('FEEDBACK_REGISTRY_REQUIRED')
    scope = auto_wake.read_private(directory / 'scope.json')
    if not isinstance(scope, dict) or scope.get('from') != endpoint_id:
        raise ValueError('FEEDBACK_SCOPE_DENIED')
    store = ownership_guard.Store(directory, scope)
    database = canonical(database_path)
    fd = os.open(database, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        wake.private_hook_file(fd)
    finally:
        os.close(fd)
    return {'config': config, 'store': store, 'databasePath': str(database),
            'runtimeSessionId': runtime_session_id, 'endpointId': endpoint_id}


def validate_metadata(context, value):
    if not isinstance(value, dict) or set(value) != METADATA_FIELDS:
        raise ValueError('FEEDBACK_METADATA_INVALID')
    scope = context['store'].scope
    if value['exchangeId'] != scope['exchangeId'] or value['from'] != scope['to'] or value['to'] != scope['from']:
        raise ValueError('FEEDBACK_SCOPE_DENIED')
    ownership_guard.identifier(value['messageId'])
    if (not isinstance(value['payloadDigest'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['payloadDigest'])
            or type(value['payloadLength']) is not int or not 1 <= value['payloadLength'] <= 65536
            or type(value['auditSequence']) is not int or not 0 < value['auditSequence'] <= 9007199254740991
            or not isinstance(value['createdAt'], str) or not 1 <= len(value['createdAt']) <= 80):
        raise ValueError('FEEDBACK_METADATA_INVALID')
    return value


def committed_key(context, metadata):
    # Deliberately no payload columns or core mutation APIs at this boundary.
    uri = Path(context['databasePath']).as_uri() + '?mode=ro'
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=2)) as db:
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        rows = db.execute('''SELECT m.exchange_id,m.from_endpoint_json,m.to_endpoint_json,
m.payload_digest,m.payload_length,m.created_at,m.idempotency_key,a.sequence
FROM message m JOIN audit_event a ON a.subject_id=m.message_id AND a.exchange_id=m.exchange_id AND a.kind='message_created'
WHERE m.message_id=?''', (metadata['messageId'],)).fetchall()
    if len(rows) != 1:
        raise ValueError('FEEDBACK_COMMITTED_METADATA_DENIED')
    row = rows[0]
    source = json.loads(row[1], object_pairs_hook=wake.unique_object)
    target = json.loads(row[2], object_pairs_hook=wake.unique_object)
    actual = (row[0], source, target, row[3], row[4], row[5], row[7])
    expected = (metadata['exchangeId'], {'adapter': 'chatgpt', 'endpointId': metadata['from']},
                {'adapter': 'pi', 'endpointId': metadata['to']}, metadata['payloadDigest'],
                metadata['payloadLength'], metadata['createdAt'], metadata['auditSequence'])
    if actual != expected:
        raise ValueError('FEEDBACK_COMMITTED_METADATA_DENIED')
    return row[6]


def classify(context, value):
    metadata = validate_metadata(context, value)
    key = committed_key(context, metadata)
    if not isinstance(key, str) or not key.startswith(RESERVED):
        return {'kind': 'NONE'}
    match = KEY_PATTERN.fullmatch(key)
    if match is None:
        return {'kind': 'BLOCKED', 'reason': 'FEEDBACK_KEY_INVALID'}
    probe_id, hint = match.groups()
    store = context['store']
    paths = list((store.root / 'metadata').glob('msg_*.json'))
    if len(paths) > 4096:
        raise ValueError('FEEDBACK_REGISTRY_TOO_LARGE')
    matches = []
    for path in paths:
        projection = store.projection(path.stem)
        if projection['probeId'] == probe_id:
            matches.append(projection)
    if len(matches) != 1:
        return {'kind': 'BLOCKED', 'reason': 'FEEDBACK_PROBE_UNVERIFIED'}
    projection = matches[0]
    # Correlation comes from the actual CE key and local probe, including an
    # UNVERIFIED owner. This only selects terminal control handling; it grants
    # no payload authority and cannot promote a missing owner to MATCH.
    return {'kind': 'FEEDBACK', 'messageId': metadata['messageId'], 'requestMessageId': projection['requestMessageId'],
            'outgoingMessageId': projection['messageId'], 'probeId': probe_id, 'outcomeHint': hint}


def consume(context, value):
    if not isinstance(value, dict) or set(value) != {'metadata', 'association', 'text'}:
        raise ValueError('FEEDBACK_INPUT_INVALID')
    metadata = validate_metadata(context, value['metadata'])
    association = classify(context, metadata)
    if association.get('kind') != 'FEEDBACK' or value['association'] != association:
        raise ValueError('FEEDBACK_ASSOCIATION_CHANGED')
    config = context['config']
    runtime = auto_wake.resolve_runtime(config)
    scope = context['store'].scope
    if (runtime['runtimeSessionId'] != context['runtimeSessionId'] or runtime['hookSenderEndpointId'] != context['endpointId']
            or runtime['hookRecipientEndpointId'] != scope['to'] or runtime['hookExchangeId'] != scope['exchangeId']
            or Path(runtime['databasePath']).resolve() != Path(context['databasePath'])):
        raise ValueError('FEEDBACK_RUNTIME_CHANGED')
    claim = receipt_target.inbound_claim(config, runtime, metadata['messageId'], require_read=True, metadata_only=True)
    if claim['metadata'] != metadata:
        raise ValueError('FEEDBACK_NATIVE_METADATA_CHANGED')
    store = context['store']
    store.record_terminal(metadata['messageId'], association['outgoingMessageId'], association['probeId'])
    # Refusal, malformed body and literal UNKNOWN are terminal UNVERIFIED, never
    # business text or an opportunity to arm a notification after uncertainty.
    body = None
    text = value['text']
    if (isinstance(text, str) and len(text.encode('utf8')) <= 2048
            and len(text.encode('utf8')) == metadata['payloadLength']
            and hashlib.sha256(text.encode('utf8')).hexdigest() == metadata['payloadDigest']):
        try:
            parsed = json.loads(text, object_pairs_hook=wake.unique_object)
            expected_keys = {'protocol', 'messageId', 'requestMessageId', 'probeId', 'outcome'}
            if (isinstance(parsed, dict) and set(parsed) == expected_keys
                    and parsed['protocol'] == 'ce.task-owner-feedback.v1'
                    and parsed['messageId'] == association['outgoingMessageId']
                    and parsed['requestMessageId'] == association['requestMessageId']
                    and parsed['probeId'] == association['probeId']
                    and parsed['outcome'] == association['outcomeHint'] and parsed['outcome'] in ownership_guard.OUTCOMES):
                body = parsed
        except (ValueError, UnicodeError):
            pass
    if body is not None and body['outcome'] == 'MATCH' and store.projection(association['outgoingMessageId'])['ownerStatus'] != 'REGISTERED':
        body = None
    valid = body is not None
    if body is None:
        body = {'protocol': 'ce.task-owner-feedback.v1', 'messageId': association['outgoingMessageId'],
                'requestMessageId': association['requestMessageId'], 'probeId': association['probeId'], 'outcome': 'UNVERIFIED'}
    envelope = {k: metadata[k] for k in ('messageId', 'exchangeId', 'from', 'to')}
    action_mode = (valid and config['conversationGuard']['mode'] == 'ownership-check'
                   and config['conversationGuard']['registryDirectory'] == str(store.root))
    if action_mode:
        # Action kind is bound to the actual committed outgoing CE key. A later
        # mode change cannot promote CHECK_ONLY into business notice or retry.
        try:
            outgoing = ownership_loop.outgoing_metadata(association['outgoingMessageId'], runtime)
        except (ValueError, OSError, sqlite3.Error):
            outgoing = None
        key = outgoing['idempotencyKey'] if outgoing else None
        action_mode = isinstance(key, str) and not key.startswith('ce-check-only:')
    if action_mode:
        ownership_loop.receive_feedback(metadata['messageId'], body, config, runtime)
    else:
        store.feedback(envelope, body, allow_notification=False)
    return {'kind': 'TERMINAL', 'messageId': metadata['messageId'], 'requestMessageId': association['requestMessageId'],
            'outgoingMessageId': association['outgoingMessageId'], 'probeId': association['probeId'],
            'outcome': body['outcome'], 'status': 'RECORDED' if valid else 'UNVERIFIED', 'suppressOrdinaryReply': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sidecar', required=True)
    parser.add_argument('--database-path', required=True)
    parser.add_argument('--runtime-session-id', required=True)
    parser.add_argument('--endpoint-id', required=True)
    parser.add_argument('--action', choices=('classify', 'consume'), required=True)
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(524289)
        if len(raw) > 524288:
            raise ValueError('FEEDBACK_INPUT_TOO_LARGE')
        value = json.loads(raw.decode('utf8'), object_pairs_hook=wake.unique_object)
        context = load_context(args.sidecar, args.database_path, args.runtime_session_id, args.endpoint_id)
        result = (classify if args.action == 'classify' else consume)(context, value)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, UnicodeError, sqlite3.Error, subprocess.SubprocessError) as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code):
            code = 'FEEDBACK_BRIDGE_REJECTED'
        print(json.dumps({'status': code}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
