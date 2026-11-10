"""Receipt target and explicit read checks; a title never attests the actual origin."""
import fcntl
import hashlib
import json
import os
import stat
from pathlib import Path

import wake


def validate_config(value):
    if isinstance(value, dict) and value.get('mode') == 'ownership-check':
        if (set(value) != {'mode', 'registryDirectory', 'captureAfterAuditSequence'}
                or not isinstance(value['registryDirectory'], str)
                or not os.path.isabs(value['registryDirectory'])
                or os.path.normpath(value['registryDirectory']) != value['registryDirectory']
                or type(value['captureAfterAuditSequence']) is not int
                or not 0 <= value['captureAfterAuditSequence'] <= 9007199254740991):
            raise ValueError('CONVERSATION_GUARD_CONFIG_INVALID')
        return dict(value)
    if (not isinstance(value, dict) or set(value) not in ({'mode'}, {'mode', 'targetSelection', 'captureAfterAuditSequence'})
            or value['mode'] not in ('title-match', 'explicit-only')):
        raise ValueError('CONVERSATION_GUARD_CONFIG_INVALID')
    if 'targetSelection' in value and (value['targetSelection'] != 'desktop-at-intake'
            or type(value['captureAfterAuditSequence']) is not int
            or not 0 <= value['captureAfterAuditSequence'] <= 9007199254740991):
        raise ValueError('CONVERSATION_GUARD_CONFIG_INVALID')
    return dict(value)


def automatic_decision(mode, target=None):
    # The accepted policy selects the desktop at intake; it still does not attest
    # the actual initiating chat. Only a validated immutable receipt target can allow a wake.
    if mode == 'title-match' and target is not None:
        return None
    return {'mode': mode, 'reason': 'SOURCE_BINDING_UNAVAILABLE' if mode == 'title-match' else 'EXPLICIT_ONLY'}


def check_title(expected, windows, envelope):
    """Exact advisory predicate only. MATCH does not attest source or authorize input."""
    if not wake.hook_text(expected, 512) or not expected.strip():
        return 'SOURCE_TITLE_MISSING'
    if not isinstance(windows, list) or len(windows) != 1:
        return 'WINDOW_AMBIGUOUS'
    if (not isinstance(envelope, dict) or envelope.get('version') != '2.5'
            or envelope.get('ok') is not True):
        return 'SNAPSHOT_DENIED'
    data = envelope.get('data')
    if (not isinstance(data, dict) or data.get('complete') is not True
            or data.get('app') != 'ChatGPT' or not isinstance(data.get('tree'), dict)):
        return 'SNAPSHOT_DENIED'
    if (not isinstance(windows[0], dict) or not isinstance(data.get('window'), dict)
            or not windows[0].get('id') or windows[0]['id'] != data['window'].get('id')):
        return 'WINDOW_CHANGED'
    try:
        areas = [n for n in wake.nodes(data['tree']) if n.get('role') == 'webarea']
    except (TypeError, AttributeError):
        return 'SNAPSHOT_DENIED'
    if len(areas) != 1:
        return 'TITLE_AMBIGUOUS'
    title = areas[0].get('name')
    if not wake.hook_text(title, 512) or not title.strip():
        return 'CURRENT_TITLE_MISSING'
    return 'MATCH' if title == expected else 'TITLE_MISMATCH'


def explicit_fetch(selection, state_dir, execute_tool):
    """A trusted host supplies the actual human selection and its existing CE executor.

    This is not a registered tool, CLI, consent detector, source binding, or new CE
    authority. The host must authenticate the user gesture and preserve its current
    CE permissions/approvals. Refusal must raise or return isError=True. Only the
    selected payload tool is called; no Inbox scan, ACK, desktop action or payload log.
    """
    fields = {'kind', 'selectionId', 'messageId', 'originalRequestMessageId', 'exchangeId', 'taskId'}
    if (not isinstance(selection, dict) or set(selection) != fields
            or selection['kind'] != 'HUMAN_SELECTED_REPLY'
            or not wake.hook_text(selection['selectionId'], 256)
            or not wake.hook_text(selection['taskId'], 256)
            or not wake.hook_match('msg_' + wake.HOOK_ID, selection['messageId'])
            or not wake.hook_match('msg_' + wake.HOOK_ID, selection['originalRequestMessageId'])
            or not wake.hook_match('ho_' + wake.HOOK_ID, selection['exchangeId'])):
        raise ValueError('FETCH_MAPPING_REQUIRED')
    selection = dict(selection)
    directory = Path(state_dir)
    if not directory.is_absolute():
        raise ValueError('FETCH_STATE_PATH_INVALID')
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_REQUIRED')
    lock = os.open(directory / '.fetch.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock, 'r+') as stream:
        wake.private_hook_file(stream.fileno())
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / ('fetch-' + selection['messageId'] + '.json')
        fingerprint = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()
        if os.path.lexists(path):
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, 'rb') as saved_file:
                wake.private_hook_file(saved_file.fileno())
                raw = saved_file.read(16385)
            if len(raw) > 16384:
                raise ValueError('FETCH_JOURNAL_INVALID')
            try:
                saved = json.loads(raw, object_pairs_hook=wake.unique_object)
            except (UnicodeError, json.JSONDecodeError) as error:
                raise ValueError('FETCH_JOURNAL_INVALID') from error
            if (not isinstance(saved, dict) or saved.get('recordSha256') != fingerprint
                    or saved.get('selection') != selection):
                raise ValueError('FETCH_MAPPING_CONFLICT')
            if saved.get('state') not in ('READ_MAY_HAVE_OCCURRED', 'UNKNOWN', 'READ_REFUSED', 'READ_RETURNED'):
                raise ValueError('FETCH_JOURNAL_INVALID')
            return {'messageId': selection['messageId'], 'state': saved['state']}
        if os.path.lexists(path.with_suffix('.tmp')):
            raise ValueError('FETCH_STATE_UNCERTAIN')
        saved = {'selection': selection, 'recordSha256': fingerprint,
                 'provenance': 'HUMAN_SELECTION_NOT_SOURCE_ATTESTATION', 'state': 'READ_MAY_HAVE_OCCURRED'}
        wake.write_state(path, saved)
        try:
            result = execute_tool('ce_read_payload', {'messageId': selection['messageId']})
        except Exception:
            saved['state'] = 'UNKNOWN'
            wake.write_state(path, saved)
            raise ValueError('FETCH_OUTCOME_UNKNOWN') from None
        saved['state'] = 'READ_REFUSED' if isinstance(result, dict) and result.get('isError') is True else 'READ_RETURNED'
        wake.write_state(path, saved)
        return {'messageId': selection['messageId'], 'state': saved['state'], 'toolResult': result}
