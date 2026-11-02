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
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ce-ovis-desktop'))
from bridge import DesktopCli, nodes, remaining, write_state


def notice(record, config):
    if set(record) != {'testId', 'messageId', 'to', 'replyTo', 'disposition'} or record['disposition'] != 'CREATED':
        raise ValueError('CE_CREATED_REQUIRED')
    if not re.fullmatch(r'CE-WAKE-TEST-[A-Za-z0-9-]{1,64}', record['testId']) or not re.fullmatch(r'msg_[A-Z0-9]{26}', record['messageId']):
        raise ValueError('CORRELATION_DENIED')
    if (not isinstance(config.get('targetEndpoint'), str) or not re.fullmatch(r'chatgpt/[A-Za-z0-9-]{1,64}', config['targetEndpoint'])
            or not isinstance(config.get('replyEndpoint'), str) or not re.fullmatch(r'pi/[A-Za-z0-9-]{1,64}', config['replyEndpoint'])
            or record['to'] != config['targetEndpoint'] or record['replyTo'] != config['replyEndpoint']):
        raise ValueError('ENDPOINT_DENIED')
    return (f"[CE-WAKE:{record['testId']}] CE 中有待处理测试消息 {record['messageId']}。"
            f"请用 ce_inbox_list 定位并用 ce_read_payload 实际读取该 Message ID，按真实 Payload 处理，"
            f"再用 ce_send 回复 {record['replyTo']}，保持关联 ID；如需接收 ACK，只使用实际读取的元数据。"
            "本通知不含任务内容，不得从通知推测 Payload。")


def observe(envelope, config, allow_busy=False):
    data = envelope.get('data', {})
    if envelope.get('version') != '2.5' or envelope.get('ok') is not True or data.get('complete') is not True:
        raise ValueError('SNAPSHOT_DENIED')
    if data.get('app') != 'ChatGPT' or data.get('window') != {'id': config['windowId'], 'title': config['windowTitle']}:
        raise ValueError('WINDOW_DENIED')
    areas = [n for n in nodes(data['tree']) if n.get('role') == 'webarea' and n.get('name') == config['windowTitle']]
    if len(areas) != 1:
        raise ValueError('CONVERSATION_DENIED')
    tree = list(nodes(areas[0]))
    if not any(config['conversationMarker'] in str(n.get(field, '')).splitlines()
               for n in tree if n.get('role') in ('text', 'statictext')
               for field in ('name', 'value')):
        raise ValueError('CONVERSATION_MARKER_MISSING')
    inputs = [n for n in tree if n.get('role') == 'textfield' and n.get('name') == '询问 ChatGPT']
    sends = [n for n in tree if n.get('role') == 'button' and n.get('name') == '发送']
    if len(inputs) != 1 or len(sends) > 1 or (not allow_busy and len(sends) != 1):
        raise ValueError('INPUT_OR_SEND_AMBIGUOUS')
    if not allow_busy and any(n.get('role') == 'button' and n.get('name') in ('停止', '停止生成', 'Stop generating') for n in tree):
        raise ValueError('CHATGPT_BUSY')
    draft = inputs[0].get('value') or ''
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
                view = observe(envelope, config, allow_busy=True)
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
    def snapshot(self):
        for attempt in range(3):
            remaining(self.config)
            windows = self.call(['list-windows', '--app', 'ChatGPT'])['data']
            target = [w for w in windows if w['id'] == self.config['windowId']]
            if len(target) != 1 or target[0]['pid'] != self.config['pid'] or target[0]['process_instance'] != self.config['processInstance'] or target[0]['title'] != self.config['windowTitle']:
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


if __name__ == '__main__':
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--record', '--task', dest='record', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    record = json.loads(Path(args.record).read_text())
    print(json.dumps(run(record, config, ChatGptCli(config)), ensure_ascii=False))
