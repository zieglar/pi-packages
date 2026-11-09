#!/usr/bin/env python3
"""Control-edge adapter for the explicitly selected ownership-check Hook mode.

No CE authority is added. Outgoing metadata uses the existing observer's verified
store boundary; incoming feedback requires the existing native receive receipt.
No payload column is queried and no CE tool is called by this adapter.
"""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time

import auto_wake
import ownership_guard
import receipt_target
import wake


def store_for(config, runtime):
    guard = config.get('conversationGuard', {})
    if guard.get('mode') != 'ownership-check':
        raise ValueError('OWNERSHIP_MODE_REQUIRED')
    guard = __import__('conversation_guard').validate_config(guard)
    return ownership_guard.Store(guard['registryDirectory'], {
        'exchangeId': runtime['hookExchangeId'], 'from': runtime['hookSenderEndpointId'],
        'to': runtime['hookRecipientEndpointId']})


def metadata_connection(runtime):
    db = sqlite3.connect(Path(runtime['databasePath']).as_uri() + '?mode=ro', uri=True, timeout=2)
    db.execute('PRAGMA query_only=ON')
    return db


def key_metadata(key, runtime):
    with contextlib.closing(metadata_connection(runtime)) as db:
        row = db.execute('SELECT message_id FROM message WHERE exchange_id=? AND idempotency_key=?',
                         (runtime['hookExchangeId'], key)).fetchone()
    return None if row is None else {'messageId': row[0]}


def outgoing_metadata(message_id, runtime):
    with contextlib.closing(metadata_connection(runtime)) as db:
        row = db.execute('''SELECT m.idempotency_key,a.sequence FROM message m JOIN audit_event a
ON a.subject_id=m.message_id AND a.exchange_id=m.exchange_id AND a.kind='message_created'
WHERE m.exchange_id=? AND m.message_id=?''', (runtime['hookExchangeId'], message_id)).fetchall()
    if len(row) != 1:
        raise ValueError('OUTGOING_METADATA_REQUIRED')
    return {'messageId': message_id, 'idempotencyKey': row[0][0], 'auditSequence': row[0][1]}


def intent_path(store, key):
    if not isinstance(key, str) or not 1 <= len(key) <= 200 or not all(32 < ord(c) < 127 for c in key):
        raise ValueError('REPLY_KEY_INVALID')
    folder = auto_wake.private_dir(store.root / 'intents')
    return folder / (hashlib.sha256(key.encode()).hexdigest() + '.json')


def prepare(request_id, key, config, runtime):
    ownership_guard.identifier(request_id)
    store = store_for(config, runtime)
    claim = receipt_target.inbound_claim(config, runtime, request_id, require_read=True)
    path = intent_path(store, key)
    with store.locked():
        # A control-feedback receipt can never become a new business reply intent.
        terminal = store.root / 'terminal' / (request_id + '.json')
        if os.path.lexists(terminal):
            auto_wake.read_private(terminal)
            raise ValueError('CONTROL_FEEDBACK_IS_TERMINAL')
        intent = {'requestMessageId': request_id, 'idempotencyKey': key,
                  'requestAuditSequence': claim['auditSequence'], **store.scope}
        if os.path.lexists(path):
            if auto_wake.read_private(path) != intent:
                raise ValueError('REPLY_KEY_CONFLICT')
            if os.path.lexists(path.with_name(path.stem + '.ready.json')):
                return {'requestMessageId': request_id, 'status': 'PREPARED', 'idempotencyKey': key}
        elif key_metadata(key, runtime) is not None:
            raise ValueError('REPLY_ALREADY_COMMITTED')
        else:
            store.write(path, intent)
        # Intent is durable before the second absence check. A message that was
        # already committed cannot acquire an association after the fact.
        if key_metadata(key, runtime) is not None:
            raise ValueError('REPLY_ALREADY_COMMITTED')
        ready = path.with_name(path.stem + '.ready.json')
        store.write(ready, {'intentSha256': hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()})
    return {'requestMessageId': request_id, 'status': 'PREPARED', 'idempotencyKey': key}


class CurrentDesktop(wake.ChatGptCli):
    def snapshot(self):
        windows = self.call(['list-windows', '--app', 'ChatGPT'])['data']
        if not isinstance(windows, list) or len(windows) != 1:
            raise ValueError('UNIQUE_CHATGPT_WINDOW_REQUIRED')
        window = windows[0]
        if (window.get('id') != self.config['windowId'] or window.get('pid') != self.config['pid']
                or window.get('process_instance') != self.config['processInstance']):
            raise ValueError('CHATGPT_PROCESS_OR_WINDOW_CHANGED')
        return super().snapshot()

    def fill(self, ref, text):
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        if view['draft']:
            raise ValueError('NONEMPTY_DRAFT')
        self.expected_prompt = text
        self.config['checkAuthority']()
        super().fill(view['input']['ref_id'], text)

    def submit(self, ref):
        view = wake.observe(self.snapshot(), self.config, require_marker=False)
        if view['draft'] != self.expected_prompt or 'disabled' in view['send'].get('states', []):
            raise ValueError('DRAFT_OR_SEND_READBACK_MISMATCH')
        self.config['checkAuthority']()
        super().submit(view['send']['ref_id'])


