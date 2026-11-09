#!/usr/bin/env python3
"""Interactive macOS notification boundary for CE ChatGPT wake tasks."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


TASK = re.compile(r'CE-WAKE-(?:TEST|AUTO)-[A-Za-z0-9-]{1,64}')
MESSAGE = re.compile(r'msg_[A-Z0-9]{26}')
CONFIG_FIELDS = {'terminalNotifier', 'stateDir', 'desktopConfig', 'actionTitle', 'timeoutSeconds'}


def _validate_config(config):
    if (set(config) not in (CONFIG_FIELDS, CONFIG_FIELDS | {'targetTitle'})
            or not isinstance(config['terminalNotifier'], str)
            or not Path(config['terminalNotifier']).is_absolute()
            or not Path(config['terminalNotifier']).is_file()
            or not os.access(config['terminalNotifier'], os.X_OK)
            or not isinstance(config['stateDir'], str)
            or not Path(config['stateDir']).is_absolute()
            or not isinstance(config['desktopConfig'], str)
            or not Path(config['desktopConfig']).is_absolute()
            or not isinstance(config['actionTitle'], str)
            or not 1 <= len(config['actionTitle']) <= 40
            or type(config['timeoutSeconds']) is not int
            or not 1 <= config['timeoutSeconds'] <= 900):
        raise ValueError('NOTIFICATION_CONFIG_INVALID')
    if 'targetTitle' in config and (not isinstance(config['targetTitle'], str)
            or not 1 <= len(config['targetTitle']) <= 512 or re.search(r'[\x00-\x1f\x7f]', config['targetTitle'])):
        raise ValueError('NOTIFICATION_CONFIG_INVALID')
    desktop = json.loads(Path(config['desktopConfig']).read_text())
    # The notification journal and the desktop journal each hold an exclusive lock on
    # <stateDir>/.lock. Sharing one directory would make the handler's own lock
    # block the desktop driver, so the two state directories must differ.
    desktop_state = desktop.get('stateDir')
    if isinstance(desktop_state, str) and desktop_state:
        if Path(desktop_state).resolve() == Path(config['stateDir']).resolve():
            raise ValueError('NOTIFICATION_STATE_DIR_CONFLICT')
    return desktop


def _validate_record(record, desktop):
    fields = {'testId', 'messageId', 'to', 'replyTo', 'disposition'}
    if (set(record) != fields or record['disposition'] != 'CREATED'
            or not isinstance(record['testId'], str) or not TASK.fullmatch(record['testId'])
            or not isinstance(record['messageId'], str) or not MESSAGE.fullmatch(record['messageId'])
            or record['to'] != desktop.get('targetEndpoint')
            or record['replyTo'] != desktop.get('replyEndpoint')):
        raise ValueError('NOTIFICATION_RECORD_INVALID')


def _state_dir(config):
    directory = Path(config['stateDir'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError('PRIVATE_STATE_REQUIRED')
    return directory


def journal_path(config, task_id):
    if not isinstance(task_id, str) or not TASK.fullmatch(task_id):
        raise ValueError('TASK_ID_INVALID')
    name = hashlib.sha256(task_id.encode()).hexdigest()
    return Path(config['stateDir']) / ('notification-' + name + '.json')


def _write(path, value):
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream, ensure_ascii=False, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def _read(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1):
        raise ValueError('TASK_STATE_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        return json.load(stream)


@contextlib.contextmanager
def _locked(config):
    directory = _state_dir(config)
    fd = os.open(directory / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
            raise ValueError('TASK_STATE_UNSAFE')
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def terminal_notifier(request, executable):
    command = [executable, '-title', request['title'], '-message', request['message'],
               '-group', request['group'], '-action', request['action'],
               '-timeout', str(request['timeout'])]
    result = subprocess.run(command, capture_output=True, text=True,
                            timeout=request['timeout'] + 5)
    outcome = result.stdout.rstrip('\r\n')
    if result.returncode not in (0, 6) or not outcome:
        raise OSError('TERMINAL_NOTIFIER_UNKNOWN')
    return outcome


def remove_notification(group, executable):
    result = subprocess.run([executable, '-remove', group], capture_output=True,
                            text=True, timeout=5)
    if result.returncode != 0:
        raise OSError('NOTIFICATION_REMOVE_UNKNOWN')


def _load_wake():
    path = Path(__file__).with_name('wake.py')
    spec = importlib.util.spec_from_file_location('ce_chatgpt_wake_driver', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def handle(task_id, config, wake=None, remover=None):
    desktop = _validate_config(config)
    path = journal_path(config, task_id)
    with _locked(config):
        if not path.exists():
            raise ValueError('TASK_NOT_FOUND')
        saved = _read(path)
        if saved.get('taskId') != task_id or saved.get('group') != 'ce-chatgpt-wake:' + task_id:
            raise ValueError('TASK_MAPPING_INVALID')
        _validate_record(saved.get('record'), desktop)
        expected = hashlib.sha256(json.dumps(saved['record'], sort_keys=True).encode()).hexdigest()
        if saved.get('recordSha256') != expected:
            raise ValueError('TASK_MAPPING_INVALID')
        if saved.get('consent') != 'ACTION_BUTTON':
            raise ValueError('ACTION_CONSENT_REQUIRED')
        if saved.get('state') != 'ACTION_CLICKED':
            return {'taskId': task_id, 'group': saved['group'], 'state': saved['state']}
        # Consume the one explicit consent durably before invoking any desktop command.
        saved['state'] = 'WAKE_MAY_HAVE_OCCURRED'
        _write(path, saved)
        wake_driver = _load_wake()
        wake_call = wake or (lambda record, desktop_config: wake_driver.run(
            record, desktop_config, wake_driver.ChatGptCli(desktop_config)))
        result = wake_call(saved['record'], desktop)
        if result.get('noticeSubmission') != 'OBSERVED':
            saved['state'] = 'UNKNOWN'
            saved['wake'] = result
            _write(path, saved)
            return {'taskId': task_id, 'group': saved['group'], 'state': 'UNKNOWN'}
        remove = remover or (lambda group: remove_notification(group, config['terminalNotifier']))
        try:
            remove(saved['group'])
        except (OSError, subprocess.SubprocessError):
            saved['state'] = 'REMOVAL_UNKNOWN'
            saved['wake'] = result
            _write(path, saved)
            return {'taskId': task_id, 'group': saved['group'], 'state': 'REMOVAL_UNKNOWN'}
        saved['state'] = 'TAKEN_OVER'
        saved['wake'] = result
        _write(path, saved)
        return {'taskId': task_id, 'group': saved['group'], 'state': 'TAKEN_OVER'}


def post(record, config, notifier=None, handler=None):
    desktop = _validate_config(config)
    _validate_record(record, desktop)
    path = journal_path(config, record['testId'])
    fingerprint = hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()
    with _locked(config):
        if path.exists():
            saved = _read(path)
            if saved.get('recordSha256') != fingerprint:
                raise ValueError('TASK_ID_CONFLICT')
            return {'taskId': saved['taskId'], 'group': saved['group'], 'state': saved['state']}
        group = 'ce-chatgpt-wake:' + record['testId']
        saved = {'taskId': record['testId'], 'group': group, 'recordSha256': fingerprint,
                 'record': record, 'state': 'NOTIFICATION_ATTEMPTED'}
        _write(path, saved)
    request = {'title': 'Pi → ChatGPT', 'message': '有新的 CE 任务待处理：' + record['testId'],
               'group': group, 'action': config['actionTitle'], 'timeout': config['timeoutSeconds']}
    if 'targetTitle' in config:
        request['message'] = '等待目标会话“' + config['targetTitle'] + '”。切回后点击继续。' + record['testId']
    notify = notifier or (lambda value: terminal_notifier(value, config['terminalNotifier']))
    try:
        outcome = notify(request)
    except (OSError, subprocess.SubprocessError):
        with _locked(config):
            saved = _read(path)
            saved['state'] = 'UNKNOWN'
            _write(path, saved)
        return {'taskId': saved['taskId'], 'group': group, 'state': 'UNKNOWN'}
    # Only the exact authorized action button is consent. A notification body click
    # (@ACTIONCLICKED) is not an explicit approval and must never route a wake.
    if outcome == config['actionTitle']:
        with _locked(config):
            saved = _read(path)
            saved['consent'] = 'ACTION_BUTTON'
            saved['state'] = 'ACTION_CLICKED'
            _write(path, saved)
        route = handler or handle
        return route(record['testId'], config)
    with _locked(config):
        saved = _read(path)
        saved['state'] = 'DISMISSED' if outcome == '@CLOSED' else 'UNKNOWN'
        _write(path, saved)
    return {'taskId': saved['taskId'], 'group': saved['group'], 'state': saved['state']}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--record', '--task', dest='record')
    modes.add_argument('--task-id')
    args = parser.parse_args(argv)
    config = json.loads(Path(args.config).read_text())
    result = post(json.loads(Path(args.record).read_text()), config) if args.record else handle(args.task_id, config)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['state'] == 'TAKEN_OVER' else 1


if __name__ == '__main__':
    os.umask(0o077)
    sys.exit(main())
