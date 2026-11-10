#!/usr/bin/env python3
"""Fixed CE metadata notice in one operator-authorized ChatGPT conversation."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import stat
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ce-ovis-desktop'))
from bridge import DesktopCli, nodes, remaining, write_state


HOOK_MAX_INPUT = 16384
HOOK_ID = r'[0-9A-HJKMNP-TV-Z]{26}'
HOOK_FIELDS = {'schemaVersion', 'event', 'eventId', 'eventKey', 'messageId',
               'exchangeId', 'sender', 'recipient', 'createdAt', 'payloadDigest', 'payloadLength'}
HOOK_CONFIG_FIELDS = {'hookSenderAdapter', 'hookSenderEndpointId', 'hookRecipientAdapter',
                      'hookRecipientEndpointId', 'hookExchangeId', 'stateDir'}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('HOOK_INPUT_DUPLICATE_FIELD')
        result[key] = value
    return result


def hook_text(value, maximum):
    return (isinstance(value, str) and 0 < len(value) <= maximum
            and not any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF
                        for char in value))


def hook_match(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def validate_hook(raw, config):
    if (not isinstance(config, dict) or set(config) != HOOK_CONFIG_FIELDS
            or config['hookSenderAdapter'] != 'pi' or config['hookRecipientAdapter'] != 'chatgpt'
            or not hook_text(config['hookSenderEndpointId'], 256)
            or not hook_text(config['hookRecipientEndpointId'], 256)
            or not hook_match('ho_' + HOOK_ID, config['hookExchangeId'])
            or not hook_text(config['stateDir'], 4096) or not os.path.isabs(config['stateDir'])
            or os.path.normpath(config['stateDir']) != config['stateDir']):
        raise ValueError('HOOK_CONFIG_INVALID')
    if len(raw) > HOOK_MAX_INPUT:
        raise ValueError('HOOK_INPUT_TOO_LARGE')
    try:
        decoded = raw.decode('utf-8')
    except UnicodeError as error:
        raise ValueError('HOOK_INPUT_INVALID_ENCODING') from error
    try:
        event = json.loads(decoded, object_pairs_hook=unique_object)
    except (json.JSONDecodeError, RecursionError) as error:
        raise ValueError('HOOK_INPUT_INVALID_JSON') from error
    if not isinstance(event, dict) or set(event) != HOOK_FIELDS:
        raise ValueError('HOOK_EVENT_FIELDS_INVALID')
    if type(event['schemaVersion']) is not int or event['schemaVersion'] != 1:
        raise ValueError('HOOK_SCHEMA_VERSION_INVALID')
    if event['event'] != 'ce.message.committed.v1':
        raise ValueError('HOOK_EVENT_NAME_INVALID')
    for field, prefix, code in (('eventId', 'evt_', 'EVENT_ID'), ('messageId', 'msg_', 'MESSAGE_ID'),
                                ('exchangeId', 'ho_', 'EXCHANGE_ID')):
        if not hook_match(prefix + HOOK_ID, event[field]):
            raise ValueError('HOOK_' + code + '_INVALID')
    if not hook_match('ho_' + HOOK_ID + r'/[1-9][0-9]{0,15}', event['eventKey']):
        raise ValueError('HOOK_EVENT_KEY_INVALID')
    if int(event['eventKey'].rsplit('/', 1)[1]) > 9007199254740991:
        raise ValueError('HOOK_EVENT_KEY_INVALID')
    for field in ('sender', 'recipient'):
        endpoint = event[field]
        if (not isinstance(endpoint, dict) or set(endpoint) != {'adapter', 'endpointId'}
                or not hook_text(endpoint['adapter'], 64) or not hook_text(endpoint['endpointId'], 256)):
            raise ValueError('HOOK_ENDPOINT_INVALID')
    if event['sender']['adapter'] != 'pi' or event['recipient']['adapter'] != 'chatgpt':
        raise ValueError('HOOK_DIRECTION_DENIED')
    if event['sender']['endpointId'] != config['hookSenderEndpointId']:
        raise ValueError('HOOK_SENDER_DENIED')
    if event['recipient']['endpointId'] != config['hookRecipientEndpointId']:
        raise ValueError('HOOK_RECIPIENT_DENIED')
    if event['exchangeId'] != config['hookExchangeId']:
        raise ValueError('HOOK_EXCHANGE_DENIED')
    if event['eventKey'].rsplit('/', 1)[0] != event['exchangeId']:
        raise ValueError('HOOK_EVENT_KEY_INVALID')
    if not hook_match(r'[0-9a-f]{64}', event['payloadDigest']):
        raise ValueError('HOOK_PAYLOAD_DIGEST_INVALID')
    if type(event['payloadLength']) is not int or not 0 <= event['payloadLength'] <= 9007199254740991:
        raise ValueError('HOOK_PAYLOAD_LENGTH_INVALID')
    if not hook_match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', event['createdAt']):
        raise ValueError('HOOK_CREATED_AT_INVALID')
    try:
        created = datetime.datetime.fromisoformat(event['createdAt'].replace('Z', '+00:00'))
    except ValueError as error:
        raise ValueError('HOOK_CREATED_AT_INVALID') from error
    age = (datetime.datetime.now(datetime.UTC) - created).total_seconds()
    if age > 120:
        raise ValueError('HOOK_EVENT_STALE')
    if age < -5:
        raise ValueError('HOOK_EVENT_FROM_FUTURE')
    return event


def private_hook_file(fd):
    info = os.fstat(fd)
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or info.st_nlink != 1):
        raise ValueError('HOOK_STATE_FILE_UNSAFE')


def osascript_notifier(text):
    # The script is constant; notice text is argv data, never AppleScript source.
    script = ('on run argv\n'
              'display notification (item 1 of argv) with title "CE message"\n'
              'end run')
    subprocess.run(['/usr/bin/osascript', '-e', script, '--', text], shell=False,
                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                   timeout=5, check=True)


def notify_hook(raw, config, notifier=None):
    event = validate_hook(raw, config)
    directory = Path(config['stateDir'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_REQUIRED')
    flags = os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR | flags, 0o600)
    with os.fdopen(fd, 'r+') as lock:
        private_hook_file(lock.fileno())
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Any legacy attempt, even corrupt or uncertain, prevents a new effect.
        if os.path.lexists(directory / (event['messageId'] + '.json')):
            raise ValueError('HOOK_HISTORICAL_ATTEMPT')
        file = directory / ('hook-' + event['messageId'] + '.json')
        fingerprint = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
        if os.path.lexists(file):
            fd = os.open(file, os.O_RDONLY | flags)
            with os.fdopen(fd, 'rb') as saved_file:
                private_hook_file(saved_file.fileno())
                saved = json.loads(saved_file.read(HOOK_MAX_INPUT + 1), object_pairs_hook=unique_object)
            if not isinstance(saved, dict) or saved.get('recordSha256') != fingerprint:
                raise ValueError('HOOK_MESSAGE_CONFLICT')
            if (saved.get('stage') not in ('NOTIFICATION_ATTEMPTED', 'NOTIFICATION_UNKNOWN', 'NOTIFICATION_REQUESTED')
                    or saved.get('result') not in (
                        {'messageId': event['messageId'], 'notificationRequest': 'UNKNOWN'},
                        {'messageId': event['messageId'], 'notificationRequest': 'REQUESTED'})):
                raise ValueError('HOOK_JOURNAL_INVALID')
            return saved['result']
        # Never overwrite recovery debris left before an interrupted atomic write.
        if os.path.lexists(file.with_suffix('.tmp')):
            raise ValueError('HOOK_HISTORICAL_ATTEMPT')
        result = {'messageId': event['messageId'], 'notificationRequest': 'UNKNOWN'}
        state = {'recordSha256': fingerprint, 'stage': 'NOTIFICATION_ATTEMPTED', 'result': result}
        write_state(file, state)
        try:
            text = f"CE 有新消息 {event['messageId']}（{event['exchangeId']}）。本通知仅含标识符。"
            (osascript_notifier if notifier is None else notifier)(text)
            result['notificationRequest'] = 'REQUESTED'
            state['stage'] = 'NOTIFICATION_REQUESTED'
        except (ValueError, OSError, subprocess.SubprocessError):
            state['stage'] = 'NOTIFICATION_UNKNOWN'
        write_state(file, state)
        return result


def notice(record, config):
    if set(record) != {'testId', 'messageId', 'to', 'replyTo', 'disposition'} or record['disposition'] != 'CREATED':
        raise ValueError('CE_CREATED_REQUIRED')
    if not re.fullmatch(r'CE-WAKE-(?:TEST|AUTO)-[A-Za-z0-9-]{1,64}', record['testId']) or not re.fullmatch(r'msg_[A-Z0-9]{26}', record['messageId']):
        raise ValueError('CORRELATION_DENIED')
    if (not isinstance(config.get('targetEndpoint'), str) or not re.fullmatch(r'chatgpt/[A-Za-z0-9-]{1,64}', config['targetEndpoint'])
            or not isinstance(config.get('replyEndpoint'), str) or not re.fullmatch(r'pi/[A-Za-z0-9-]{1,64}', config['replyEndpoint'])
            or record['to'] != config['targetEndpoint'] or record['replyTo'] != config['replyEndpoint']):
        raise ValueError('ENDPOINT_DENIED')
    return (f"[CE-WAKE:{record['testId']}] CE 中有待处理消息 {record['messageId']}。"
            f"请用 ce_inbox_list 定位并用 ce_read_payload 实际读取该 Message ID，按真实 Payload 处理，"
            f"再用 ce_send 回复 {record['replyTo']}，保持关联 ID；如需接收 ACK，只使用实际读取的元数据。"
            "本通知不含任务内容，不得从通知推测 Payload。")


def marker_present(tree, marker):
    return any(marker in str(n.get(field, '')).splitlines()
               for n in tree if n.get('role') in ('text', 'statictext')
               for field in ('name', 'value'))


# agent-desktop v1.0.2 macOS snapshot states and advertised action capabilities.
DIAGNOSTIC_STATES = frozenset({'focused', 'disabled', 'secure', 'expanded', 'checked', 'indeterminate',
                               'selected', 'hidden', 'busy', 'modal', 'required', 'pressed', 'readonly', 'offscreen'})
DIAGNOSTIC_ACTIONS = frozenset({'Click', 'Toggle', 'RightClick', 'ScrollTo', 'Scroll', 'SetValue',
                                'Select', 'SetFocus', 'TypeText', 'Expand', 'Collapse'})


def control_diagnostics(envelope):
    # Diagnostics keep only fixed control metadata, never drafts or conversation text.
    data = envelope.get('data', {})
    areas = [n for n in nodes(data.get('tree', {})) if n.get('role') == 'webarea']
    tree = list(nodes(areas[0])) if len(areas) == 1 else []
    inputs = [n for n in tree if n.get('role') == 'textfield' and n.get('name') == '询问 ChatGPT']
    sends = [n for n in tree if n.get('role') == 'button' and n.get('name') == '发送']
    stops = [n for n in tree if n.get('role') == 'button' and n.get('name') in ('停止', '停止生成', 'Stop generating')]
    def describe(node):
        # Unknown metadata is not persisted or used to infer whether a control is enabled.
        metadata = {}
        for field, allowed in (('states', DIAGNOSTIC_STATES), ('available_actions', DIAGNOSTIC_ACTIONS)):
            value = node.get(field)
            metadata[field] = sorted(value) if isinstance(value, list) and all(
                isinstance(item, str) and item in allowed for item in value) else None
        states = metadata['states']
        return {'role': node.get('role'), 'name': node.get('name'), 'states': states,
                'enabled': 'disabled' not in states if states is not None else None,
                'availableActions': metadata['available_actions']}
    webarea = {'role': 'webarea', 'name': areas[0].get('name')} if len(areas) == 1 else None
    window = {key: data.get('window', {}).get(key) for key in ('id', 'title')}
    draft = inputs[0].get('value') if len(inputs) == 1 else None
    normalized = '' if draft == '询问 ChatGPT\n' else draft
    return {'webareaCount': len(areas), 'composerCandidates': [describe(n) for n in inputs],
            'sendCandidates': [describe(n) for n in sends], 'stopCandidates': [describe(n) for n in stops],
            'webarea': webarea, 'window': window,
            'draftState': ('EMPTY' if normalized == '' else 'NONEMPTY' if isinstance(normalized, str)
                           else 'UNKNOWN'), 'draftLength': len(normalized) if isinstance(normalized, str) else None}


def selector_counts(envelope):
    """Counts are observable controls, independent of whether draft text is known."""
    controls = control_diagnostics(envelope)
    return {'composer': len(controls['composerCandidates']), 'send': len(controls['sendCandidates'])}


def observe(envelope, config, allow_busy=False, *, require_marker=True):
    data = envelope.get('data', {})
    if envelope.get('version') != '2.5' or envelope.get('ok') is not True or data.get('complete') is not True:
        raise ValueError('SNAPSHOT_DENIED')
    if data.get('app') != 'ChatGPT' or data.get('window', {}).get('id') != config['windowId']:
        raise ValueError('WINDOW_DENIED')
    # Observation may omit this auxiliary signal; action callers always require it.
    areas = [n for n in nodes(data['tree']) if n.get('role') == 'webarea']
    if len(areas) != 1:
        raise ValueError('CONVERSATION_DENIED')
    tree = list(nodes(areas[0]))
    if require_marker and not marker_present(tree, config['conversationMarker']):
        raise ValueError('CONVERSATION_MARKER_MISSING')
    inputs = [n for n in tree if n.get('role') == 'textfield' and n.get('name') == '询问 ChatGPT']
    sends = [n for n in tree if n.get('role') == 'button' and n.get('name') == '发送']
    if len(inputs) != 1 or len(sends) > 1 or (not allow_busy and len(sends) != 1):
        raise ValueError('INPUT_OR_SEND_AMBIGUOUS')
    if not allow_busy and any(n.get('role') == 'button' and n.get('name') in ('停止', '停止生成', 'Stop generating') for n in tree):
        raise ValueError('CHATGPT_BUSY')
    draft = inputs[0].get('value')
    if not isinstance(draft, str):
        raise ValueError('DRAFT_STATE_UNKNOWN')
    if draft == '询问 ChatGPT\n':
        draft = ''
    texts = [n.get('value', n.get('name', '')) for n in tree if n is not inputs[0] and n.get('role') in ('text', 'statictext', 'textfield')]
    return {'input': inputs[0], 'send': sends[0] if sends else None, 'draft': draft, 'texts': texts}


def run(record, config, desktop):
    text = notice(record, config)
    directory = Path(config['stateDir'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_REQUIRED')
    config['executionEnd'] = time.monotonic() + min(120, config.get('maxWaitSeconds', 60))
    fd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        file = directory / (record['messageId'] + '.json')
        fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
        if file.exists():
            saved = json.loads(file.read_text())
            if saved['recordSha256'] != fingerprint:
                raise ValueError('MESSAGE_CORRELATION_CONFLICT')
            return saved['result']
        result = {'testId': record['testId'], 'messageId': record['messageId'], 'ceMessage': 'CREATED', 'noticeSubmission': 'NOT_ATTEMPTED', 'taskExecution': 'AWAITING_CE_REPLY'}
        state = {'recordSha256': fingerprint, 'stage': 'OBSERVING', 'result': result}
        write_state(file, state)
        try:
            while True:
                remaining(config)
                envelope = desktop.snapshot()
                view = observe(envelope, config, allow_busy=not config.get('refuseBusy', False))
                busy = any(n.get('role') == 'button' and n.get('name') in ('停止', '停止生成', 'Stop generating') for n in nodes(envelope['data']['tree']))
                if not busy:
                    view = observe(envelope, config)
                    break
                time.sleep(config.get('pollSeconds', .5))
            if view['draft']:
                raise ValueError('NONEMPTY_DRAFT')
            state['stage'] = 'INPUT_MAY_HAVE_OCCURRED'
            write_state(file, state)
            desktop.fill(view['input']['ref_id'], text)
            view = observe(desktop.snapshot(), config)
            if view['draft'] != text or 'disabled' in view['send'].get('states', []):
                raise ValueError('DRAFT_OR_SEND_READBACK_MISMATCH')
            remaining(config)
            result['noticeSubmission'] = 'UNKNOWN'
            state['stage'] = 'SUBMIT_MAY_HAVE_OCCURRED'
            write_state(file, state)
            desktop.submit(view['send']['ref_id'])
            while remaining(config) > 0:
                view = observe(desktop.snapshot(), config, allow_busy=True)
                if not view['draft'] and text in '\n'.join(view['texts']):
                    result['noticeSubmission'] = 'OBSERVED'
                    state['stage'] = 'NOTICE_OBSERVED'
                    break
                time.sleep(config.get('pollSeconds', .5))
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            code = str(error)
            result['reason'] = code if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code) else type(error).__name__
        write_state(file, state)
        return result


class ChatGptCli(DesktopCli):
    def call(self, args):
        # A success-shaped response from a failed process is not an observation.
        marker = Path(self.config['desktopTmpDir']) / 'command-in-flight'
        with marker.open('w') as stream:
            stream.write(str(os.getpid()))
            stream.flush()
            os.fsync(stream.fileno())
        result = subprocess.run(self.prefix + args, env=self.env, capture_output=True, text=True,
                                timeout=min(15, remaining(self.config)))
        if result.returncode != 0:
            raise ValueError('DESKTOP_COMMAND_FAILED')
        envelope = json.loads(result.stdout)
        if not isinstance(envelope, dict) or envelope.get('version') != '2.5' or envelope.get('ok') is not True:
            raise ValueError('DESKTOP_COMMAND_FAILED')
        marker.unlink()
        return envelope


    def snapshot(self):
        for attempt in range(3):
            remaining(self.config)
            windows = self.call(['list-windows', '--app', 'ChatGPT'])['data']
            target = [w for w in windows if w['id'] == self.config['windowId']]
            if len(target) != 1 or target[0]['pid'] != self.config['pid'] or target[0]['process_instance'] != self.config['processInstance']:
                raise ValueError('CHATGPT_PROCESS_OR_WINDOW_CHANGED')
            envelope = self.call(['snapshot', '--app', 'ChatGPT', '--window-id', self.config['windowId'], '--compact', '--max-depth', '30', '--timeout-ms', '8000'])
            if envelope['data'].get('complete') is True:
                return envelope
            if attempt < 2:
                time.sleep(.2)
        raise ValueError('SNAPSHOT_INCOMPLETE')

    def fill(self, ref, text):
        self.call(['set-value', ref, text])

    def submit(self, ref):
        self.call(['click', ref])


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--hook', action='store_true')
    modes.add_argument('--record', '--task', dest='record')
    args = parser.parse_args(argv)
    if args.hook:
        try:
            with Path(args.config).open('rb') as file:
                raw_config = file.read(HOOK_MAX_INPUT + 1)
            if len(raw_config) > HOOK_MAX_INPUT:
                raise ValueError('HOOK_CONFIG_INVALID')
            config = json.loads(raw_config.decode('utf-8'), object_pairs_hook=unique_object)
            raw = sys.stdin.buffer.read(HOOK_MAX_INPUT + 1)
            if isinstance(config, dict) and set(config) == {'autoWakeConfig'}:
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                import auto_wake
                # Opt-in config is private and belongs to this existing Hook command.
                auto_wake.read_private(args.config)
                automatic = auto_wake.load_config(config['autoWakeConfig'])
                if Path(args.config) != Path(automatic['ownerDirectory']) / 'config.json':
                    raise ValueError('AUTO_CONFIG_OWNER_INVALID')
                result = auto_wake.enqueue(raw, automatic)
                code = 0 if result['dispatch'] == 'QUEUED' else 1
            else:
                result = notify_hook(raw, config)
                code = 0 if result['notificationRequest'] == 'REQUESTED' else 1
            print(json.dumps(result, ensure_ascii=False))
            return code
        except (ValueError, OSError, UnicodeError, RecursionError, subprocess.SubprocessError) as error:
            code = str(error)
            sys.stderr.write((code if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code)
                              else 'HOOK_REJECTED') + '\n')
            return 1
    config = json.loads(Path(args.config).read_text())
    record = json.loads(Path(args.record).read_text())
    print(json.dumps(run(record, config, ChatGptCli(config)), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
