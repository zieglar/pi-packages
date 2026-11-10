#!/usr/bin/env python3
"""Bounded Ovis driver; real tasks require local opt-in. Journals never allow replay."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

from lifecycle import require_executable

def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def end_marker(task):
    return '[CE-OVIS-END:' + task['taskId'] + ']'


def prompt_for(task):
    if task['testOnly'] is False:
        return (f"[CE-OVIS-TASK:{task['taskId']}]\n执行以下本地已授权任务，遵守当前 Agent 的权限与审批要求：\n"
                f"{task['text']}\n处理结束后说明结果及未完成事项。"
                "结束标记只表示你已报告处理结果，不表示业务结果已验证。\n"
                f"最后独占一行输出 {end_marker(task)}")
    return (f"[CE-OVIS-TEST:{task['taskId']}]\n仅回显以下测试文本，不使用工具：\n"
            f"{task['text']}\n最后独占一行输出 {end_marker(task)}")


def nodes(tree):
    yield tree
    for child in tree.get('children', []):
        yield from nodes(child)


def observe(envelope, config):
    if envelope.get('version') != '2.5' or envelope.get('ok') is not True:
        raise ValueError('DESKTOP_OBSERVATION_FAILED')
    data = envelope['data']
    if data.get('complete') is not True or data.get('window', {}).get('id') != config['windowId'] or data.get('app') != 'Ovis':
        raise ValueError('WINDOW_OR_COMPLETENESS_MISMATCH')
    all_nodes = list(nodes(data['tree']))
    logs = [n for n in all_nodes if n.get('role') == 'log' and n.get('name') == config['conversation']]
    inputs = [n for n in all_nodes if n.get('role') == 'textfield' and n.get('name') == '消息']
    if len(logs) != 1 or len(inputs) != 1:
        raise ValueError('CONVERSATION_OR_INPUT_MISMATCH')
    texts = []
    for n in nodes(logs[0]):
        if n.get('role') in ('text', 'statictext'):
            value = n.get('value', n.get('name'))
            if isinstance(value, str) and value:
                texts.append(value)
    return {'input': inputs[0], 'texts': texts, 'buttons': [n for n in all_nodes if n.get('role') == 'button'], 'log': logs[0]}


def classify(view, task):
    buttons = [n.get('name', '') for n in view['buttons']]
    if '停止 Agent' in buttons:
        return {'ovisState': 'PROCESSING'}
    if any(n in ('重试', 'Retry', '重新生成') for n in buttons):
        return {'ovisState': 'FAILED'}
    marker = end_marker(task)
    text = '\n'.join(view['texts'])
    # Exclude the submitted prompt: its instructions also contain the end marker.
    prompt = prompt_for(task)
    if text.startswith(prompt):
        text = text[len(prompt):].lstrip('\n')
    elif prompt in text:
        text = text.split(prompt, 1)[1].lstrip('\n')
    lines = text.splitlines()
    while lines and re.fullmatch(r'\d{1,2}:\d{2}', lines[-1]):
        lines.pop()
    if lines and lines[-1] == marker and '发送消息' in buttons:
        response = '\n'.join(lines[:-1]).strip()
        response = re.sub(r'^\d{1,2}:\d{2}\n', '', response)
        return {'ovisState': 'REPORTED' if task['testOnly'] is False else 'COMPLETED', 'response': response}
    return {'ovisState': 'UNKNOWN'}


def remaining(config):
    if config.get('taskDeadline') is not None and time.time() >= config['taskDeadline']:
        raise ValueError('TASK_EXPIRED')
    if config.get('executionEnd') is None:
        return 15
    parent = os.environ.get('CE_BRIDGE_PARENT_PID')
    stop_file = os.environ.get('CE_BRIDGE_STOP_FILE')
    if (parent and os.getppid() != int(parent)) or (stop_file and Path(stop_file).exists()):
        raise ValueError('WINDOW_STOPPED')
    seconds = config['executionEnd'] - time.monotonic()
    if seconds <= 0:
        raise ValueError('TASK_EXECUTION_DEADLINE')
    return seconds


def validate(task, config):
    keys = {'schemaVersion', 'taskId', 'target', 'testOnly', 'text', 'deadline'}
    execute = task.get('testOnly') is False and config.get('taskMode') == 'execute'
    if set(task) != keys or type(task['schemaVersion']) is not int or task['schemaVersion'] != 1 or not (task['testOnly'] is True or execute):
        raise ValueError('TEST_TASK_SCHEMA_DENIED')
    prefix = 'TASK' if execute else 'TEST'
    if not isinstance(task['taskId'], str) or not re.fullmatch(r'CE-OVIS-' + prefix + r'-[A-Za-z0-9-]{1,64}', task['taskId']):
        raise ValueError('TEST_TASK_ID_DENIED')
    if task['taskId'] != config['allowedTaskId'] or not isinstance(task['target'], str) or task['target'] + ' 的对话' != config['conversation']:
        raise ValueError('TASK_TARGET_DENIED')
    if execute:
        agent_prefix = config.get('agentButtonPrefix')
        if not isinstance(agent_prefix, str) or not agent_prefix.startswith('pi: ' + task['target'] + ' '):
            raise ValueError('TARGET_AGENT_SELECTION_REQUIRED')
    if not isinstance(task['text'], str) or not 1 <= len(task['text'].encode()) <= 4096 or digest(task['text']) != config['allowedTextSha256']:
        raise ValueError('TASK_TEXT_DENIED')
    deadline = datetime.datetime.fromisoformat(task['deadline'].replace('Z', '+00:00'))
    if deadline.tzinfo is None or deadline.timestamp() <= time.time():
        raise ValueError('TASK_EXPIRED')
    return min(config.get('maxWaitSeconds', 120), max(0, deadline.timestamp() - time.time()), 300)


def write_state(path, state):
    tmp = path.with_suffix('.tmp')
    fd = os.open(tmp, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(state, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run_task(task, config, desktop):
    budget = validate(task, config)
    config['executionEnd'] = time.monotonic() + budget
    directory = Path(config['stateDir'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_DIRECTORY_REQUIRED')
    lockfd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lockfd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        path = directory / (task['taskId'] + '.json')
        task_hash = digest(json.dumps(task, sort_keys=True, ensure_ascii=False))
        if path.exists():
            state = json.loads(path.read_text())
            if state['taskSha256'] != task_hash:
                raise ValueError('TASK_ID_CONTENT_CONFLICT')
            return state['result']
        state = {'taskSha256': task_hash, 'stage': 'OBSERVING', 'result': {'taskId': task['taskId'], 'scriptState': 'STOPPED', 'ovisState': 'UNKNOWN', 'submission': 'NOT_ATTEMPTED'}}
        if task['testOnly'] is False:
            state['result'].update(desktopSubmission='NOT_ATTEMPTED', agentProcessingObserved=False,
                                   completionReport='UNKNOWN', taskCompletion='UNVERIFIED')
        write_state(path, state)
        result = state['result']
        def checkpoint(stage):
            if task['testOnly'] is False:
                result['desktopSubmission'] = result['submission']
            state['stage'] = stage
            write_state(path, state)
        try:
            remaining(config)
            desktop.prepare()
            view = observe(desktop.snapshot(), config)
            if view['input'].get('value') or any(n.get('name') == '停止 Agent' for n in view['buttons']):
                result['reason'] = 'DRAFT_OR_ACTIVE_TURN_PRESENT'
                checkpoint('REFUSED')
                return result
            remaining(config)
            checkpoint('INPUT_MAY_HAVE_OCCURRED')
            desktop.action('type', view['input']['ref_id'], prompt_for(task))
            view = observe(desktop.snapshot(), config)
            if view['input'].get('value') != prompt_for(task):
                raise ValueError('DRAFT_READBACK_MISMATCH')
            sends = [n for n in view['buttons'] if n.get('name') == '发送消息']
            if len(sends) != 1:
                raise ValueError('SEND_BUTTON_NOT_UNIQUE')
            remaining(config)
            result['submission'] = 'UNKNOWN'
            checkpoint('SUBMIT_MAY_HAVE_OCCURRED')
            desktop.action('click', sends[0]['ref_id'])
            deadline = config['executionEnd']
            while time.monotonic() < deadline:
                remaining(config)
                view = observe(desktop.snapshot(), config)
                text = '\n'.join(view['texts'])
                if prompt_for(task) in text and not view['input'].get('value'):
                    result['submission'] = 'OBSERVED'
                    result.update(classify(view, task))
                    if task['testOnly'] is False:
                        if result['ovisState'] == 'PROCESSING' and not result['agentProcessingObserved']:
                            result['agentProcessingObserved'] = True
                            checkpoint('PROCESSING_OBSERVED')
                        if result['ovisState'] == 'REPORTED':
                            result['completionReport'] = 'REPORTED'
                    if result['ovisState'] in ('COMPLETED', 'REPORTED', 'FAILED'):
                        result['scriptState'] = 'FINISHED'
                        checkpoint('FINISHED')
                        return result
                time.sleep(max(0.001, config.get('pollSeconds', 0.5)))
            result['reason'] = 'OBSERVATION_DEADLINE'
        except (ValueError, OSError, TimeoutError, subprocess.SubprocessError) as error:
            code = str(error)
            result['reason'] = code if isinstance(error, ValueError) and re.fullmatch(r'[A-Z][A-Z0-9_]{1,79}', code) else type(error).__name__
        checkpoint('STOPPED_NO_REPLAY')
        return result


class DesktopCli:
    def __init__(self, config):
        self.config = config
        require_executable(config.get('agentDesktop'), 'DESKTOP')
        for field in ('desktopTmpDir', 'stateDir'):
            if not isinstance(config.get(field), str) or not Path(config[field]).is_absolute():
                raise ValueError('ABSOLUTE_PATH_REQUIRED_' + field)
        self.env = {**os.environ, 'TMPDIR': config['desktopTmpDir']}
        tmp = Path(config['desktopTmpDir'])
        tmp.mkdir(mode=0o700, parents=True, exist_ok=True)
        if tmp.is_symlink() or tmp.stat().st_uid != os.getuid() or tmp.stat().st_mode & 0o077:
            raise ValueError('PRIVATE_DESKTOP_TMP_REQUIRED')
        self.prefix = [config['agentDesktop'], '--session', config['desktopSession']]

    def call(self, args):
        timeout = min(15, remaining(self.config))
        marker = Path(self.config['desktopTmpDir']) / 'command-in-flight'
        with marker.open('w') as f:
            f.write(str(os.getpid()))
            f.flush()
            os.fsync(f.fileno())
        p = subprocess.run(self.prefix + args, env=self.env, capture_output=True, text=True, timeout=timeout)
        envelope = json.loads(p.stdout)
        if envelope.get('version') != '2.5' or envelope.get('ok') is not True:
            raise ValueError('DESKTOP_COMMAND_FAILED')
        marker.unlink()
        return envelope

    def snapshot(self):
        info = self.call(['list-windows', '--app', 'Ovis'])
        candidates = [w for w in info['data'] if w['id'] == self.config['windowId']]
        if len(candidates) != 1 or candidates[0]['pid'] != self.config['pid'] or candidates[0]['process_instance'] != self.config['processInstance']:
            raise ValueError('OVIS_PROCESS_GENERATION_MISMATCH')
        return self.call(['snapshot', '--app', 'Ovis', '--window-id', self.config['windowId'], '--compact', '--max-depth', '30'])

    def prepare(self):
        snapshot = self.snapshot()
        prefix = self.config.get('agentButtonPrefix')
        if prefix is None:
            observe(snapshot, self.config)
            return
        if not isinstance(prefix, str) or not prefix:
            raise ValueError('TARGET_AGENT_SELECTION_NOT_CONFIGURED')
        if snapshot.get('version') != '2.5' or snapshot.get('ok') is not True or snapshot.get('data', {}).get('complete') is not True or snapshot['data'].get('app') != 'Ovis' or snapshot['data'].get('window', {}).get('id') != self.config['windowId']:
            raise ValueError('WINDOW_OR_COMPLETENESS_MISMATCH')
        buttons = [n for n in nodes(snapshot['data']['tree']) if n.get('role') == 'button' and n.get('name', '').startswith(prefix)]
        if len(buttons) != 1:
            raise ValueError('TARGET_AGENT_NOT_UNIQUE')
        self.call(['click', buttons[0]['ref_id']])
        snapshot = self.snapshot()
        chats = [n for n in nodes(snapshot['data']['tree']) if n.get('role') == 'switch' and n.get('name') == '聊天']
        if len(chats) == 1 and chats[0].get('value') == '0':
            self.call(['click', chats[0]['ref_id']])
            snapshot = self.snapshot()
        observe(snapshot, self.config)


    def action(self, command, ref, text=None):
        if command == 'type':
            if not isinstance(text, str) or not text:
                raise ValueError('TEXT_REQUIRED')
            if self.config.get('headedAuthorized') is not True:
                raise ValueError('HEADED_NOT_AUTHORIZED')
            expected = ''
            current_ref = ref
            result = None
            for piece in self.type_pieces(text):
                remaining(self.config)
                if piece == '\n':
                    # A bare Return can submit a chat or execute a shell line.
                    # Target the current input, then insert a newline without submitting.
                    self.call(['focus', current_ref])
                    result = self.call(['--headed', 'press', 'shift+return', '--app', 'Ovis',
                                        '--window-id', self.config['windowId']])
                else:
                    result = self.call(['--headed', 'type', current_ref, piece])
                expected += piece
                current_ref = self.settle_input(expected)
            return result
        remaining(self.config)
        return self.call(['click', ref])

    def type_pieces(self, text):
        for index, segment in enumerate(text.split('\n')):
            if index:
                yield '\n'
            for start in range(0, len(segment), 8):
                yield segment[start:start + 8]

    def settle_input(self, expected):
        # Observe delayed input without retyping: a stable prefix does not prove loss.
        deadline = time.monotonic() + min(3, max(0, float(self.config.get('inputSettleSeconds', 3))))
        while True:
            remaining(self.config)
            if time.monotonic() >= deadline:
                raise ValueError('CHUNK_READBACK_MISMATCH')
            view = observe(self.snapshot(), self.config)
            remaining(self.config)
            now = time.monotonic()
            if now >= deadline:
                raise ValueError('CHUNK_READBACK_MISMATCH')
            value = view['input'].get('value')
            if value == expected:
                return view['input']['ref_id']
            if value is None:
                value = ''
            if not isinstance(value, str) or not expected.startswith(value):
                raise ValueError('CHUNK_READBACK_MISMATCH')
            time.sleep(min(0.05, deadline - now))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--task', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    task = json.loads(Path(args.task).read_text())
    validate(task, config)
    config['taskDeadline'] = datetime.datetime.fromisoformat(task['deadline'].replace('Z', '+00:00')).timestamp()
    result = run_task(task, config, DesktopCli(config))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
