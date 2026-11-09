#!/usr/bin/env python3
"""Explicit metadata notification; DELIVER_REPLY keeps its existing guard.

Only a locally prepared CHECK_ONLY key can select this path. Preparing does not
send CE or touch the desktop. The verified commit supplies the actual outgoing
MID; foreground selection is not conversation identity or payload permission.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import subprocess
import sys
import time

import auto_wake
import notification
import ownership_feedback
import ownership_guard
import ownership_loop
import receipt_target
import wake

# terminal-notifier returns an action title without a verified message/probe identity.
# Keep its fallback unreachable until cross-notification callback isolation is proven.
NOTIFICATION_FALLBACK_ENABLED = False

PREFIX = 'ce-check-only:'
INTENT_FIELDS = {'schemaVersion', 'deliveryMode', 'requestMessageId', 'taskLabel', 'idempotencyKey',
                 'requestAuditSequence', 'scope', 'authoritySha256', 'status'}


def validate_required_owner(value):
    if not isinstance(value, dict) or set(value) != {'projectLabel', 'taskOwner'}:
        raise ValueError('CHECK_ONLY_REQUIRED_OWNER_INVALID')
    return {key: ownership_guard.label(value[key]) for key in ('projectLabel', 'taskOwner')}


def reason(error):
    code = str(error)
    return code if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code) else type(error).__name__


def entry_open(config):
    owner = Path(config['ownerDirectory'])
    if auto_wake.read_private(owner / 'config.json') != {'autoWakeConfig': str(owner / 'auto-wake.json')}:
        raise ValueError('CHECK_ONLY_DISABLED')
    if auto_wake.load_config(owner / 'auto-wake.json') != config:
        raise ValueError('CHECK_ONLY_CONFIG_CHANGED')


def context_for(config, runtime):
    entry_open(config)
    required = ('runtimeSessionId', 'hookSenderEndpointId', 'hookRecipientEndpointId', 'hookExchangeId',
                'databasePath', 'policyDigest', 'ceSessionId', 'participantId')
    if any(not isinstance(runtime.get(k), str) or not runtime[k] for k in required):
        raise ValueError('CHECK_ONLY_RUNTIME_INVALID')
    name = hashlib.sha256(runtime['runtimeSessionId'].encode()).hexdigest() + '.json.task-ownership.json'
    sidecar = Path(str(config['profilePath']) + '.native-inbound') / name
    context = ownership_feedback.load_context(sidecar, runtime['databasePath'], runtime['runtimeSessionId'],
                                              runtime['hookSenderEndpointId'])
    expected = {'exchangeId': runtime['hookExchangeId'], 'from': runtime['hookSenderEndpointId'],
                'to': runtime['hookRecipientEndpointId']}
    if context['config'] != config or context['store'].scope != expected:
        raise ValueError('CHECK_ONLY_SCOPE_CHANGED')
    return context


def authority_digest(config, runtime):
    facts = {key: runtime[key] for key in ('runtimeSessionId', 'hookSenderEndpointId', 'hookRecipientEndpointId',
                                          'hookExchangeId', 'policyDigest', 'ceSessionId', 'participantId')}
    return hashlib.sha256(json.dumps({'config': config, 'runtime': facts}, sort_keys=True).encode()).hexdigest()


def register_owner(request_id, expected_owner, config, *, confirmation):
    ownership_guard.identifier(request_id)
    expected = validate_required_owner(expected_owner)
    if confirmation != 'EXPLICIT_USER':
        raise ValueError('EXPLICIT_OWNER_CONFIRMATION_REQUIRED')
    if config.get('conversationGuard', {}).get('mode') != 'explicit-only':
        raise ValueError('CHECK_ONLY_EXPLICIT_MODE_REQUIRED')
    runtime = auto_wake.resolve_runtime(config)
    context = context_for(config, runtime)
    store = context['store']
    claim = receipt_target.inbound_claim(config, runtime, request_id, require_read=True, metadata_only=True)
    if 'association' in claim or os.path.lexists(store.root / 'terminal' / (request_id + '.json')):
        raise ValueError('CONTROL_FEEDBACK_IS_TERMINAL')
    # Confirmation is a trusted-user workflow assertion, never derived from CE payload text.
    return store.register(request_id, expected['projectLabel'], expected['taskOwner'],
                          confirmation=confirmation, new_request_only=True)


def prepare(request_id, task_label, config, *, required_owner=None):
    ownership_guard.identifier(request_id)
    ownership_guard.label(task_label)
    expected = validate_required_owner(required_owner) if required_owner is not None else None
    runtime = auto_wake.resolve_runtime(config)
    context = context_for(config, runtime)
    store = context['store']
    claim = receipt_target.inbound_claim(config, runtime, request_id, require_read=True, metadata_only=True)
    if 'association' in claim or os.path.lexists(store.root / 'terminal' / (request_id + '.json')):
        raise ValueError('CONTROL_FEEDBACK_IS_TERMINAL')
    folder = auto_wake.private_dir(store.root / 'check-only-intents')
    path = folder / ('request-' + request_id + '.json')
    with store.locked():
        if os.path.lexists(path):
            saved = auto_wake.read_private(path)
            validate_intent(saved, store, config, runtime)
            if (saved['requestMessageId'] != request_id or saved['taskLabel'] != task_label
                    or saved.get('requiredOwner') != expected):
                raise ValueError('CHECK_ONLY_REQUEST_CONFLICT')
            if saved['status'] != 'PREPARED':
                raise ValueError('CHECK_ONLY_PREPARE_UNKNOWN')
            committed = ownership_loop.key_metadata(saved['idempotencyKey'], runtime)
            if committed is not None:
                return {'status': 'ALREADY_COMMITTED', 'deliveryMode': 'CHECK_ONLY',
                        'requestMessageId': request_id, 'messageId': committed['messageId']}
            return {'status': 'PREPARED', 'deliveryMode': 'CHECK_ONLY', 'requestMessageId': request_id,
                    'idempotencyKey': saved['idempotencyKey']}
        key = PREFIX + secrets.token_hex(32)
        if ownership_loop.key_metadata(key, runtime) is not None:
            raise ValueError('CHECK_ONLY_KEY_ALREADY_COMMITTED')
        intent = {'schemaVersion': 1, 'deliveryMode': 'CHECK_ONLY', 'requestMessageId': request_id,
                  'taskLabel': task_label, 'idempotencyKey': key, 'requestAuditSequence': claim['auditSequence'],
                  'scope': store.scope, 'authoritySha256': authority_digest(config, runtime), 'status': 'PREPARING'}
        if expected is not None:
            intent['requiredOwner'] = expected
        store.write(path, intent)
        # Binding is durable before the second absence check. A prior message
        # cannot acquire an invented notification association after the fact.
        if ownership_loop.key_metadata(key, runtime) is not None:
            raise ValueError('CHECK_ONLY_KEY_ALREADY_COMMITTED')
        intent['status'] = 'PREPARED'
        store.write(path, intent)
    return {'status': 'PREPARED', 'deliveryMode': 'CHECK_ONLY', 'requestMessageId': request_id, 'idempotencyKey': key}


def validate_intent(value, store, config, runtime):
    if (not isinstance(value, dict) or set(value) not in (INTENT_FIELDS, INTENT_FIELDS | {'requiredOwner'})
            or type(value['schemaVersion']) is not int
            or value['schemaVersion'] != 1 or value['deliveryMode'] != 'CHECK_ONLY'
            or value['status'] not in ('PREPARING', 'PREPARED') or value['scope'] != store.scope
            or value['authoritySha256'] != authority_digest(config, runtime)
            or type(value['requestAuditSequence']) is not int or value['requestAuditSequence'] <= config['afterAuditSequence']
            or not isinstance(value['idempotencyKey'], str) or not re.fullmatch(PREFIX + r'[0-9a-f]{64}', value['idempotencyKey'])):
        raise ValueError('CHECK_ONLY_INTENT_INVALID')
    ownership_guard.identifier(value['requestMessageId'])
    ownership_guard.label(value['taskLabel'])
    if 'requiredOwner' in value:
        validate_required_owner(value['requiredOwner'])


def current_authority(event, config, runtime, intent):
    entry_open(config)
    fresh = auto_wake.resolve_runtime(config)
    if authority_digest(config, fresh) != intent['authoritySha256']:
        raise ValueError('CHECK_ONLY_AUTHORITY_CHANGED')
    auto_wake.validate_current({'messageId': event['messageId']}, config, fresh)


def dispatch(event, config, runtime, *, desktop_factory=None, notifier=None, authority=None):
    metadata = ownership_loop.outgoing_metadata(event['messageId'], runtime)
    key = metadata['idempotencyKey']
    if not isinstance(key, str) or not key.startswith(PREFIX):
        return None
    base = {'deliveryMode': 'CHECK_ONLY', 'messageId': event['messageId'], 'noticeSubmission': 'NOT_ATTEMPTED'}
    try:
        context = context_for(config, runtime)
        store = context['store']
        if not re.fullmatch(PREFIX + r'[0-9a-f]{64}', key):
            raise ValueError('CHECK_ONLY_KEY_INVALID')
        folder = auto_wake.private_dir(store.root / 'check-only-intents')
        paths = list(folder.glob('request-msg_*.json'))
        if len(paths) > 4096:
            raise ValueError('CHECK_ONLY_INTENTS_TOO_LARGE')
        matches = []
        for path in paths:
            value = auto_wake.read_private(path)
            if isinstance(value, dict) and value.get('idempotencyKey') == key:
                validate_intent(value, store, config, runtime)
                matches.append(value)
        if len(matches) != 1 or matches[0]['status'] != 'PREPARED':
            raise ValueError('CHECK_ONLY_PREPARED_INTENT_REQUIRED')
        intent = matches[0]
        if metadata['auditSequence'] <= intent['requestAuditSequence']:
            raise ValueError('CHECK_ONLY_COMMIT_ORDER_INVALID')
        projection = store.associate(intent['requestMessageId'], {'messageId': event['messageId'],
                                     'disposition': 'CREATED', **store.scope})
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        return {**base, 'stage': 'SUPPRESSED', 'reason': reason(error)}
    action_dir = auto_wake.private_dir(store.root / 'check-only-actions')
    file = action_dir / (event['messageId'] + '.json')
    with auto_wake.locked(action_dir / (event['messageId'] + '.lock')):
        if os.path.lexists(file):
            return auto_wake.read_private(file)['result']
        record = {'deliveryMode': 'CHECK_ONLY', 'messageId': event['messageId'],
                  'requestMessageId': intent['requestMessageId'], 'probeId': projection['probeId'],
                  'phase': 'SELECTING_CURRENT_WINDOW', 'result': {**base, 'stage': 'UNKNOWN'}}
        def save():
            store.write(file, record)
        save()
        expected_owner = intent.get('requiredOwner')
        def check_registered_owner():
            if expected_owner is None:
                return
            current = store.projection(event['messageId'])
            if (current['ownerStatus'] != 'REGISTERED'
                    or any(current[key] != value for key, value in expected_owner.items())):
                raise ValueError('CHECK_ONLY_REGISTERED_OWNER_REQUIRED')
        base_check = authority or (lambda: current_authority(event, config, runtime, intent))
        def check():
            check_registered_owner()
            base_check()
        if desktop_factory is None:
            import check_only_desktop
            desktop_factory = check_only_desktop.desktop_for
        def desktop_config():
            value = {'stateDir': str(action_dir), 'agentDesktop': config['agentDesktop'],
                     'desktopSession': 'ce-check-only-' + event['messageId'][4:],
                     'maxWaitSeconds': config['maxWaitSeconds'],
                     'executionEnd': time.monotonic() + config['maxWaitSeconds'], 'checkAuthority': check}
            if expected_owner is not None:
                value['checkRegisteredOwner'] = check_registered_owner
            return value
        cfg = desktop_config()
        try:
            check()
            desktop = desktop_factory(cfg)
            result = store.attempt(event['messageId'], cfg, desktop, authority=check, metadata_only=True)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            # The factory only observes/selects: it has no input or submit methods
            # in its selection flow. Its refusal is proven pre-input.
            with store.locked():
                state = store.state(event['messageId'])
                if state['automatic'] == 'NOT_ATTEMPTED':
                    state.update(automatic='SUPPRESSED', automaticPhase='OBSERVING', automaticReason=reason(error))
                    store.save(event['messageId'], state)
            result = {'noticeSubmission': 'NOT_ATTEMPTED'}
        observed = result['noticeSubmission']
        record['result'] = {**base, **result, 'stage': 'OBSERVED' if observed == 'OBSERVED' else 'UNKNOWN' if observed == 'UNKNOWN' else 'SUPPRESSED'}
        record['phase'] = 'NOTICE_OBSERVED' if observed == 'OBSERVED' else 'FALLBACK_PENDING'
        save()
        if observed == 'OBSERVED':
            return record['result']
        if not NOTIFICATION_FALLBACK_ENABLED:
            record['phase'] = 'NOTIFICATION_DISABLED'
            record['result']['notification'] = 'DISABLED'
            save()
            return record['result']
        # One fallback only, shared with the metadata-probe journal. Unknown input
        # can be acknowledged, but no button can authorize another input attempt.
        with store.locked():
            state = store.state(event['messageId'])
            if state['notification'] != 'NOT_ATTEMPTED' or state['feedback'] is not None:
                return record['result']
            try:
                check()
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                record['result']['reason'] = reason(error)
                record['phase'] = 'SUPPRESSED_BY_AUTHORITY'
                save()
                return record['result']
            state['notification'] = 'UNKNOWN'
            state['notificationEligible'] = False
            store.save(event['messageId'], state)
        unknown = observed == 'UNKNOWN'
        action = '查看状态' if unknown else '检查当前会话'
        group = 'ce-check-only:' + event['messageId'] + ':' + projection['probeId']
        request = {'title': 'Pi → ChatGPT', 'message': ('输入或提交状态不确定，不会重试。' if unknown else
                   '请切回当前 ChatGPT 会话，确认空闲且无草稿后点击检查。') + event['messageId'],
                   'group': group, 'action': action, 'timeout': config['notificationTimeoutSeconds']}
        record.update(phase='NOTIFICATION_MAY_HAVE_OCCURRED', notificationGroup=group, buttonScope='STATUS_ONLY' if unknown else 'ONE_FRESH_CHECK')
        record['result']['notification'] = 'UNKNOWN'
        save()
        notify = notifier or (lambda req: notification.terminal_notifier(req, config['terminalNotifier']))
        try:
            outcome = notify(request)
        except (OSError, subprocess.SubprocessError):
            record['phase'] = 'NOTIFICATION_UNKNOWN'
            save()
            return record['result']
        with store.locked():
            state = store.state(event['messageId'])
            if outcome != action:
                state['notification'] = 'DISMISSED' if outcome == '@CLOSED' else 'UNKNOWN'
                store.save(event['messageId'], state)
                record['result']['notification'] = state['notification']
                record['phase'] = 'FALLBACK_FINISHED_NO_CONSENT'
                save()
                return record['result']
            state['notification'] = 'ACTION_BUTTON'
            if unknown or state['automatic'] == 'UNKNOWN':
                store.save(event['messageId'], state)
                record['phase'] = 'UNKNOWN_STATUS_ONLY_NO_RETRY'
                record['result'].update(stage='UNKNOWN', noticeSubmission='UNKNOWN', notification='ACTION_BUTTON')
                save()
                return record['result']
            if state['feedback'] is not None or state['manual'] != 'NOT_ATTEMPTED':
                store.save(event['messageId'], state)
                return record['result']
            state['manual'] = 'CONSENT_CONSUMED'
            store.save(event['messageId'], state)
        record['phase'] = 'MANUAL_SELECTION_MAY_HAVE_OCCURRED'
        save()
        cfg = desktop_config()
        try:
            check()
            desktop = desktop_factory(cfg)
            result = store.attempt(event['messageId'], cfg, desktop, manual=True, authority=check, metadata_only=True)
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            with store.locked():
                state = store.state(event['messageId'])
                if state['manual'] == 'CONSENT_CONSUMED':
                    state.update(manual='SUPPRESSED', manualPhase='OBSERVING', manualReason=reason(error))
                    store.save(event['messageId'], state)
            result = {'noticeSubmission': 'NOT_ATTEMPTED'}
        observed = result['noticeSubmission']
        record['result'] = {**base, **result, 'notification': 'ACTION_BUTTON',
                            'stage': 'OBSERVED' if observed == 'OBSERVED' else 'UNKNOWN' if observed == 'UNKNOWN' else 'SUPPRESSED'}
        record['phase'] = 'NOTICE_OBSERVED' if observed == 'OBSERVED' else 'MANUAL_CHECK_FINISHED'
        save()
        return record['result']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--request', required=True)
    parser.add_argument('--task-label', required=True)
    parser.add_argument('--required-project-label')
    parser.add_argument('--required-task-owner')
    parser.add_argument('--register-owner', action='store_true')
    parser.add_argument('--confirmation')
    args = parser.parse_args(argv)
    os.umask(0o077)
    try:
        config = auto_wake.load_config(args.config)
        expected = None
        if args.required_project_label is not None or args.required_task_owner is not None:
            expected = {'projectLabel': args.required_project_label, 'taskOwner': args.required_task_owner}
        if args.register_owner:
            ownership_guard.label(args.task_label)
            result = register_owner(args.request, expected, config, confirmation=args.confirmation)
        else:
            if args.confirmation is not None:
                raise ValueError('CONFIRMATION_ONLY_FOR_REGISTRATION')
            result = prepare(args.request, args.task_label, config, required_owner=expected)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'SUPPRESSED', 'reason': reason(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