def desktop_for(config):
    config['desktopTmpDir'] = tempfile.mkdtemp(prefix='cew-', dir='/private/tmp')
    cli = CurrentDesktop(config)
    cli.env = {**auto_wake.clean_env(), 'TMPDIR': config['desktopTmpDir']}
    windows = cli.call(['list-windows', '--app', 'ChatGPT'])['data']
    if not isinstance(windows, list) or len(windows) != 1:
        raise ValueError('UNIQUE_CHATGPT_WINDOW_REQUIRED')
    window = windows[0]
    if (not isinstance(window, dict) or not isinstance(window.get('id'), str)
            or type(window.get('pid')) is not int or not isinstance(window.get('process_instance'), str)):
        raise ValueError('WINDOW_METADATA_INVALID')
    config.update(windowId=window['id'], pid=window['pid'], processInstance=window['process_instance'])
    return cli


def current_authority(event, config, runtime):
    fresh = auto_wake.load_config(Path(config['ownerDirectory']) / 'auto-wake.json')
    if fresh != config:
        raise ValueError('OWNERSHIP_CONFIG_CHANGED')
    current = auto_wake.resolve_runtime(fresh)
    for key in ('hookExchangeId', 'hookSenderEndpointId', 'hookRecipientEndpointId', 'ceSessionId', 'participantId', 'policyDigest'):
        if current[key] != runtime[key]:
            raise ValueError('CURRENT_AUTHORITY_CHANGED')
    auto_wake.validate_current({'messageId': event['messageId']}, fresh, current)


def outgoing(event, config, runtime, *, desktop_factory=None):
    store = store_for(config, runtime)
    meta = outgoing_metadata(event['messageId'], runtime)
    path = intent_path(store, meta['idempotencyKey'])
    ready = path.with_name(path.stem + '.ready.json')
    if not os.path.lexists(path) or not os.path.lexists(ready):
        return {'stage': 'SUPPRESSED', 'reason': 'UNPREPARED_OWNERSHIP_REPLY'}
    intent = auto_wake.read_private(path)
    if (set(intent) != {'requestMessageId', 'idempotencyKey', 'requestAuditSequence', *store.scope}
            or any(intent[k] != v for k, v in store.scope.items())
            or intent['idempotencyKey'] != meta['idempotencyKey'] or meta['messageId'] != event['messageId']
            or type(intent['requestAuditSequence']) is not int or meta['auditSequence'] <= intent['requestAuditSequence']
            or auto_wake.read_private(ready) != {'intentSha256': hashlib.sha256(json.dumps(intent, sort_keys=True).encode()).hexdigest()}):
        raise ValueError('OWNERSHIP_INTENT_INVALID')
    p = store.associate(intent['requestMessageId'], {'messageId': event['messageId'], 'disposition': 'CREATED', **store.scope})
    if p['ownerStatus'] != 'REGISTERED':
        return {'stage': 'SUPPRESSED', 'reason': 'OWNER_UNVERIFIED'}
    cfg = {'stateDir': str(store.root), 'agentDesktop': config['agentDesktop'],
           'maxWaitSeconds': config['maxWaitSeconds'], 'executionEnd': time.monotonic() + config['maxWaitSeconds'],
           'desktopSession': 'ce-owner-' + p['probeId']}
    cfg['checkAuthority'] = lambda: current_authority(event, config, runtime)
    desk = (desktop_factory or desktop_for)(cfg)
    result = store.attempt(p['messageId'], cfg, desk, authority=lambda: current_authority(event, config, runtime))
    status = result['noticeSubmission']
    return {'stage': 'OBSERVED' if status == 'OBSERVED' else 'UNKNOWN' if status == 'UNKNOWN' else 'SUPPRESSED',
            'result': result, 'suppressOrdinaryReply': True}


def receive_feedback(received_message_id, body, config, runtime, *, notifier=None, desktop_factory=None):
    store = store_for(config, runtime)
    # Native receive supplies the original envelope, never payload self-assertion.
    claim = receipt_target.inbound_claim(config, runtime, received_message_id, require_read=True)
    meta = claim['metadata']
    state = store.feedback({k: meta[k] for k in ('messageId', 'exchangeId', 'from', 'to')}, body)
    if not state['notificationEligible']:
        return state
    p = store.projection(body['messageId'])
    cfg = {'stateDir': str(store.root), 'agentDesktop': config['agentDesktop'],
           'maxWaitSeconds': config['maxWaitSeconds'], 'executionEnd': time.monotonic() + config['maxWaitSeconds'],
           'desktopSession': 'ce-owner-manual-' + p['probeId']}
    event = {'messageId': p['messageId']}
    def after_button():
        # Human notification wait is outside the bounded desktop action window.
        cfg['executionEnd'] = time.monotonic() + config['maxWaitSeconds']
        cfg['checkAuthority'] = lambda: current_authority(event, config, runtime)
        return (desktop_factory or desktop_for)(cfg)
    return store.notify(p['messageId'], cfg,
                        {'terminalNotifier': config['terminalNotifier'], 'timeoutSeconds': config['notificationTimeoutSeconds'],
                         'actionTitle': '检查当前对话'}, notifier=notifier,
                        desktop_factory=after_button,
                        authority=lambda: current_authority(event, config, runtime))
